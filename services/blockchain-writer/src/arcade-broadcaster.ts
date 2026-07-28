import { EventEmitter } from "node:events";
import type { Transaction } from "@bsv/sdk";
import { createLogger } from "@airchive/logger";
import {
  arcadeBatchSize,
  arcadeFallbackTotal,
  arcadeSubmissionsTotal,
  txBroadcastLatency,
} from "./metrics.js";
import {
  type ArcBroadcasterState,
  type BroadcastOptions,
  type BroadcastOutcome,
  type Broadcaster,
} from "./broadcaster.js";
import { computeTxid } from "./tx-builder.js";

const log = createLogger({ service: "blockchain-writer:arcade" });

/**
 * Arcade's terminal and intermediate transaction states.
 * @see https://github.com/bsv-blockchain/arcade
 */
export const ARCADE_STATUS = {
  RECEIVED: "RECEIVED",
  SENT_TO_NETWORK: "SENT_TO_NETWORK",
  ACCEPTED_BY_NETWORK: "ACCEPTED_BY_NETWORK",
  SEEN_ON_NETWORK: "SEEN_ON_NETWORK",
  SEEN_IN_ORPHAN_MEMPOOL: "SEEN_IN_ORPHAN_MEMPOOL",
  MINED: "MINED",
  REJECTED: "REJECTED",
  DOUBLE_SPEND_ATTEMPTED: "DOUBLE_SPEND_ATTEMPTED",
} as const;

/**
 * States from which a transaction will never progress. Rebroadcasting these
 * wastes capacity and, for a double spend, is actively harmful.
 */
const TERMINAL_FAILURE_STATUSES = new Set<string>([
  ARCADE_STATUS.REJECTED,
  ARCADE_STATUS.DOUBLE_SPEND_ATTEMPTED,
]);

export function isTerminalArcadeFailure(status: string): boolean {
  return TERMINAL_FAILURE_STATUSES.has(status.trim().toUpperCase());
}

export interface ArcadeBroadcasterConfig {
  /** Base URL, e.g. https://arcade-v2-us-1.bsvblockchain.tech */
  url: string;
  apiKey?: string;
  /**
   * Window over which submissions are coalesced into a single POST /txs.
   * At ~100 aircraft writing at 1 Hz this turns ~100 requests/second into ~5.
   */
  batchWindowMs: number;
  maxBatchSize: number;
  requestTimeoutMs: number;
  /** Shared by submissions and the SSE stream so status events can be matched. */
  callbackToken: string;
  /** Ask Arcade for intermediate statuses, not just the final one. */
  fullStatusUpdates: boolean;
  /**
   * How long to wait for SEEN_ON_NETWORK after an orphan-mempool result before
   * declaring the write failed. Arcade typically reaches this state in ~3s.
   */
  seenGateTimeoutMs: number;
}

export const DEFAULT_ARCADE_CONFIG: Omit<ArcadeBroadcasterConfig, "url" | "callbackToken"> = {
  batchWindowMs: 200,
  maxBatchSize: 100,
  requestTimeoutMs: 20_000,
  fullStatusUpdates: true,
  seenGateTimeoutMs: 6_000,
};

/** Statuses that mean the network has the transaction and its change is spendable. */
const SPENDABLE_STATUSES = new Set<string>([
  ARCADE_STATUS.SEEN_ON_NETWORK,
  ARCADE_STATUS.ACCEPTED_BY_NETWORK,
  ARCADE_STATUS.MINED,
]);

interface PendingSubmission {
  tx: Transaction;
  txid: string;
  icao: string;
  enqueuedAt: number;
  resolve: (outcome: BroadcastOutcome) => void;
}

/** Arcade returns per-transaction results, but field names vary by version. */
interface ArcadeTxResponse {
  txid?: string;
  status?: string | number;
  txStatus?: string;
  extraInfo?: string;
  detail?: string;
  title?: string;
}

/**
 * Broadcasts through Arcade, coalescing concurrent submissions into batched
 * `POST /txs` calls, and falling back to the ARC upstream whenever Arcade is
 * unavailable so an Arcade outage can never block writes.
 */
export class ArcadeBroadcaster extends EventEmitter implements Broadcaster {
  private readonly config: ArcadeBroadcasterConfig;
  private readonly fallback: Broadcaster;
  private batch: PendingSubmission[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = 0;
  private healthy = true;
  private readonly seenWaiters = new Map<string, (spendable: boolean) => void>();

  readonly hasSeenOnNetworkGate = true;

  constructor(
    config: Pick<ArcadeBroadcasterConfig, "url" | "callbackToken"> &
      Partial<ArcadeBroadcasterConfig>,
    fallback: Broadcaster,
  ) {
    super();
    this.config = { ...DEFAULT_ARCADE_CONFIG, ...config };
    this.fallback = fallback;

    // Status updates from the ARC fallback must still reach the writer.
    this.fallback.on("status-update", (payload) => this.emit("status-update", payload));
  }

  get baseUrl(): string {
    return this.config.url.replace(/\/+$/, "");
  }

  get callbackToken(): string {
    return this.config.callbackToken;
  }

  async broadcast(
    tx: Transaction,
    icao?: string,
    options?: BroadcastOptions,
  ): Promise<BroadcastOutcome> {
    if (!this.healthy) {
      arcadeFallbackTotal.inc({ reason: "unhealthy" });
      return this.fallback.broadcast(tx, icao, options);
    }

    // Arcade's POST /tx does not reliably return a txid on a new submission,
    // so the local txid is authoritative for tracking.
    const txid = computeTxid(tx);

    return new Promise<BroadcastOutcome>((resolve) => {
      this.batch.push({
        tx,
        txid,
        icao: icao ?? "unknown",
        enqueuedAt: Date.now(),
        resolve,
      });

      if (this.batch.length >= this.config.maxBatchSize) {
        this.flushBatch();
        return;
      }
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.flushBatch();
    }, this.config.batchWindowMs);
  }

  private flushBatch(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.batch.length === 0) return;

    const batch = this.batch;
    this.batch = [];
    arcadeBatchSize.observe(batch.length);
    void this.submitBatch(batch);
  }

  private async submitBatch(batch: PendingSubmission[]): Promise<void> {
    this.inFlight++;
    const start = performance.now();

    try {
      const { outcomes, httpStatus } = await this.postBatch(batch);
      const latency = (performance.now() - start) / 1_000;

      await Promise.all(
        batch.map(async (submission) => {
          txBroadcastLatency.observe({ icao: submission.icao }, latency);
          const reported = outcomes.get(submission.txid);

          // Silence means acceptance only on a 2xx: Arcade lists just the
          // transactions it objected to. On an error status an unlisted member
          // has no known fate, and assuming success would record a spend for a
          // transaction the network may never have taken.
          if (!reported && httpStatus >= 400) {
            arcadeFallbackTotal.inc({ reason: "unresolved" });
            const fallbackOutcome = await this.fallback
              .broadcast(submission.tx, submission.icao, { kind: "tx" })
              .catch((err: Error) => ({
                txid: submission.txid,
                status: "FAILED" as const,
                code: err.name,
                description: err.message,
              }));
            submission.resolve(fallbackOutcome);
            return;
          }

          let outcome = reported ?? {
            txid: submission.txid,
            status: "SEEN_ON_NETWORK" as const,
          };

          // A batch member whose parent is still propagating lands in the orphan
          // mempool. Rather than assuming it will be accepted — which is what
          // previously let the writer spend change the network had never seen —
          // wait for Arcade to confirm the transaction really is on the network.
          if (outcome.status === "FAILED" && outcome.code === "SEEN_IN_ORPHAN_MEMPOOL") {
            const spendable = await this.awaitSeenOnNetwork(submission.txid);
            if (spendable) {
              outcome = { txid: submission.txid, status: "SEEN_ON_NETWORK" };
            }
          }

          arcadeSubmissionsTotal.inc({
            outcome: outcome.status === "SEEN_ON_NETWORK" ? "accepted" : "rejected",
          });
          submission.resolve(outcome);
        }),
      );

      log.debug(
        { count: batch.length, latency, endpoint: this.baseUrl },
        "Arcade batch submitted",
      );
    } catch (err) {
      // Arcade itself failed, not the transactions. Every member of the batch
      // is still valid, so hand the whole batch to the ARC fallback rather
      // than failing writes that would otherwise have succeeded.
      const message = (err as Error).message;
      log.warn(
        { err: message, count: batch.length },
        "Arcade batch submission failed — falling back to ARC upstream",
      );
      arcadeFallbackTotal.inc({ reason: "submit_error" }, batch.length);

      await Promise.all(
        batch.map(async (submission) => {
          const outcome = await this.fallback
            .broadcast(submission.tx, submission.icao, { kind: "tx" })
            .catch((fallbackErr: Error) => ({
              txid: "",
              status: "FAILED" as const,
              code: fallbackErr.name,
              description: fallbackErr.message,
            }));
          submission.resolve(outcome);
        }),
      );
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  /**
   * Submits Extended Format, which Arcade requires — it rejects BEEF. Both
   * endpoints take raw EF bytes as `application/octet-stream`; `/txs` parses a
   * plain concatenation of them and rejects any other content type outright.
   * Returns outcomes keyed by txid; absent entries are treated as accepted,
   * because Arcade reports only the transactions it took issue with.
   */
  private async postBatch(
    batch: PendingSubmission[],
  ): Promise<{ outcomes: Map<string, BroadcastOutcome>; httpStatus: number }> {
    const single = batch.length === 1;
    const url = `${this.baseUrl}${single ? "/tx" : "/txs"}`;
    const body = concatExtendedFormat(batch);

    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      Accept: "application/json",
      "X-CallbackToken": this.config.callbackToken,
    };
    if (this.config.fullStatusUpdates) {
      headers["X-FullStatusUpdates"] = "true";
    }
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });

    if (!res.ok && res.status >= 500) {
      throw new Error(`Arcade ${res.status} ${res.statusText}`);
    }

    const raw = await res.text();
    return { outcomes: this.parseResponses(raw, res.status), httpStatus: res.status };
  }

  private parseResponses(raw: string, httpStatus: number): Map<string, BroadcastOutcome> {
    const outcomes = new Map<string, BroadcastOutcome>();
    if (raw.trim() === "") return outcomes;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A 2xx with an unparseable body still means Arcade accepted the batch.
      if (httpStatus < 400) return outcomes;
      throw new Error(`Arcade returned ${httpStatus} with unparseable body`);
    }

    const entries: ArcadeTxResponse[] = Array.isArray(parsed)
      ? (parsed as ArcadeTxResponse[])
      : [parsed as ArcadeTxResponse];

    for (const entry of entries) {
      const txid = entry.txid?.trim();
      if (!txid) continue;
      outcomes.set(txid, toOutcome(txid, entry, httpStatus));
    }

    return outcomes;
  }

  /**
   * Feeds a status observed elsewhere (the SSE stream) into any gate waiting on
   * that txid, so the gate usually resolves in a few hundred milliseconds
   * instead of running to its polling deadline.
   */
  noteStatus(txid: string, status: string): void {
    const waiter = this.seenWaiters.get(txid);
    if (!waiter) return;

    const normalised = status.trim().toUpperCase();
    if (SPENDABLE_STATUSES.has(normalised)) waiter(true);
    else if (isTerminalArcadeFailure(normalised)) waiter(false);
  }

  /**
   * Resolves true once Arcade reports the transaction on the network. Uses the
   * SSE stream when it is delivering, and falls back to polling `GET /tx/{txid}`
   * so the gate still works if SSE is disabled or disconnected.
   */
  private async awaitSeenOnNetwork(txid: string): Promise<boolean> {
    const deadline = Date.now() + this.config.seenGateTimeoutMs;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (spendable: boolean): void => {
        if (settled) return;
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(deadlineTimer);
        this.seenWaiters.delete(txid);
        resolve(spendable);
      };

      this.seenWaiters.set(txid, finish);

      const pollTimer = setInterval(() => {
        if (Date.now() >= deadline) return;
        void this.fetchStatus(txid).then((status) => {
          if (!status) return;
          if (SPENDABLE_STATUSES.has(status)) finish(true);
          else if (isTerminalArcadeFailure(status)) finish(false);
        });
      }, 1_000);

      const deadlineTimer = setTimeout(() => {
        log.warn(
          { txid, timeoutMs: this.config.seenGateTimeoutMs },
          "Transaction not seen on network within the gate window — treating as unconfirmed",
        );
        finish(false);
      }, this.config.seenGateTimeoutMs);
    });
  }

  private async fetchStatus(txid: string): Promise<string | null> {
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;

      const res = await fetch(`${this.baseUrl}/tx/${txid}`, {
        headers,
        signal: AbortSignal.timeout(4_000),
      });
      if (!res.ok) return null;

      const body = (await res.json()) as ArcadeTxResponse;
      const status = String(body.txStatus ?? body.status ?? "").trim().toUpperCase();
      return status === "" ? null : status;
    } catch {
      return null;
    }
  }

  /** Marks Arcade unavailable so subsequent writes go straight to the fallback. */
  setHealthy(healthy: boolean): void {
    if (this.healthy === healthy) return;
    this.healthy = healthy;
    log[healthy ? "info" : "error"](
      { endpoint: this.baseUrl },
      healthy
        ? "Arcade upstream healthy — resuming Arcade-first broadcasting"
        : "Arcade upstream unhealthy — routing all broadcasts to the ARC fallback",
    );
  }

  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      this.setHealthy(res.ok);
      return res.ok;
    } catch {
      this.setHealthy(false);
      return false;
    }
  }

  getState(): ArcBroadcasterState {
    const fallbackState = this.fallback.getState();
    return {
      inFlight: this.inFlight + fallbackState.inFlight,
      queueDepth: this.batch.length + fallbackState.queueDepth,
      // Arcade batching absorbs load, so the writer is only truly blocked when
      // Arcade is down AND the fallback's breaker has tripped.
      circuitOpen: !this.healthy && fallbackState.circuitOpen,
      circuitOpenRemainingMs: fallbackState.circuitOpenRemainingMs,
    };
  }

  getLimits(): { maxConcurrentBroadcasts: number; maxQueueDepth: number } {
    const fallbackLimits = this.fallback.getLimits();
    return {
      maxConcurrentBroadcasts:
        fallbackLimits.maxConcurrentBroadcasts + this.config.maxBatchSize,
      maxQueueDepth: fallbackLimits.maxQueueDepth + this.config.maxBatchSize,
    };
  }

  isDegraded(): boolean {
    if (this.healthy) return this.batch.length >= this.config.maxBatchSize;
    return this.fallback.isDegraded();
  }

  setupCallbackReceiver(port: number): void {
    // Arcade pushes status over an outbound SSE connection, so no inbound
    // listener is needed for it. The ARC fallback still uses callbacks.
    this.fallback.setupCallbackReceiver(port);
  }

  async closeCallbackReceiver(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    await this.fallback.closeCallbackReceiver();
  }
}

function concatExtendedFormat(batch: PendingSubmission[]): Uint8Array {
  const parts = batch.map((submission) => submission.tx.toEF());
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const body = new Uint8Array(total);

  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return body;
}

function toOutcome(
  txid: string,
  entry: ArcadeTxResponse,
  httpStatus: number,
): BroadcastOutcome {
  const status = String(entry.txStatus ?? "").trim().toUpperCase();

  if (isTerminalArcadeFailure(status)) {
    return {
      txid,
      status: "FAILED",
      code: status,
      description: entry.extraInfo ?? entry.detail ?? entry.title,
    };
  }

  if (status === ARCADE_STATUS.SEEN_IN_ORPHAN_MEMPOOL) {
    return {
      txid,
      status: "FAILED",
      code: "SEEN_IN_ORPHAN_MEMPOOL",
      description: entry.extraInfo ?? "Parent not yet seen by the network",
    };
  }

  // A 4xx with no recognised status is a rejection of this transaction.
  if (httpStatus >= 400 && status === "") {
    return {
      txid,
      status: "FAILED",
      code: String(entry.status ?? httpStatus),
      description: entry.detail ?? entry.title ?? entry.extraInfo,
    };
  }

  return { txid, status: "SEEN_ON_NETWORK" };
}
