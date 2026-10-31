import { createLogger } from "@airchive/logger";
import {
  spendGuardTransitionsTotal,
  spendPostureGauge,
  spendRejectRatio,
  spendStaleRejectsTotal,
} from "./metrics.js";

const log = createLogger({ service: "blockchain-writer:spend-governor" });

/**
 * How much of the treasury the writer is currently willing to risk.
 *
 * `NORMAL`   — ordinary operation.
 * `CAUTIOUS` — rejections are elevated: only near-settled outputs are spent and
 *              a rejected payload gets one retry rather than three.
 * `PROBING`  — a halt has expired and a small, budgeted trial is being spent to
 *              find out whether the network is accepting again.
 * `HALTED`   — nothing is broadcast at all. Samples are preserved in
 *              `pending_writes` instead of being paid for, so no fee is spent
 *              on transactions the network is currently refusing.
 */
export type SpendPosture = "NORMAL" | "CAUTIOUS" | "PROBING" | "HALTED";

// HALTED keeps its original value so existing dashboards and alert rules that
// compare against 2 continue to mean the same thing.
const POSTURE_METRIC_VALUE: Record<SpendPosture, number> = {
  NORMAL: 0,
  CAUTIOUS: 1,
  HALTED: 2,
  PROBING: 3,
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
  /** Cooldown for a first halt, doubled for each halt that follows it. */
  haltCooldownMs: number;
  /** Ceiling the doubling stops at, so a broken upstream cannot lock out forever. */
  haltCooldownMaxMs: number;
  /** Transactions a post-halt trial may spend before it must wait for verdicts. */
  probeBudget: number;
  /** How long a trial waits for the network's answer before declaring success. */
  probeSettleMs: number;
  /** Unconfirmed ancestors an output may have and still be spent. */
  maxUnconfirmedChainDepth: number;
  /** Tighter ceiling applied while CAUTIOUS or PROBING. */
  cautiousUnconfirmedChainDepth: number;
  /** Requeue ceiling for a rejected payload while NORMAL. */
  maxRejectRequeues: number;
}

interface Observation {
  at: number;
  rejected: boolean;
}

/**
 * A bounded trial spent after a halt expires.
 *
 * `settleUntil` is null while the trial is still allowed to broadcast and is
 * stamped once the budget runs out, at which point spending stops and the
 * governor simply waits to hear back.
 */
interface Probe {
  startedAt: number;
  spent: number;
  rejected: number;
  settleUntil: number | null;
}

export interface SpendGuardProbeSnapshot {
  spent: number;
  budget: number;
  rejected: number;
  settling: boolean;
  settleRemainingMs: number;
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
  /** Consecutive halts without an intervening clean trial; drives the backoff. */
  consecutiveHalts: number;
  /** Cooldown length applied by the most recent halt. */
  lastHaltCooldownMs: number;
  lastHaltReason: string | null;
  /**
   * Rejections excluded from the ratio and from trials. Covers verdicts that
   * arrived while spending was already stopped, and verdicts on transactions
   * broadcast before the current evidence window or before the open trial.
   */
  staleRejectsWhileHalted: number;
  probe: SpendGuardProbeSnapshot | null;
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
 *
 * Two properties of the evidence shape the design:
 *
 * Acceptance is known immediately but rejection arrives seconds later over SSE,
 * so a freshly reopened window reads as healthy long before the bad news lands.
 * Judging on the ratio alone therefore lets a resume broadcast thousands of
 * doomed transactions during the blind spot; recovery instead spends a fixed
 * budget and then waits to be told the answer.
 *
 * A rejection that arrives while spending is already stopped is a verdict on a
 * transaction paid for before the stop. It is not evidence about the present,
 * and counting it pins the window at a 100% reject rate with no accepted
 * broadcasts to dilute it, so every cooldown expires straight back into a halt.
 *
 * A rejection whose transaction was broadcast before the evidence being judged
 * is the same kind of verdict: before the open trial, or earlier than the
 * rolling window. It is counted as stale and left out of the ratio. A verdict
 * with no broadcast time is treated the same way, because it cannot be shown
 * to describe a transaction from inside that window.
 */
export class SpendGovernor {
  private readonly observations: Observation[] = [];
  private haltedUntil = 0;
  private consecutiveHalts = 0;
  private lastHaltCooldownMs = 0;
  private lastHaltReason: string | null = null;
  private staleRejects = 0;
  private probe: Probe | null = null;
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

  /**
   * @param broadcastAtMs When the rejected transaction was broadcast, epoch
   *   milliseconds. A time before the open trial, or before the rolling
   *   evidence window, is stale and does not move the ratio. `null`, an
   *   unknown time, or omitting the argument counts the verdict as current:
   *   treasury refills and splits have no tx_results clock, and a storm of
   *   those must still halt spending.
   */
  noteTerminalRejection(broadcastAtMs?: number | null): void {
    this.record(true, broadcastAtMs);
  }

  /**
   * Counts a transaction handed to an upstream against the trial's allowance.
   *
   * Budgeting here rather than at the archive call sites means refills, agent
   * top-ups and treasury reshaping consume the allowance too, so a recovery
   * cannot quietly spend the wallet on pool maintenance while it is supposed to
   * be testing the water with a handful of transactions.
   */
  noteBroadcastDispatched(): void {
    if (this.probe) this.probe.spent++;
  }

  /** True while the operator kill switch is set. */
  isPaused(): boolean {
    return this.config.paused;
  }

  getPosture(): SpendPosture {
    const posture = this.evaluate();
    if (posture !== this.lastPosture) {
      this.logTransition(posture);
      this.lastPosture = posture;
    }
    this.publish(posture);
    return posture;
  }

  /** False when no transaction of any kind may be broadcast. */
  allowsBroadcast(): boolean {
    const posture = this.getPosture();
    if (posture === "HALTED") return false;
    if (posture === "PROBING") {
      return this.probe !== null
        && this.probe.settleUntil === null
        && this.probe.spent < this.config.probeBudget;
    }
    return true;
  }

  /**
   * False when treasury movements (refills, top-ups, splits) must not happen.
   * A trial spends its budget on the archive itself rather than on reshaping
   * the pool, so treasury work waits for the trial to clear.
   */
  allowsTreasurySpend(): boolean {
    return this.allowsBroadcast();
  }

  /**
   * Requeue ceiling for a rejected payload. Zero means the payload is left as a
   * FAILED archive gap rather than paying to rebuild a transaction the network
   * is currently refusing.
   */
  maxRejectRequeues(): number {
    switch (this.getPosture()) {
      case "HALTED":
      case "PROBING":
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

  private record(rejected: boolean, broadcastAtMs?: number | null): void {
    const now = Date.now();

    if (this.probe) {
      // Only a transaction broadcast during this trial is evidence about it.
      // Acceptance is recorded at broadcast time, so an accept cannot describe
      // an earlier transaction; rejections arrive later and can.
      if (rejected && this.verdictIsStale(broadcastAtMs, this.probe.startedAt)) {
        this.recordStaleReject();
        return;
      }
      if (rejected) this.probe.rejected++;
      this.observations.push({ at: now, rejected });
      this.trim(now);
      return;
    }

    // Verdicts that arrive after spending stopped describe transactions already
    // paid for. Folding them into the window would keep the reject ratio at 1
    // with nothing accepted to offset it, so the cooldown could never end.
    if (this.isHardStopped(now)) {
      if (rejected) this.recordStaleReject();
      return;
    }

    // Outside a trial the evidence window is the last SPEND_GUARD_WINDOW_MS.
    // A rejection of an older broadcast must not share that window with fresh
    // accepts. The opening instant of the window still counts, matching trim.
    if (rejected && this.verdictIsStale(broadcastAtMs, now - this.config.windowMs)) {
      this.recordStaleReject();
      return;
    }

    this.observations.push({ at: now, rejected });
    this.trim(now);
  }

  /**
   * True when this rejection must not enter the ratio or the open trial.
   * An omitted broadcast time is not stale. An explicit null, or a non-finite
   * value, is unknown and is excluded. A finite time is stale when it falls
   * before `notBefore`.
   */
  private verdictIsStale(
    broadcastAtMs: number | null | undefined,
    notBefore: number,
  ): boolean {
    if (broadcastAtMs === undefined || broadcastAtMs === null) return false;
    if (!Number.isFinite(broadcastAtMs)) return false;
    return broadcastAtMs < notBefore;
  }

  private recordStaleReject(): void {
    this.staleRejects++;
    spendStaleRejectsTotal.inc();
  }

  private isHardStopped(now: number): boolean {
    return this.config.paused || this.haltedUntil > now;
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

    if (this.probe) return this.evaluateProbe(now);

    if (this.haltedUntil > now) return "HALTED";

    if (this.haltedUntil > 0) {
      // The cooldown is up. Reopening the taps outright would spend at full rate
      // through the window where rejections have not been reported yet, so the
      // writer buys a bounded amount of evidence instead.
      this.haltedUntil = 0;
      this.observations.length = 0;
      this.probe = { startedAt: now, spent: 0, rejected: 0, settleUntil: null };
      return "PROBING";
    }

    const { rejected, total } = this.counts();
    if (total < this.config.minSamples) return "NORMAL";

    const ratio = rejected / total;
    if (ratio >= this.config.haltRatio) {
      this.beginHalt(now, "reject_ratio");
      return "HALTED";
    }
    if (ratio >= this.config.cautiousRatio) return "CAUTIOUS";
    return "NORMAL";
  }

  private evaluateProbe(now: number): SpendPosture {
    const probe = this.probe!;

    // The trial exists to find a single rejection cheaply, so one is decisive.
    if (probe.rejected > 0) {
      this.beginHalt(now, "probe_rejected");
      return "HALTED";
    }

    // A trial that cannot spend its budget — because the fleet is quiet or every
    // broadcast is failing locally — must still conclude rather than sit open.
    const budgetSpent = probe.spent >= this.config.probeBudget;
    const expired = now - probe.startedAt >= this.config.probeSettleMs * 3;

    if (!budgetSpent && !expired) return "PROBING";

    if (probe.settleUntil === null) {
      probe.settleUntil = now + this.config.probeSettleMs;
      return "PROBING";
    }
    if (now < probe.settleUntil) return "PROBING";

    this.probe = null;
    this.consecutiveHalts = 0;
    this.observations.length = 0;
    return "NORMAL";
  }

  /**
   * Each halt without an intervening clean trial doubles the wait, so a network
   * that is genuinely refusing costs one small trial per hour rather than one
   * every cooldown.
   */
  private beginHalt(now: number, reason: string): void {
    const cooldown = Math.min(
      this.config.haltCooldownMaxMs,
      this.config.haltCooldownMs * 2 ** this.consecutiveHalts,
    );
    this.consecutiveHalts = Math.min(this.consecutiveHalts + 1, 16);
    this.haltedUntil = now + cooldown;
    this.lastHaltCooldownMs = cooldown;
    this.lastHaltReason = reason;
    this.probe = null;
    this.observations.length = 0;
  }

  private counts(): { rejected: number; total: number } {
    let rejected = 0;
    for (const observation of this.observations) {
      if (observation.rejected) rejected++;
    }
    return { rejected, total: this.observations.length };
  }

  private logTransition(posture: SpendPosture): void {
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
      consecutiveHalts: snapshot.consecutiveHalts,
      staleRejectsWhileHalted: snapshot.staleRejectsWhileHalted,
    };

    if (posture === "HALTED") {
      log.error(
        { ...detail, reason: snapshot.lastHaltReason, cooldownMs: snapshot.lastHaltCooldownMs },
        "Spend halted — rejections exceeded the safe share of recent broadcasts; "
          + "samples are preserved in pending_writes instead of paying fees",
      );
    } else if (posture === "PROBING") {
      log.warn(
        { ...detail, probeBudget: this.config.probeBudget },
        "Spend trial started — a capped number of transactions will be broadcast to "
          + "test whether the network is accepting again, then spending pauses for the verdict",
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
  }

  private snapshotFor(posture: SpendPosture): SpendGuardSnapshot {
    const { rejected, total } = this.counts();
    const now = Date.now();
    return {
      posture,
      accepted: total - rejected,
      rejected,
      rejectRatio: total === 0 ? 0 : rejected / total,
      windowMs: this.config.windowMs,
      haltRemainingMs: Math.max(0, this.haltedUntil - now),
      paused: this.config.paused,
      maxUnconfirmedChainDepth:
        posture === "NORMAL"
          ? this.config.maxUnconfirmedChainDepth
          : this.config.cautiousUnconfirmedChainDepth,
      maxRejectRequeues:
        posture === "HALTED" || posture === "PROBING"
          ? 0
          : posture === "CAUTIOUS"
            ? 1
            : this.config.maxRejectRequeues,
      consecutiveHalts: this.consecutiveHalts,
      lastHaltCooldownMs: this.lastHaltCooldownMs,
      lastHaltReason: this.lastHaltReason,
      staleRejectsWhileHalted: this.staleRejects,
      probe: this.probe
        ? {
            spent: this.probe.spent,
            budget: this.config.probeBudget,
            rejected: this.probe.rejected,
            settling: this.probe.settleUntil !== null,
            settleRemainingMs: Math.max(0, (this.probe.settleUntil ?? now) - now),
          }
        : null,
    };
  }

  private publish(posture: SpendPosture): void {
    spendPostureGauge.set(POSTURE_METRIC_VALUE[posture]);
    const { rejected, total } = this.counts();
    spendRejectRatio.set(total === 0 ? 0 : rejected / total);
  }
}
