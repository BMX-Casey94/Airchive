import type { Knex } from "knex";
import type { Redis } from "ioredis";
import type { RecordType } from "@airchive/types";
import { RecordType as RecordTypeEnum } from "@airchive/types";
import type { WalletVault } from "@airchive/crypto";
import {
  coalescePendingTelemetryWrites,
  deletePendingWrite,
  getPendingWriteCount,
  getPendingWrites,
  insertPendingWrite,
  markWriteDeferred,
  markWriteRetried,
  prunePreservedWrites,
  upsertPendingTelemetryWrite,
} from "@airchive/db";
import { createLogger } from "@airchive/logger";
import {
  BroadcastPriority,
  isDependencyPendingBroadcastFailure,
  isLocalBackpressureBroadcastFailure,
  isTransientBroadcastFailure,
  type Broadcaster,
} from "./broadcaster.js";
import type { UtxoManager } from "./utxo-manager.js";
import { buildRawOpReturnTx, computeTxid } from "./tx-builder.js";
import { insertTxResult } from "@airchive/db";
import {
  pendingWritesGauge,
  recordTypeMetricLabel,
  writerWriteIngressTotal,
  writerWriteOutcomesTotal,
} from "./metrics.js";
import type { AutoRefillMonitor } from "./auto-refill.js";

const log = createLogger({ service: "blockchain-writer:write-buffer" });

const RETRY_INTERVAL_MS = 2_500;
/**
 * How much of an outage backlog is kept. Beyond this the oldest deferred
 * telemetry is dropped: at the measured write rate a dry treasury accrues
 * around a million rows a day, and an unattended outage must not be able to
 * fill the disk.
 */
const PRESERVED_RETENTION_MS = 24 * 60 * 60 * 1_000;
const PRUNE_INTERVAL_MS = 5 * 60_000;
const RETRY_BATCH_SIZE = 100;
const RETRY_MAX_PARALLEL_AIRCRAFT = 12;
const RETRY_CONCURRENCY_DIVISOR = 4;
const TRANSIENT_BROADCAST_COOLDOWN_MS = 3_000;

type PendingWrite = Awaited<ReturnType<typeof getPendingWrites>>[number];

type RetryWriteOutcome =
  | { type: "succeeded"; icao: string; blockReason?: string }
  | { type: "deferred"; icao: string; requestRefill: boolean; blockReason?: string }
  | { type: "failed"; icao: string };

interface RetryGroupOutcome {
  successCount: number;
  deferredCount: number;
  failedByIcao: Map<string, number>;
  deferredByIcao: Map<string, number>;
  refillRequested: Set<string>;
}

function isUtxoUnavailableWriteDeferral(message: string): boolean {
  return message.includes("No available UTXOs")
    || message.includes("UTXO spend cooling down")
    || message.includes("UTXO ready reserve protected")
    // A stale pool is a funding problem, not a bad payload. Treating it as a
    // retry would burn the retry budget and hand the write to the purge.
    || message.includes("pool is stale");
}

function isTransientWriteDeferral(message: string): boolean {
  return message.includes("Broadcast dependency pending")
    || message.includes("Broadcast local backpressure")
    || message.includes("Broadcast transient failure")
    || isUtxoUnavailableWriteDeferral(message);
}

function classifyRetryDeferralOutcome(message: string): string {
  return isUtxoUnavailableWriteDeferral(message)
    ? "deferred_utxo_unavailable"
    : "deferred_backpressure";
}

function formatRetryBackoffReason(remainingMs: number): string {
  return `Retry propagation backoff active (${remainingMs}ms remaining)`;
}

export class WriteBuffer {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private pruneIntervalId: ReturnType<typeof setInterval> | null = null;
  private retrying = false;
  private redisPublisher: Redis | null = null;
  private autoRefill: AutoRefillMonitor | null = null;
  private drainBatchSize: number | null = null;
  private fundingDryGate: (() => boolean) | null = null;
  /** When true, the 24h preserved-row prune is paused (e.g. during RECOVERING). */
  private prunePauseGate: (() => boolean) | null = null;

  constructor(
    private readonly db: Knex,
    private readonly broadcaster: Broadcaster,
    private readonly utxoManager: UtxoManager,
    private readonly vault: WalletVault,
  ) {}

  setAutoRefill(refill: AutoRefillMonitor): void {
    this.autoRefill = refill;
  }

  /**
   * Caps how many writes a single retry cycle attempts. Recovery from a funding
   * outage uses this so a backlog accumulated over hours is released steadily
   * rather than all at once.
   */
  setDrainBatchSize(size: number | null): void {
    this.drainBatchSize = size === null ? null : Math.max(1, Math.floor(size));
  }

  /**
   * While the treasury is dry every retry is certain to fail on UTXO
   * acquisition, so the loop pauses entirely instead of burning the retry
   * budget and ageing the backlog towards the purge.
   */
  setFundingDryGate(gate: () => boolean): void {
    this.fundingDryGate = gate;
  }

  /**
   * Pauses ageing-out of preserved backlog while recovery is draining it.
   * Without this, a long RECOVERING window can drop 24h-old outage samples
   * that have not yet been broadcast.
   */
  setPrunePauseGate(gate: () => boolean): void {
    this.prunePauseGate = gate;
  }

  setRedisPublisher(redis: Redis): void {
    this.redisPublisher = redis;
  }

  /** Lets callers bump the pending-write gauge after an external insert. */
  async noteExternalEnqueue(): Promise<void> {
    pendingWritesGauge.inc();
  }

  /**
   * Deferred telemetry is normally collapsed to the latest sample per aircraft,
   * because a write held back by a momentary broadcaster blip really is
   * superseded a second later.
   *
   * A dry treasury is a different situation entirely: the outage lasts until
   * somebody sends coins, and collapsing there quietly destroyed the archive it
   * claimed to be protecting — every arriving sample deleted the one being
   * held. While funding is dry the whole stream is preserved instead, drained
   * in order once the treasury recovers and aged out on a retention window so
   * it cannot grow without bound.
   */
  async buffer(
    icao: string,
    recordType: RecordType,
    payload: Uint8Array,
    flightId?: string,
  ): Promise<void> {
    const preserveStream = this.fundingDryGate?.() === true;

    if (recordType === RecordTypeEnum.TELEMETRY && !preserveStream) {
      const result = await upsertPendingTelemetryWrite(this.db, {
        aircraft_icao: icao,
        record_type: recordType,
        payload: Buffer.from(payload),
        flight_id: flightId,
      });
      if (result === "inserted") {
        pendingWritesGauge.inc();
      }
      log.debug({ icao, recordType, mode: result }, "Telemetry write buffered for retry");
      return;
    }

    await insertPendingWrite(this.db, {
      aircraft_icao: icao,
      record_type: recordType,
      payload: Buffer.from(payload),
      flight_id: flightId,
      preserved: preserveStream,
    });

    pendingWritesGauge.inc();
    log.debug({ icao, recordType, preserved: preserveStream }, "Write buffered for retry");
  }

  /**
   * Drops outage backlog older than the retention window. Runs on a timer
   * rather than at insert time so the cost does not land on the write path
   * during the outage itself.
   */
  async prunePreservedBacklog(): Promise<number> {
    if (this.prunePauseGate?.() === true) {
      log.debug("Skipping preserved backlog prune — funding recovery in progress");
      return 0;
    }

    const cutoff = new Date(Date.now() - PRESERVED_RETENTION_MS);
    const removed = await prunePreservedWrites(this.db, cutoff);
    if (removed > 0) {
      await this.syncPendingGauge();
      log.warn(
        { removed, retentionHours: PRESERVED_RETENTION_MS / 3_600_000 },
        "Dropped preserved writes beyond the retention window — "
          + "these telemetry samples will not reach the chain",
      );
    }
    return removed;
  }

  startRetryLoop(): void {
    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      void this.retry();
    }, RETRY_INTERVAL_MS);

    this.pruneIntervalId = setInterval(() => {
      void this.prunePreservedBacklog().catch((err) =>
        log.error({ err }, "Preserved backlog prune failed"),
      );
    }, PRUNE_INTERVAL_MS);
    this.pruneIntervalId.unref?.();

    void this.syncPendingGauge().catch((err) =>
      log.warn({ err }, "Pending write gauge sync failed"),
    );
    log.info({ intervalMs: RETRY_INTERVAL_MS }, "Write-buffer retry loop started");
  }

  async coalesceTelemetryBacklog(): Promise<number> {
    const removed = await coalescePendingTelemetryWrites(this.db);
    if (removed > 0) {
      await this.syncPendingGauge();
      log.info({ removed }, "Coalesced superseded telemetry writes from retry backlog");
    }
    return removed;
  }

  stopRetryLoop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.pruneIntervalId) {
      clearInterval(this.pruneIntervalId);
      this.pruneIntervalId = null;
    }
  }

  async retry(): Promise<number> {
    if (this.retrying) return 0;
    this.retrying = true;
    let successCount = 0;

    try {
      const broadcasterState = this.broadcaster.getState();
      if (this.broadcaster.isDegraded()) {
        log.debug(
          {
            inFlight: broadcasterState.inFlight,
            queueDepth: broadcasterState.queueDepth,
            circuitOpen: broadcasterState.circuitOpen,
            breakerRemainingMs: broadcasterState.circuitOpenRemainingMs,
          },
          "Skipping retry cycle — broadcaster currently degraded",
        );
        return 0;
      }

      // While the treasury cannot fund a refill, every retry is guaranteed to
      // fail on UTXO acquisition. Churning through them only burns broadcaster
      // capacity and buries the real cause in deferral noise.
      if (this.autoRefill?.isTreasuryBlocked()) {
        log.debug("Skipping retry cycle — treasury backing off, writes cannot be funded");
        return 0;
      }

      // The drain during recovery calls retry() directly, so the gate is only
      // consulted for the scheduled loop.
      if (this.drainBatchSize === null && this.fundingDryGate?.()) {
        log.debug("Skipping retry cycle — treasury dry, backlog held until refunded");
        return 0;
      }

      const batchSize = this.drainBatchSize ?? RETRY_BATCH_SIZE;
      const pending = await getPendingWrites(this.db, batchSize);
      if (pending.length === 0) return 0;

      const pendingByAircraft = this.groupPendingWritesByAircraft(pending);
      const retryParallelism = this.getRetryParallelism(pendingByAircraft.length);
      const failedByIcao = new Map<string, number>();
      const deferredByIcao = new Map<string, number>();
      const noUtxoIcaos = new Set<string>();
      let deferredCount = 0;

      let groupIndex = 0;
      await Promise.all(
        Array.from({ length: retryParallelism }, async () => {
          while (true) {
            const currentIndex = groupIndex++;
            const writes = pendingByAircraft[currentIndex];
            if (!writes) return;

            const outcome = await this.retryAircraftWrites(writes);
            successCount += outcome.successCount;
            deferredCount += outcome.deferredCount;
            this.mergeCountMaps(failedByIcao, outcome.failedByIcao);
            this.mergeCountMaps(deferredByIcao, outcome.deferredByIcao);
            for (const icao of outcome.refillRequested) noUtxoIcaos.add(icao);
          }
        }),
      );

      if (successCount > 0 || failedByIcao.size > 0 || deferredByIcao.size > 0) {
        const failSummary: Record<string, number> = {};
        for (const [icao, count] of failedByIcao) failSummary[icao] = count;
        const deferredSummary: Record<string, number> = {};
        for (const [icao, count] of deferredByIcao) deferredSummary[icao] = count;

        log.info(
          {
            attempted: pending.length,
            aircraftGroups: pendingByAircraft.length,
            parallelAircraft: retryParallelism,
            succeeded: successCount,
            deferred: deferredCount,
            failed: pending.length - successCount - deferredCount,
            ...(failedByIcao.size > 0 ? { failedByAircraft: failSummary } : {}),
            ...(deferredByIcao.size > 0 ? { deferredByAircraft: deferredSummary } : {}),
            ...(noUtxoIcaos.size > 0 ? { refillRequested: Array.from(noUtxoIcaos) } : {}),
          },
          "Write-buffer retry cycle complete",
        );
      }
    } catch (err) {
      log.error({ err }, "Write-buffer retry cycle error");
    } finally {
      this.retrying = false;
    }

    return successCount;
  }

  private getRetryParallelism(groupCount: number): number {
    const limits = this.broadcaster.getLimits();
    const byArcCapacity = Math.max(
      1,
      Math.floor(limits.maxConcurrentBroadcasts / RETRY_CONCURRENCY_DIVISOR),
    );
    return Math.max(
      1,
      Math.min(groupCount, RETRY_MAX_PARALLEL_AIRCRAFT, byArcCapacity),
    );
  }

  private groupPendingWritesByAircraft(pending: PendingWrite[]): PendingWrite[][] {
    const grouped = new Map<string, PendingWrite[]>();
    for (const write of pending) {
      const existing = grouped.get(write.aircraft_icao);
      if (existing) existing.push(write);
      else grouped.set(write.aircraft_icao, [write]);
    }
    return Array.from(grouped.values());
  }

  private mergeCountMaps(target: Map<string, number>, source: Map<string, number>): void {
    for (const [key, value] of source) {
      target.set(key, (target.get(key) ?? 0) + value);
    }
  }

  private async retryAircraftWrites(
    writes: PendingWrite[],
  ): Promise<RetryGroupOutcome> {
    const failedByIcao = new Map<string, number>();
    const deferredByIcao = new Map<string, number>();
    const refillRequested = new Set<string>();
    let successCount = 0;
    let deferredCount = 0;
    let blockedReason: string | null = null;
    const icao = writes[0]?.aircraft_icao;

    if (!icao) {
      return {
        successCount,
        deferredCount,
        failedByIcao,
        deferredByIcao,
        refillRequested,
      };
    }

    const retryBackoffRemainingMs = this.autoRefill?.getRetryBackoffRemainingMs(icao) ?? 0;
    if (retryBackoffRemainingMs > 0) {
      log.debug(
        { icao, remainingMs: retryBackoffRemainingMs },
        formatRetryBackoffReason(retryBackoffRemainingMs),
      );
      deferredByIcao.set(icao, writes.length);
      return {
        successCount,
        deferredCount: writes.length,
        failedByIcao,
        deferredByIcao,
        refillRequested,
      };
    }

    for (const write of writes) {
      if (blockedReason) {
        await markWriteDeferred(this.db, write.id, blockedReason).catch(() => {});
        deferredByIcao.set(icao, (deferredByIcao.get(icao) ?? 0) + 1);
        deferredCount++;
        continue;
      }

      const outcome = await this.retryPendingWrite(write);
      if (outcome.type === "succeeded") {
        successCount++;
        if (outcome.blockReason) {
          blockedReason = outcome.blockReason;
        }
        continue;
      }

      if (outcome.type === "deferred") {
        deferredByIcao.set(icao, (deferredByIcao.get(icao) ?? 0) + 1);
        deferredCount++;
        if (outcome.blockReason) {
          blockedReason = outcome.blockReason;
        }
        if (outcome.requestRefill) {
          refillRequested.add(icao);
        }
        continue;
      }

      failedByIcao.set(icao, (failedByIcao.get(icao) ?? 0) + 1);
    }

    return {
      successCount,
      deferredCount,
      failedByIcao,
      deferredByIcao,
      refillRequested,
    };
  }

  private async retryPendingWrite(
    write: PendingWrite,
  ): Promise<RetryWriteOutcome> {
    const icao = write.aircraft_icao;
    const recordTypeLabel = recordTypeMetricLabel(write.record_type);
    writerWriteIngressTotal.inc({ path: "retry", record_type: recordTypeLabel });
    let utxoAcquired = false;
    let utxoTxid = "";
    let utxoVout = 0;
    let broadcastAttempted = false;

    try {
      const privateKey = this.vault.getAircraftPrivateKey(icao);
      const walletAddress = this.vault.getAircraftAddress(icao);
      const retryReadyReserve = this.autoRefill?.getRetryReadyReserve(icao) ?? 0;
      const utxo = await this.utxoManager.acquireUtxo(icao, retryReadyReserve);
      utxoAcquired = true;
      utxoTxid = utxo.txid;
      utxoVout = utxo.vout;

      const payload =
        write.payload instanceof Buffer
          ? new Uint8Array(write.payload)
          : write.payload;

      const { tx, changeOutput, opReturn } = await buildRawOpReturnTx({
        utxo,
        privateKey,
        icao,
        timestamp: Date.now(),
        recordType: write.record_type,
        payload,
      });

      const retryPriority =
        write.record_type === RecordTypeEnum.FLIGHT_EVENT
          ? BroadcastPriority.RETRY_EVENT
          : BroadcastPriority.RETRY_TELEMETRY;
      broadcastAttempted = true;
      const result = await this.broadcaster.broadcast(tx, icao, {
        kind: "retry",
        priority: retryPriority,
      });

      if (result.status === "FAILED") {
        // Only meaningful without an upstream SEEN_ON_NETWORK gate; with one,
        // an orphan result is a real failure and must not be recorded as a send.
        if (
          isDependencyPendingBroadcastFailure(result)
          && !this.broadcaster.hasSeenOnNetworkGate
        ) {
          const localTxid = computeTxid(tx);
          const poolState = await this.utxoManager.recordSpend(
            utxo.txid, utxo.vout,
            localTxid, 1,
            changeOutput.satoshis, changeOutput.lockingScript, icao,
          );
          const blockReason = `Broadcast dependency pending: ${result.code ?? result.description ?? "unknown"}`;
          this.autoRefill?.noteRetryPressure(icao, blockReason);
          this.autoRefill?.requestRefillIfPoolLow(icao, poolState);
          utxoAcquired = false;
          const orphanRow = {
            txid: localTxid,
            aircraft_icao: icao,
            record_type: write.record_type,
            status: "SEEN_ON_NETWORK" as const,
            timestamp: Date.now(),
            fee_sats: Number(utxo.satoshis) - changeOutput.satoshis,
            size_bytes: tx.toBinary().length,
            flight_id: write.flight_id ?? undefined,
          };
          await insertTxResult(this.db, { ...orphanRow, op_return: opReturn });
          await this.redisPublisher?.publish("txresult", JSON.stringify(orphanRow)).catch(() => {});
          log.info({ icao, txid: localTxid, code: result.code }, "Retry orphan-mempool recorded optimistically");
          await deletePendingWrite(this.db, write.id);
          pendingWritesGauge.dec();
          writerWriteOutcomesTotal.inc({
            path: "retry",
            record_type: recordTypeLabel,
            outcome: "optimistic_orphan",
          });
          return { type: "succeeded", icao, blockReason };
        }
        if (isLocalBackpressureBroadcastFailure(result)) {
          throw new Error(`Broadcast local backpressure: ${result.code ?? "unknown"}`);
        }
        if (isTransientBroadcastFailure(result)) {
          this.utxoManager.delaySpendRetries(
            icao,
            utxo.txid,
            utxo.vout,
            TRANSIENT_BROADCAST_COOLDOWN_MS,
            result.code ?? result.description ?? "transient upstream failure",
          );
          void this.utxoManager.reconcile(icao, walletAddress).catch((err) =>
            log.warn({ err, icao }, "Aircraft UTXO reconcile failed after transient broadcast error"),
          );
          throw new Error(`Broadcast transient failure: ${result.code ?? "unknown"}`);
        }
        await this.utxoManager.deleteStaleUtxo(utxo.txid, utxo.vout).catch(() => {});
        utxoAcquired = false;
        throw new Error(`Broadcast returned FAILED status: ${result.code ?? "unknown"}`);
      }

      const txid = result.txid;

      const poolState = await this.utxoManager.recordSpend(
        utxo.txid,
        utxo.vout,
        txid,
        1,
        changeOutput.satoshis,
        changeOutput.lockingScript,
        icao,
      );
      this.autoRefill?.requestRefillIfPoolLow(icao, poolState);

      const retryResultRow = {
        txid,
        aircraft_icao: icao,
        record_type: write.record_type,
        status: "SEEN_ON_NETWORK" as const,
        timestamp: Date.now(),
        fee_sats: Number(utxo.satoshis) - changeOutput.satoshis,
        size_bytes: tx.toBinary().length,
        flight_id: write.flight_id ?? undefined,
      };
      await insertTxResult(this.db, { ...retryResultRow, op_return: opReturn });
      await this.redisPublisher?.publish("txresult", JSON.stringify(retryResultRow)).catch(() => {});

      await deletePendingWrite(this.db, write.id);
      pendingWritesGauge.dec();
      writerWriteOutcomesTotal.inc({
        path: "retry",
        record_type: recordTypeLabel,
        outcome: "broadcasted",
      });
      return { type: "succeeded", icao };
    } catch (err) {
      // Only an input the network was never offered may go straight back into
      // the pool. Once it has been broadcast, unlocking it risks a second
      // transaction spending it, and the resulting conflict silently kills the
      // aircraft's whole chain — so leave it locked and let the chain decide.
      if (utxoAcquired && !broadcastAttempted) {
        await this.utxoManager
          .releaseUtxo(utxoTxid, utxoVout)
          .catch(() => {});
      } else if (utxoAcquired) {
        void this.utxoManager
          .reconcile(icao, this.vault.getAircraftAddress(icao))
          .catch(() => {});
      }

      const msg = (err as Error).message ?? "";
      const requestRefill = isUtxoUnavailableWriteDeferral(msg);
      if (requestRefill) {
        this.autoRefill?.noteRetryPressure(icao, msg);
      }
      if (requestRefill) {
        this.autoRefill?.requestRefill(icao);
      }

      if (isTransientWriteDeferral(msg)) {
        await markWriteDeferred(this.db, write.id, msg).catch(() => {});
        writerWriteOutcomesTotal.inc({
          path: "retry",
          record_type: recordTypeLabel,
          outcome: classifyRetryDeferralOutcome(msg),
        });
        return {
          type: "deferred",
          icao,
          requestRefill,
          blockReason: requestRefill ? msg : undefined,
        };
      }

      await markWriteRetried(this.db, write.id, msg).catch(() => {});
      writerWriteOutcomesTotal.inc({
        path: "retry",
        record_type: recordTypeLabel,
        outcome: "failed",
      });
      return { type: "failed", icao };
    }
  }

  private async syncPendingGauge(): Promise<void> {
    const count = await getPendingWriteCount(this.db);
    pendingWritesGauge.set(count);
  }
}
