import { P2PKH, PrivateKey } from "@bsv/sdk";
import { createLogger } from "@airchive/logger";
import type { WalletVault } from "@airchive/crypto";
import type { Config } from "./config.js";
import type { ArcBroadcaster } from "./broadcaster.js";
import type { UtxoManager } from "./utxo-manager.js";
import { buildRefillTx, derivePubKeyHash } from "./tx-builder.js";

const log = createLogger({ service: "blockchain-writer:auto-refill" });

const CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_IDLE_WINDOW_MS = 30 * 60 * 1_000;

interface WocUtxo {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height: number;
}

export class AutoRefillMonitor {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly lastActivity = new Map<string, number>();
  private readonly idleWindowMs: number;

  constructor(
    private readonly config: Config,
    private readonly broadcaster: ArcBroadcaster,
    private readonly utxoManager: UtxoManager,
    private readonly vault: WalletVault,
    private readonly fleet: Array<{ icao: string }>,
    idleWindowMs?: number,
  ) {
    this.idleWindowMs = idleWindowMs ?? DEFAULT_IDLE_WINDOW_MS;
  }

  /**
   * Record that an aircraft has had write activity (telemetry or flight-event).
   * Called externally whenever a write:{ICAO} or flight-event:{ICAO} message
   * is received, so the refill monitor knows which aircraft are actively flying.
   */
  recordActivity(icao: string): void {
    this.lastActivity.set(icao.toUpperCase(), Date.now());
  }

  isActive(icao: string): boolean {
    const ts = this.lastActivity.get(icao.toUpperCase());
    if (ts === undefined) return false;
    return Date.now() - ts < this.idleWindowMs;
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
      "Auto-refill monitor started (activity-aware)",
    );
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Run a full refill cycle. When `force` is true (e.g. initial bootstrap),
   * all aircraft below threshold are refilled regardless of activity.
   */
  async checkAll(force = false): Promise<void> {
    if (this.running) return;
    this.running = true;

    let refilled = 0;
    let skippedIdle = 0;
    let sufficientBalance = 0;

    try {
      for (const aircraft of this.fleet) {
        const result = await this.checkAndRefill(aircraft.icao, force);
        if (result === "refilled") refilled++;
        else if (result === "skipped_idle") skippedIdle++;
        else sufficientBalance++;
        await new Promise((r) => setTimeout(r, 500));
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
      const fundingAddress = fundingKey.toAddress();
      const fundingPkh = derivePubKeyHash(fundingKey);
      const fundingLockingScriptHex = new P2PKH().lock(fundingPkh).toHex();

      const fundingUtxos = await this.fetchFundingUtxos(fundingAddress);
      if (fundingUtxos.length === 0) {
        log.error("Funding wallet has no UTXOs");
        return "skipped_idle";
      }

      const refillAmount = this.config.refillAmountSats;
      const suitable = fundingUtxos.find((u) => u.value >= refillAmount + 300);
      if (!suitable) {
        log.error(
          { required: refillAmount, maxAvailable: Math.max(...fundingUtxos.map((u) => u.value)) },
          "Funding wallet has no UTXO large enough for refill",
        );
        return "skipped_idle";
      }

      const aircraftPrivKey = this.vault.getAircraftPrivateKey(icao);
      const recipientPkh = derivePubKeyHash(aircraftPrivKey);
      const recipientLockingScriptHex = new P2PKH().lock(recipientPkh).toHex();

      const { tx, recipientVout } = await buildRefillTx({
        fundingUtxo: {
          txid: suitable.tx_hash,
          vout: suitable.tx_pos,
          satoshis: suitable.value,
          lockingScript: fundingLockingScriptHex,
        },
        fundingKey,
        recipientPkh,
        amountSats: refillAmount,
      });

      const result = await this.broadcaster.broadcast(tx, icao);
      if (result.status === "FAILED") {
        log.error({ icao }, "Refill broadcast failed");
        return "skipped_idle";
      }

      await this.utxoManager.addUtxo(
        icao,
        result.txid,
        recipientVout,
        refillAmount,
        recipientLockingScriptHex,
      );

      log.info(
        { icao, txid: result.txid, amount: refillAmount },
        "Refill transaction broadcast",
      );
      return "refilled";
    } catch (err) {
      log.error({ err, icao }, "Refill failed");
      return "skipped_idle";
    }
  }

  private async fetchFundingUtxos(address: string): Promise<WocUtxo[]> {
    const url = `${this.config.wocApiUrl}/address/${address}/unspent`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(`WoC fetch failed for funding wallet: ${res.status}`);
    }

    return (await res.json()) as WocUtxo[];
  }
}
