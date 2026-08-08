import { PrivateKey } from "@bsv/sdk";
import { createLogger } from "@airchive/logger";
import type { WalletVault } from "@airchive/crypto";
import type { Config } from "./config.js";
import {
  BroadcastPriority,
  isDependencyPendingBroadcastFailure,
  isTransientBroadcastFailure,
  type Broadcaster,
} from "./broadcaster.js";
import type { UtxoManager, UtxoPoolState } from "./utxo-manager.js";
import type {
  FundingSelectionReason,
  FundingUtxoManager,
} from "./funding-utxo-manager.js";
import { buildRefillTx, derivePubKeyHash, estimateRefillFee } from "./tx-builder.js";
import {
  aircraftDryCount,
  refillOutcomesTotal,
  spendBlockedTotal,
  treasuryDry,
} from "./metrics.js";

const log = createLogger({ service: "blockchain-writer:auto-refill" });

const DEFAULT_IDLE_WINDOW_MS = 30 * 60 * 1_000;
const REFILL_COOLDOWN_MS = 8_000;
const ORPHAN_MEMPOOL_COOLDOWN_MS = 5_000;
const TRANSIENT_REFILL_COOLDOWN_MS = 15_000;
const SERIAL_REFILL_GAP_MS = 200;
const REFILL_OUTPUT_DUST_LIMIT = 546;
/**
 * Cap on funding inputs per refill. Each input adds ~148 bytes and locks
 * another treasury output for the duration of the broadcast, so combining a
 * handful is a fix for fragmentation while combining hundreds would just move
 * the contention somewhere else.
 */
export const MAX_REFILL_INPUTS = 12;

/**
 * The smallest treasury output that can fund a whole refill on its own.
 *
 * Both the splitter and the consolidator size their outputs by this, so the
 * treasury converges on outputs that are individually useful rather than on a
 * large count of scraps that every refill then has to sweep together.
 */
export function treasuryOutputFloorSats(
  refillAmountSats: number,
  refillOutputCount: number,
): number {
  return refillAmountSats + 100 + estimateRefillFee(refillOutputCount, true, 1);
}

/**
 * A treasury failure blocks refills fleet-wide, so a flat retry delay turns one
 * bad attempt into a stampede every time it lapses. Back off geometrically to a
 * ceiling instead, and reset the moment a refill succeeds.
 */
const TREASURY_BACKOFF_BASE_MS = 2_000;
const TREASURY_BACKOFF_MAX_MS = 60_000;
/** Consolidation costs fees and moves the whole treasury, so pace it. */
const TREASURY_CONSOLIDATION_COOLDOWN_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * "Treasury dry" was previously logged for every selection failure, which sent
 * an operator hunting for money that was already there. Each of these has a
 * different remedy, so each gets its own message.
 */
const FUNDING_SELECTION_MESSAGES: Record<FundingSelectionReason, string> = {
  ok: "Funding inputs acquired",
  no_unlocked_candidates:
    "TREASURY UNAVAILABLE — every funding output is locked or below the dust "
    + "threshold. If the balance is healthy this is stranded locks, not an "
    + "empty treasury; the lock TTL sweep will reclaim them.",
  all_candidates_cooling:
    "TREASURY COOLING — all funding candidates are inside their propagation "
    + "cooldown. This is transient and clears within seconds.",
  insufficient_within_input_cap:
    "TREASURY FRAGMENTED — the balance is sufficient but spread across more "
    + "outputs than one refill may consume; consolidation is required.",
};

/**
 * Distinct refill outcomes. These were previously collapsed into "skipped_idle",
 * which made a dry treasury or a hard broadcast rejection indistinguishable from
 * an aircraft that simply had nothing to write.
 */
export type RefillOutcome =
  | "refilled"
  | "sufficient"
  | "idle"
  | "treasury_dry"
  | "treasury_cooldown"
  | "broadcast_deferred"
  | "broadcast_failed"
  | "error";

export class AutoRefillMonitor {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly lastActivity = new Map<string, number>();
  private readonly idleWindowMs: number;
  private readonly refillCooldowns = new Map<string, number>();
  private readonly retryPressureUntil = new Map<string, number>();
  private readonly retryBackoffUntil = new Map<string, number>();
  private treasuryBlockedUntil = 0;
  private treasuryConsecutiveFailures = 0;
  private spendGate: (() => boolean) | null = null;
  /** Aircraft observed with no spendable UTXOs during the current cycle. */
  private readonly dryAircraft = new Set<string>();
  private refillActive = 0;
  private readonly refillWaiters: Array<() => void> = [];
  private consolidationInFlight = false;
  private consolidationNotBefore = 0;

  constructor(
    private readonly config: Config,
    private readonly broadcaster: Broadcaster,
    private readonly utxoManager: UtxoManager,
    private readonly vault: WalletVault,
    private readonly fleet: Array<{ icao: string }>,
    private readonly fundingUtxoManager: FundingUtxoManager,
    idleWindowMs?: number,
  ) {
    this.idleWindowMs = idleWindowMs ?? DEFAULT_IDLE_WINDOW_MS;
  }

  recordActivity(icao: string): void {
    this.lastActivity.set(icao.toUpperCase(), Date.now());
  }

  isActive(icao: string): boolean {
    const ts = this.lastActivity.get(icao.toUpperCase());
    if (ts === undefined) return false;
    return Date.now() - ts < this.idleWindowMs;
  }

  /** True while the treasury is backing off after a funding failure. */
  isTreasuryBlocked(): boolean {
    return Date.now() < this.treasuryBlockedUntil;
  }

  /**
   * Supplies the spend governor's verdict. A refill is a treasury spend like
   * any other, and refilling into a network that is refusing transactions just
   * moves coin into wallets whose writes will also be refused.
   */
  setSpendGate(gate: () => boolean): void {
    this.spendGate = gate;
  }

  private isSpendHalted(): boolean {
    return this.spendGate !== null && this.spendGate() === false;
  }

  /** Aircraft observed with no spendable UTXOs on the most recent sweep. */
  getDryAircraftCount(): number {
    return this.dryAircraft.size;
  }

  getDryAircraft(): string[] {
    return [...this.dryAircraft];
  }

  /**
   * Clears the funding backoff so a recovery pass is not immediately rejected by
   * the cooldown the outage itself accumulated.
   */
  resetTreasuryBackoff(): void {
    this.treasuryConsecutiveFailures = 0;
    this.treasuryBlockedUntil = 0;
    this.refillCooldowns.clear();
  }

  /**
   * Runs a treasury consolidation, at most one at a time and no more often than
   * the cooldown. Every stalled aircraft reports the same fragmentation in the
   * same cycle, so without this the writer would launch a hundred identical
   * consolidations and spend the treasury on fees.
   */
  private requestTreasuryConsolidation(): void {
    if (this.consolidationInFlight) return;
    if (Date.now() < this.consolidationNotBefore) return;

    this.consolidationInFlight = true;
    this.consolidationNotBefore = Date.now() + TREASURY_CONSOLIDATION_COOLDOWN_MS;

    void this.fundingUtxoManager
      .consolidateIfFragmented(
        this.config.fundingWalletWif,
        this.broadcaster,
        treasuryOutputFloorSats(
          this.config.refillAmountSats,
          this.config.refillMaxOutputsPerTx,
        ),
      )
      .then((broadcast) => {
        if (broadcast > 0) {
          log.info({ broadcast }, "Treasury consolidation ran after a fragmented refill");
          // The pool shape changed, so the backoff earned by the old shape no
          // longer describes reality.
          this.resetTreasuryBackoff();
        }
      })
      .catch((err) => log.error({ err }, "Treasury consolidation failed"))
      .finally(() => {
        this.consolidationInFlight = false;
      });
  }

  private noteTreasuryFailure(): number {
    this.treasuryConsecutiveFailures++;
    const backoffMs = Math.min(
      TREASURY_BACKOFF_MAX_MS,
      TREASURY_BACKOFF_BASE_MS * 2 ** (this.treasuryConsecutiveFailures - 1),
    );
    this.treasuryBlockedUntil = Date.now() + backoffMs;
    treasuryDry.set(1);
    return backoffMs;
  }

  private noteTreasurySuccess(): void {
    this.treasuryConsecutiveFailures = 0;
    this.treasuryBlockedUntil = 0;
    treasuryDry.set(0);
  }

  private readonly pendingRefills = new Set<string>();

  requestRefill(icao: string): void {
    const key = icao.toUpperCase();
    if (this.pendingRefills.has(key)) return;

    const cooldownUntil = this.refillCooldowns.get(key) ?? 0;
    if (Date.now() < cooldownUntil) return;

    if (this.isSpendHalted()) {
      spendBlockedTotal.inc({ site: "refill_request" });
      log.debug({ icao }, "Skipping refill — spending is halted by the governor");
      return;
    }

    if (this.isTreasuryBlocked()) {
      refillOutcomesTotal.inc({ outcome: "treasury_cooldown" });
      log.debug({ icao }, "Skipping refill — treasury backing off after recent failure");
      return;
    }

    this.pendingRefills.add(key);
    void this.runRefillSlot(() => this.checkAndRefill(key, true))
      .finally(() => this.pendingRefills.delete(key));
  }

  start(): void {
    if (this.intervalId) return;

    const checkIntervalMs = Math.max(5_000, this.config.refillCheckIntervalMs);

    this.intervalId = setInterval(() => {
      void this.checkAll();
    }, checkIntervalMs);

    log.info(
      {
        intervalMs: checkIntervalMs,
        threshold: this.config.refillThresholdSats,
        idleWindowMs: this.idleWindowMs,
        activeUtxoTarget: this.config.activeAircraftUtxoTarget,
        activeReadyUtxoTarget: this.config.activeAircraftReadyUtxoTarget,
        retryReadyReserve: this.config.retryReadyUtxoReserve,
        retryPressureReadyBoost: this.config.retryPressureReadyUtxoBoost,
        retryPressureWindowMs: this.config.retryPressureWindowMs,
        retryBackoffMs: this.config.retryBackoffMs,
        retryBackoffJitterMs: this.config.retryBackoffJitterMs,
        minOutputSats: this.config.refillMinOutputSats,
        maxOutputsPerTx: this.config.refillMaxOutputsPerTx,
        maxConcurrentRefills: this.config.maxConcurrentRefills,
      },
      "Auto-refill monitor started (activity-aware, pool-count aware)",
    );
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async checkAll(force = false): Promise<void> {
    if (this.running) return;

    if (this.isSpendHalted()) {
      spendBlockedTotal.inc({ site: "refill_sweep" });
      log.warn(
        "Refill sweep skipped — spending is halted, so the treasury is left intact",
      );
      return;
    }

    this.running = true;

    const tally: Record<RefillOutcome, number> = {
      refilled: 0,
      sufficient: 0,
      idle: 0,
      treasury_dry: 0,
      treasury_cooldown: 0,
      broadcast_deferred: 0,
      broadcast_failed: 0,
      error: 0,
    };

    try {
      const orderedFleet = [...this.fleet].sort((a, b) => {
        return Number(this.isActive(b.icao)) - Number(this.isActive(a.icao));
      });

      let idx = 0;
      const workers = Array.from(
        { length: this.config.maxConcurrentRefills },
        async () => {
          while (true) {
            const i = idx++;
            if (i >= orderedFleet.length) return;
            const aircraft = orderedFleet[i]!;
            const key = aircraft.icao.toUpperCase();
            if (this.pendingRefills.has(key)) continue;
            this.pendingRefills.add(key);
            try {
              const result = await this.checkAndRefill(aircraft.icao, force);
              tally[result]++;
              refillOutcomesTotal.inc({ outcome: result });
            } catch (err) {
              tally.error++;
              refillOutcomesTotal.inc({ outcome: "error" });
              log.error({ err, icao: aircraft.icao }, "Refill check error");
            } finally {
              this.pendingRefills.delete(key);
            }
          }
        },
      );
      await Promise.all(workers);
    } catch (err) {
      log.error({ err }, "Auto-refill cycle error");
    } finally {
      this.running = false;
    }

    aircraftDryCount.set(this.dryAircraft.size);

    const starved = tally.treasury_dry + tally.treasury_cooldown
      + tally.broadcast_failed + tally.error;
    if (starved > 0 || this.dryAircraft.size > 0) {
      log.error(
        { ...tally, dryAircraft: this.dryAircraft.size, force },
        "Auto-refill cycle complete — aircraft left with no spendable UTXOs",
      );
    } else {
      log.info({ ...tally, force }, "Auto-refill cycle complete");
    }
  }

  requestRefillIfPoolLow(
    icao: string,
    pool: Pick<UtxoPoolState, "balance" | "unlockedUtxoCount" | "readyUtxoCount">,
    force = false,
  ): void {
    const activeAircraft = this.isActive(icao);
    if (!force && !activeAircraft) return;

    const targetUtxoCount = this.getTargetUtxoCount(icao, force);
    const readyUtxoTarget = this.getReadyUtxoTarget(icao, force);
    const needsRefill = pool.balance < this.config.refillThresholdSats
      || pool.unlockedUtxoCount < targetUtxoCount
      || pool.readyUtxoCount < readyUtxoTarget;

    if (!needsRefill) return;

    log.debug(
      {
        icao,
        balance: pool.balance,
        unlockedUtxos: pool.unlockedUtxoCount,
        readyUtxos: pool.readyUtxoCount,
        targetUtxoCount,
        readyUtxoTarget,
        force,
      },
      "Requesting proactive refill after low-watermark spend",
    );
    this.requestRefill(icao);
  }

  noteRetryPressure(icao: string, reason: string): void {
    const key = icao.toUpperCase();
    const now = Date.now();
    this.pruneRetryState(now);

    const pressureDurationMs = Math.max(0, this.config.retryPressureWindowMs);
    const nextPressureUntil = Math.max(
      this.retryPressureUntil.get(key) ?? 0,
      now + pressureDurationMs,
    );
    this.retryPressureUntil.set(key, nextPressureUntil);

    const baseBackoffMs = Math.max(0, this.config.retryBackoffMs);
    const jitterLimitMs = Math.max(0, this.config.retryBackoffJitterMs);
    const jitterMs = jitterLimitMs > 0
      ? Math.floor(Math.random() * (jitterLimitMs + 1))
      : 0;
    const backoffMs = baseBackoffMs + jitterMs;
    if (backoffMs > 0) {
      const nextBackoffUntil = Math.max(
        this.retryBackoffUntil.get(key) ?? 0,
        now + backoffMs,
      );
      this.retryBackoffUntil.set(key, nextBackoffUntil);
      log.debug(
        {
          icao: key,
          reason,
          retryPressureRemainingMs: nextPressureUntil - now,
          retryBackoffRemainingMs: nextBackoffUntil - now,
        },
        "Applied retry pressure shaping for aircraft",
      );
      return;
    }

    log.debug(
      {
        icao: key,
        reason,
        retryPressureRemainingMs: nextPressureUntil - now,
      },
      "Applied retry pressure shaping for aircraft",
    );
  }

  getRetryBackoffRemainingMs(icao: string): number {
    const key = icao.toUpperCase();
    const now = Date.now();
    this.pruneRetryState(now);
    const until = this.retryBackoffUntil.get(key) ?? 0;
    return Math.max(0, until - now);
  }

  getRetryReadyReserve(icao: string): number {
    if (!this.isActive(icao)) return 0;
    return Math.min(
      Math.max(0, this.getTargetUtxoCount(icao, false) - 1),
      Math.max(0, this.config.retryReadyUtxoReserve),
    );
  }

  private async checkAndRefill(
    icao: string,
    force: boolean,
  ): Promise<RefillOutcome> {
    const pool = await this.utxoManager.checkBalance(icao);
    if (pool.unlockedUtxoCount === 0) {
      this.dryAircraft.add(icao.toUpperCase());
    } else {
      this.dryAircraft.delete(icao.toUpperCase());
    }
    const activeAircraft = this.isActive(icao);
    const targetUtxoCount = this.getTargetUtxoCount(icao, force);
    const readyUtxoTarget = this.getReadyUtxoTarget(icao, force);
    const enforceCountTarget =
      force || activeAircraft;

    if (
      pool.balance >= this.config.refillThresholdSats
      && (
        !enforceCountTarget
        || (
          pool.unlockedUtxoCount >= targetUtxoCount
          && pool.readyUtxoCount >= readyUtxoTarget
        )
      )
    ) {
      return "sufficient";
    }

    if (!force && !activeAircraft) {
      log.debug(
        {
          icao,
          activeAircraft,
          balance: pool.balance,
          unlockedUtxos: pool.unlockedUtxoCount,
          readyUtxos: pool.readyUtxoCount,
          coolingUtxos: pool.coolingUtxoCount,
          threshold: this.config.refillThresholdSats,
          targetUtxoCount,
          readyUtxoTarget,
          enforceCountTarget,
        },
        "Skipping refill — aircraft idle (no recent write activity)",
      );
      return "idle";
    }

    const refillAmount = this.config.refillAmountSats;
    const missingUnlockedUtxos = Math.max(0, targetUtxoCount - pool.unlockedUtxoCount);
    const missingReadyUtxos = Math.max(0, readyUtxoTarget - pool.readyUtxoCount);
    const desiredOutputCount = this.getDesiredRefillOutputCount(
      refillAmount,
      Math.max(missingUnlockedUtxos, missingReadyUtxos),
    );

    log.info(
      {
        icao,
        balance: pool.balance,
        unlockedUtxos: pool.unlockedUtxoCount,
        readyUtxos: pool.readyUtxoCount,
        coolingUtxos: pool.coolingUtxoCount,
        activeAircraft,
        threshold: this.config.refillThresholdSats,
        targetUtxoCount,
        readyUtxoTarget,
        enforceCountTarget,
        force,
        refillAmount,
        desiredOutputCount,
      },
      "Aircraft pool below target, initiating refill",
    );

    try {
      if (this.isTreasuryBlocked()) {
        this.refillCooldowns.set(icao.toUpperCase(), Date.now() + REFILL_COOLDOWN_MS);
        return "treasury_cooldown";
      }

      const fundingKey = PrivateKey.fromWif(this.config.fundingWalletWif);
      const minRequired = refillAmount + 100;

      // A treasury split for concurrency holds many modest outputs, so a refill
      // is funded from as many of them as it takes rather than demanding one
      // large enough on its own — that requirement stalled writes while the
      // treasury held millions of satoshis.
      const { utxos: fundingUtxos, diagnostics } = await this.fundingUtxoManager.acquireMany(
        minRequired,
        MAX_REFILL_INPUTS,
        (inputCount) => estimateRefillFee(desiredOutputCount, true, inputCount),
      );
      if (fundingUtxos.length === 0) {
        const backoffMs = this.noteTreasuryFailure();
        const treasuryState = await this.fundingUtxoManager
          .getBalance()
          .catch(() => ({ balance: -1, count: -1 }));
        log.error(
          {
            icao,
            required: minRequired,
            treasuryBalance: treasuryState.balance,
            treasuryUtxos: treasuryState.count,
            backoffMs,
            consecutiveFailures: this.treasuryConsecutiveFailures,
            ...diagnostics,
          },
          FUNDING_SELECTION_MESSAGES[diagnostics.reason],
        );
        this.refillCooldowns.set(icao.toUpperCase(), Date.now() + REFILL_COOLDOWN_MS);
        void this.fundingUtxoManager.reconcile(this.config.fundingWalletWif).catch((err) =>
          log.error({ err }, "Background funding reconciliation failed"),
        );

        // Fragmentation is the one selection failure the writer can fix by
        // itself, so it does — rather than waiting for the next restart while
        // every aircraft stalls beside a treasury that has the money.
        if (diagnostics.reason === "insufficient_within_input_cap") {
          this.requestTreasuryConsolidation();
        }
        return "treasury_dry";
      }

      const spentInputs = fundingUtxos.map((utxo) => ({
        txid: utxo.txid.trim(),
        vout: utxo.vout,
      }));

      try {
        const aircraftPrivKey = this.vault.getAircraftPrivateKey(icao);
        const recipientPkh = derivePubKeyHash(aircraftPrivKey);
        const { tx, recipientOutputs, changeVout, changeSats, changeLockingScript } =
          await buildRefillTx({
            fundingUtxos: fundingUtxos.map((utxo) => ({
              txid: utxo.txid.trim(),
              vout: utxo.vout,
              satoshis: Number(utxo.satoshis),
              lockingScript: utxo.locking_script,
            })),
            fundingKey,
            recipientPkh,
            amountSats: refillAmount,
            recipientOutputCount: desiredOutputCount,
          });

        const result = await this.broadcaster.broadcast(tx, icao, {
          kind: "refill",
          priority: BroadcastPriority.REFILL,
        });
        if (result.status === "FAILED") {
          if (isDependencyPendingBroadcastFailure(result)) {
            log.info({ icao, code: result.code }, "Refill dependency not yet propagated; backing off");
            await this.fundingUtxoManager.releaseMany(spentInputs);
            this.refillCooldowns.set(icao.toUpperCase(), Date.now() + ORPHAN_MEMPOOL_COOLDOWN_MS);
            this.noteTreasuryFailure();
            await sleep(SERIAL_REFILL_GAP_MS);
            return "broadcast_deferred";
          }
          if (isTransientBroadcastFailure(result)) {
            log.warn(
              { icao, code: result.code, description: result.description },
              "Refill broadcast failed transiently — retaining funding inputs and reconciling",
            );
            await this.fundingUtxoManager.releaseMany(spentInputs);
            this.refillCooldowns.set(icao.toUpperCase(), Date.now() + TRANSIENT_REFILL_COOLDOWN_MS);
            this.noteTreasuryFailure();
            void this.fundingUtxoManager.reconcile(this.config.fundingWalletWif).catch((err) =>
              log.error({ err }, "Background funding reconciliation failed"),
            );
            await sleep(SERIAL_REFILL_GAP_MS);
            return "broadcast_deferred";
          }
          log.error(
            { icao, code: result.code, description: result.description },
            "Refill broadcast rejected — aircraft remains unfunded",
          );
          for (const input of spentInputs) {
            await this.fundingUtxoManager.deleteStale(input.txid, input.vout);
          }
          this.refillCooldowns.set(icao.toUpperCase(), Date.now() + REFILL_COOLDOWN_MS);
          await sleep(SERIAL_REFILL_GAP_MS);
          return "broadcast_failed";
        }

        const txid = result.txid;

        await this.fundingUtxoManager.recordSpendMany(
          spentInputs,
          changeVout !== null ? txid : null,
          changeVout,
          changeSats > 0 ? changeSats : null,
          changeLockingScript,
        );

        await this.utxoManager.addUtxos(
          icao,
          recipientOutputs.map((output) => ({
            txid,
            vout: output.vout,
            satoshis: output.satoshis,
            lockingScript: output.lockingScript,
          })),
        );

        this.noteTreasurySuccess();
        log.info(
          {
            icao,
            txid,
            amount: refillAmount,
            fundingInputs: spentInputs.length,
            recipientOutputs: recipientOutputs.length,
            changeReturned: changeSats > 0,
          },
          "Refill transaction broadcast (multi-output aircraft top-up)",
        );
        await sleep(SERIAL_REFILL_GAP_MS);
        return "refilled";
      } catch (err) {
        await this.fundingUtxoManager.releaseMany(spentInputs);
        throw err;
      }
    } catch (err) {
      log.error({ err, icao }, "Refill failed");
      this.refillCooldowns.set(icao.toUpperCase(), Date.now() + REFILL_COOLDOWN_MS);
      return "error";
    }
  }

  private getTargetUtxoCount(icao: string, force: boolean): number {
    if (!force && !this.isActive(icao)) return 1;
    return Math.max(1, this.config.activeAircraftUtxoTarget);
  }

  private getReadyUtxoTarget(icao: string, force: boolean): number {
    if (!force && !this.isActive(icao)) return 1;
    const retryPressureBoost = this.isUnderRetryPressure(icao)
      ? Math.max(0, this.config.retryPressureReadyUtxoBoost)
      : 0;
    const readyTarget = Math.max(1, this.config.activeAircraftReadyUtxoTarget)
      + retryPressureBoost;
    return Math.min(this.getTargetUtxoCount(icao, force), readyTarget);
  }

  private getDesiredRefillOutputCount(
    refillAmountSats: number,
    missingUtxos: number,
  ): number {
    const desiredByGap = Math.max(1, missingUtxos);
    const minOutputSats = Math.max(
      REFILL_OUTPUT_DUST_LIMIT,
      this.config.refillMinOutputSats,
    );
    const maxByAmount = Math.max(1, Math.floor(refillAmountSats / minOutputSats));
    const maxOutputsPerTx = Math.max(1, Math.floor(this.config.refillMaxOutputsPerTx));
    return Math.max(1, Math.min(desiredByGap, maxByAmount, maxOutputsPerTx));
  }

  private async runRefillSlot<T>(op: () => Promise<T>): Promise<T> {
    await this.acquireRefillSlot();
    try {
      return await op();
    } finally {
      this.releaseRefillSlot();
    }
  }

  private async acquireRefillSlot(): Promise<void> {
    if (this.refillActive < this.config.maxConcurrentRefills) {
      this.refillActive++;
      return;
    }

    await new Promise<void>((resolve) => {
      this.refillWaiters.push(() => {
        this.refillActive++;
        resolve();
      });
    });
  }

  private releaseRefillSlot(): void {
    this.refillActive = Math.max(0, this.refillActive - 1);
    const next = this.refillWaiters.shift();
    if (next) {
      next();
    }
  }

  private isUnderRetryPressure(icao: string): boolean {
    const key = icao.toUpperCase();
    const now = Date.now();
    this.pruneRetryState(now);
    const until = this.retryPressureUntil.get(key) ?? 0;
    return until > now;
  }

  private pruneRetryState(now = Date.now()): void {
    for (const [key, until] of this.retryPressureUntil) {
      if (until <= now) {
        this.retryPressureUntil.delete(key);
      }
    }
    for (const [key, until] of this.retryBackoffUntil) {
      if (until <= now) {
        this.retryBackoffUntil.delete(key);
      }
    }
  }
}
