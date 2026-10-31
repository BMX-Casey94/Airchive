import { randomUUID } from "node:crypto";
import { PrivateKey } from "@bsv/sdk";
import type { Knex } from "knex";
import type { Redis } from "ioredis";
import { AlertSeverity } from "@airchive/types";
import {
  getFundingState,
  getPreservedWriteCount,
  insertAlert,
  TREASURY_SCOPE,
  upsertFundingState,
  type FundingStateName,
  type FundingStateRow,
} from "@airchive/db";
import { createLogger } from "@airchive/logger";
import type { Config } from "./config.js";
import type { Broadcaster } from "./broadcaster.js";
import type { FundingUtxoManager } from "./funding-utxo-manager.js";
import {
  MAX_REFILL_INPUTS,
  treasuryOutputFloorSats,
  type AutoRefillMonitor,
} from "./auto-refill.js";
import { estimateRefillFee } from "./tx-builder.js";
import {
  fundingRecoveriesTotal,
  fundingRunwayHours,
  fundingStateGauge,
  treasuryDry,
} from "./metrics.js";

const log = createLogger({ service: "blockchain-writer:funding-state" });

/** Accepts the real outcome and the boolean the recovery tests still return. */
function fundingReconcileApplied(
  result: boolean | { ok: boolean } | null | undefined,
): boolean {
  if (typeof result === "boolean") return result;
  return result?.ok === true;
}

const STATE_ORDINALS: Record<FundingStateName, number> = {
  HEALTHY: 0,
  LOW: 1,
  DRY: 2,
  RECOVERING: 3,
};

/**
 * Wall-clock smoothing window for the burn estimate. Weighting samples by
 * elapsed time rather than counting ticks keeps the figure meaningful if the
 * poll interval is ever retuned, and stops a 5s burst reading as a permanent
 * rate.
 */
const BURN_TIME_CONSTANT_MS = 30 * 60_000;
/** Channel the gateway relays to the dashboard for the funding banner. */
const FUNDING_CHANNEL = "funding-state";

function detailsRecord(details: FundingStateRow["details"] | undefined): Record<string, unknown> {
  if (!details) return {};
  if (typeof details === "string") {
    try {
      const parsed: unknown = JSON.parse(details);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
    return {};
  }
  return details;
}

export interface FundingSnapshot {
  state: FundingStateName;
  balanceSats: number;
  utxoCount: number;
  stateSince: string;
  lastCheckedAt: string | null;
  nextPollAt: string | null;
  consecutiveDryPolls: number;
  burnSatsPerHour: number;
  runwayHours: number | null;
  dryThresholdSats: number;
  lowThresholdSats: number;
  pendingWrites: number;
  dryAircraft: number;
  /**
   * While true, preserved outage rows must not be pruned or purged. Set for the
   * whole recovery and kept afterwards until those rows have been broadcast.
   */
  backlogShield: boolean;
}

/**
 * Persisted funding health for the treasury, with automatic recovery.
 *
 * The state, its dwell time, the poll backoff and the alert timestamps are in
 * Postgres. Recovery itself is not: it is an in-process procedure. A writer
 * that finds RECOVERING already persisted therefore resumes the procedure on
 * startup, and a step that fails or times out cannot leave the row there.
 */
export class FundingStateMachine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopped = false;
  private lastBalance: number | null = null;
  private lastBalanceAt = 0;
  private burnEma = 0;
  private burnInitialised = false;
  private cached: FundingSnapshot | null = null;
  /** True only while this process is inside runRecovery. Cleared in finally. */
  private recoveryInFlight = false;
  /**
   * Keeps preserved-backlog prune and the exhausted-row purge conservative
   * after RECOVERING has been left. Independent of the state name so a large
   * backlog can be drained by the normal retry loop without being deleted.
   */
  private backlogShield = false;
  /**
   * Published so operators can top the treasury up without shelling into the
   * host to read a log line. Derived from the WIF, which never leaves this
   * service — the address is public information, the key is not.
   */
  private readonly treasuryAddress: string;

  constructor(
    private readonly db: Knex,
    private readonly config: Config,
    private readonly fundingUtxoManager: FundingUtxoManager,
    private readonly autoRefill: AutoRefillMonitor,
    private readonly broadcaster: Broadcaster,
    private readonly publisher: Redis | null = null,
  ) {
    this.treasuryAddress = PrivateKey.fromWif(config.fundingWalletWif).toAddress();
  }

  /**
   * A single refill plus its worst-case fee. Refills combine inputs, so what
   * matters is the aggregate balance rather than the size of the largest
   * output; below this figure nothing can be funded at all.
   */
  get dryThresholdSats(): number {
    return (
      this.config.refillAmountSats
      + estimateRefillFee(this.config.refillMaxOutputsPerTx, true, MAX_REFILL_INPUTS)
      + 1_000
    );
  }

  get lowThresholdSats(): number {
    return this.dryThresholdSats * Math.max(1, this.config.funding.lowWatermarkRefills);
  }

  async start(): Promise<void> {
    this.stopped = false;
    // Re-establish the gauge and any dry gate before the first write lands.
    await this.tick().catch((err) =>
      log.error({ err }, "Initial funding state evaluation failed"),
    );

    this.timer = setInterval(() => {
      void this.tick();
    }, Math.max(5_000, this.config.funding.checkIntervalMs));

    log.info(
      {
        checkIntervalMs: this.config.funding.checkIntervalMs,
        dryThresholdSats: this.dryThresholdSats,
        lowThresholdSats: this.lowThresholdSats,
        dryPollBaseMs: this.config.funding.dryPollBaseMs,
        dryPollMaxMs: this.config.funding.dryPollMaxMs,
      },
      "Funding state machine started",
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Latest evaluated snapshot, served to the gateway without touching the chain. */
  snapshot(): FundingSnapshot | null {
    return this.cached;
  }

  isDry(): boolean {
    return this.cached?.state === "DRY";
  }

  isRecovering(): boolean {
    return this.cached?.state === "RECOVERING";
  }

  /**
   * True while recovery is running, or while a preserved outage backlog is
   * still shielded. Prune and purge consult this so leaving RECOVERING does
   * not start deleting rows the retry loop has not broadcast yet.
   */
  pausesBacklogMaintenance(): boolean {
    return this.recoveryInFlight || this.backlogShield || this.isRecovering();
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.evaluate();
    } catch (err) {
      log.error({ err }, "Funding state evaluation failed");
    } finally {
      this.ticking = false;
    }
  }

  private async evaluate(): Promise<void> {
    const previous = await getFundingState(this.db, TREASURY_SCOPE);
    const previousState = (previous?.state ?? "HEALTHY") as FundingStateName;
    this.adoptBacklogShield(previous);

    // RECOVERING is sticky in classify(), and runRecovery is started only from
    // a DRY → funded transition. A restart (or a tick that lands after the
    // in-memory procedure has gone) would otherwise refresh last_checked_at
    // forever and never leave the state. Resume when nothing in this process
    // is already running it, and do not persist over a completion that wins
    // the race against this tick.
    if (previousState === "RECOVERING") {
      if (this.recoveryInFlight || this.stopped) return;
      // Claim the procedure before the next await. A tick whose read started
      // before the exit commit must not launch a second consolidate/split.
      this.recoveryInFlight = true;
      try {
        const fresh = await this.withTimeout(
          getFundingState(this.db, TREASURY_SCOPE),
          this.stepTimeoutMs(),
          "resume-read",
        );
        if ((fresh?.state ?? "HEALTHY") !== "RECOVERING" || this.stopped) {
          this.recoveryInFlight = false;
          return;
        }
        const { balance, count } = await this.withTimeout(
          this.fundingUtxoManager.getBalance(),
          this.stepTimeoutMs(),
          "resume-balance",
        );
        if (this.stopped) {
          this.recoveryInFlight = false;
          return;
        }
        log.warn(
          { balance, utxoCount: count, stateSince: fresh?.state_since },
          "Persisted funding state is RECOVERING and no recovery is running — resuming",
        );
        this.startRecovery(balance, count);
      } catch (err) {
        this.recoveryInFlight = false;
        throw err;
      }
      return;
    }

    // While dry, chain polls follow the backoff schedule so an empty wallet is
    // not hammered every tick. Two important exceptions:
    //   1) Never advance next_poll_at on a skipped tick — doing so pushed the
    //      deadline further out every 15s and made reconcile unreachable.
    //   2) If the local pool already looks funded, verify against the chain
    //      immediately. Otherwise the UI can show a large balance while the
    //      badge stays DRY forever (and phantom UTXOs never get purged).
    if (previousState === "DRY" && !this.dryPollDue(previous)) {
      const local = await this.fundingUtxoManager.getBalance();
      const looksFunded =
        local.count > 0 && local.balance >= this.dryThresholdSats;

      if (!looksFunded) {
        await this.persist(previousState, previous, { skippedPoll: true }, false, {
          nextPollAt: previous?.next_poll_at
            ? new Date(previous.next_poll_at)
            : null,
          consecutiveDryPolls: previous?.consecutive_dry_polls ?? 0,
        });
        return;
      }

      log.info(
        {
          balance: local.balance,
          utxoCount: local.count,
          dryThresholdSats: this.dryThresholdSats,
        },
        "Local treasury pool looks funded while state is DRY — "
          + "forcing chain reconciliation ahead of the dry-poll schedule",
      );
    }

    let dryReconciled = previousState !== "DRY";
    if (previousState === "DRY") {
      const reconciled = await this.fundingUtxoManager
        .reconcile(this.config.fundingWalletWif)
        .catch((err) => {
          log.warn({ err }, "Dry-state funding reconciliation failed");
          return false as const;
        });
      dryReconciled = fundingReconcileApplied(reconciled);
    }

    const { balance, count } = await this.fundingUtxoManager.getBalance();
    this.updateBurnEstimate(balance);

    // Leaving DRY requires a successful chain reconcile. A stale local pool can
    // look flush (phantom UTXOs) while the address is empty, or the reverse —
    // never promote on unverified local figures alone.
    if (previousState === "DRY" && !dryReconciled) {
      await this.persist("DRY", previous, { reconcileFailed: true }, false, {
        nextPollAt: previous?.next_poll_at
          ? new Date(previous.next_poll_at)
          : new Date(Date.now() + this.config.funding.dryPollBaseMs),
        consecutiveDryPolls: previous?.consecutive_dry_polls ?? 0,
      });
      return;
    }

    const nextState = this.classify(balance, count, previousState);

    if (nextState === previousState) {
      await this.persist(nextState, previous, {});
      return;
    }

    log.info(
      { from: previousState, to: nextState, balance, utxoCount: count },
      "Funding state transition",
    );

    if (nextState === "DRY") {
      await this.onEnterDry(balance, count, previous);
      return;
    }

    if (previousState === "DRY" && (nextState === "LOW" || nextState === "HEALTHY")) {
      await this.persist("RECOVERING", previous, { recoveredBalance: balance }, true);
      if (!this.recoveryInFlight && !this.stopped) {
        this.recoveryInFlight = true;
        this.startRecovery(balance, count);
      }
      return;
    }

    await this.persist(nextState, previous, {}, true);

    if (nextState === "LOW") {
      log.warn(
        {
          balance,
          utxoCount: count,
          lowThresholdSats: this.lowThresholdSats,
          runwayHours: this.runwayHours(balance),
        },
        "Treasury below the low watermark — fund the wallet before it runs dry",
      );
      await this.raiseAlert(
        AlertSeverity.WARNING,
        "TREASURY_LOW",
        `Treasury at ${balance} sats (${this.runwayHoursLabel(balance)} of runway). `
          + "Fund the wallet to avoid an outage.",
        { balance, utxoCount: count, threshold: this.lowThresholdSats },
        previous,
      );
      return;
    }

    if (nextState === "HEALTHY") {
      treasuryDry.set(0);
    }
  }

  private classify(
    balance: number,
    count: number,
    previousState: FundingStateName,
  ): FundingStateName {
    // While this process is inside runRecovery the row stays RECOVERING.
    // A persisted RECOVERING with nothing in flight is resumed by evaluate()
    // before classify() is asked, so a restart cannot sit here forever.
    if (previousState === "RECOVERING" && this.recoveryInFlight) return "RECOVERING";
    if (count === 0 || balance < this.dryThresholdSats) return "DRY";
    if (balance < this.lowThresholdSats) return "LOW";
    return "HEALTHY";
  }

  private async onEnterDry(
    balance: number,
    count: number,
    previous: FundingStateRow | undefined,
  ): Promise<void> {
    treasuryDry.set(1);
    const nextPollAt = new Date(Date.now() + this.config.funding.dryPollBaseMs);

    await this.persist("DRY", previous, { balance, utxoCount: count }, true, {
      nextPollAt,
      consecutiveDryPolls: 0,
    });

    const pending = await this.pendingWriteCount();
    log.error(
      {
        balance,
        utxoCount: count,
        dryThresholdSats: this.dryThresholdSats,
        pendingWrites: pending,
      },
      "TREASURY DRY — writes are being preserved, not discarded. "
        + "Send funds to the funding wallet and the system will resume unattended",
    );

    await this.raiseAlert(
      AlertSeverity.CRITICAL,
      "TREASURY_DRY",
      `Treasury exhausted at ${balance} sats. ${pending} pending writes are being held. `
        + "The system will resume automatically once the funding wallet is topped up.",
      { balance, utxoCount: count, pendingWrites: pending },
      previous,
      true,
    );
  }

  /**
   * Caller has already set `recoveryInFlight`. The flag is cleared when the
   * procedure finishes, including when a step throws, so a restart can resume
   * and a live process cannot start a second one.
   */
  private startRecovery(balance: number, count: number): void {
    // Shield before the first await inside runRecovery. Prune must stay paused
    // for the whole procedure, including the gap before the row leaves RECOVERING.
    this.backlogShield = true;
    void this.runRecovery(balance, count).finally(() => {
      this.recoveryInFlight = false;
    });
  }

  /**
   * Chain truth, then pool shape, then a refill pass. The preserved backlog is
   * not drained here: the write-buffer retry loop already does that, and waiting
   * for hundreds of thousands of rows is what kept RECOVERING from ever ending.
   * Leaving the state is therefore not gated on the backlog.
   */
  private async runRecovery(balance: number, count: number): Promise<void> {
    const startedAt = Date.now();
    try {
      log.info({ balance, utxoCount: count }, "Funding detected — starting recovery");
      const interrupted = await this.runRecoverySteps();
      if (!interrupted) {
        log.warn(
          "Funding recovery interrupted by shutdown — leaving RECOVERING so the next process resumes",
        );
        return;
      }
      await this.finishRecovery(startedAt);
    } catch (err) {
      log.error(
        { err },
        "Funding recovery failed — exiting RECOVERING so the state cannot stay pinned",
      );
      await this.finishRecovery(startedAt, err);
    }
  }

  /**
   * @returns false when shutdown asked us to stop before the pool steps finished.
   *          The persisted state is left as RECOVERING so startup can resume.
   */
  private async runRecoverySteps(): Promise<boolean> {
    const reconcile = await this.runBoundedStep("reconcile", () =>
      this.fundingUtxoManager.reconcile(this.config.fundingWalletWif),
    );
    if (reconcile === "stopped") return false;
    if (reconcile === "in-flight") {
      // A reconcile that is still writing the pool must not race a split: it
      // would delete outputs the chain has not advertised yet.
      log.error(
        "Skipping treasury consolidate, split and refill — reconciliation is still in flight",
      );
      return true;
    }

    const floorSats = treasuryOutputFloorSats(
      this.config.refillAmountSats,
      this.config.refillMaxOutputsPerTx,
    );

    // Change accrued during the outage is often below the refill floor, so
    // sweep it back into usable outputs before splitting for concurrency.
    const consolidate = await this.runBoundedStep("consolidate", () =>
      this.fundingUtxoManager.consolidateIfFragmented(
        this.config.fundingWalletWif,
        this.broadcaster,
        floorSats,
      ),
    );
    if (consolidate === "stopped") return false;
    if (consolidate === "in-flight") {
      log.error(
        "Skipping funding split and refill — consolidation is still in flight and a second spend must not overlap it",
      );
      return true;
    }

    const split = await this.runBoundedStep("split", () =>
      this.fundingUtxoManager.splitIfNeeded(
        this.config.fundingWalletWif,
        this.broadcaster,
        this.config.fundingPoolSplitTarget,
        floorSats,
        this.splitMaxCostSats(),
      ),
    );
    if (split === "stopped") return false;
    if (split === "in-flight") {
      log.error("Skipping recovery refill — the treasury split is still in flight");
      return true;
    }

    // The outage accumulated a backoff that would reject the recovery pass.
    this.autoRefill.resetTreasuryBackoff();
    const refill = await this.runBoundedStep("refill", () => this.autoRefill.checkAll(false));
    if (refill === "stopped") return false;
    return true;
  }

  /**
   * One attempt has a deadline. A thrown error is retried up to the configured
   * bound. A timeout is not retried: the attempt may still be broadcasting, and
   * a second call could spend the treasury again.
   */
  private async runBoundedStep(
    step: string,
    run: () => Promise<unknown>,
  ): Promise<"ok" | "failed" | "in-flight" | "stopped"> {
    const attempts = this.stepAttempts();
    const timeoutMs = this.stepTimeoutMs();
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (this.stopped) return "stopped";
      let settled = false;
      const attemptPromise = Promise.resolve().then(run).then(
        (value) => {
          settled = true;
          return value;
        },
        (err: unknown) => {
          settled = true;
          throw err;
        },
      );
      try {
        await this.withTimeout(attemptPromise, timeoutMs, step);
        return "ok";
      } catch (err) {
        const timedOut = !settled;
        log.error(
          { err, step, attempt, attempts, timeoutMs, timedOut },
          timedOut
            ? "Funding recovery step timed out"
            : "Funding recovery step failed",
        );
        if (timedOut) {
          log.error(
            { step, attempt },
            "Funding recovery step still in flight after timeout — not retrying, so a second treasury spend is not launched",
          );
          void attemptPromise.catch((lateErr: unknown) => {
            log.error(
              { err: lateErr, step },
              "Funding recovery step settled with an error after timeout",
            );
          });
          return "in-flight";
        }
        if (attempt >= attempts) {
          log.error(
            { step, attempts },
            "Funding recovery step exhausted its retries — continuing so RECOVERING cannot stick",
          );
          return "failed";
        }
      }
    }
    return "failed";
  }

  private withTimeout<T>(work: Promise<T>, timeoutMs: number, step: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Funding recovery step ${step} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /** Persists the real treasury classification. Never writes RECOVERING back. */
  private async finishRecovery(startedAt: number, failure?: unknown): Promise<void> {
    if (this.stopped) return;

    let balance = this.lastBalance ?? 0;
    let count = this.cached?.utxoCount ?? 0;
    try {
      const finalBalance = await this.withTimeout(
        this.fundingUtxoManager.getBalance(),
        this.stepTimeoutMs(),
        "final-balance",
      );
      balance = finalBalance.balance;
      count = finalBalance.count;
    } catch (err) {
      log.error(
        { err },
        "Funding recovery could not read the treasury balance — exiting RECOVERING with the last known figures",
      );
    }

    const state = this.classify(balance, count, "HEALTHY");
    let preserved: number | null = null;
    try {
      preserved = await getPreservedWriteCount(this.db);
    } catch (err) {
      log.error(
        { err },
        "Funding recovery could not count preserved writes — keeping the backlog shield",
      );
    }
    // Unknown means keep the shield. Zero means there is nothing left to protect.
    this.backlogShield = preserved === null || preserved > 0;

    try {
      await this.persist(
        state,
        undefined,
        {
          recoveredIn: Date.now() - startedAt,
          backlogShield: this.backlogShield,
          ...(failure !== undefined ? { recoveryError: String(failure) } : {}),
        },
        true,
        { nextPollAt: null, consecutiveDryPolls: 0 },
      );
    } catch (err) {
      log.error({ err, state }, "Funding recovery could not persist the exit state");
      return;
    }

    if (state !== "DRY") {
      treasuryDry.set(0);
      fundingRecoveriesTotal.inc();
    }

    log.info(
      {
        balance,
        utxoCount: count,
        state,
        backlogShield: this.backlogShield,
        preservedWrites: preserved,
        durationMs: Date.now() - startedAt,
        failed: failure !== undefined,
      },
      "Funding recovery complete",
    );

    if (failure !== undefined) return;

    await this.raiseAlert(
      AlertSeverity.INFO,
      "TREASURY_RECOVERED",
      `Treasury refunded to ${balance} sats. Held writes stay in the retry buffer`
        + (this.backlogShield ? " and will not be pruned until they have been broadcast." : "."),
      { balance, utxoCount: count, backlogShield: this.backlogShield, preservedWrites: preserved },
      undefined,
      true,
    );
  }

  private stepAttempts(): number {
    const configured = this.config.funding.recoveryStepAttempts;
    if (!Number.isFinite(configured) || configured < 1) return 3;
    return Math.min(5, Math.floor(configured));
  }

  private stepTimeoutMs(): number {
    const configured = this.config.funding.recoveryStepTimeoutMs;
    if (!Number.isFinite(configured) || configured < 1_000) return 120_000;
    return Math.min(configured, 10 * 60_000);
  }

  private splitMaxCostSats(): number {
    const configured = this.config.funding.splitMaxCostSats;
    if (!Number.isFinite(configured) || configured < 0) return 50_000;
    return Math.floor(configured);
  }

  private adoptBacklogShield(previous: FundingStateRow | undefined): void {
    if (detailsRecord(previous?.details).backlogShield === true) {
      this.backlogShield = true;
    }
  }

  private dryPollDue(previous: FundingStateRow | undefined): boolean {
    const next = previous?.next_poll_at;
    if (!next) return true;
    return Date.now() >= new Date(next).getTime();
  }

  private nextDryBackoffMs(consecutivePolls: number): number {
    const base = Math.max(1_000, this.config.funding.dryPollBaseMs);
    const ceiling = Math.max(base, this.config.funding.dryPollMaxMs);
    return Math.min(ceiling, base * 2 ** Math.min(consecutivePolls, 16));
  }

  /**
   * Quiet intervals count as zero burn. Sampling only the intervals that
   * happened to contain a spend measured the burn rate *while spending*, which
   * is a different quantity from the average burn and made the runway read
   * materially shorter than the treasury actually had.
   *
   * A balance increase means a top-up landed, which masks whatever was spent
   * alongside it, so those intervals carry no usable signal and are skipped.
   * The estimate stays uninitialised — and the runway unreported — until real
   * spending has been observed, rather than starting from an optimistic zero.
   */
  private updateBurnEstimate(balance: number): void {
    const now = Date.now();
    const elapsedMs = now - this.lastBalanceAt;
    const previous = this.lastBalance;
    this.lastBalance = balance;
    this.lastBalanceAt = now;

    if (previous === null || elapsedMs <= 0) return;

    const spent = previous - balance;
    if (spent < 0) return;

    const instantaneous = spent / (elapsedMs / 3_600_000);
    if (!this.burnInitialised) {
      if (spent === 0) return;
      this.burnEma = instantaneous;
      this.burnInitialised = true;
      return;
    }

    const alpha = 1 - Math.exp(-elapsedMs / BURN_TIME_CONSTANT_MS);
    this.burnEma += alpha * (instantaneous - this.burnEma);
  }

  private runwayHours(balance: number): number | null {
    if (this.burnEma <= 0) return null;
    return balance / this.burnEma;
  }

  private runwayHoursLabel(balance: number): string {
    const hours = this.runwayHours(balance);
    if (hours === null) return "an unknown amount";
    return `${hours.toFixed(1)}h`;
  }

  private async pendingWriteCount(): Promise<number> {
    const row = await this.db("pending_writes")
      .count<{ count: string | number }>("* as count")
      .first();
    return Number(row?.count ?? 0);
  }

  private async persist(
    state: FundingStateName,
    previous: FundingStateRow | undefined,
    details: Record<string, unknown>,
    changed = false,
    overrides: {
      nextPollAt?: Date | null;
      consecutiveDryPolls?: number;
      lastAlertAt?: Date | null;
    } = {},
  ): Promise<void> {
    const { balance, count } = await this.fundingUtxoManager.getBalance();

    let nextPollAt = overrides.nextPollAt;
    let dryPolls = overrides.consecutiveDryPolls;
    if (state === "DRY" && nextPollAt === undefined) {
      const polls = (previous?.consecutive_dry_polls ?? 0) + 1;
      dryPolls = polls;
      nextPollAt = new Date(Date.now() + this.nextDryBackoffMs(polls));
    }

    if (details.backlogShield === true) this.backlogShield = true;
    if (details.backlogShield === false) this.backlogShield = false;
    const preserved = await getPreservedWriteCount(this.db).catch((err: unknown) => {
      log.error({ err }, "Preserved write count failed — backlog shield left unchanged");
      return null;
    });
    // Nothing preserved means there is nothing for the shield to protect.
    // A failed count leaves the shield as it was, which is the conservative side.
    if (preserved === 0) this.backlogShield = false;

    await upsertFundingState(this.db, TREASURY_SCOPE, {
      state,
      balance_sats: balance,
      utxo_count: count,
      resetSince: changed,
      next_poll_at: nextPollAt,
      consecutive_dry_polls: state === "DRY" ? dryPolls : 0,
      burn_sats_per_hour: this.burnEma,
      ...(overrides.lastAlertAt !== undefined ? { last_alert_at: overrides.lastAlertAt } : {}),
      details: {
        ...details,
        dryThresholdSats: this.dryThresholdSats,
        lowThresholdSats: this.lowThresholdSats,
        treasuryAddress: this.treasuryAddress,
        backlogShield: this.backlogShield,
      },
    });

    const pendingWrites = await this.pendingWriteCount();
    const snapshot: FundingSnapshot = {
      state,
      balanceSats: balance,
      utxoCount: count,
      stateSince: changed
        ? new Date().toISOString()
        : (previous?.state_since ?? new Date()).toISOString(),
      lastCheckedAt: new Date().toISOString(),
      nextPollAt: nextPollAt ? nextPollAt.toISOString() : null,
      consecutiveDryPolls: state === "DRY" ? (dryPolls ?? 0) : 0,
      burnSatsPerHour: Math.round(this.burnEma),
      runwayHours: this.runwayHours(balance),
      dryThresholdSats: this.dryThresholdSats,
      lowThresholdSats: this.lowThresholdSats,
      pendingWrites,
      dryAircraft: this.autoRefill.getDryAircraftCount(),
      backlogShield: this.backlogShield,
    };
    this.cached = snapshot;

    fundingStateGauge.set({ scope: TREASURY_SCOPE }, STATE_ORDINALS[state]);
    if (snapshot.runwayHours !== null) {
      fundingRunwayHours.set(snapshot.runwayHours);
    }

    await this.publisher
      ?.publish(FUNDING_CHANNEL, JSON.stringify(snapshot))
      .catch(() => {});
  }

  /**
   * Persists the alert so it appears in the audit trail and dashboard, and lets
   * the alert engine dispatch it over SendGrid/Twilio. Repeats are rate limited
   * so a week-long outage does not become a week of paging.
   */
  private async raiseAlert(
    severity: AlertSeverity,
    type: string,
    message: string,
    data: Record<string, unknown>,
    previous: FundingStateRow | undefined,
    force = false,
  ): Promise<void> {
    const lastAlertAt = previous?.last_alert_at
      ? new Date(previous.last_alert_at).getTime()
      : 0;
    if (!force && Date.now() - lastAlertAt < this.config.funding.alertRepeatMs) {
      return;
    }

    const id = randomUUID();
    try {
      await insertAlert(this.db, {
        id,
        // Funding is fleet-wide, so it is scoped to the system rather than a tail.
        aircraft_icao: "SYSTEM",
        severity,
        type,
        message,
        data,
      });
    } catch (err) {
      log.error({ err, type }, "Failed to persist funding alert");
    }

    await this.publisher
      ?.publish(
        "alerts",
        JSON.stringify({
          id,
          aircraft_icao: "SYSTEM",
          severity,
          type,
          message,
          data,
          created_at: new Date().toISOString(),
        }),
      )
      .catch(() => {});

    await upsertFundingState(this.db, TREASURY_SCOPE, {
      state: (this.cached?.state ?? "HEALTHY") as FundingStateName,
      balance_sats: this.cached?.balanceSats ?? 0,
      utxo_count: this.cached?.utxoCount ?? 0,
      resetSince: false,
      last_alert_at: new Date(),
    }).catch(() => {});
  }
}
