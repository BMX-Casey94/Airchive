import { PrivateKey } from "@bsv/sdk";
import { createLogger } from "@airchive/logger";
import type { WalletVault } from "@airchive/crypto";
import type { Config } from "./config.js";
import {
  BroadcastPriority,
  isDependencyPendingBroadcastFailure,
  isTransientBroadcastFailure,
  type ArcBroadcaster,
} from "./broadcaster.js";
import type { UtxoManager } from "./utxo-manager.js";
import type { FundingUtxoManager } from "./funding-utxo-manager.js";
import { buildRefillTx, derivePubKeyHash, estimateRefillFee } from "./tx-builder.js";

const log = createLogger({ service: "blockchain-writer:auto-refill" });

const DEFAULT_IDLE_WINDOW_MS = 30 * 60 * 1_000;
const REFILL_COOLDOWN_MS = 30_000;
const TREASURY_FAILURE_COOLDOWN_MS = 60_000;
const ORPHAN_MEMPOOL_COOLDOWN_MS = 20_000;
const TRANSIENT_REFILL_COOLDOWN_MS = 45_000;
const SERIAL_REFILL_GAP_MS = 1_000;
const REFILL_OUTPUT_DUST_LIMIT = 546;
const MAX_CONCURRENT_REFILLS = 4;
const MIN_ACTIVE_READY_UTXOS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AutoRefillMonitor {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly lastActivity = new Map<string, number>();
  private readonly idleWindowMs: number;
  private readonly refillCooldowns = new Map<string, number>();
  private treasuryFailedAt = 0;
  private refillActive = 0;
  private readonly refillWaiters: Array<() => void> = [];

  constructor(
    private readonly config: Config,
    private readonly broadcaster: ArcBroadcaster,
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

  private readonly pendingRefills = new Set<string>();

  requestRefill(icao: string): void {
    const key = icao.toUpperCase();
    if (this.pendingRefills.has(key)) return;

    const cooldownUntil = this.refillCooldowns.get(key) ?? 0;
    if (Date.now() < cooldownUntil) return;

    if (Date.now() < this.treasuryFailedAt + TREASURY_FAILURE_COOLDOWN_MS) {
      log.debug({ icao }, "Skipping refill — treasury in cooldown after recent failure");
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
        minOutputSats: this.config.refillMinOutputSats,
        maxOutputsPerTx: this.config.refillMaxOutputsPerTx,
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
    this.running = true;

    let refilled = 0;
    let skippedIdle = 0;
    let sufficientBalance = 0;

    try {
      const orderedFleet = [...this.fleet].sort((a, b) => {
        return Number(this.isActive(b.icao)) - Number(this.isActive(a.icao));
      });

      const results = await Promise.all(orderedFleet.map(async (aircraft) => {
        const key = aircraft.icao.toUpperCase();
        if (this.pendingRefills.has(key)) {
          return "skipped_idle" as const;
        }
        this.pendingRefills.add(key);
        try {
          return await this.runRefillSlot(() => this.checkAndRefill(aircraft.icao, force));
        } finally {
          this.pendingRefills.delete(key);
        }
      }));

      for (const result of results) {
        if (result === "refilled") refilled++;
        else if (result === "skipped_idle") skippedIdle++;
        else sufficientBalance++;
      }
    } catch (err) {
      log.error({ err }, "Auto-refill cycle error");
    } finally {
      this.running = false;
    }

    log.info(
      { refilled, skippedIdle, sufficientBalance, force },
      "Auto-refill cycle complete",
    );
  }

  private async checkAndRefill(
    icao: string,
    force: boolean,
  ): Promise<"refilled" | "skipped_idle" | "sufficient"> {
    const pool = await this.utxoManager.checkBalance(icao);
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
      return "skipped_idle";
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
      if (Date.now() < this.treasuryFailedAt + TREASURY_FAILURE_COOLDOWN_MS) {
        this.refillCooldowns.set(icao.toUpperCase(), Date.now() + REFILL_COOLDOWN_MS);
        return "skipped_idle";
      }

      const fundingKey = PrivateKey.fromWif(this.config.fundingWalletWif);
      const minRequired = refillAmount + estimateRefillFee(desiredOutputCount) + 100;

      const fundingUtxo = await this.fundingUtxoManager.acquire(minRequired);
      if (!fundingUtxo) {
        log.warn(
          { icao, required: minRequired },
          "No local funding UTXO available — triggering background reconciliation",
        );
        this.treasuryFailedAt = Date.now();
        this.refillCooldowns.set(icao.toUpperCase(), Date.now() + REFILL_COOLDOWN_MS);
        void this.fundingUtxoManager.reconcile(this.config.fundingWalletWif).catch((err) =>
          log.error({ err }, "Background funding reconciliation failed"),
        );
        return "skipped_idle";
      }

      try {
        const aircraftPrivKey = this.vault.getAircraftPrivateKey(icao);
        const recipientPkh = derivePubKeyHash(aircraftPrivKey);
        const { tx, recipientOutputs, changeVout, changeSats, changeLockingScript } =
          await buildRefillTx({
            fundingUtxo: {
              txid: fundingUtxo.txid.trim(),
              vout: fundingUtxo.vout,
              satoshis: Number(fundingUtxo.satoshis),
              lockingScript: fundingUtxo.locking_script,
            },
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
            await this.fundingUtxoManager.release(fundingUtxo.txid.trim(), fundingUtxo.vout);
            this.refillCooldowns.set(icao.toUpperCase(), Date.now() + ORPHAN_MEMPOOL_COOLDOWN_MS);
            this.treasuryFailedAt = Date.now();
            await sleep(SERIAL_REFILL_GAP_MS);
            return "skipped_idle";
          }
          if (isTransientBroadcastFailure(result)) {
            log.warn(
              { icao, code: result.code, description: result.description },
              "Refill broadcast failed transiently — retaining funding input and reconciling",
            );
            await this.fundingUtxoManager.release(fundingUtxo.txid.trim(), fundingUtxo.vout);
            this.refillCooldowns.set(icao.toUpperCase(), Date.now() + TRANSIENT_REFILL_COOLDOWN_MS);
            this.treasuryFailedAt = Date.now();
            void this.fundingUtxoManager.reconcile(this.config.fundingWalletWif).catch((err) =>
              log.error({ err }, "Background funding reconciliation failed"),
            );
            await sleep(SERIAL_REFILL_GAP_MS);
            return "skipped_idle";
          }
          log.error({ icao, code: result.code }, "Refill broadcast failed");
          await this.fundingUtxoManager.deleteStale(fundingUtxo.txid.trim(), fundingUtxo.vout);
          this.refillCooldowns.set(icao.toUpperCase(), Date.now() + REFILL_COOLDOWN_MS);
          await sleep(SERIAL_REFILL_GAP_MS);
          return "skipped_idle";
        }

        const txid = result.txid;

        await this.fundingUtxoManager.recordSpend(
          fundingUtxo.txid.trim(),
          fundingUtxo.vout,
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

        log.info(
          {
            icao,
            txid,
            amount: refillAmount,
            recipientOutputs: recipientOutputs.length,
            changeReturned: changeSats > 0,
          },
          "Refill transaction broadcast (multi-output aircraft top-up)",
        );
        await sleep(SERIAL_REFILL_GAP_MS);
        return "refilled";
      } catch (err) {
        await this.fundingUtxoManager.release(fundingUtxo.txid.trim(), fundingUtxo.vout);
        throw err;
      }
    } catch (err) {
      log.error({ err, icao }, "Refill failed");
      this.refillCooldowns.set(icao.toUpperCase(), Date.now() + REFILL_COOLDOWN_MS);
      return "skipped_idle";
    }
  }

  private getTargetUtxoCount(icao: string, force: boolean): number {
    if (!force && !this.isActive(icao)) return 1;
    return Math.max(1, this.config.activeAircraftUtxoTarget);
  }

  private getReadyUtxoTarget(icao: string, force: boolean): number {
    if (!force && !this.isActive(icao)) return 1;
    return Math.min(this.getTargetUtxoCount(icao, force), MIN_ACTIVE_READY_UTXOS);
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
    if (this.refillActive < MAX_CONCURRENT_REFILLS) {
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
}
