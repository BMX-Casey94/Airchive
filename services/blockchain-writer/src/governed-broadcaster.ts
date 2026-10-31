import type { Transaction } from "@bsv/sdk";
import { createLogger } from "@airchive/logger";
import {
  SPEND_HALTED_CODE,
  type ArcBroadcasterConfig,
  type ArcBroadcasterState,
  type ArcCallbackPayload,
  type BroadcastOptions,
  type BroadcastOutcome,
  type Broadcaster,
} from "./broadcaster.js";
import { spendBlockedTotal } from "./metrics.js";
import type { SpendGovernor } from "./spend-governor.js";
import { broadcastHold } from "./broadcast-hold.js";

const log = createLogger({ service: "blockchain-writer:governed-broadcaster" });

/**
 * The single point every transaction must pass through before it reaches an
 * upstream, so a halt is a property of the writer rather than a promise each
 * call site has to keep.
 *
 * Gating at the call sites left the paths that do not write archive data —
 * aircraft consolidation and treasury reshaping — spending straight through a
 * halt, which is how fees continued to leave the wallet after the governor had
 * supposedly stopped everything. Wrapping the upstream closes that class of
 * hole for every future call site as well.
 *
 * The refusal is reported as local backpressure rather than a network failure.
 * That distinction matters to the callers: backpressure means the payload is
 * deferred and its inputs are released untouched, whereas a network failure
 * would purge UTXOs and burn the sample as an archive gap.
 */
export class GovernedBroadcaster implements Broadcaster {
  readonly hasSeenOnNetworkGate?: boolean;

  private refusedSinceLastLog = 0;
  private lastRefusalLogAt = 0;

  constructor(
    private readonly inner: Broadcaster,
    private readonly governor: SpendGovernor,
    private readonly refusalLogIntervalMs = 60_000,
  ) {
    this.hasSeenOnNetworkGate = inner.hasSeenOnNetworkGate;
  }

  async broadcast(
    tx: Transaction,
    icao?: string,
    options?: BroadcastOptions,
  ): Promise<BroadcastOutcome> {
    if (broadcastHold.blocksBroadcast(icao, options?.kind) || !this.governor.allowsBroadcast()) {
      const kind = options?.kind ?? "tx";
      spendBlockedTotal.inc({ site: `broadcast:${kind}` });
      this.noteRefusal(kind, icao);
      return {
        txid: "",
        status: "FAILED",
        code: SPEND_HALTED_CODE,
        description:
          "Spending is halted by the governor — the transaction was not sent and no fee was paid",
      };
    }

    this.governor.noteBroadcastDispatched();
    return this.inner.broadcast(tx, icao, options);
  }

  getState(): ArcBroadcasterState {
    return this.inner.getState();
  }

  getLimits(): Pick<ArcBroadcasterConfig, "maxConcurrentBroadcasts" | "maxQueueDepth"> {
    return this.inner.getLimits();
  }

  isDegraded(): boolean {
    return this.inner.isDegraded();
  }

  setupCallbackReceiver(port: number): void {
    this.inner.setupCallbackReceiver(port);
  }

  closeCallbackReceiver(): Promise<void> {
    return this.inner.closeCallbackReceiver();
  }

  on(event: "status-update", listener: (payload: ArcCallbackPayload) => void): this {
    this.inner.on(event, listener);
    return this;
  }

  /**
   * A halt refuses on every write at fleet rate, so each refusal is counted and
   * summarised periodically instead of filling the log with identical lines.
   */
  private noteRefusal(kind: string, icao?: string): void {
    this.refusedSinceLastLog++;
    const now = Date.now();
    if (now - this.lastRefusalLogAt < this.refusalLogIntervalMs) return;

    log.warn(
      {
        refused: this.refusedSinceLastLog,
        sinceMs: this.lastRefusalLogAt === 0 ? null : now - this.lastRefusalLogAt,
        lastKind: kind,
        lastIcao: icao,
        posture: this.governor.getPosture(),
      },
      "Broadcasts refused at the spend gate — nothing was sent and no fee was paid",
    );
    this.lastRefusalLogAt = now;
    this.refusedSinceLastLog = 0;
  }
}
