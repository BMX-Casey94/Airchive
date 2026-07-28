import type { Knex } from "knex";
import { P2PKH, PrivateKey } from "@bsv/sdk";
import { createLogger } from "@airchive/logger";
import {
  deleteFundingUtxo,
  getFundingUtxoBalance,
  getFundingUtxoCount,
  insertFundingUtxo,
  reclaimStaleFundingLocks,
  releaseFundingUtxo,
  unlockAllFundingUtxos,
  type FundingUtxoRow,
} from "@airchive/db";
import {
  buildFundingSplitTx,
  derivePubKeyHash,
  estimateRefillFee,
} from "./tx-builder.js";
import {
  BroadcastPriority,
  type Broadcaster,
} from "./broadcaster.js";
import {
  fundingPoolBalance,
  fundingPoolCount,
  utxoLocksReclaimedTotal,
} from "./metrics.js";
import { UTXO_LOCK_TTL_MS } from "./utxo-manager.js";

const log = createLogger({ service: "blockchain-writer:funding-utxo" });

const MIN_USABLE_SATS = 546;
/**
 * Floor for a treasury split output. A refill spends roughly one of these, so
 * anything smaller only adds inputs to every future refill without adding
 * usable capacity. Callers that know the configured refill amount should pass
 * their own value.
 */
const DEFAULT_MIN_SPLIT_OUTPUT_SATS = 100_000;
const MIN_RECONCILE_INTERVAL_MS = 30_000;
const RATE_LIMITED_COOLDOWN_MS = 120_000;
const FUNDING_PROPAGATION_COOLDOWN_MS = 500;

interface WocUtxo {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height: number;
}

export type FundingSelectionReason =
  | "ok"
  | "no_unlocked_candidates"
  | "all_candidates_cooling"
  | "insufficient_within_input_cap";

export interface FundingSelectionDiagnostics {
  candidatesExamined: number;
  coolingSkipped: number;
  selectableSats: number;
  requiredSats: number;
  inputCap: number;
  reason: FundingSelectionReason;
}

export interface FundingSelection {
  utxos: FundingUtxoRow[];
  diagnostics: FundingSelectionDiagnostics;
}

export class FundingUtxoManager {
  private reconcileInFlight: Promise<void> | null = null;
  private reconcileEarliestRetryAt = 0;
  private readonly fundingCooldownUntil = new Map<string, number>();

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
    this.pruneExpiredCooldowns();
    return this.db.transaction(async (trx) => {
      const candidates = await trx("funding_utxo_pool")
        .where({ is_locked: false })
        .where("satoshis", ">=", minSats)
        .orderBy("satoshis", "desc")
        .forUpdate()
        .skipLocked() as FundingUtxoRow[];

      const utxo = candidates.find((row) => !this.isFundingCooling(row.txid, row.vout));
      if (!utxo) return undefined;

      await trx("funding_utxo_pool")
        .where({ txid: utxo.txid, vout: utxo.vout })
        .update({ is_locked: true, locked_at: trx.fn.now() });

      return utxo;
    });
  }

  /**
   * Acquires enough funding UTXOs to cover `minSats`, largest first.
   *
   * A treasury split for refill concurrency holds many modest outputs, so
   * insisting on one output big enough for a whole refill leaves the writer
   * starved while the money is sitting right there. `feeForInputs` lets the
   * caller account for the fee growing with each additional input, so the
   * selection stops as soon as the running total genuinely covers the spend.
   */
  async acquireMany(
    minSats: number,
    maxInputs: number,
    feeForInputs?: (inputCount: number) => number,
  ): Promise<FundingSelection> {
    this.pruneExpiredCooldowns();
    const cap = Math.max(1, Math.floor(maxInputs));

    return this.db.transaction(async (trx) => {
      const candidates = await trx("funding_utxo_pool")
        .where({ is_locked: false })
        .where("satoshis", ">=", MIN_USABLE_SATS)
        .orderBy("satoshis", "desc")
        .limit(cap * 4)
        .forUpdate()
        .skipLocked() as FundingUtxoRow[];

      const selected: FundingUtxoRow[] = [];
      let cooling = 0;
      let total = 0;
      for (const row of candidates) {
        if (selected.length >= cap) break;
        if (this.isFundingCooling(row.txid, row.vout)) {
          cooling += 1;
          continue;
        }
        selected.push(row);
        total += Number(row.satoshis);
        const required = minSats
          + (feeForInputs ? feeForInputs(selected.length) : 0);
        if (total >= required) break;
      }

      const required = minSats
        + (feeForInputs ? feeForInputs(Math.max(1, selected.length)) : 0);

      // The distinction matters operationally: an empty candidate set means the
      // pool is locked or genuinely empty, whereas a short selection means the
      // money exists but is spread over more outputs than one transaction may
      // consume. They demand different remedies, so never collapse them.
      if (selected.length === 0 || total < required) {
        return {
          utxos: [],
          diagnostics: {
            candidatesExamined: candidates.length,
            coolingSkipped: cooling,
            selectableSats: total,
            requiredSats: required,
            inputCap: cap,
            reason: candidates.length === 0
              ? ("no_unlocked_candidates" as const)
              : cooling >= candidates.length
                ? ("all_candidates_cooling" as const)
                : ("insufficient_within_input_cap" as const),
          },
        };
      }

      await trx("funding_utxo_pool")
        .whereIn(
          ["txid", "vout"],
          selected.map((row) => [row.txid, row.vout]),
        )
        .update({ is_locked: true, locked_at: trx.fn.now() });

      return {
        utxos: selected,
        diagnostics: {
          candidatesExamined: candidates.length,
          coolingSkipped: cooling,
          selectableSats: total,
          requiredSats: required,
          inputCap: cap,
          reason: "ok" as const,
        },
      };
    });
  }

  async release(txid: string, vout: number): Promise<void> {
    await releaseFundingUtxo(this.db, txid, vout);
  }

  async releaseMany(utxos: Array<{ txid: string; vout: number }>): Promise<void> {
    await Promise.all(
      utxos.map((utxo) => this.release(utxo.txid.trim(), utxo.vout)),
    );
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
    await this.recordSpendMany(
      [{ txid: spentTxid, vout: spentVout }],
      changeTxid,
      changeVout,
      changeSats,
      changeLockingScript,
    );
  }

  /** Multi-input variant: every consumed output is retired in one transaction. */
  async recordSpendMany(
    spent: Array<{ txid: string; vout: number }>,
    changeTxid: string | null,
    changeVout: number | null,
    changeSats: number | null,
    changeLockingScript: string | null,
  ): Promise<void> {
    await this.db.transaction(async (trx: Knex.Transaction) => {
      for (const input of spent) {
        await trx("funding_utxo_pool")
          .where({ txid: input.txid, vout: input.vout })
          .delete();
      }

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

    for (const input of spent) {
      this.clearFundingCooldown(input.txid, input.vout);
    }
    if (changeTxid !== null && changeVout !== null && changeSats !== null && changeSats >= MIN_USABLE_SATS) {
      this.setFundingCooldown(changeTxid, changeVout, FUNDING_PROPAGATION_COOLDOWN_MS);
    }
    await this.refreshMetrics();
  }

  async deleteStale(txid: string, vout: number): Promise<void> {
    const deleted = await deleteFundingUtxo(this.db, txid, vout);
    this.clearFundingCooldown(txid, vout);
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

  async reclaimStaleLocks(ttlMs = UTXO_LOCK_TTL_MS): Promise<number> {
    const reclaimed = await reclaimStaleFundingLocks(this.db, ttlMs);
    if (reclaimed > 0) {
      utxoLocksReclaimedTotal.inc({ pool: "funding" }, reclaimed);
      log.warn(
        { reclaimed, ttlMs },
        "Reclaimed funding UTXO locks held beyond TTL (orphaned by a failed refill)",
      );
    }
    return reclaimed;
  }

  async getBalance(): Promise<{ balance: number; count: number }> {
    const [balance, count] = await Promise.all([
      getFundingUtxoBalance(this.db),
      getFundingUtxoCount(this.db),
    ]);
    return { balance, count };
  }

  /**
   * Aggressively split funding UTXOs until the pool reaches the desired
   * target count. Each large UTXO is fanned out into up to 40 outputs.
   * Multiple rounds are run, with a short propagation wait between
   * rounds so the newly-created outputs become spendable.
   */
  async splitIfNeeded(
    fundingWif: string,
    broadcaster: Broadcaster,
    desiredMinCount = 80,
    minOutputSats = DEFAULT_MIN_SPLIT_OUTPUT_SATS,
  ): Promise<number> {
    const { count, balance } = await this.getBalance();
    if (count >= desiredMinCount) {
      log.info({ count, balance, desiredMinCount }, "Funding pool already at target count");
      return 0;
    }

    const fundingKey = PrivateKey.fromWif(fundingWif);
    let totalCreated = 0;
    const MAX_ROUNDS = 6;
    const OUTPUTS_PER_SPLIT = 40;
    // Chasing a count target with no floor on output size is how the treasury
    // ends up holding hundreds of outputs that are individually too small to
    // fund a single refill. Never mint an output below one refill's worth.
    const floorSats = Math.max(minOutputSats, MIN_USABLE_SATS);
    const MIN_INPUT_SATS = OUTPUTS_PER_SPLIT * floorSats;
    const PROPAGATION_WAIT_MS = 2_000;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const currentPool = await this.getBalance();
      const deficit = desiredMinCount - currentPool.count;
      if (deficit <= 0) break;

      const splitsThisRound = Math.min(
        Math.ceil(deficit / OUTPUTS_PER_SPLIT),
        Math.max(1, Math.floor(currentPool.count / 2)),
      );

      let createdThisRound = 0;
      let failedThisRound = false;

      for (let i = 0; i < splitsThisRound; i++) {
        const remaining = desiredMinCount - currentPool.count - totalCreated;
        if (remaining <= 0) break;
        const outputCount = Math.max(2, Math.min(remaining, OUTPUTS_PER_SPLIT));

        const utxo = await this.acquire(MIN_INPUT_SATS);
        if (!utxo) {
          // Only worth splitting at all if the input can yield two outputs that
          // each still clear the refill floor.
          const smallUtxo = await this.acquire(2 * floorSats);
          if (!smallUtxo) {
            log.warn(
              { round, deficit: remaining, floorSats },
              "No funding UTXO large enough to split without dropping below the "
                + "refill floor — pool is as granular as it usefully gets",
            );
            failedThisRound = true;
            break;
          }
          const adjustedCount = Math.min(
            outputCount,
            Math.floor(Number(smallUtxo.satoshis) / floorSats),
          );
          if (adjustedCount < 2) {
            await this.release(smallUtxo.txid.trim(), smallUtxo.vout);
            failedThisRound = true;
            break;
          }

          const splitResult = await this.executeReshape(
            [smallUtxo], fundingKey, broadcaster, adjustedCount,
          );
          if (splitResult < 0) {
            failedThisRound = true;
            break;
          }
          createdThisRound += splitResult;
          totalCreated += splitResult;
          continue;
        }

        const splitResult = await this.executeReshape(
          [utxo], fundingKey, broadcaster, outputCount,
        );
        if (splitResult < 0) {
          failedThisRound = true;
          break;
        }
        createdThisRound += splitResult;
        totalCreated += splitResult;
      }

      log.info(
        { round: round + 1, createdThisRound, totalCreated, poolCount: currentPool.count + totalCreated },
        "Funding split round complete",
      );

      if (failedThisRound) break;

      const updatedPool = await this.getBalance();
      if (updatedPool.count >= desiredMinCount) break;

      if (round < MAX_ROUNDS - 1) {
        log.info(
          { waitMs: PROPAGATION_WAIT_MS },
          "Waiting for split outputs to propagate before next round",
        );
        await new Promise((r) => setTimeout(r, PROPAGATION_WAIT_MS));
        this.pruneExpiredCooldowns();
      }
    }

    if (totalCreated > 0) {
      await this.refreshMetrics();
      log.info({ totalCreated }, "Funding pool expanded via split");
    }
    return totalCreated;
  }

  /**
   * Merges treasury outputs that are individually too small to fund a refill
   * back into full-sized ones.
   *
   * Without this, a treasury that has become fragmented — by an over-eager
   * split, or by change accumulating below the refill floor — stays that way
   * forever: every refill has to combine a handful of scraps, and once the
   * count of scraps exceeds the per-transaction input cap the writer reports a
   * dry treasury while holding millions of satoshis.
   *
   * Returns the number of consolidation transactions broadcast.
   */
  async consolidateIfFragmented(
    fundingWif: string,
    broadcaster: Broadcaster,
    minOutputSats = DEFAULT_MIN_SPLIT_OUTPUT_SATS,
    maxInputsPerTx = 25,
    maxTransactions = 8,
  ): Promise<number> {
    const floorSats = Math.max(minOutputSats, MIN_USABLE_SATS);
    const fundingKey = PrivateKey.fromWif(fundingWif);
    let broadcast = 0;

    for (let i = 0; i < maxTransactions; i++) {
      const smalls = await this.acquireSmallOutputs(floorSats, maxInputsPerTx);
      const total = smalls.reduce((sum, row) => sum + Number(row.satoshis), 0);
      const fee = estimateRefillFee(1, false, smalls.length);
      const largestInput = smalls.reduce(
        (max, row) => Math.max(max, Number(row.satoshis)), 0,
      );

      // The test is whether merging leaves the treasury better off, not whether
      // it reaches the refill floor in one pass. A badly fragmented treasury
      // needs several passes to climb back, and refusing every pass that falls
      // short of the floor is what would keep it fragmented forever.
      if (smalls.length < 2 || total - fee <= largestInput) {
        await this.releaseMany(
          smalls.map((row) => ({ txid: row.txid.trim(), vout: row.vout })),
        );
        break;
      }

      const outputCount = Math.max(1, Math.floor((total - fee) / floorSats));
      const created = await this.executeReshape(
        smalls, fundingKey, broadcaster, outputCount,
      );
      if (created < 0) break;

      broadcast += 1;
      log.info(
        { inputs: smalls.length, inputSats: total, outputs: created, floorSats },
        "Consolidated fragmented treasury outputs",
      );
    }

    if (broadcast > 0) await this.refreshMetrics();
    return broadcast;
  }

  /** Locks the smallest unlocked outputs sitting below the usable floor. */
  private async acquireSmallOutputs(
    belowSats: number,
    limit: number,
  ): Promise<FundingUtxoRow[]> {
    this.pruneExpiredCooldowns();
    return this.db.transaction(async (trx) => {
      const rows = await trx("funding_utxo_pool")
        .where({ is_locked: false })
        .where("satoshis", ">=", MIN_USABLE_SATS)
        .where("satoshis", "<", belowSats)
        .orderBy("satoshis", "asc")
        .limit(limit)
        .forUpdate()
        .skipLocked() as FundingUtxoRow[];

      const selected = rows.filter((row) => !this.isFundingCooling(row.txid, row.vout));
      if (selected.length === 0) return [];

      await trx("funding_utxo_pool")
        .whereIn(
          ["txid", "vout"],
          selected.map((row) => [row.txid, row.vout]),
        )
        .update({ is_locked: true, locked_at: trx.fn.now() });

      return selected;
    });
  }

  /**
   * Spends the given treasury outputs back to the funding address as
   * `outputCount` new ones, then swaps them in the local pool. Returns the
   * number of outputs created, or -1 if the broadcast failed and the inputs
   * were released.
   */
  private async executeReshape(
    utxos: FundingUtxoRow[],
    fundingKey: PrivateKey,
    broadcaster: Broadcaster,
    outputCount: number,
  ): Promise<number> {
    const spent = utxos.map((utxo) => ({ txid: utxo.txid.trim(), vout: utxo.vout }));
    const inputSats = utxos.reduce((sum, utxo) => sum + Number(utxo.satoshis), 0);

    try {
      const { tx, outputs } = await buildFundingSplitTx({
        fundingUtxos: utxos.map((utxo) => ({
          txid: utxo.txid.trim(),
          vout: utxo.vout,
          satoshis: Number(utxo.satoshis),
          lockingScript: utxo.locking_script,
        })),
        fundingKey,
        targetOutputCount: outputCount,
      });

      const result = await broadcaster.broadcast(tx, undefined, {
        kind: "refill",
        priority: BroadcastPriority.REFILL,
      });

      if (result.status === "FAILED") {
        log.warn(
          { code: result.code, description: result.description, inputs: spent.length },
          "Funding reshape broadcast failed",
        );
        await this.releaseMany(spent);
        return -1;
      }

      const txid = result.txid;
      await this.db("funding_utxo_pool")
        .whereIn(["txid", "vout"], spent.map((input) => [input.txid, input.vout]))
        .delete();
      for (const input of spent) {
        this.clearFundingCooldown(input.txid, input.vout);
      }

      for (const out of outputs) {
        await insertFundingUtxo(this.db, {
          txid,
          vout: out.vout,
          satoshis: out.satoshis,
          locking_script: out.lockingScript,
        });
        this.setFundingCooldown(txid, out.vout, FUNDING_PROPAGATION_COOLDOWN_MS);
      }

      log.info(
        { txid, inputs: spent.length, inputSats, newOutputs: outputs.length },
        "Funding pool reshape broadcast accepted",
      );
      return outputs.length;
    } catch (err) {
      log.error({ err, inputs: spent.length }, "Funding reshape error");
      await this.releaseMany(spent);
      return -1;
    }
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
        this.clearFundingCooldown((row.txid as string).trim(), row.vout as number);
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

  private fundingKey(txid: string, vout: number): string {
    return `${txid.trim()}:${vout}`;
  }

  private setFundingCooldown(txid: string, vout: number, ms: number): void {
    this.fundingCooldownUntil.set(this.fundingKey(txid, vout), Date.now() + ms);
  }

  private clearFundingCooldown(txid: string, vout: number): void {
    this.fundingCooldownUntil.delete(this.fundingKey(txid, vout));
  }

  private isFundingCooling(txid: string, vout: number): boolean {
    const until = this.fundingCooldownUntil.get(this.fundingKey(txid, vout)) ?? 0;
    return until > Date.now();
  }

  private pruneExpiredCooldowns(): void {
    const now = Date.now();
    for (const [key, until] of this.fundingCooldownUntil.entries()) {
      if (until <= now) this.fundingCooldownUntil.delete(key);
    }
  }
}
