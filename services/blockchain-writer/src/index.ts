import { createServer as createHttpServer } from "node:http";
import type { Knex } from "knex";
import { Redis } from "ioredis";
import {
  RecordType,
  type FlightEventRecord,
  type TelemetryRecord,
} from "@airchive/types";
import { WalletVault } from "@airchive/crypto";
import {
  encodeTelemetryPayload,
  encodeFlightEventPayload,
  FLEET_PSEUDO_ICAO,
} from "@airchive/telemetry-codec";
import {
  closeDb,
  getAllAircraftConfig,
  getDb,
  getFundingState,
  insertTxResult,
  markTxRejected,
  TREASURY_SCOPE,
  unlockAllAircraftUtxos,
  upsertAircraftConfig,
} from "@airchive/db";
import { createLogger } from "@airchive/logger";
import { loadConfig } from "./config.js";
import {
  ArcBroadcaster,
  BroadcastPriority,
  isDependencyPendingBroadcastFailure,
  isLocalBackpressureBroadcastFailure,
  isTransientBroadcastFailure,
  type ArcCallbackPayload,
  type BroadcastOutcome,
  type Broadcaster,
  type TerminalRejectionContext,
} from "./broadcaster.js";
import { ArcadeBroadcaster, isTerminalArcadeFailure } from "./arcade-broadcaster.js";
import { extractArcadeRejectDiagnosis } from "./arcade-reject-diagnosis.js";
import { ArcadeSseClient } from "./arcade-sse.js";
import {
  ChainDepthExhaustedError,
  StalePoolError,
  UtxoManager,
} from "./utxo-manager.js";
import { FundingUtxoManager } from "./funding-utxo-manager.js";
import { AutoRefillMonitor, treasuryOutputFloorSats } from "./auto-refill.js";
import { AgentWalletRefiller, resolveAgentTargets } from "./agent-refill.js";
import { WriteBuffer } from "./write-buffer.js";
import { ConfirmationPoller } from "./confirmation-poller.js";
import { FundingStateMachine } from "./funding-state.js";
import { HeaderStore } from "./header-store.js";
import { buildChainLookup } from "./chain-lookup.js";
import { recordUnverifiedProof, recordVerifiedProof, verifyBump } from "./spv.js";
import { buildFlightEventTx, buildTelemetryTx, computeTxid } from "./tx-builder.js";
import { BoundedTaskQueue } from "./task-queue.js";
import { rebufferRejectedTransaction } from "./rebuffer-rejected.js";
import {
  recordTypeMetricLabel,
  registry,
  rejectRequeuesTotal,
  spendBlockedTotal,
  statusEventsShedTotal,
  statusQueueDepth,
  writerWriteIngressTotal,
  writerWriteOutcomesTotal,
} from "./metrics.js";
import { SpendGovernor } from "./spend-governor.js";

const log = createLogger({ service: "blockchain-writer" });

const CONSOLIDATION_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const METRICS_PORT = Number(process.env.METRICS_PORT ?? "9091");
const TRANSIENT_BROADCAST_COOLDOWN_MS = 3_000;
const PENDING_WRITE_MAX_RETRIES = 10;
const LOCK_RECLAIM_INTERVAL_MS = 60_000;
/**
 * Blocks arrive roughly every ten minutes, so a minute is ample to hand settled
 * outputs back to the write path promptly without polling the database hard.
 */
const CHAIN_DEPTH_SETTLE_INTERVAL_MS = 60_000;
/**
 * Status events are cheap individually and ruinous in aggregate. The pool is
 * sized around the database connection pool the work ends up queueing behind;
 * raising it only moves the contention rather than relieving it.
 */
const STATUS_QUEUE_CONCURRENCY = 8;
const STATUS_QUEUE_MAX_DEPTH = 5_000;
/** Blocks arrive roughly every ten minutes, so this stays comfortably ahead. */
const HEADER_SYNC_INTERVAL_MS = 120_000;
/** Published by ingestion on every telemetry tick the dashboard renders. */
const AIRCRAFT_ACTIVITY_CHANNEL = "aircraft-activity";

/**
 * Distinguishes "this write could not be funded" from "this write is bad".
 * Only the latter may ever be discarded.
 */
function isFundingRelatedError(lastError: string | null): boolean {
  if (!lastError) return false;
  return lastError.includes("No available UTXOs")
    || lastError.includes("UTXO spend cooling down")
    || lastError.includes("UTXO ready reserve protected")
    || lastError.includes("pool is stale")
    || lastError.includes("TREASURY DRY");
}

/**
 * Telemetry is irreplaceable, so the retry-exhaustion purge must never discard
 * writes that only failed because there was nothing to fund them with. Those
 * rows are preserved and drained once funding returns.
 */
async function purgeUnrecoverablePendingWrites(db: Knex): Promise<void> {
  // A funding outage in progress means every exhausted row is suspect. Nothing
  // is discarded until the treasury is demonstrably healthy again.
  const funding = await getFundingState(db, TREASURY_SCOPE).catch(() => undefined);
  if (funding && funding.state !== "HEALTHY") {
    log.warn(
      { fundingState: funding.state },
      "Skipping pending-write purge — funding is not healthy, backlog preserved in full",
    );
    return;
  }

  const exhausted = await db("pending_writes")
    .where("retry_count", ">=", PENDING_WRITE_MAX_RETRIES)
    .select("id", "last_error") as Array<{ id: number; last_error: string | null }>;

  if (exhausted.length === 0) return;

  const preserved: number[] = [];
  const purgeable: number[] = [];
  for (const row of exhausted) {
    (isFundingRelatedError(row.last_error) ? preserved : purgeable).push(row.id);
  }

  if (preserved.length > 0) {
    // Reset the counter so a long funding outage cannot creep these rows back
    // towards the purge threshold on every restart.
    await db("pending_writes").whereIn("id", preserved).update({ retry_count: 0 });
    log.warn(
      { preserved: preserved.length },
      "Preserved pending writes that exhausted retries solely due to funding starvation",
    );
  }

  if (purgeable.length > 0) {
    await db("pending_writes").whereIn("id", purgeable).delete();
    log.info(
      { purged: purgeable.length, maxRetries: PENDING_WRITE_MAX_RETRIES },
      "Purged pending writes that failed for non-funding reasons",
    );
  }
}

/**
 * Transient transport faults. The pools and clients underneath all reconnect on
 * their own, so the correct response is to log and carry on rather than to tear
 * down a process that is mid-flight on several hundred aircraft.
 */
const RECOVERABLE_SOCKET_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function isRecoverableSocketError(err: Error): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== undefined && RECOVERABLE_SOCKET_CODES.has(code)) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) return isRecoverableSocketError(cause);
  return false;
}

function shouldRequestRefillForAcquireError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return message.includes("No available UTXOs")
    || message.includes("UTXO spend cooling down");
}

/**
 * A pool holding only locked, dust or phantom rows cannot be fixed by a refill —
 * it needs chain truth. Reconcile instead, otherwise the wallet stays silent
 * indefinitely while refills succeed into a pool nothing can spend from.
 */
function handleAcquireFailure(
  err: unknown,
  icao: string,
  utxoManager: UtxoManager,
  autoRefill: AutoRefillMonitor,
  walletAddress: string,
): void {
  if (err instanceof StalePoolError) {
    log.warn(
      { icao, residualRows: err.residualRows },
      "Aircraft pool stale — reconciling against chain",
    );
    void utxoManager.reconcile(icao, walletAddress).catch((reconcileErr) =>
      log.error({ err: reconcileErr, icao }, "Stale-pool reconciliation failed"),
    );
    autoRefill.requestRefill(icao);
    return;
  }

  // The wallet holds real funds, they are simply too deep in an unconfirmed
  // chain to extend. Reconciling would find nothing new; what unblocks it is a
  // block confirming the lineage, or fresh shallow outputs from a refill.
  if (err instanceof ChainDepthExhaustedError) {
    log.debug(
      { icao, deepRows: err.deepRows, maxDepth: err.maxDepth },
      "Aircraft outputs too deep in an unconfirmed chain — awaiting confirmation or refill",
    );
    autoRefill.requestRefill(icao);
    return;
  }

  if (shouldRequestRefillForAcquireError(err)) {
    autoRefill.requestRefill(icao);
  }
}

function isHandledBackpressureError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return message.includes("Broadcast dependency pending")
    || message.includes("Broadcast local backpressure")
    || message.includes("UTXO spend cooling down")
    || message.includes("Unconfirmed chain depth ceiling reached")
    || message.includes("Broadcast transient failure");
}

/**
 * Decides what to do with an input after a write failed.
 *
 * Releasing it unconditionally is unsafe. "Transient" upstream failures —
 * timeouts, socket resets, 5xx after the node already accepted the bytes — and
 * any error raised *after* the broadcast call leave the writer unable to say
 * whether the network has the transaction. Unlocking the input then lets the
 * next write spend it a second time; one of the two is rejected as a conflict,
 * and because the writer records its change optimistically the whole subsequent
 * chain for that aircraft is invalid. That is precisely how an aircraft goes
 * quiet while still appearing live.
 *
 * So: release only when the transaction was never handed to the broadcaster.
 * Otherwise leave the input locked and let chain truth decide, which the
 * reconcile below does immediately and the lock-TTL sweep repeats as a backstop.
 */
async function settleInputAfterFailedWrite(
  icao: string,
  utxoManager: UtxoManager,
  utxo: { txid: string; vout: number },
  walletAddress: string,
  broadcastAttempted: boolean,
): Promise<void> {
  if (!broadcastAttempted) {
    await utxoManager.releaseUtxo(utxo.txid, utxo.vout).catch(() => {});
    return;
  }

  void utxoManager.reconcile(icao, walletAddress).catch((err) =>
    log.warn(
      { err, icao, txid: utxo.txid.slice(0, 12), vout: utxo.vout },
      "Reconciliation after an inconclusive broadcast failed — input stays locked",
    ),
  );
}

async function handleFailedAircraftBroadcast(
  icao: string,
  utxoManager: UtxoManager,
  utxo: { txid: string; vout: number },
  walletAddress: string,
  result: BroadcastOutcome,
): Promise<Error> {
  if (isDependencyPendingBroadcastFailure(result)) {
    utxoManager.delaySpendRetries(
      icao,
      utxo.txid,
      utxo.vout,
      undefined,
      result.code,
    );
    return new Error(`Broadcast dependency pending: ${result.code ?? "unknown"}`);
  }

  if (isLocalBackpressureBroadcastFailure(result)) {
    return new Error(`Broadcast local backpressure: ${result.code ?? "unknown"}`);
  }

  if (isTransientBroadcastFailure(result)) {
    utxoManager.delaySpendRetries(
      icao,
      utxo.txid,
      utxo.vout,
      TRANSIENT_BROADCAST_COOLDOWN_MS,
      result.code ?? result.description ?? "transient upstream failure",
    );
    void utxoManager.reconcile(icao, walletAddress).catch((err) =>
      log.warn({ err, icao }, "Aircraft UTXO reconcile failed after transient broadcast error"),
    );
    return new Error(`Broadcast transient failure: ${result.code ?? "unknown"}`);
  }

  await utxoManager.deleteStaleUtxo(utxo.txid, utxo.vout).catch(() => {});
  return new Error(`Broadcast returned FAILED status: ${result.code ?? "unknown"}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  log.info("Loading configuration");

  const vault = new WalletVault({ masterSeed: config.walletMasterSeed });

  const db = getDb();

  const allDbAircraft = await getAllAircraftConfig(db);
  const dbAircraft = allDbAircraft.filter((ac) => ac.enabled);
  const envIcaos = new Set(config.trackedAircraft);
  const fleetMap = new Map<string, { icao: string; wallet_index: number }>();
  const existingByIcao = new Map(allDbAircraft.map((ac) => [ac.icao, ac]));

  // Preserve existing wallet indexes so deterministic aircraft wallets never drift between services.
  for (const ac of dbAircraft) {
    fleetMap.set(ac.icao, { icao: ac.icao, wallet_index: ac.wallet_index });
    envIcaos.delete(ac.icao);
  }

  let autoIndex = allDbAircraft.length > 0
    ? Math.max(...allDbAircraft.map((a) => a.wallet_index)) + 1
    : 0;

  for (const icao of envIcaos) {
    const existing = existingByIcao.get(icao);
    if (existing) {
      fleetMap.set(icao, { icao, wallet_index: existing.wallet_index });
      continue;
    }
    if (!fleetMap.has(icao)) {
      fleetMap.set(icao, { icao, wallet_index: autoIndex++ });
    }
  }

  const fleet = Array.from(fleetMap.values());
  if (fleet.length === 0) {
    throw new Error("No aircraft configured. Set TRACKED_AIRCRAFT or populate aircraft_config table.");
  }

  vault.registerFleet(fleet);
  log.info({ aircraft: fleet.map((a) => a.icao) }, "Fleet registered");

  for (const ac of fleet) {
    await upsertAircraftConfig(db, {
      icao: ac.icao,
      callsign: ac.icao,
      reg: "",
      aircraft_type: "",
      wallet_index: ac.wallet_index,
      wallet_address: vault.getAircraftAddress(ac.icao),
      enabled: true,
    });
  }
  log.info({ count: fleet.length }, "aircraft_config rows ensured");

  const arcBroadcaster = new ArcBroadcaster(config.arcEndpoints, {
    maxConcurrentBroadcasts: config.arcMaxConcurrentBroadcasts,
    maxQueueDepth: config.arcMaxQueueDepth,
    transientRetryAttempts: config.arcTransientRetryAttempts,
    transientRetryBaseMs: config.arcTransientRetryBaseMs,
    circuitFailureThreshold: config.arcCircuitFailureThreshold,
    circuitWindowMs: config.arcCircuitWindowMs,
    circuitOpenMs: config.arcCircuitOpenMs,
  });
  log.info(
    { arcEndpoints: config.arcEndpoints.map((endpoint) => endpoint.name) },
    "ARC upstreams configured",
  );

  // Arcade is preferred when configured, with ARC retained as the fallback so
  // an Arcade outage degrades throughput rather than stopping writes.
  let arcadeBroadcaster: ArcadeBroadcaster | null = null;
  let arcadeSse: ArcadeSseClient | null = null;
  if (config.arcade.enabled) {
    arcadeBroadcaster = new ArcadeBroadcaster(
      {
        url: config.arcade.url,
        apiKey: config.arcade.apiKey,
        batchWindowMs: config.arcade.batchWindowMs,
        maxBatchSize: config.arcade.maxBatchSize,
        callbackToken: config.arcade.callbackToken,
      },
      arcBroadcaster,
    );
    await arcadeBroadcaster.checkHealth();
    log.info(
      {
        endpoint: config.arcade.url,
        batchWindowMs: config.arcade.batchWindowMs,
        maxBatchSize: config.arcade.maxBatchSize,
        sse: config.arcade.sseEnabled,
      },
      "Arcade broadcaster enabled (ARC retained as fallback)",
    );
  } else {
    log.warn("ARCADE_URL not set — broadcasting via ARC only");
  }

  const broadcaster: Broadcaster = arcadeBroadcaster ?? arcBroadcaster;

  // Independent providers share the work so a WhatsOnChain 429 no longer
  // freezes confirmations and wallet reconciliation at the same time.
  // BananaBlocks covers status/proofs/headers; Bitails prefers UTXO lookups.
  const woc = buildChainLookup({
    woc: {
      baseUrl: config.wocApiUrl,
      apiKey: config.wocApiKey,
      maxRequestsPerSecond: config.wocMaxRequestsPerSecond,
    },
    bananaBlocks: {
      enabled: config.bananaBlocksEnabled,
      baseUrl: config.bananaBlocksUrl,
      maxRequestsPerSecond: config.bananaBlocksMaxRequestsPerSecond,
    },
    bitails: {
      enabled: config.bitailsEnabled,
      baseUrl: config.bitailsUrl,
      apiKey: config.bitailsApiKey,
      maxRequestsPerSecond: config.bitailsMaxRequestsPerSecond,
    },
  });

  // Decides whether spending is safe at all. Every path that can move coin —
  // live writes, the retry loop, reject requeues, refills and agent top-ups —
  // consults it, so a network that is refusing transactions costs one burst of
  // fees rather than an unattended day of them.
  const spendGovernor = new SpendGovernor(config.spendGuard);

  const utxoManager = new UtxoManager(db, woc);
  utxoManager.setMaxUnconfirmedChainDepth(() =>
    spendGovernor.maxUnconfirmedChainDepth(),
  );
  const fundingUtxoManager = new FundingUtxoManager(db, woc);
  const writeBuffer = new WriteBuffer(db, broadcaster, utxoManager, vault);
  const autoRefill = new AutoRefillMonitor(
    config,
    broadcaster,
    utxoManager,
    vault,
    fleet,
    fundingUtxoManager,
    config.refillIdleWindowMs,
  );
  writeBuffer.setAutoRefill(autoRefill);
  writeBuffer.setSpendGovernor(spendGovernor);
  autoRefill.setSpendGate(() => spendGovernor.allowsTreasurySpend());
  let confirmationPoller: ConfirmationPoller | null = null;

  const headerStore = new HeaderStore(db, woc);
  const initialHeaders = await headerStore.syncTip();
  log.info(
    { synced: initialHeaders, tip: await headerStore.currentHeight() },
    "Block header store initialised",
  );
  const headerSyncInterval = setInterval(() => {
    void headerStore.syncTip().catch((err) => log.warn({ err }, "Header sync failed"));
  }, HEADER_SYNC_INTERVAL_MS);

  /* ── Startup: unlock stale locks from previous unclean shutdown ── */
  const unlockedAircraft = await unlockAllAircraftUtxos(db);
  if (unlockedAircraft > 0) {
    log.info({ unlocked: unlockedAircraft }, "Unlocked stale aircraft UTXOs from previous run");
  }
  await fundingUtxoManager.unlockAll();

  /* ── Bootstrap aircraft UTXO pools ── */
  log.info("Bootstrapping UTXO pools");
  for (const aircraft of fleet) {
    try {
      const address = vault.getAircraftAddress(aircraft.icao);
      const touchedChain = await utxoManager.bootstrap(aircraft.icao, address);
      if (touchedChain) {
        await new Promise((r) => setTimeout(r, 350));
      }
    } catch (err) {
      log.error({ err, icao: aircraft.icao }, "UTXO bootstrap failed");
    }
  }

  await utxoManager.purgeSubThresholdUtxos();
  // Confirmations that landed while the writer was down still count.
  await utxoManager.settleConfirmedChainDepths().catch((err) =>
    log.error({ err }, "Initial chain-depth settlement failed"),
  );

  const chroniclePurged = await db("utxo_pool")
    .where("is_chronicle", true)
    .delete();
  if (chroniclePurged > 0) {
    log.warn({ purged: chroniclePurged }, "Purged UTXOs with custom Chronicle locking scripts (unspendable with standard P2PKH)");
  }

  await purgeUnrecoverablePendingWrites(db);
  await writeBuffer.coalesceTelemetryBacklog().catch((err) =>
    log.error({ err }, "Telemetry backlog coalescing failed"),
  );
  // A restart following a long outage should trim the backlog immediately
  // rather than waiting for the first scheduled prune.
  await writeBuffer.prunePreservedBacklog().catch((err) =>
    log.error({ err }, "Preserved backlog prune failed"),
  );

  /* ── Bootstrap funding/treasury UTXO pool ── */
  log.info("Bootstrapping funding UTXO pool");
  await fundingUtxoManager.bootstrap(config.fundingWalletWif).catch((err) =>
    log.error({ err }, "Funding UTXO bootstrap failed"),
  );

  /* ── Reshape the treasury for refill concurrency ── */
  const treasuryFloorSats = treasuryOutputFloorSats(
    config.refillAmountSats,
    config.refillMaxOutputsPerTx,
  );

  // Consolidate before splitting: an already-fragmented treasury has no output
  // big enough to split, so splitting first would be a no-op and the pool would
  // stay stuck below the refill floor.
  await fundingUtxoManager
    .consolidateIfFragmented(config.fundingWalletWif, broadcaster, treasuryFloorSats)
    .catch((err) => log.error({ err }, "Funding pool consolidation failed"));

  await fundingUtxoManager
    .splitIfNeeded(
      config.fundingWalletWif,
      broadcaster,
      config.fundingPoolSplitTarget,
      treasuryFloorSats,
    )
    .catch((err) => log.error({ err }, "Funding pool split failed"));

  const statusUpdateQueue = new BoundedTaskQueue({
    name: "status-update",
    concurrency: STATUS_QUEUE_CONCURRENCY,
    maxDepth: STATUS_QUEUE_MAX_DEPTH,
    onOverflow: () => statusEventsShedTotal.inc(),
  });

  broadcaster.on("status-update", (payload: ArcCallbackPayload) => {
    handleStatusUpdate(payload);
  });

  /**
   * Undoes the local bookkeeping for a transaction the network refused.
   *
   * The writer records a spend and its change the moment a broadcast is
   * accepted for delivery, which is what keeps the per-aircraft chain moving at
   * 1 Hz. When the network later rejects that transaction, the local pool is
   * left holding an output that does not exist. Purging it and reconciling the
   * owning wallet against the chain is what stops a single rejection from
   * silently ending every subsequent write for that aircraft.
   */
  async function handleTerminalRejection(
    txid: string,
    rejection?: TerminalRejectionContext,
  ): Promise<void> {
    spendGovernor.noteTerminalRejection();

    try {
      const purged = await utxoManager.invalidateOutputsOf(txid);

      const owner = await db("tx_results")
        .where({ txid })
        .first("aircraft_icao") as { aircraft_icao?: string } | undefined;
      const icao = owner?.aircraft_icao?.trim().toUpperCase();

      if (icao && icao !== FLEET_PSEUDO_ICAO) {
        const address = vault.getAircraftAddress(icao);
        await utxoManager.reconcile(icao, address);
        autoRefill.requestRefill(icao);
        log.warn(
          {
            icao,
            txid: txid.slice(0, 12),
            purged,
            rejectStatus: rejection?.status,
            reason: rejection?.reason ?? "(upstream gave no reason)",
            competingTxs: rejection?.competingTxs,
            source: rejection?.source,
          },
          "Rejected transaction unwound and wallet reconciled against chain",
        );
      } else {
        // No owning aircraft means the treasury broadcast it — a refill, split or
        // consolidation — so the funding pool is the one holding phantom outputs.
        await fundingUtxoManager.reconcile(config.fundingWalletWif);
      }
    } catch (err) {
      log.error(
        {
          err,
          txid: txid.slice(0, 12),
          rejectStatus: rejection?.status,
          reason: rejection?.reason,
          source: rejection?.source,
        },
        "Failed to unwind a rejected transaction — pool may hold phantom outputs",
      );
    }

    // The rejected txid must never be resubmitted, but the archive payload can
    // be rebuilt into a new transaction once the wallet has a live UTXO again.
    // Rebuilding is not free, so the governor decides how many attempts a
    // payload is worth: while the network is refusing transactions at scale,
    // paying to rebuild each one simply doubles the loss.
    const maxRequeues = spendGovernor.maxRejectRequeues();
    if (maxRequeues <= 0) {
      spendBlockedTotal.inc({ site: "reject_requeue" });
      rejectRequeuesTotal.inc({ outcome: "skipped_spend_halted" });
      log.warn(
        {
          txid: txid.slice(0, 12),
          posture: spendGovernor.getPosture(),
          rejectStatus: rejection?.status,
          reason: rejection?.reason ?? "(upstream gave no reason)",
        },
        "Reject requeue withheld — spending is halted, so this sample stays a "
          + "FAILED archive gap rather than paying for another attempt",
      );
      return;
    }

    try {
      const outcome = await rebufferRejectedTransaction(txid, {
        db,
        onQueued: () => writeBuffer.noteExternalEnqueue(),
        maxRequeues,
        rejection,
      });
      rejectRequeuesTotal.inc({ outcome });
    } catch (err) {
      rejectRequeuesTotal.inc({ outcome: "failed" });
      log.error(
        {
          err,
          txid: txid.slice(0, 12),
          rejectStatus: rejection?.status,
          reason: rejection?.reason,
          source: rejection?.source,
        },
        "Failed to re-queue payload after terminal rejection",
      );
    }
  }

  async function processStatusUpdate(payload: ArcCallbackPayload): Promise<void> {
    try {
      const upstreamStatus = payload.txStatus.trim().toUpperCase();

      // REJECTED and DOUBLE_SPEND_ATTEMPTED are terminal. Recording them as
      // FAILED stops the retry loop from resurrecting a transaction the network
      // has already refused, which for a double spend would be actively harmful.
      if (isTerminalArcadeFailure(upstreamStatus)) {
        const diagnosis = extractArcadeRejectDiagnosis(payload, upstreamStatus);
        const rejection: TerminalRejectionContext = {
          status: diagnosis.status || upstreamStatus,
          reason: diagnosis.reason,
          competingTxs: diagnosis.competingTxs ?? payload.competingTxs,
          source: "sse",
          upstreamSnippet: diagnosis.upstreamSnippet,
        };

        // A transaction already proved to be in a block cannot subsequently be
        // rejected; such an event is stale ordering, not new information.
        const marked = await markTxRejected(db, payload.txid, {
          status: rejection.status,
          reason: rejection.reason
            ?? (rejection.upstreamSnippet
              ? `no reason field; upstream=${rejection.upstreamSnippet}`
              : null),
          competingTxs: rejection.competingTxs,
        });
        if (marked === 0) return;

        log.error(
          {
            txid: payload.txid,
            rejectStatus: rejection.status,
            reason: rejection.reason ?? "(upstream gave no reason)",
            competingTxs: rejection.competingTxs,
            upstreamSnippet: rejection.upstreamSnippet,
            source: rejection.source,
          },
          "Transaction terminally rejected by the network — "
            + "payload will be re-queued for a fresh broadcast when possible",
        );

        // The rejected transaction's outputs do not exist, so anything the
        // writer optimistically recorded from it must go before it becomes the
        // parent of the aircraft's next write and propagates the rejection.
        // handleTerminalRejection also re-queues the OP_RETURN into pending_writes.
        await handleTerminalRejection(payload.txid, rejection);

        await publisher
          .publish("txresult", JSON.stringify({
            txid: payload.txid,
            status: "FAILED",
            rejectStatus: rejection.status,
            reason: rejection.reason,
          }))
          .catch(() => {});
        return;
      }

      // MINED is only ever recorded off the back of a proof that verifies
      // against a header we hold. An upstream simply asserting MINED is not
      // evidence, and treating it as such is what made the old "SPV Verified"
      // badge meaningless.
      if (upstreamStatus === "MINED" && payload.merklePath) {
        const result = await verifyBump(payload.txid, payload.merklePath, headerStore);
        if (result.verified && result.blockHeight !== undefined) {
          await recordVerifiedProof(db, payload.txid, payload.merklePath, result.blockHeight);
          await publisher
            .publish(
              "txresult",
              JSON.stringify({
                txid: payload.txid,
                status: "MINED",
                block_height: result.blockHeight,
                spv_verified: true,
              }),
            )
            .catch(() => {});
          return;
        }
        await recordUnverifiedProof(
          db,
          payload.txid,
          payload.merklePath,
          result.blockHeight ?? payload.blockHeight,
          result.reason ?? "verification failed",
        );
        // The poller retries it once the header catches up.
        confirmationPoller?.nudge();
        return;
      }

      if (upstreamStatus === "MINED") {
        // Mined without a proof: keep polling until one is available.
        confirmationPoller?.nudge();
      }

      // Every remaining status (RECEIVED, SENT_TO_NETWORK, ACCEPTED_BY_NETWORK,
      // SEEN_ON_NETWORK) tells us nothing the row does not already say — it is
      // inserted as SEEN_ON_NETWORK at broadcast time. Writing the status back
      // anyway cost an UPDATE per event on the hottest path in the writer, and
      // worse, a late event could demote a transaction the poller had already
      // proved and mined, leaving rows flagged spv_verified while sitting in
      // SEEN_ON_NETWORK forever. Only a newly learned block height is recorded,
      // and never over a MINED row.
      if (payload.blockHeight !== undefined) {
        await db("tx_results")
          .where({ txid: payload.txid })
          .whereNot({ status: "MINED" })
          .whereNull("block_height")
          .update({ block_height: payload.blockHeight });
      }
    } catch (err) {
      log.error({ err, txid: payload.txid }, "Status update processing error");
    }
  }

  /**
   * Arcade streams every intermediate status for every transaction, so this is
   * the hottest callback in the writer. Work is queued behind a fixed pool
   * rather than spawned as a floating promise per event: a burst of rejections
   * previously put thousands of concurrent database operations in flight and
   * exhausted the heap.
   */
  function handleStatusUpdate(payload: ArcCallbackPayload): void {
    const accepted = statusUpdateQueue.push(() => processStatusUpdate(payload));
    statusQueueDepth.set(statusUpdateQueue.depth);
    if (!accepted) {
      log.warn(
        {
          txid: payload.txid,
          rejectStatus: payload.txStatus,
          reason: payload.extraInfo ?? undefined,
          competingTxs: payload.competingTxs,
          maxDepth: STATUS_QUEUE_MAX_DEPTH,
        },
        "Status event shed — backlog saturated; the confirmation poller remains the backstop",
      );
    }
  }

  broadcaster.setupCallbackReceiver(config.arcCallbackPort);

  if (arcadeBroadcaster && config.arcade.sseEnabled) {
    arcadeSse = new ArcadeSseClient(
      arcadeBroadcaster.baseUrl,
      arcadeBroadcaster.callbackToken,
      config.arcade.apiKey,
    );
    arcadeSse.on("status-update", (payload: ArcCallbackPayload) => {
      arcadeBroadcaster?.noteStatus(payload.txid, payload.txStatus);
      handleStatusUpdate(payload);
    });
    arcadeSse.start();
  }

  const publisher = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: config.redis.db,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
  });
  publisher.on("error", (err) => {
    log.warn({ err: err.message }, "Redis publisher error");
  });
  await publisher.connect();
  writeBuffer.setRedisPublisher(publisher);
  log.info("Redis publisher connected");

  const subscriber = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: config.redis.db,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
  });
  subscriber.on("error", (err) => {
    log.warn({ err: err.message }, "Redis subscriber error");
  });

  await subscriber.connect();
  log.info("Redis subscriber connected");

  const channels: string[] = [AIRCRAFT_ACTIVITY_CHANNEL];
  for (const aircraft of fleet) {
    channels.push(`write:${aircraft.icao}`, `flight-event:${aircraft.icao}`);
  }
  await subscriber.subscribe(...channels);
  log.info({ channels: channels.length }, "Subscribed to Redis channels");

  const trackedIcaos = new Set(fleet.map((aircraft) => aircraft.icao.toUpperCase()));

  subscriber.on("message", (channel: string, message: string) => {
    // Liveness carries no payload — it exists purely so refill's notion of an
    // active aircraft matches what the dashboard is showing.
    if (channel === AIRCRAFT_ACTIVITY_CHANNEL) {
      const icao = message.trim().toUpperCase();
      if (trackedIcaos.has(icao)) {
        autoRefill.recordActivity(icao);
      }
      return;
    }

    const sep = channel.indexOf(":");
    const prefix = channel.slice(0, sep);
    const icao = channel.slice(sep + 1);

    autoRefill.recordActivity(icao);

    if (prefix === "write") {
      void processTelemetryWrite(icao, message);
    } else if (prefix === "flight-event") {
      void processFlightEventWrite(icao, message);
    }
  });

  async function bufferDeferredWrite(
    icao: string,
    recordType: RecordType,
    payload: Uint8Array,
    flightId: string | undefined,
    context: string,
  ): Promise<boolean> {
    try {
      await writeBuffer.buffer(icao, recordType, payload, flightId);
      return true;
    } catch (err) {
      log.error({ err, icao, recordType, context }, "Failed to persist deferred write");
      writerWriteOutcomesTotal.inc({
        path: "live",
        record_type: recordTypeMetricLabel(recordType),
        outcome: "buffer_persist_failed",
      });
      return false;
    }
  }

  async function processTelemetryWrite(
    icao: string,
    raw: string,
  ): Promise<void> {
    const recordTypeLabel = recordTypeMetricLabel(RecordType.TELEMETRY);
    writerWriteIngressTotal.inc({ path: "live", record_type: recordTypeLabel });
    let telemetry: TelemetryRecord;
    try {
      telemetry = JSON.parse(raw) as TelemetryRecord;
    } catch {
      writerWriteOutcomesTotal.inc({
        path: "live",
        record_type: recordTypeLabel,
        outcome: "invalid_json",
      });
      log.error({ icao }, "Invalid telemetry JSON on write channel");
      return;
    }

    const broadcasterState = broadcaster.getState();
    const liveTelemetryQueueReserve = Math.max(1, config.arcMaxConcurrentBroadcasts);
    // A halted governor is not backpressure: the sample is durable in Postgres
    // and costs nothing to hold, whereas broadcasting it right now would pay a
    // fee the network is likely to refuse.
    const spendHalted = !spendGovernor.allowsBroadcast();
    const shouldDeferTelemetry =
      spendHalted
      || broadcasterState.circuitOpen
      || broadcasterState.queueDepth >= Math.max(1, config.arcMaxQueueDepth - liveTelemetryQueueReserve);

    if (shouldDeferTelemetry) {
      const payload = encodeTelemetryPayload(telemetry);
      const buffered = await bufferDeferredWrite(
        icao,
        RecordType.TELEMETRY,
        payload,
        telemetry.flight_id,
        spendHalted ? "spend_halted" : "preemptive_defer",
      );
      if (!buffered) return;
      if (spendHalted) spendBlockedTotal.inc({ site: "live_telemetry" });
      writerWriteOutcomesTotal.inc({
        path: "live",
        record_type: recordTypeLabel,
        outcome: spendHalted ? "buffered_spend_halted" : "buffered_preemptive",
      });
      return;
    }

    const privateKey = vault.getAircraftPrivateKey(icao);
    const walletAddress = vault.getAircraftAddress(icao);
    let utxo;

    try {
      utxo = await utxoManager.acquireUtxo(icao);
    } catch (err) {
      handleAcquireFailure(err, icao, utxoManager, autoRefill, walletAddress);
      const payload = encodeTelemetryPayload(telemetry);
      const buffered = await bufferDeferredWrite(
        icao,
        RecordType.TELEMETRY,
        payload,
        telemetry.flight_id,
        "utxo_unavailable",
      );
      if (!buffered) return;
      writerWriteOutcomesTotal.inc({
        path: "live",
        record_type: recordTypeLabel,
        outcome: "buffered_utxo_unavailable",
      });
      return;
    }

    let broadcastAttempted = false;
    try {
      const { tx, changeOutput, opReturn } = await buildTelemetryTx({
        utxo,
        privateKey,
        telemetry,
        recordType: RecordType.TELEMETRY,
      });

      broadcastAttempted = true;
      const result = await broadcaster.broadcast(tx, icao, {
        kind: "telemetry",
        priority: BroadcastPriority.LIVE_TELEMETRY,
      });

      if (result.status === "FAILED") {
        // With a SEEN_ON_NETWORK gate upstream, an orphan result means the
        // network genuinely never took the transaction within the window, so
        // the optimistic path below would record a spend that never happened.
        if (
          isDependencyPendingBroadcastFailure(result)
          && !broadcaster.hasSeenOnNetworkGate
        ) {
          const localTxid = computeTxid(tx);
          const poolState = await utxoManager.recordSpend(
            utxo.txid, utxo.vout,
            localTxid, 1,
            changeOutput.satoshis, changeOutput.lockingScript, icao,
          );
          autoRefill.noteRetryPressure(
            icao,
            `Broadcast dependency pending: ${result.code ?? result.description ?? "unknown"}`,
          );
          autoRefill.requestRefillIfPoolLow(icao, poolState);
          const orphanRow = {
            txid: localTxid,
            aircraft_icao: icao,
            record_type: RecordType.TELEMETRY,
            status: "SEEN_ON_NETWORK" as const,
            timestamp: Date.now(),
            fee_sats: Number(utxo.satoshis) - changeOutput.satoshis,
            size_bytes: tx.toBinary().length,
            flight_id: telemetry.flight_id,
            chronicle_validated: !!changeOutput.isChronicle,
          };
          // The envelope is persisted but kept out of the Redis broadcast: it is
          // for later decoding, not for live dashboard consumers.
          await insertTxResult(db, { ...orphanRow, op_return: opReturn });
          await publisher.publish("txresult", JSON.stringify(orphanRow)).catch(() => {});
          confirmationPoller?.nudge();
          writerWriteOutcomesTotal.inc({
            path: "live",
            record_type: recordTypeLabel,
            outcome: "optimistic_orphan",
          });
          spendGovernor.noteBroadcastAccepted();
          log.info({ icao, txid: localTxid, code: result.code }, "Orphan-mempool broadcast recorded optimistically");
          return;
        }
        throw await handleFailedAircraftBroadcast(
          icao,
          utxoManager,
          utxo,
          walletAddress,
          result,
        );
      }

      const txid = result.txid;

      const poolState = await utxoManager.recordSpend(
        utxo.txid,
        utxo.vout,
        txid,
        1,
        changeOutput.satoshis,
        changeOutput.lockingScript,
        icao,
      );
      autoRefill.requestRefillIfPoolLow(icao, poolState);
      spendGovernor.noteBroadcastAccepted();

      const txResultRow = {
        txid,
        aircraft_icao: icao,
        record_type: RecordType.TELEMETRY,
        status: "SEEN_ON_NETWORK" as const,
        timestamp: Date.now(),
        fee_sats: Number(utxo.satoshis) - changeOutput.satoshis,
        size_bytes: tx.toBinary().length,
        flight_id: telemetry.flight_id,
        chronicle_validated: !!changeOutput.isChronicle,
      };
      await insertTxResult(db, { ...txResultRow, op_return: opReturn });
      await publisher.publish("txresult", JSON.stringify(txResultRow)).catch(() => {});
      confirmationPoller?.nudge();
      writerWriteOutcomesTotal.inc({
        path: "live",
        record_type: recordTypeLabel,
        outcome: "broadcasted",
      });
    } catch (err) {
      await settleInputAfterFailedWrite(
        icao, utxoManager, utxo, walletAddress, broadcastAttempted,
      );
      const payload = encodeTelemetryPayload(telemetry);
      await writeBuffer
        .buffer(icao, RecordType.TELEMETRY, payload, telemetry.flight_id)
        .catch(() => {});
      writerWriteOutcomesTotal.inc({
        path: "live",
        record_type: recordTypeLabel,
        outcome: isHandledBackpressureError(err)
          ? "buffered_after_backpressure"
          : "buffered_after_failure",
      });
      if (isHandledBackpressureError(err)) {
        log.warn({ err, icao }, "Telemetry write deferred");
      } else {
        log.error({ err, icao }, "Telemetry write failed");
      }
    }
  }

  async function processFlightEventWrite(
    icao: string,
    raw: string,
  ): Promise<void> {
    const recordTypeLabel = recordTypeMetricLabel(RecordType.FLIGHT_EVENT);
    writerWriteIngressTotal.inc({ path: "live", record_type: recordTypeLabel });
    let event: FlightEventRecord;
    try {
      event = JSON.parse(raw) as FlightEventRecord;
    } catch {
      writerWriteOutcomesTotal.inc({
        path: "live",
        record_type: recordTypeLabel,
        outcome: "invalid_json",
      });
      log.error({ icao }, "Invalid flight-event JSON");
      return;
    }

    const spendHalted = !spendGovernor.allowsBroadcast();
    if (spendHalted || broadcaster.getState().circuitOpen) {
      const payload = encodeFlightEventPayload(event);
      const buffered = await bufferDeferredWrite(
        icao,
        RecordType.FLIGHT_EVENT,
        payload,
        event.flight_id,
        spendHalted ? "spend_halted" : "preemptive_defer",
      );
      if (!buffered) return;
      if (spendHalted) spendBlockedTotal.inc({ site: "live_flight_event" });
      writerWriteOutcomesTotal.inc({
        path: "live",
        record_type: recordTypeLabel,
        outcome: spendHalted ? "buffered_spend_halted" : "buffered_preemptive",
      });
      return;
    }

    const privateKey = vault.getAircraftPrivateKey(icao);
    const walletAddress = vault.getAircraftAddress(icao);
    let utxo;

    try {
      utxo = await utxoManager.acquireUtxo(icao);
    } catch (err) {
      handleAcquireFailure(err, icao, utxoManager, autoRefill, walletAddress);
      const payload = encodeFlightEventPayload(event);
      const buffered = await bufferDeferredWrite(
        icao,
        RecordType.FLIGHT_EVENT,
        payload,
        event.flight_id,
        "utxo_unavailable",
      );
      if (!buffered) return;
      writerWriteOutcomesTotal.inc({
        path: "live",
        record_type: recordTypeLabel,
        outcome: "buffered_utxo_unavailable",
      });
      return;
    }

    let broadcastAttempted = false;
    try {
      const { tx, changeOutput, opReturn } = await buildFlightEventTx({
        utxo,
        privateKey,
        event,
      });

      broadcastAttempted = true;
      const result = await broadcaster.broadcast(tx, icao, {
        kind: "flight_event",
        priority: BroadcastPriority.FLIGHT_EVENT,
      });

      if (result.status === "FAILED") {
        // With a SEEN_ON_NETWORK gate upstream, an orphan result means the
        // network genuinely never took the transaction within the window, so
        // the optimistic path below would record a spend that never happened.
        if (
          isDependencyPendingBroadcastFailure(result)
          && !broadcaster.hasSeenOnNetworkGate
        ) {
          const localTxid = computeTxid(tx);
          const poolState = await utxoManager.recordSpend(
            utxo.txid, utxo.vout,
            localTxid, 1,
            changeOutput.satoshis, changeOutput.lockingScript, icao,
          );
          autoRefill.noteRetryPressure(
            icao,
            `Broadcast dependency pending: ${result.code ?? result.description ?? "unknown"}`,
          );
          autoRefill.requestRefillIfPoolLow(icao, poolState);
          const orphanRow = {
            txid: localTxid,
            aircraft_icao: icao,
            record_type: RecordType.FLIGHT_EVENT,
            status: "SEEN_ON_NETWORK" as const,
            timestamp: Date.now(),
            fee_sats: Number(utxo.satoshis) - changeOutput.satoshis,
            size_bytes: tx.toBinary().length,
            flight_id: event.flight_id,
          };
          await insertTxResult(db, { ...orphanRow, op_return: opReturn });
          await publisher.publish("txresult", JSON.stringify(orphanRow)).catch(() => {});
          confirmationPoller?.nudge();
          writerWriteOutcomesTotal.inc({
            path: "live",
            record_type: recordTypeLabel,
            outcome: "optimistic_orphan",
          });
          spendGovernor.noteBroadcastAccepted();
          log.info({ icao, txid: localTxid, code: result.code }, "Orphan-mempool flight-event recorded optimistically");
          return;
        }
        throw await handleFailedAircraftBroadcast(
          icao,
          utxoManager,
          utxo,
          walletAddress,
          result,
        );
      }

      const txid = result.txid;

      const poolState = await utxoManager.recordSpend(
        utxo.txid,
        utxo.vout,
        txid,
        1,
        changeOutput.satoshis,
        changeOutput.lockingScript,
        icao,
      );
      autoRefill.requestRefillIfPoolLow(icao, poolState);
      spendGovernor.noteBroadcastAccepted();

      const feResultRow = {
        txid,
        aircraft_icao: icao,
        record_type: RecordType.FLIGHT_EVENT,
        status: "SEEN_ON_NETWORK" as const,
        timestamp: Date.now(),
        fee_sats: Number(utxo.satoshis) - changeOutput.satoshis,
        size_bytes: tx.toBinary().length,
        flight_id: event.flight_id,
      };
      await insertTxResult(db, { ...feResultRow, op_return: opReturn });
      await publisher.publish("txresult", JSON.stringify(feResultRow)).catch(() => {});
      confirmationPoller?.nudge();
      writerWriteOutcomesTotal.inc({
        path: "live",
        record_type: recordTypeLabel,
        outcome: "broadcasted",
      });
    } catch (err) {
      await settleInputAfterFailedWrite(
        icao, utxoManager, utxo, walletAddress, broadcastAttempted,
      );
      const payload = encodeFlightEventPayload(event);
      await writeBuffer
        .buffer(icao, RecordType.FLIGHT_EVENT, payload, event.flight_id)
        .catch(() => {});
      writerWriteOutcomesTotal.inc({
        path: "live",
        record_type: recordTypeLabel,
        outcome: isHandledBackpressureError(err)
          ? "buffered_after_backpressure"
          : "buffered_after_failure",
      });
      if (isHandledBackpressureError(err)) {
        log.warn({ err, icao }, "Flight-event write deferred");
      } else {
        log.error({ err, icao }, "Flight-event write failed");
      }
    }
  }

  const consolidationInterval = setInterval(() => {
    void runConsolidation();
  }, CONSOLIDATION_INTERVAL_MS);

  // Locks are only ever held across a single broadcast. Anything older lost its
  // owner, so reclaim it rather than letting the spendable pool quietly shrink —
  // but only for outputs the chain agrees are still unspent.
  const lockReclaimInterval = setInterval(() => {
    void utxoManager
      .reclaimStaleLocks((icao) => vault.getAircraftAddress(icao))
      .catch((err) => log.error({ err }, "Aircraft UTXO lock reclaim failed"));
    void fundingUtxoManager.reclaimStaleLocks().catch((err) =>
      log.error({ err }, "Funding UTXO lock reclaim failed"),
    );
  }, LOCK_RECLAIM_INTERVAL_MS);

  // Depth rises with every write and falls only when blocks confirm the
  // lineage. Without this sweep the ceiling would eventually park a healthy
  // wallet's entire pool and drive endless refills.
  const chainDepthSettleInterval = setInterval(() => {
    void utxoManager.settleConfirmedChainDepths().catch((err) =>
      log.error({ err }, "Chain-depth settlement failed"),
    );
  }, CHAIN_DEPTH_SETTLE_INTERVAL_MS);
  chainDepthSettleInterval.unref?.();

  async function runConsolidation(): Promise<void> {
    log.info("Running UTXO consolidation cycle");
    for (const aircraft of fleet) {
      try {
        const key = vault.getAircraftPrivateKey(aircraft.icao);
        await utxoManager.consolidate(
          aircraft.icao,
          key,
          broadcaster,
          config.consolidationThreshold,
        );
      } catch (err) {
        log.error({ err, icao: aircraft.icao }, "Consolidation error");
      }
    }
  }

  const fundingState = new FundingStateMachine(
    db,
    config,
    fundingUtxoManager,
    autoRefill,
    writeBuffer,
    broadcaster,
    publisher,
  );
  writeBuffer.setFundingDryGate(() => fundingState.isDry());
  writeBuffer.setPrunePauseGate(() => fundingState.isRecovering());
  await fundingState.start();

  autoRefill.start();
  writeBuffer.startRetryLoop();

  const agentRefiller = new AgentWalletRefiller(
    config,
    broadcaster,
    fundingUtxoManager,
    resolveAgentTargets(),
    woc,
  );
  agentRefiller.setSpendGate(() => spendGovernor.allowsTreasurySpend());
  agentRefiller.start();

  confirmationPoller = new ConfirmationPoller(
    db,
    woc,
    headerStore,
    arcadeBroadcaster?.baseUrl,
    config.arcade.apiKey,
  );
  confirmationPoller.setRedisPublisher(publisher);
  confirmationPoller.setTerminalRejectionHandler(handleTerminalRejection);
  confirmationPoller.start();

  log.info("Running initial auto-refill check (activity-aware bootstrap)");
  void autoRefill.checkAll(false).catch((err) =>
    log.error({ err }, "Initial auto-refill failed"),
  );
  void agentRefiller.checkAll().catch((err) =>
    log.error({ err }, "Initial agent wallet top-up failed"),
  );

  startMetricsServer();

  function startMetricsServer(): void {
    const server = createHttpServer((req, res) => {
      // A halted writer looks healthy from the outside, so the posture has to be
      // readable without shelling into the container to grep logs.
      if (req.url?.startsWith("/spend-posture")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(spendGovernor.getSnapshot()));
        return;
      }

      registry
        .metrics()
        .then((metrics) => {
          res.writeHead(200, { "Content-Type": registry.contentType });
          res.end(metrics);
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        });
    });
    server.listen(METRICS_PORT, () => {
      log.info({ port: METRICS_PORT }, "Prometheus metrics server listening");
    });
  }

  async function shutdown(): Promise<void> {
    log.info("Graceful shutdown initiated");

    clearInterval(consolidationInterval);
    clearInterval(lockReclaimInterval);
    clearInterval(chainDepthSettleInterval);
    clearInterval(headerSyncInterval);
    arcadeSse?.stop();
    fundingState.stop();
    autoRefill.stop();
    agentRefiller.stop();
    writeBuffer.stopRetryLoop();
    confirmationPoller?.stop();

    try {
      await subscriber.quit();
    } catch {
      subscriber.disconnect();
    }

    try {
      await publisher.quit();
    } catch {
      publisher.disconnect();
    }

    await broadcaster.closeCallbackReceiver();
    await closeDb();

    log.info("Shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // A socket reset from Postgres, Redis or a broadcaster must not be able to
  // kill the writer with a bare stack trace. These are logged with full context
  // and, for a genuinely unknown fault, the process exits non-zero so the
  // supervisor restarts it cleanly rather than leaving it half-alive.
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    if (isRecoverableSocketError(err)) {
      log.warn({ err: err.message }, "Recoverable socket error outside a handler");
      return;
    }
    log.fatal({ err }, "Unhandled promise rejection — restarting");
    process.exit(1);
  });

  process.on("uncaughtException", (err) => {
    if (isRecoverableSocketError(err)) {
      log.warn({ err: err.message }, "Recoverable socket error outside a handler");
      return;
    }
    log.fatal({ err }, "Uncaught exception — restarting");
    process.exit(1);
  });

  log.info(
    {
      aircraftCount: fleet.length,
      spendPosture: spendGovernor.getPosture(),
      spendPaused: spendGovernor.isPaused(),
      maxUnconfirmedChainDepth: config.spendGuard.maxUnconfirmedChainDepth,
      spendHaltRatio: config.spendGuard.haltRatio,
      spendGuardWindowMs: config.spendGuard.windowMs,
    },
    "Blockchain writer service started",
  );
}

main().catch((err) => {
  log.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
