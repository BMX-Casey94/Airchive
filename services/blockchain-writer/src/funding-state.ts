import { randomUUID } from "node:crypto";
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

/** Smoothing factor for the burn estimate; low enough to ignore single spikes. */
const BURN_EMA_ALPHA = 0.25;
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
  private cached: FundingSnapshot | null = null;

  constructor(
    private readonly db: Knex,
    private readonly config: Config,
    private readonly fundingUtxoManager: FundingUtxoManager,
    private readonly autoRefill: AutoRefillMonitor,
    private readonly writeBuffer: WriteBuffer,
    private readonly broadcaster: Broadcaster,
    private readonly publisher: Redis | null = null,
  ) {}

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

    // While dry the pool is only refreshed on the backoff schedule; polling WoC
    // every 15 seconds for an address nobody has funded yet is pure noise.
    if (previousState === "DRY" && !this.dryPollDue(previous)) {
      await this.persist(previousState, previous, { skippedPoll: true });
      return;
    }

    if (previousState === "DRY") {
      await this.fundingUtxoManager
        .reconcile(this.config.fundingWalletWif)
        .catch((err) => log.warn({ err }, "Dry-state funding reconciliation failed"));
    }

    const { balance, count } = await this.fundingUtxoManager.getBalance();
    this.updateBurnEstimate(balance);

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

  private updateBurnEstimate(balance: number): void {
    const now = Date.now();
    if (this.lastBalance !== null && now > this.lastBalanceAt) {
      const spent = this.lastBalance - balance;
      const hours = (now - this.lastBalanceAt) / 3_600_000;
      if (spent > 0 && hours > 0) {
        const instantaneous = spent / hours;
        this.burnEma = this.burnEma === 0
          ? instantaneous
          : this.burnEma * (1 - BURN_EMA_ALPHA) + instantaneous * BURN_EMA_ALPHA;
      }
    }
    this.lastBalance = balance;
    this.lastBalanceAt = now;
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
