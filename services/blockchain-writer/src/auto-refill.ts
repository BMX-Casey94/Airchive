import { P2PKH, PrivateKey } from "@bsv/sdk";
import { createLogger } from "@airchive/logger";
import type { WalletVault } from "@airchive/crypto";
import type { Config } from "./config.js";
import {
  isDependencyPendingBroadcastFailure,
  type ArcBroadcaster,
} from "./broadcaster.js";
import type { UtxoManager } from "./utxo-manager.js";
import type { FundingUtxoManager } from "./funding-utxo-manager.js";
import { buildRefillTx, derivePubKeyHash } from "./tx-builder.js";

const log = createLogger({ service: "blockchain-writer:auto-refill" });

const CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_IDLE_WINDOW_MS = 30 * 60 * 1_000;
const REFILL_COOLDOWN_MS = 30_000;
const TREASURY_FAILURE_COOLDOWN_MS = 60_000;
const ORPHAN_MEMPOOL_COOLDOWN_MS = 20_000;
const SERIAL_REFILL_GAP_MS = 1_000;

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
  private refillSerialTail: Promise<void> = Promise.resolve();

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
    void this.runSerialRefill(() => this.checkAndRefill(key, true))
      .finally(() => this.pendingRefills.delete(key));
  }

  start(): void {
    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      void this.checkAll();
    }, CHECK_INTERVAL_MS);

    log.info(
      {
        intervalMs: CHECK_INTERVAL_MS,
        threshold: this.config.refillThresholdSats,
        idleWindowMs: this.idleWindowMs,
      },
      "Auto-refill monitor started (activity-aware, local funding pool)",
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
      for (const aircraft of this.fleet) {
        const key = aircraft.icao.toUpperCase();
        if (this.pendingRefills.has(key)) {
          skippedIdle++;
          continue;
        }
        this.pendingRefills.add(key);
        try {
          const result = await this.runSerialRefill(() => this.checkAndRefill(aircraft.icao, force));
          if (result === "refilled") refilled++;
          else if (result === "skipped_idle") skippedIdle++;
          else sufficientBalance++;
        } finally {
          this.pendingRefills.delete(key);
        }
        await new Promise((r) => setTimeout(r, 200));
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
    const { balance } = await this.utxoManager.checkBalance(icao);

    if (balance >= this.config.refillThresholdSats) return "sufficient";

    if (!force && !this.isActive(icao)) {
      log.debug(
        { icao, balance, threshold: this.config.refillThresholdSats },
        "Skipping refill — aircraft idle (no recent write activity)",
      );
      return "skipped_idle";
    }

    log.info(
      { icao, balance, threshold: this.config.refillThresholdSats, force },
      "Balance below threshold, initiating refill",
    );

    try {
      const fundingKey = PrivateKey.fromWif(this.config.fundingWalletWif);

      const refillAmount = this.config.refillAmountSats;
      const minRequired = refillAmount + 300;

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
        const recipientLockingScriptHex = new P2PKH().lock(recipientPkh).toHex();

        const { tx, recipientVout, changeVout, changeSats, changeLockingScript } =
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
          });

        const result = await this.broadcaster.broadcast(tx, icao);
        if (result.status === "FAILED") {
          if (isDependencyPendingBroadcastFailure(result)) {
            log.info({ icao, code: result.code }, "Refill dependency not yet propagated; backing off");
            await this.fundingUtxoManager.release(fundingUtxo.txid.trim(), fundingUtxo.vout);
            this.refillCooldowns.set(icao.toUpperCase(), Date.now() + ORPHAN_MEMPOOL_COOLDOWN_MS);
            this.treasuryFailedAt = Date.now();
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

        await this.utxoManager.addUtxo(
          icao,
          txid,
          recipientVout,
          refillAmount,
          recipientLockingScriptHex,
        );

        log.info(
          { icao, txid, amount: refillAmount, changeReturned: changeSats > 0 },
          "Refill transaction broadcast (local funding pool)",
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

  private async runSerialRefill<T>(op: () => Promise<T>): Promise<T> {
    const previous = this.refillSerialTail;
    let release = () => {};
    this.refillSerialTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await op();
    } finally {
      release();
    }
  }
}
