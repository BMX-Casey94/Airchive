import { createLogger } from "@airchive/logger";
import {
  spendGuardTransitionsTotal,
  spendPostureGauge,
  spendRejectRatio,
} from "./metrics.js";

const log = createLogger({ service: "blockchain-writer:spend-governor" });

/**
 * How much of the treasury the writer is currently willing to risk.
 *
 * `NORMAL`   — ordinary operation.
 * `CAUTIOUS` — rejections are elevated: only near-settled outputs are spent and
 *              a rejected payload gets one retry rather than three.
 * `HALTED`   — nothing is broadcast at all. Samples are preserved in
 *              `pending_writes` instead of being paid for, so no fee is spent
 *              on transactions the network is currently refusing.
 */
export type SpendPosture = "NORMAL" | "CAUTIOUS" | "HALTED";

const POSTURE_METRIC_VALUE: Record<SpendPosture, number> = {
  NORMAL: 0,
  CAUTIOUS: 1,
  HALTED: 2,
};

export interface SpendGuardConfig {
  /** Operator kill switch. While true the posture is pinned to HALTED. */
  paused: boolean;
  /** Rolling window over which accepted and rejected broadcasts are compared. */
  windowMs: number;
  /** Below this many observations the ratio is noise, so posture stays NORMAL. */
  minSamples: number;
  /** Reject share at which spending becomes conservative. */
  cautiousRatio: number;
  /** Reject share at which spending stops entirely. */
  haltRatio: number;
  /** How long a halt holds before the window is re-tested. */
  haltCooldownMs: number;
  /** Unconfirmed ancestors an output may have and still be spent. */
  maxUnconfirmedChainDepth: number;
  /** Tighter ceiling applied while CAUTIOUS. */
  cautiousUnconfirmedChainDepth: number;
  /** Requeue ceiling for a rejected payload while NORMAL. */
  maxRejectRequeues: number;
}

interface Observation {
  at: number;
  rejected: boolean;
}

export interface SpendGuardSnapshot {
  posture: SpendPosture;
  accepted: number;
  rejected: number;
  rejectRatio: number;
  windowMs: number;
  haltRemainingMs: number;
  paused: boolean;
  maxUnconfirmedChainDepth: number;
  maxRejectRequeues: number;
}

/**
 * Decides whether the writer may spend, based on how the network has answered
 * recently rather than on how healthy the treasury looks.
 *
 * A rejected broadcast is not free: the payload is re-queued, the wallet is
 * reconciled, a refill is requested, and the aircraft's next write may chain
 * onto an output that no longer exists. When the reject rate climbs, continuing
 * to broadcast converts treasury into rejected transactions faster than the
 * archive gains anything, so the safe move is to stop, keep the samples in
 * Postgres, and let confirmations catch up.
 */
export class SpendGovernor {
  private readonly observations: Observation[] = [];
  private haltedUntil = 0;
  private lastPosture: SpendPosture = "NORMAL";

  constructor(private readonly config: SpendGuardConfig) {
    this.lastPosture = config.paused ? "HALTED" : "NORMAL";
    this.publish(this.lastPosture);
    if (config.paused) {
      log.warn(
        { paused: true },
        "Spend governor started paused by configuration — no transactions will be broadcast",
      );
    }
  }

  noteBroadcastAccepted(): void {
    this.record(false);
  }

  noteTerminalRejection(): void {
    this.record(true);
  }

  /** True while the operator kill switch is set. */
  isPaused(): boolean {
    return this.config.paused;
  }

  getPosture(): SpendPosture {
    const posture = this.evaluate();
    if (posture !== this.lastPosture) {
      const snapshot = this.snapshotFor(posture);
      spendGuardTransitionsTotal.inc({ to: posture });
      const detail = {
        from: this.lastPosture,
        to: posture,
        accepted: snapshot.accepted,
        rejected: snapshot.rejected,
        rejectRatio: Number(snapshot.rejectRatio.toFixed(4)),
        windowMs: snapshot.windowMs,
        haltRemainingMs: snapshot.haltRemainingMs,
      };
      if (posture === "HALTED") {
        log.error(
          detail,
          "Spend halted — rejections exceeded the safe share of recent broadcasts; "
            + "samples are preserved in pending_writes instead of paying fees",
        );
      } else if (posture === "CAUTIOUS") {
        log.warn(
          detail,
          "Spend restricted — only near-settled outputs will be spent and rejected "
            + "payloads get a single retry",
        );
      } else {
        log.info(detail, "Spend posture returned to normal");
      }
      this.lastPosture = posture;
    }
    this.publish(posture);
    return posture;
  }

  /** False when no transaction of any kind may be broadcast. */
  allowsBroadcast(): boolean {
    return this.getPosture() !== "HALTED";
  }

  /** False when treasury movements (refills, top-ups, splits) must not happen. */
  allowsTreasurySpend(): boolean {
    return this.getPosture() !== "HALTED";
  }

  /**
   * Requeue ceiling for a rejected payload. Zero means the payload is left as a
   * FAILED archive gap rather than paying to rebuild a transaction the network
   * is currently refusing.
   */
  maxRejectRequeues(): number {
    switch (this.getPosture()) {
      case "HALTED":
        return 0;
      case "CAUTIOUS":
        return 1;
      default:
        return this.config.maxRejectRequeues;
    }
  }

  /** Unconfirmed ancestors an output may have and still be considered spendable. */
  maxUnconfirmedChainDepth(): number {
    return this.getPosture() === "NORMAL"
      ? this.config.maxUnconfirmedChainDepth
      : this.config.cautiousUnconfirmedChainDepth;
  }

  getSnapshot(): SpendGuardSnapshot {
    return this.snapshotFor(this.getPosture());
  }

  private record(rejected: boolean): void {
    const now = Date.now();
    this.observations.push({ at: now, rejected });
    this.trim(now);
  }

  private trim(now: number): void {
    const cutoff = now - this.config.windowMs;
    let drop = 0;
    while (drop < this.observations.length && this.observations[drop]!.at < cutoff) {
      drop++;
    }
    if (drop > 0) this.observations.splice(0, drop);
  }

  private evaluate(): SpendPosture {
    if (this.config.paused) return "HALTED";

    const now = Date.now();
    this.trim(now);

    if (this.haltedUntil > now) return "HALTED";

    const { rejected, total } = this.counts();
    if (total < this.config.minSamples) return "NORMAL";

    const ratio = rejected / total;
    if (ratio >= this.config.haltRatio) {
      this.haltedUntil = now + this.config.haltCooldownMs;
      // The window is cleared so the cooldown measures fresh evidence rather
      // than re-tripping on the same burst that caused the halt.
      this.observations.length = 0;
      return "HALTED";
    }
    if (ratio >= this.config.cautiousRatio) return "CAUTIOUS";
    return "NORMAL";
  }

  private counts(): { rejected: number; total: number } {
    let rejected = 0;
    for (const observation of this.observations) {
      if (observation.rejected) rejected++;
    }
    return { rejected, total: this.observations.length };
  }

  private snapshotFor(posture: SpendPosture): SpendGuardSnapshot {
    const { rejected, total } = this.counts();
    return {
      posture,
      accepted: total - rejected,
      rejected,
      rejectRatio: total === 0 ? 0 : rejected / total,
      windowMs: this.config.windowMs,
      haltRemainingMs: Math.max(0, this.haltedUntil - Date.now()),
      paused: this.config.paused,
      maxUnconfirmedChainDepth:
        posture === "NORMAL"
          ? this.config.maxUnconfirmedChainDepth
          : this.config.cautiousUnconfirmedChainDepth,
      maxRejectRequeues:
        posture === "HALTED"
          ? 0
          : posture === "CAUTIOUS"
            ? 1
            : this.config.maxRejectRequeues,
    };
  }

  private publish(posture: SpendPosture): void {
    spendPostureGauge.set(POSTURE_METRIC_VALUE[posture]);
    const { rejected, total } = this.counts();
    spendRejectRatio.set(total === 0 ? 0 : rejected / total);
  }
}
