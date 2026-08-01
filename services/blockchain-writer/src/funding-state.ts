import { randomUUID } from "node:crypto";
import { PrivateKey } from "@bsv/sdk";
import type { Knex } from "knex";
import type { Redis } from "ioredis";
import { AlertSeverity } from "@airchive/types";
import {
  getFundingState,
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
import type { WriteBuffer } from "./write-buffer.js";
import { estimateRefillFee } from "./tx-builder.js";
import {
  fundingRecoveriesTotal,
  fundingRunwayHours,
  fundingStateGauge,
  treasuryDry,
} from "./metrics.js";

const log = createLogger({ service: "blockchain-writer:funding-state" });

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
}

/**
 * Persisted funding health for the treasury, with automatic recovery.
 *
 * The important property is that no part of the recovery path lives in memory
 * only: the state, its dwell time, the poll backoff and the alert timestamps
 * are all in Postgres, so a writer restarted halfway through a multi-day
 * funding outage resumes exactly where it left off and needs no intervention
 * beyond somebody sending coins to the funding address.
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
    private readonly writeBuffer: WriteBuffer,
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
      dryReconciled = await this.fundingUtxoManager
        .reconcile(this.config.fundingWalletWif)
        .catch((err) => {
          log.warn({ err }, "Dry-state funding reconciliation failed");
          return false;
        });
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
      void this.runRecovery(balance, count);
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
    // A recovery in progress owns the state until runRecovery finishes.
    if (previousState === "RECOVERING") return "RECOVERING";
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
   * Ordered recovery: chain truth first, then pool shape, then the aircraft that
   * are actually flying, and only then the backlog — drained under a batch cap so
   * a long outage does not turn into a broadcast stampede on the way out.
   */
  private async runRecovery(balance: number, count: number): Promise<void> {
    const startedAt = Date.now();
    try {
      log.info({ balance, utxoCount: count }, "Funding detected — starting recovery");

      await this.fundingUtxoManager
        .reconcile(this.config.fundingWalletWif)
        .catch((err) => log.warn({ err }, "Recovery reconciliation failed"));

      const floorSats = treasuryOutputFloorSats(
        this.config.refillAmountSats,
        this.config.refillMaxOutputsPerTx,
      );

      // Change accrued during the outage is often below the refill floor, so
      // sweep it back into usable outputs before splitting for concurrency.
      await this.fundingUtxoManager
        .consolidateIfFragmented(
          this.config.fundingWalletWif,
          this.broadcaster,
          floorSats,
        )
        .catch((err) => log.error({ err }, "Recovery consolidation failed"));

      await this.fundingUtxoManager
        .splitIfNeeded(
          this.config.fundingWalletWif,
          this.broadcaster,
          this.config.fundingPoolSplitTarget,
          floorSats,
        )
        .catch((err) => log.error({ err }, "Recovery funding split failed"));

      // The outage accumulated a backoff that would reject the recovery pass.
      this.autoRefill.resetTreasuryBackoff();

      // Active aircraft first: checkAll orders the fleet by recent activity.
      await this.autoRefill
        .checkAll(false)
        .catch((err) => log.error({ err }, "Recovery refill pass failed"));

      this.writeBuffer.setDrainBatchSize(this.config.funding.recoveryDrainBatchSize);
      const drained = await this.drainBacklog();

      const final = await this.fundingUtxoManager.getBalance();
      const state = this.classify(final.balance, final.count, "HEALTHY");
      await this.persist(state, undefined, { recoveredIn: Date.now() - startedAt }, true, {
        nextPollAt: null,
        consecutiveDryPolls: 0,
      });
      if (state !== "DRY") {
        treasuryDry.set(0);
        fundingRecoveriesTotal.inc();
      }

      log.info(
        {
          balance: final.balance,
          utxoCount: final.count,
          drained,
          durationMs: Date.now() - startedAt,
          state,
        },
        "Funding recovery complete",
      );

      await this.raiseAlert(
        AlertSeverity.INFO,
        "TREASURY_RECOVERED",
        `Treasury refunded to ${final.balance} sats. ${drained} held writes drained.`,
        { balance: final.balance, utxoCount: final.count, drained },
        undefined,
        true,
      );
    } catch (err) {
      log.error({ err }, "Funding recovery failed — reverting to evaluation");
      await this.persist("DRY", undefined, { recoveryError: String(err) }, true, {
        nextPollAt: new Date(Date.now() + this.config.funding.dryPollBaseMs),
      });
    } finally {
      this.writeBuffer.setDrainBatchSize(null);
    }
  }

  /** Drains the preserved backlog in capped cycles until it stops shrinking. */
  private async drainBacklog(): Promise<number> {
    let drained = 0;
    for (let cycle = 0; cycle < 200; cycle++) {
      if (this.stopped) break;
      const remaining = await this.pendingWriteCount();
      if (remaining === 0) break;
      const written = await this.writeBuffer.retry();
      drained += written;
      if (written === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return drained;
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
        dryThresholdSats: this.dryThresholdSats,
        lowThresholdSats: this.lowThresholdSats,
        treasuryAddress: this.treasuryAddress,
        ...details,
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
