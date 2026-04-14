import type { Knex } from "knex";
import { P2PKH, PrivateKey } from "@bsv/sdk";
import { createLogger } from "@airchive/logger";
import {
  acquireFundingUtxo,
  deleteFundingUtxo,
  getFundingUtxoBalance,
  getFundingUtxoCount,
  insertFundingUtxo,
  releaseFundingUtxo,
  unlockAllFundingUtxos,
  type FundingUtxoRow,
} from "@airchive/db";
import { derivePubKeyHash } from "./tx-builder.js";
import { fundingPoolBalance, fundingPoolCount } from "./metrics.js";

const log = createLogger({ service: "blockchain-writer:funding-utxo" });

const MIN_USABLE_SATS = 546;
const MIN_RECONCILE_INTERVAL_MS = 30_000;
const RATE_LIMITED_COOLDOWN_MS = 120_000;

interface WocUtxo {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height: number;
}

export class FundingUtxoManager {
  private reconcileInFlight: Promise<void> | null = null;
  private reconcileEarliestRetryAt = 0;

  constructor(
    private readonly db: Knex,
    private readonly wocApiUrl: string,
  ) {}

  /**
   * Populate the local funding pool from WoC if it is empty.
   * Only called at startup or during explicit reconciliation.
   */
  async bootstrap(fundingWif: string): Promise<void> {
    const existing = await getFundingUtxoCount(this.db);
    if (existing > 0) {
      log.info({ count: existing }, "Funding UTXO pool already populated, skipping bootstrap");
      await this.refreshMetrics();
      return;
    }

    const fundingKey = PrivateKey.fromWif(fundingWif);
    const address = fundingKey.toAddress();
    const pkh = derivePubKeyHash(fundingKey);
    const lockingScript = new P2PKH().lock(pkh).toHex();

    log.info({ address }, "Bootstrapping funding UTXO pool from WoC");

    const utxos = await this.fetchFromChain(address);
    if (utxos.length === 0) {
      log.warn({ address }, "No UTXOs found on-chain for funding wallet");
      return;
    }

    for (const u of utxos) {
      if (u.value < MIN_USABLE_SATS) continue;
      await insertFundingUtxo(this.db, {
        txid: u.tx_hash,
        vout: u.tx_pos,
        satoshis: u.value,
        locking_script: lockingScript,
      });
    }

    const inserted = await getFundingUtxoCount(this.db);
    log.info({ count: inserted, totalOnChain: utxos.length }, "Funding UTXO pool bootstrapped");
    await this.refreshMetrics();
  }

  /**
   * Acquire a funding UTXO large enough for a refill.
   * Returns undefined if none available (caller should reconcile or wait).
   */
  async acquire(minSats: number): Promise<FundingUtxoRow | undefined> {
    return acquireFundingUtxo(this.db, minSats);
  }

  async release(txid: string, vout: number): Promise<void> {
    await releaseFundingUtxo(this.db, txid, vout);
  }

  /**
   * After a successful refill broadcast, remove the spent input and
   * insert the change output back into the local pool.
   */
  async recordSpend(
    spentTxid: string,
    spentVout: number,
    changeTxid: string | null,
    changeVout: number | null,
    changeSats: number | null,
    changeLockingScript: string | null,
  ): Promise<void> {
    await this.db.transaction(async (trx: Knex.Transaction) => {
      await trx("funding_utxo_pool")
        .where({ txid: spentTxid, vout: spentVout })
        .delete();

      if (
        changeTxid !== null &&
        changeVout !== null &&
        changeSats !== null &&
        changeLockingScript !== null &&
        changeSats >= MIN_USABLE_SATS
      ) {
        await trx("funding_utxo_pool").insert({
          txid: changeTxid,
          vout: changeVout,
          satoshis: changeSats,
          locking_script: changeLockingScript,
          is_locked: false,
        });
      }
    });

    await this.refreshMetrics();
  }

  async deleteStale(txid: string, vout: number): Promise<void> {
    const deleted = await deleteFundingUtxo(this.db, txid, vout);
    if (deleted > 0) {
      log.warn({ txid: txid.slice(0, 12), vout }, "Purged stale funding UTXO");
    }
  }

  async unlockAll(): Promise<number> {
    const count = await unlockAllFundingUtxos(this.db);
    if (count > 0) {
      log.info({ unlocked: count }, "Unlocked stale funding UTXOs from previous run");
    }
    return count;
  }

  async getBalance(): Promise<{ balance: number; count: number }> {
    const [balance, count] = await Promise.all([
      getFundingUtxoBalance(this.db),
      getFundingUtxoCount(this.db),
    ]);
    return { balance, count };
  }

  /**
   * Reconcile local state against on-chain reality.
   * De-duplicated: if a reconciliation is in-flight, callers join it;
   * if one completed recently (or WoC rate-limited us), callers skip.
   */
  async reconcile(fundingWif: string): Promise<void> {
    if (Date.now() < this.reconcileEarliestRetryAt) return;
    if (this.reconcileInFlight) return this.reconcileInFlight;

    this.reconcileInFlight = this.doReconcile(fundingWif).finally(() => {
      this.reconcileInFlight = null;
    });

    return this.reconcileInFlight;
  }

  private async doReconcile(fundingWif: string): Promise<void> {
    const fundingKey = PrivateKey.fromWif(fundingWif);
    const address = fundingKey.toAddress();
    const pkh = derivePubKeyHash(fundingKey);
    const lockingScript = new P2PKH().lock(pkh).toHex();

    let onChain: WocUtxo[];
    try {
      onChain = await this.fetchFromChain(address);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      const cooldown = msg.includes("429")
        ? RATE_LIMITED_COOLDOWN_MS
        : MIN_RECONCILE_INTERVAL_MS;
      this.reconcileEarliestRetryAt = Date.now() + cooldown;
      log.warn({ err, retryInMs: cooldown }, "Funding reconciliation skipped — WoC unreachable");
      return;
    }

    this.reconcileEarliestRetryAt = Date.now() + MIN_RECONCILE_INTERVAL_MS;

    const onChainSet = new Set(onChain.map((u) => `${u.tx_hash}:${u.tx_pos}`));

    const localRows = await this.db("funding_utxo_pool").select("txid", "vout");
    const localSet = new Set(localRows.map((r: { txid: string; vout: number }) => `${r.txid.trim()}:${r.vout}`));

    let added = 0;
    let removed = 0;

    for (const u of onChain) {
      const key = `${u.tx_hash}:${u.tx_pos}`;
      if (!localSet.has(key) && u.value >= MIN_USABLE_SATS) {
        await insertFundingUtxo(this.db, {
          txid: u.tx_hash,
          vout: u.tx_pos,
          satoshis: u.value,
          locking_script: lockingScript,
        });
        added++;
      }
    }

    for (const row of localRows) {
      const key = `${(row.txid as string).trim()}:${row.vout}`;
      if (!onChainSet.has(key)) {
        await deleteFundingUtxo(this.db, (row.txid as string).trim(), row.vout as number);
        removed++;
      }
    }

    if (added > 0 || removed > 0) {
      log.info({ added, removed, onChainTotal: onChain.length }, "Funding pool reconciled");
    }

    await this.refreshMetrics();
  }

  private async fetchFromChain(address: string): Promise<WocUtxo[]> {
    const url = `${this.wocApiUrl}/address/${address}/unspent`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`WoC fetch failed for funding wallet: ${res.status}`);
    }
    return (await res.json()) as WocUtxo[];
  }

  private async refreshMetrics(): Promise<void> {
    try {
      const { balance, count } = await this.getBalance();
      fundingPoolBalance.set(balance);
      fundingPoolCount.set(count);
    } catch {
      // non-critical
    }
  }
}
