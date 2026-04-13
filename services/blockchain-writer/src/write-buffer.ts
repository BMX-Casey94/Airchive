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
  upsertPendingTelemetryWrite,
} from "@airchive/db";
import { createLogger } from "@airchive/logger";
import {
  BroadcastPriority,
  isDependencyPendingBroadcastFailure,
  isLocalBackpressureBroadcastFailure,
  isTransientBroadcastFailure,
  type ArcBroadcaster,
} from "./broadcaster.js";
import type { UtxoManager } from "./utxo-manager.js";
import { buildRawOpReturnTx } from "./tx-builder.js";
import { insertTxResult } from "@airchive/db";
import { pendingWritesGauge } from "./metrics.js";
import type { AutoRefillMonitor } from "./auto-refill.js";

const log = createLogger({ service: "blockchain-writer:write-buffer" });

const RETRY_INTERVAL_MS = 5_000;
const RETRY_BATCH_SIZE = 100;
const TRANSIENT_BROADCAST_COOLDOWN_MS = 45_000;

function isTransientWriteDeferral(message: string): boolean {
  return message.includes("Broadcast dependency pending")
    || message.includes("Broadcast local backpressure")
    || message.includes("Broadcast transient failure")
    || message.includes("UTXO spend cooling down")
    || message.includes("No available UTXOs");
}

export class WriteBuffer {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private retrying = false;
  private redisPublisher: Redis | null = null;
  private autoRefill: AutoRefillMonitor | null = null;

  constructor(
    private readonly db: Knex,
    private readonly broadcaster: ArcBroadcaster,
    private readonly utxoManager: UtxoManager,
    private readonly vault: WalletVault,
  ) {}

  setAutoRefill(refill: AutoRefillMonitor): void {
    this.autoRefill = refill;
  }

  setRedisPublisher(redis: Redis): void {
    this.redisPublisher = redis;
  }

  async buffer(
    icao: string,
    recordType: RecordType,
    payload: Uint8Array,
    flightId?: string,
  ): Promise<void> {
    if (recordType === RecordTypeEnum.TELEMETRY) {
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
    });

    pendingWritesGauge.inc();
    log.debug({ icao, recordType }, "Write buffered for retry");
  }

  startRetryLoop(): void {
    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      void this.retry();
    }, RETRY_INTERVAL_MS);

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

      const pending = await getPendingWrites(this.db, RETRY_BATCH_SIZE);
      if (pending.length === 0) return 0;

      const failedByIcao = new Map<string, number>();
      const deferredByIcao = new Map<string, number>();
      const noUtxoIcaos = new Set<string>();
      let deferredCount = 0;

      for (const write of pending) {
        const icao = write.aircraft_icao;
        let utxoAcquired = false;
        let utxoTxid = "";
        let utxoVout = 0;

        if (noUtxoIcaos.has(icao)) {
          await markWriteDeferred(this.db, write.id, "No available UTXOs").catch(() => {});
          deferredByIcao.set(icao, (deferredByIcao.get(icao) ?? 0) + 1);
          deferredCount++;
          continue;
        }

        try {
          const privateKey = this.vault.getAircraftPrivateKey(icao);
          const walletAddress = this.vault.getAircraftAddress(icao);
          const utxo = await this.utxoManager.acquireUtxo(icao);
          utxoAcquired = true;
          utxoTxid = utxo.txid;
          utxoVout = utxo.vout;

          const payload =
            write.payload instanceof Buffer
              ? new Uint8Array(write.payload)
              : write.payload;

          const { tx, changeOutput } = await buildRawOpReturnTx({
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
          const result = await this.broadcaster.broadcast(tx, icao, {
            kind: "retry",
            priority: retryPriority,
          });

          if (result.status === "FAILED") {
            if (isDependencyPendingBroadcastFailure(result)) {
              this.utxoManager.delaySpendRetries(
                icao,
                utxo.txid,
                utxo.vout,
                undefined,
                result.code,
              );
              throw new Error(`Broadcast dependency pending: ${result.code ?? "unknown"}`);
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

          await this.utxoManager.recordSpend(
            utxo.txid,
            utxo.vout,
            txid,
            1,
            changeOutput.satoshis,
            changeOutput.lockingScript,
            icao,
          );

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
          await insertTxResult(this.db, retryResultRow);
          await this.redisPublisher?.publish("txresult", JSON.stringify(retryResultRow)).catch(() => {});

          await deletePendingWrite(this.db, write.id);
          pendingWritesGauge.dec();
          successCount++;
        } catch (err) {
          if (utxoAcquired) {
            await this.utxoManager
              .releaseUtxo(utxoTxid, utxoVout)
              .catch(() => {});
          }

          const msg = (err as Error).message ?? "";
          if (
            msg.includes("No available UTXOs")
            || msg.includes("UTXO spend cooling down")
          ) {
            noUtxoIcaos.add(icao);
            this.autoRefill?.requestRefill(icao);
          }

          if (isTransientWriteDeferral(msg)) {
            await markWriteDeferred(this.db, write.id, msg).catch(() => {});
            deferredByIcao.set(icao, (deferredByIcao.get(icao) ?? 0) + 1);
            deferredCount++;
          } else {
            await markWriteRetried(this.db, write.id, msg).catch(() => {});
            failedByIcao.set(icao, (failedByIcao.get(icao) ?? 0) + 1);
          }
        }
      }

      if (successCount > 0 || failedByIcao.size > 0 || deferredByIcao.size > 0) {
        const failSummary: Record<string, number> = {};
        for (const [icao, count] of failedByIcao) failSummary[icao] = count;
        const deferredSummary: Record<string, number> = {};
        for (const [icao, count] of deferredByIcao) deferredSummary[icao] = count;

        log.info(
          {
            attempted: pending.length,
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

  private async syncPendingGauge(): Promise<void> {
    const count = await getPendingWriteCount(this.db);
    pendingWritesGauge.set(count);
  }
}
