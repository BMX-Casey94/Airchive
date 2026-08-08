import type { Knex } from "knex";
import { P2PKH, type PrivateKey } from "@bsv/sdk";
import type { UTXORecord } from "@airchive/types";
import {
  getUtxoCount,
  getUtxoPoolBalance,
  insertUtxo,
  markUtxosConfirmed,
  resetConfirmedUtxoDepths,
  type NewUtxo,
} from "@airchive/db";
import { createLogger } from "@airchive/logger";
import { buildConsolidationTx } from "./tx-builder.js";
import {
  BroadcastPriority,
  type Broadcaster,
} from "./broadcaster.js";
import {
  utxoChainDepthDeferralsTotal,
  utxoChainDepthResetsTotal,
  utxoLocksReclaimedTotal,
  utxoPoolBalance,
  utxoPoolCount,
} from "./metrics.js";
import type { ChainLookup } from "./chain-lookup.js";

const log = createLogger({ service: "blockchain-writer:utxo" });

interface WocUtxo {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height: number;
}

export interface UtxoPoolState {
  balance: number;
  utxoCount: number;
  unlockedUtxoCount: number;
  readyUtxoCount: number;
  coolingUtxoCount: number;
  /** Unlocked outputs held back because they sit too deep in an unconfirmed chain. */
  deepUtxoCount: number;
}

const MIN_USABLE_SATS = 120;
/**
 * Ceiling used when no governor is attached, e.g. in tests and one-shot tools.
 * Production wires the configured value through `setMaxUnconfirmedChainDepth`.
 */
const DEFAULT_MAX_UNCONFIRMED_CHAIN_DEPTH = 5;
/** Depth assigned to an output the treasury has just delivered but not settled. */
const REFILL_OUTPUT_DEPTH = 1;
const ORPHAN_SPEND_COOLDOWN_MS = 1_000;
const CHAIN_PROPAGATION_COOLDOWN_MS = 0;
const REFILL_PROPAGATION_COOLDOWN_MS = 500;
const RECONCILE_COOLDOWN_MS = 60_000;
const MAX_CONCURRENT_RECONCILES = 2;

/**
 * A lock is held only for the duration of one build-and-broadcast. Anything
 * still locked well beyond that lost its owner to a crash or an unhandled
 * rejection, and holding it forever silently shrinks the spendable pool.
 */
export const UTXO_LOCK_TTL_MS = 2 * 60 * 1_000;

/**
 * WhatsOnChain reports mempool outputs with a zero (or absent) height. Only a
 * real block height proves the output — and therefore its whole ancestry — has
 * settled.
 */
function isConfirmedHeight(height: number | null | undefined): boolean {
  return typeof height === "number" && Number.isFinite(height) && height > 0;
}

/**
 * Raised when an aircraft's pool still holds rows but none can be spent. The
 * pool cannot fix this itself — only reconciliation against the chain can.
 */
export class StalePoolError extends Error {
  constructor(
    readonly icao: string,
    readonly residualRows: number,
  ) {
    super(
      `No spendable UTXOs for aircraft ${icao} despite ${residualRows} pool row(s) — pool is stale`,
    );
    this.name = "StalePoolError";
  }
}

/**
 * Raised when the only outputs left would extend an unconfirmed chain past the
 * ceiling. The funds are real, so this is a wait-for-a-block condition rather
 * than a funding failure: the write is deferred and a refill is requested so
 * fresh, shallow outputs arrive.
 */
export class ChainDepthExhaustedError extends Error {
  constructor(
    readonly icao: string,
    readonly deepRows: number,
    readonly maxDepth: number,
  ) {
    super(
      `Unconfirmed chain depth ceiling reached for aircraft ${icao} `
        + `(${deepRows} output(s) at or beyond depth ${maxDepth})`,
    );
    this.name = "ChainDepthExhaustedError";
  }
}

export class UtxoManager {
  private readonly utxoCooldownUntil = new Map<string, number>();
  private readonly reconcileInFlight = new Map<string, Promise<void>>();
  private readonly reconcileCooldownUntil = new Map<string, number>();
  private reconcileActive = 0;
  private readonly reconcileWaiters: Array<() => void> = [];
  private maxUnconfirmedChainDepth: () => number = () =>
    DEFAULT_MAX_UNCONFIRMED_CHAIN_DEPTH;

  constructor(
    private readonly db: Knex,
    private readonly woc: ChainLookup,
  ) {}

  /**
   * Supplies the live ceiling on unconfirmed chain depth. It is a callback
   * rather than a number so the spend governor can tighten it the moment
   * rejections climb, without the pool having to be rebuilt.
   */
  setMaxUnconfirmedChainDepth(resolve: () => number): void {
    this.maxUnconfirmedChainDepth = () => Math.max(1, Math.floor(resolve()));
  }

  getMaxUnconfirmedChainDepth(): number {
    return Math.max(1, Math.floor(this.maxUnconfirmedChainDepth()));
  }

  async bootstrap(icao: string, address: string): Promise<boolean> {
    const existing = await getUtxoCount(this.db, icao);
    if (existing > 0) {
      const state = await this.checkBalance(icao);
      // A populated pool is not necessarily a usable one: every row may be dust
      // or a phantom left by a spend the network dropped. Trusting the row count
      // alone left such wallets permanently unable to spend.
      if (state.unlockedUtxoCount === 0) {
        log.warn(
          { icao, rows: existing },
          "UTXO pool has rows but none are spendable — reconciling against chain instead of skipping",
        );
        await this.reconcile(icao, address);
        return true;
      }
      log.info(
        { icao, count: existing, spendable: state.unlockedUtxoCount },
        "UTXO pool already populated, skipping bootstrap",
      );
      this.setMetricsFromState(icao, state);
      return false;
    }

    log.info({ icao, address }, "Bootstrapping UTXO pool from WoC");
    const utxos = await this.fetchFromChain(address);
    if (utxos.length === 0) {
      log.warn({ icao, address }, "No UTXOs found on-chain for aircraft wallet");
      return true;
    }

    const lockingScript = this.deriveLockingScriptHex(address);

    for (const woc of utxos) {
      const record: NewUtxo = {
        aircraft_icao: icao,
        txid: woc.tx_hash,
        vout: woc.tx_pos,
        satoshis: woc.value,
        locking_script: lockingScript,
        unconfirmed_depth: isConfirmedHeight(woc.height) ? 0 : REFILL_OUTPUT_DEPTH,
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
    return true;
  }

  async acquireUtxo(icao: string, minReadyReserve = 0): Promise<UTXORecord> {
    const key = icao.toUpperCase();
    this.pruneExpiredCooldowns();
    const maxDepth = this.getMaxUnconfirmedChainDepth();

    for (let attempt = 0; attempt < 5; attempt++) {
      // Shallowest first, then largest. Preferring settled funds spreads writes
      // across the pool instead of repeatedly extending whichever lineage
      // happens to hold the biggest change output, which is what turned a
      // single rejection into a long tail of doomed descendants.
      const spendable = await this.db("utxo_pool")
        .where({ aircraft_icao: icao, is_locked: false })
        .where("satoshis", ">=", MIN_USABLE_SATS)
        .where("unconfirmed_depth", "<", maxDepth)
        .orderBy([
          { column: "unconfirmed_depth", order: "asc" },
          { column: "satoshis", order: "desc" },
        ]) as UTXORecord[];

      const readyCandidates = spendable.filter(
        (utxo) => !this.isUtxoCooling(utxo.txid, utxo.vout),
      );

      if (readyCandidates.length === 0) {
        if (spendable.length > 0) {
          throw new Error(`UTXO spend cooling down for aircraft ${key}`);
        }

        // Funds may exist but sit too deep in an unconfirmed chain to extend
        // safely. That is a wait-for-a-block state, not a stale pool, and must
        // not be resolved by spending anyway.
        const deep = await this.db("utxo_pool")
          .where({ aircraft_icao: icao, is_locked: false })
          .where("satoshis", ">=", MIN_USABLE_SATS)
          .where("unconfirmed_depth", ">=", maxDepth)
          .count<[{ count: string }]>({ count: "*" })
          .first();
        const deepRows = Number(deep?.count ?? 0);
        if (deepRows > 0) {
          utxoChainDepthDeferralsTotal.inc();
          throw new ChainDepthExhaustedError(key, deepRows, maxDepth);
        }

        // Nothing spendable. If rows still exist they are locked, dust, or
        // phantoms left by a spend the network never accepted — all of which
        // need chain truth to resolve, not another refill.
        const residual = await this.db("utxo_pool")
          .where({ aircraft_icao: icao })
          .count<[{ count: string }]>({ count: "*" })
          .first();
        const residualRows = Number(residual?.count ?? 0);
        if (residualRows > 0) {
          throw new StalePoolError(key, residualRows);
        }
        throw new Error(`No available UTXOs for aircraft ${icao}`);
      }

      if (minReadyReserve > 0 && readyCandidates.length <= minReadyReserve) {
        throw new Error(
          `UTXO ready reserve protected for aircraft ${key} (ready=${readyCandidates.length}, reserve=${minReadyReserve})`,
        );
      }

      const ready = readyCandidates[0]!;

      const locked = await this.db("utxo_pool")
        .where({ txid: ready.txid, vout: ready.vout, is_locked: false })
        .update({ is_locked: true, locked_at: this.db.fn.now() });

      if (locked > 0) {
        return ready;
      }
    }

    throw new Error(`UTXO acquisition contention for aircraft ${icao}`);
  }

  /**
   * Frees locks held past the TTL, but only for outputs the chain still says
   * are unspent.
   *
   * A lock outlives its owner in two very different situations: the broadcast
   * never happened, in which case the output is still spendable; or the
   * broadcast did happen and the writer lost track of it, in which case the
   * output is gone. Unlocking blindly treats the second case as the first and
   * hands the same output to the next write, producing a conflicting spend
   * whose rejection then invalidates every transaction chained behind it.
   *
   * Reconciling each affected wallet first removes the outputs that are truly
   * spent; whatever survives is safe to unlock.
   */
  async reclaimStaleLocks(
    resolveAddress?: (icao: string) => string,
    ttlMs = UTXO_LOCK_TTL_MS,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - ttlMs);

    const staleQuery = () =>
      this.db("utxo_pool")
        .where({ is_locked: true })
        .where((builder) => {
          void builder.where("locked_at", "<", cutoff).orWhereNull("locked_at");
        });

    const affected = await staleQuery().distinct("aircraft_icao") as Array<{
      aircraft_icao: string;
    }>;
    if (affected.length === 0) return 0;

    if (resolveAddress) {
      for (const { aircraft_icao: icao } of affected) {
        try {
          await this.reconcile(icao, resolveAddress(icao));
        } catch (err) {
          log.warn(
            { err, icao },
            "Could not reconcile before reclaiming locks — leaving them held",
          );
        }
      }
    }

    // Rows deleted by reconciliation were spent, so this only unlocks the ones
    // the chain still recognises.
    const reclaimed = await staleQuery().update({ is_locked: false, locked_at: null });

    if (reclaimed > 0) {
      utxoLocksReclaimedTotal.inc({ pool: "aircraft" }, reclaimed);
      log.warn(
        { reclaimed, aircraft: affected.length, ttlMs },
        "Reclaimed aircraft UTXO locks the chain confirms are still unspent",
      );
    }
    return reclaimed;
  }

  delaySpendRetries(
    icao: string,
    txid: string,
    vout: number,
    ms = ORPHAN_SPEND_COOLDOWN_MS,
    reason = "dependency pending",
  ): void {
    const key = icao.toUpperCase();
    this.setUtxoCooldown(txid, vout, ms);
    log.info(
      { icao: key, txid: txid.slice(0, 12), vout, cooldownMs: ms, reason },
      "Deferring aircraft UTXO reuse",
    );
  }

  async releaseUtxo(txid: string, vout: number): Promise<void> {
    await this.db("utxo_pool")
      .where({ txid, vout })
      .update({ is_locked: false, locked_at: null });
  }

  async deleteStaleUtxo(txid: string, vout: number): Promise<void> {
    const deleted = await this.db("utxo_pool").where({ txid, vout }).delete();
    this.clearUtxoCooldown(txid, vout);
    if (deleted > 0) {
      log.warn({ txid: txid.slice(0, 12), vout }, "Purged stale UTXO after broadcast rejection");
    }
  }

  /**
   * Drops every pool entry created by a transaction the network refused.
   *
   * A rejected transaction's change output does not exist, but the writer
   * recorded it locally the moment it broadcast. Left in place it becomes the
   * parent of the aircraft's next write, which is then rejected for spending a
   * non-existent input, and so on — one rejection quietly ends all further
   * writes for that aircraft. Removing the phantom outputs breaks that chain,
   * and the caller reconciles against the chain to recover the real ones.
   */
  async invalidateOutputsOf(txid: string): Promise<number> {
    const normalised = txid.trim();
    const rows = await this.db("utxo_pool")
      .where({ txid: normalised })
      .select("vout") as Array<{ vout: number }>;
    if (rows.length === 0) return 0;

    const deleted = await this.db("utxo_pool").where({ txid: normalised }).delete();
    for (const row of rows) {
      this.clearUtxoCooldown(normalised, row.vout);
    }
    log.warn(
      { txid: normalised.slice(0, 12), deleted },
      "Purged phantom outputs of a rejected transaction",
    );
    return deleted;
  }

  async recordSpend(
    spentTxid: string,
    spentVout: number,
    changeTxid: string,
    changeVout: number,
    changeSats: number,
    changeLockingScript: string,
    icao: string,
  ): Promise<UtxoPoolState> {
    await this.db.transaction(async (trx: Knex.Transaction) => {
      // The change output inherits the parent's position in the unconfirmed
      // chain and adds one, so the ceiling is enforced against real lineage
      // rather than a guess.
      const parent = await trx("utxo_pool")
        .where({ txid: spentTxid, vout: spentVout })
        .first<{ unconfirmed_depth: number | string | null }>("unconfirmed_depth");
      const parentDepth = Math.max(0, Number(parent?.unconfirmed_depth ?? 0) || 0);

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
          unconfirmed_depth: parentDepth + 1,
        });
      } else {
        log.debug(
          { icao, changeSats, txid: changeTxid.slice(0, 12) },
          "Discarding sub-threshold change UTXO",
        );
      }
    });

    this.clearUtxoCooldown(spentTxid, spentVout);
    if (changeSats >= MIN_USABLE_SATS) {
      this.deferFreshOutputReuse(
        icao,
        changeTxid,
        changeVout,
        CHAIN_PROPAGATION_COOLDOWN_MS,
      );
    }
    return await this.refreshMetrics(icao);
  }

  async addUtxo(
    icao: string,
    txid: string,
    vout: number,
    satoshis: number,
    lockingScript: string,
  ): Promise<UtxoPoolState> {
    return await this.addUtxos(icao, [{
      txid,
      vout,
      satoshis,
      lockingScript,
    }]);
  }

  async addUtxos(
    icao: string,
    outputs: Array<{
      txid: string;
      vout: number;
      satoshis: number;
      lockingScript: string;
    }>,
  ): Promise<UtxoPoolState> {
    for (const output of outputs) {
      await insertUtxo(this.db, {
        aircraft_icao: icao,
        txid: output.txid,
        vout: output.vout,
        satoshis: output.satoshis,
        locking_script: output.lockingScript,
        // A refill is itself an unconfirmed transaction, so its outputs start
        // one level into the chain rather than pretending to be settled funds.
        unconfirmed_depth: REFILL_OUTPUT_DEPTH,
      });
      this.deferFreshOutputReuse(
        icao,
        output.txid,
        output.vout,
        REFILL_PROPAGATION_COOLDOWN_MS,
      );
    }
    return await this.refreshMetrics(icao);
  }

  async reconcile(icao: string, address: string): Promise<void> {
    const key = icao.toUpperCase();
    const existing = this.reconcileInFlight.get(key);
    if (existing) {
      await existing;
      return;
    }

    const cooldownUntil = this.reconcileCooldownUntil.get(key) ?? 0;
    if (cooldownUntil > Date.now()) {
      log.debug(
        { icao: key, remainingMs: cooldownUntil - Date.now() },
        "Skipping aircraft reconciliation — cooldown active",
      );
      return;
    }
    this.reconcileCooldownUntil.set(key, Date.now() + RECONCILE_COOLDOWN_MS);

    const task = (async () => {
      await this.acquireReconcileSlot();
      let onChain: WocUtxo[];
      try {
        onChain = await this.fetchFromChain(address);
      } catch (err) {
        log.warn({ err, icao: key }, "Aircraft reconciliation skipped — WoC unreachable");
        return;
      } finally {
        this.releaseReconcileSlot();
      }

      const lockingScript = this.deriveLockingScriptHex(address);
      const onChainSet = new Set(onChain.map((u) => `${u.tx_hash}:${u.tx_pos}`));
      const localRows = await this.db("utxo_pool")
        .where({ aircraft_icao: key })
        .select("txid", "vout");
      const localSet = new Set(
        localRows.map((row: { txid: string; vout: number }) => `${row.txid.trim()}:${row.vout}`),
      );

      let added = 0;
      let removed = 0;
      const confirmedOutpoints: Array<{ txid: string; vout: number }> = [];

      for (const utxo of onChain) {
        const outpoint = `${utxo.tx_hash}:${utxo.tx_pos}`;
        const confirmed = isConfirmedHeight(utxo.height);
        if (confirmed) {
          confirmedOutpoints.push({ txid: utxo.tx_hash, vout: utxo.tx_pos });
        }
        if (!localSet.has(outpoint) && utxo.value >= MIN_USABLE_SATS) {
          await insertUtxo(this.db, {
            aircraft_icao: key,
            txid: utxo.tx_hash,
            vout: utxo.tx_pos,
            satoshis: utxo.value,
            locking_script: lockingScript,
            unconfirmed_depth: confirmed ? 0 : REFILL_OUTPUT_DEPTH,
          });
          added++;
        }
      }

      // A confirmed output has no unconfirmed ancestors, so settling it frees
      // the whole lineage behind it for spending again.
      const depthResets = await markUtxosConfirmed(this.db, confirmedOutpoints);
      if (depthResets > 0) {
        utxoChainDepthResetsTotal.inc(depthResets);
      }

      for (const row of localRows) {
        const outpoint = `${(row.txid as string).trim()}:${row.vout as number}`;
        if (!onChainSet.has(outpoint)) {
          await this.db("utxo_pool")
            .where({
              txid: (row.txid as string).trim(),
              vout: row.vout as number,
            })
            .delete();
          this.clearUtxoCooldown((row.txid as string).trim(), row.vout as number);
          removed++;
        }
      }

      if (added > 0 || removed > 0 || depthResets > 0) {
        log.info(
          {
            icao: key,
            added,
            removed,
            depthResets,
            onChainTotal: onChain.length,
          },
          "Aircraft UTXO pool reconciled",
        );
      }

      await this.refreshMetrics(key);
    })();

    this.reconcileInFlight.set(key, task);
    try {
      await task;
    } finally {
      if (this.reconcileInFlight.get(key) === task) {
        this.reconcileInFlight.delete(key);
      }
    }
  }

  async consolidate(
    icao: string,
    privateKey: PrivateKey,
    broadcaster: Broadcaster,
    threshold: number,
  ): Promise<void> {
    const count = await getUtxoCount(this.db, icao);
    if (count <= threshold) return;

    const utxos = await this.db("utxo_pool")
      .where({ aircraft_icao: icao, is_locked: false })
      .orderBy("satoshis", "asc") as UTXORecord[];

    if (utxos.length <= threshold) return;

    // Consolidation spends every input at once, so its single output sits one
    // level below the deepest of them.
    const consolidatedDepth = utxos.reduce(
      (deepest, utxo) => Math.max(deepest, Number(utxo.unconfirmed_depth ?? 0) || 0),
      0,
    ) + 1;

    log.info({ icao, utxoCount: utxos.length }, "Starting UTXO consolidation");

    try {
      const { tx, changeOutput } = await buildConsolidationTx(utxos, privateKey);
      const result = await broadcaster.broadcast(tx, icao, {
        kind: "consolidation",
        priority: BroadcastPriority.CONSOLIDATION,
        allowTransientRetry: false,
      });

      if (result.status === "FAILED") {
        log.error({ icao }, "Consolidation broadcast failed");
        return;
      }

      const txid = result.txid;

      await this.db.transaction(async (trx: Knex.Transaction) => {
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
          unconfirmed_depth: consolidatedDepth,
        });
      });

      for (const u of utxos) {
        this.clearUtxoCooldown(u.txid, u.vout);
      }
      this.deferFreshOutputReuse(
        icao,
        txid,
        0,
        CHAIN_PROPAGATION_COOLDOWN_MS,
      );

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
  ): Promise<UtxoPoolState> {
    this.pruneExpiredCooldowns();

    const maxDepth = this.getMaxUnconfirmedChainDepth();
    const [balanceRaw, utxoCount, unlockedRows] = await Promise.all([
      getUtxoPoolBalance(this.db, icao),
      getUtxoCount(this.db, icao),
      this.db("utxo_pool")
        .where({ aircraft_icao: icao, is_locked: false })
        .where("satoshis", ">=", MIN_USABLE_SATS)
        .select("txid", "vout", "unconfirmed_depth") as Promise<
          Array<{ txid: string; vout: number; unconfirmed_depth: number | string | null }>
        >,
    ]);

    const balance = balanceRaw !== null ? Number(balanceRaw) : 0;
    // Outputs too deep in an unconfirmed chain are not spendable right now, so
    // counting them as available would hide the need for a refill and let the
    // write path keep discovering the shortfall one deferral at a time.
    const shallowRows = unlockedRows.filter(
      (row) => (Number(row.unconfirmed_depth ?? 0) || 0) < maxDepth,
    );
    const unlockedUtxoCount = shallowRows.length;
    const readyUtxoCount = shallowRows.filter(
      (row) => !this.isUtxoCooling(row.txid, row.vout),
    ).length;
    const coolingUtxoCount = Math.max(0, unlockedUtxoCount - readyUtxoCount);

    return {
      balance,
      utxoCount,
      unlockedUtxoCount,
      readyUtxoCount,
      coolingUtxoCount,
      deepUtxoCount: Math.max(0, unlockedRows.length - unlockedUtxoCount),
    };
  }

  /**
   * Frees outputs whose creating transaction has been proved into a block.
   *
   * This is what keeps the depth ceiling from becoming a ratchet on a healthy
   * wallet: writes push depth up, confirmations pull it back to zero.
   */
  async settleConfirmedChainDepths(): Promise<number> {
    const reset = await resetConfirmedUtxoDepths(this.db);
    if (reset > 0) {
      utxoChainDepthResetsTotal.inc(reset);
      log.debug(
        { reset },
        "Reset unconfirmed chain depth for pool outputs confirmed on-chain",
      );
    }
    return reset;
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

  private deferFreshOutputReuse(
    icao: string,
    txid: string,
    vout: number,
    ms: number,
  ): void {
    this.setUtxoCooldown(txid, vout, ms);
    log.debug(
      { icao: icao.toUpperCase(), txid: txid.slice(0, 12), vout, cooldownMs: ms },
      "Cooling fresh aircraft output before reuse",
    );
  }

  private async fetchFromChain(address: string): Promise<WocUtxo[]> {
    const utxos = await this.woc.getJson<WocUtxo[]>(
      `/address/${address}/unspent`,
      { label: "address_unspent", timeoutMs: 15_000 },
    );
    if (!utxos) {
      throw new Error(`WoC UTXO fetch returned no body for ${address}`);
    }
    return utxos;
  }

  private getOutpointKey(txid: string, vout: number): string {
    return `${txid.trim()}:${vout}`;
  }

  private isUtxoCooling(txid: string, vout: number): boolean {
    const until = this.utxoCooldownUntil.get(this.getOutpointKey(txid, vout)) ?? 0;
    return until > Date.now();
  }

  private setUtxoCooldown(txid: string, vout: number, ms: number): void {
    const key = this.getOutpointKey(txid, vout);
    const nextUntil = Date.now() + ms;
    const currentUntil = this.utxoCooldownUntil.get(key) ?? 0;
    this.utxoCooldownUntil.set(key, Math.max(currentUntil, nextUntil));
  }

  private clearUtxoCooldown(txid: string, vout: number): void {
    this.utxoCooldownUntil.delete(this.getOutpointKey(txid, vout));
  }

  private pruneExpiredCooldowns(): void {
    const now = Date.now();
    for (const [key, until] of this.utxoCooldownUntil) {
      if (until <= now) {
        this.utxoCooldownUntil.delete(key);
      }
    }
  }

  private async acquireReconcileSlot(): Promise<void> {
    if (this.reconcileActive < MAX_CONCURRENT_RECONCILES) {
      this.reconcileActive++;
      return;
    }

    await new Promise<void>((resolve) => {
      this.reconcileWaiters.push(() => {
        this.reconcileActive++;
        resolve();
      });
    });
  }

  private releaseReconcileSlot(): void {
    this.reconcileActive = Math.max(0, this.reconcileActive - 1);
    const next = this.reconcileWaiters.shift();
    if (next) {
      next();
    }
  }

  private setMetricsFromState(icao: string, state: Pick<UtxoPoolState, "balance" | "utxoCount">): void {
    utxoPoolBalance.set({ icao }, state.balance);
    utxoPoolCount.set({ icao }, state.utxoCount);
  }

  private async refreshMetrics(icao: string): Promise<UtxoPoolState> {
    try {
      const state = await this.checkBalance(icao);
      this.setMetricsFromState(icao, state);
      return state;
    } catch {
      // Non-critical; swallow metrics refresh errors
      return await this.checkBalance(icao);
    }
  }
}
