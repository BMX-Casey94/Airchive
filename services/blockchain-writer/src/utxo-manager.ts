import type { Knex } from "knex";
import { P2PKH, type PrivateKey } from "@bsv/sdk";
import type { UTXORecord } from "@airchive/types";
import {
  getUtxoCount,
  getUtxoPoolBalance,
  insertUtxo,
  type NewUtxo,
} from "@airchive/db";
import { createLogger } from "@airchive/logger";
import { buildConsolidationTx } from "./tx-builder.js";
import type { ArcBroadcaster } from "./broadcaster.js";
import { utxoPoolBalance, utxoPoolCount } from "./metrics.js";

const log = createLogger({ service: "blockchain-writer:utxo" });

interface WocUtxo {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height: number;
}

const MIN_USABLE_SATS = 120;
const ORPHAN_SPEND_COOLDOWN_MS = 15_000;
const CHAIN_PROPAGATION_COOLDOWN_MS = 10_000;
const REFILL_PROPAGATION_COOLDOWN_MS = 20_000;

export class UtxoManager {
  private readonly spendBackoffUntil = new Map<string, number>();

  constructor(
    private readonly db: Knex,
    private readonly wocApiUrl: string,
  ) {}

  async bootstrap(icao: string, address: string): Promise<void> {
    const existing = await getUtxoCount(this.db, icao);
    if (existing > 0) {
      log.info({ icao, count: existing }, "UTXO pool already populated, skipping bootstrap");
      await this.refreshMetrics(icao);
      return;
    }

    log.info({ icao, address }, "Bootstrapping UTXO pool from WoC");

    const url = `${this.wocApiUrl}/address/${address}/unspent`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(
        `WoC UTXO fetch failed for ${address}: ${res.status} ${res.statusText}`,
      );
    }

    const utxos = (await res.json()) as WocUtxo[];
    if (utxos.length === 0) {
      log.warn({ icao, address }, "No UTXOs found on-chain for aircraft wallet");
      return;
    }

    const lockingScript = this.deriveLockingScriptHex(address);

    for (const woc of utxos) {
      const record: NewUtxo = {
        aircraft_icao: icao,
        txid: woc.tx_hash,
        vout: woc.tx_pos,
        satoshis: woc.value,
        locking_script: lockingScript,
      };

      try {
        await insertUtxo(this.db, record);
      } catch (err) {
        if ((err as Error).message?.includes("duplicate key")) continue;
        throw err;
      }
    }

    log.info({ icao, count: utxos.length }, "UTXO pool bootstrapped");
    await this.refreshMetrics(icao);
  }

  async acquireUtxo(icao: string): Promise<UTXORecord> {
    const key = icao.toUpperCase();
    const backoffUntil = this.spendBackoffUntil.get(key) ?? 0;
    if (Date.now() < backoffUntil) {
      throw new Error(`UTXO spend cooling down for aircraft ${key}`);
    }

    return this.db.transaction(async (trx) => {
      const utxo = await trx("utxo_pool")
        .where({ aircraft_icao: icao, is_locked: false })
        .where("satoshis", ">=", MIN_USABLE_SATS)
        .orderBy("satoshis", "desc")
        .forUpdate()
        .skipLocked()
        .first<UTXORecord | undefined>();

      if (!utxo) {
        throw new Error(`No available UTXOs for aircraft ${icao}`);
      }

      await trx("utxo_pool")
        .where({ txid: utxo.txid, vout: utxo.vout })
        .update({ is_locked: true });

      return utxo;
    });
  }

  delaySpendRetries(
    icao: string,
    ms = ORPHAN_SPEND_COOLDOWN_MS,
    reason = "dependency pending",
  ): void {
    const key = icao.toUpperCase();
    this.setSpendBackoff(key, ms);
    log.info({ icao: key, cooldownMs: ms, reason }, "Deferring aircraft UTXO reuse");
  }

  async releaseUtxo(txid: string, vout: number): Promise<void> {
    await this.db("utxo_pool")
      .where({ txid, vout })
      .update({ is_locked: false });
  }

  async deleteStaleUtxo(txid: string, vout: number): Promise<void> {
    const deleted = await this.db("utxo_pool").where({ txid, vout }).delete();
    if (deleted > 0) {
      log.warn({ txid: txid.slice(0, 12), vout }, "Purged stale UTXO after broadcast rejection");
    }
  }

  async recordSpend(
    spentTxid: string,
    spentVout: number,
    changeTxid: string,
    changeVout: number,
    changeSats: number,
    changeLockingScript: string,
    icao: string,
  ): Promise<void> {
    await this.db.transaction(async (trx) => {
      await trx("utxo_pool")
        .where({ txid: spentTxid, vout: spentVout })
        .delete();

      if (changeSats >= MIN_USABLE_SATS) {
        await trx("utxo_pool").insert({
          aircraft_icao: icao,
          txid: changeTxid,
          vout: changeVout,
          satoshis: changeSats,
          locking_script: changeLockingScript,
          is_locked: false,
        });
      } else {
        log.debug(
          { icao, changeSats, txid: changeTxid.slice(0, 12) },
          "Discarding sub-threshold change UTXO",
        );
      }
    });

    this.deferFreshOutputReuse(icao, CHAIN_PROPAGATION_COOLDOWN_MS);
    await this.refreshMetrics(icao);
  }

  async addUtxo(
    icao: string,
    txid: string,
    vout: number,
    satoshis: number,
    lockingScript: string,
  ): Promise<void> {
    await insertUtxo(this.db, {
      aircraft_icao: icao,
      txid,
      vout,
      satoshis,
      locking_script: lockingScript,
    });
    this.deferFreshOutputReuse(icao, REFILL_PROPAGATION_COOLDOWN_MS);
    await this.refreshMetrics(icao);
  }

  async consolidate(
    icao: string,
    privateKey: PrivateKey,
    broadcaster: ArcBroadcaster,
    threshold: number,
  ): Promise<void> {
    const count = await getUtxoCount(this.db, icao);
    if (count <= threshold) return;

    const utxos = await this.db("utxo_pool")
      .where({ aircraft_icao: icao, is_locked: false })
      .orderBy("satoshis", "asc") as UTXORecord[];

    if (utxos.length <= threshold) return;

    log.info({ icao, utxoCount: utxos.length }, "Starting UTXO consolidation");

    try {
      const { tx, changeOutput } = await buildConsolidationTx(utxos, privateKey);
      const result = await broadcaster.broadcast(tx, icao);

      if (result.status === "FAILED") {
        log.error({ icao }, "Consolidation broadcast failed");
        return;
      }

      const txid = result.txid;

      await this.db.transaction(async (trx) => {
        for (const u of utxos) {
          await trx("utxo_pool")
            .where({ txid: u.txid, vout: u.vout })
            .delete();
        }

        await trx("utxo_pool").insert({
          aircraft_icao: icao,
          txid,
          vout: 0,
          satoshis: changeOutput.satoshis,
          locking_script: changeOutput.lockingScript,
          is_locked: false,
        });
      });

      log.info(
        { icao, txid, consolidatedCount: utxos.length, satoshis: changeOutput.satoshis },
        "UTXO consolidation complete",
      );
      await this.refreshMetrics(icao);
    } catch (err) {
      log.error({ err, icao }, "UTXO consolidation error");
    }
  }

  async checkBalance(
    icao: string,
  ): Promise<{ balance: number; utxoCount: number }> {
    const [balanceRaw, utxoCount] = await Promise.all([
      getUtxoPoolBalance(this.db, icao),
      getUtxoCount(this.db, icao),
    ]);

    const balance = balanceRaw !== null ? Number(balanceRaw) : 0;
    return { balance, utxoCount };
  }

  async purgeSubThresholdUtxos(): Promise<number> {
    const deleted = await this.db("utxo_pool")
      .where("satoshis", "<", MIN_USABLE_SATS)
      .delete();
    if (deleted > 0) {
      log.info({ deleted, threshold: MIN_USABLE_SATS }, "Purged sub-threshold dust UTXOs from pool");
    }
    return deleted;
  }

  private deriveLockingScriptHex(address: string): string {
    const decoded = this.decodeBase58Address(address);
    const lockingScript = new P2PKH().lock(decoded);
    return lockingScript.toHex();
  }

  private decodeBase58Address(address: string): number[] {
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let num = 0n;
    for (const char of address) {
      const idx = ALPHABET.indexOf(char);
      if (idx === -1) throw new Error(`Invalid base58 character: ${char}`);
      num = num * 58n + BigInt(idx);
    }
    const hex = num.toString(16).padStart(50, "0");
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.slice(i, i + 2), 16));
    }
    // Strip version byte (1) and checksum (4), return 20-byte pubkey hash
    return bytes.slice(1, 21);
  }

  private deferFreshOutputReuse(icao: string, ms: number): void {
    this.setSpendBackoff(icao, ms);
  }

  private setSpendBackoff(icao: string, ms: number): void {
    const key = icao.toUpperCase();
    const nextUntil = Date.now() + ms;
    const currentUntil = this.spendBackoffUntil.get(key) ?? 0;
    this.spendBackoffUntil.set(key, Math.max(currentUntil, nextUntil));
  }

  private async refreshMetrics(icao: string): Promise<void> {
    try {
      const { balance, utxoCount } = await this.checkBalance(icao);
      utxoPoolBalance.set({ icao }, balance);
      utxoPoolCount.set({ icao }, utxoCount);
    } catch {
      // Non-critical; swallow metrics refresh errors
    }
  }
}
