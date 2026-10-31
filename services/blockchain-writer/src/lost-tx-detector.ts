import type { Knex } from "knex";
import { FLEET_PSEUDO_ICAO } from "@airchive/telemetry-codec";
import { createLogger } from "@airchive/logger";
import type { TxProbe } from "./chain-lookup.js";
import { readBoolEnv, readNonNegativeInt } from "./live-path-policy.js";
import { lostTxTotal } from "./metrics.js";
import {
  deleteUnconfirmedOutputsOf,
  settleTerminalRejectionMark,
} from "./missing-tx-unwind.js";
import { rebufferRejectedTransaction } from "./rebuffer-rejected.js";

const log = createLogger({ service: "blockchain-writer:lost-tx" });

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH = 50;
const DEFAULT_MIN_AGE_MS = 20 * 60_000;
const DEFAULT_RECHECK_MS = 5 * 60_000;
/** One requeue per txid. A second pass finds the row already claimed. */
const LOST_REQUEUE_ONCE = 1;
const STATE_CAP = 10_000;

const LOST_REASON =
  "Reported SEEN_ON_NETWORK but the chain has no record of this transaction";

export function lostTxDetectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBoolEnv("LOST_TX_DETECTION_ENABLED", true, env);
}

export function lostTxCheckIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const ms = readNonNegativeInt("LOST_TX_CHECK_INTERVAL_MS", DEFAULT_INTERVAL_MS, env);
  return ms > 0 ? ms : DEFAULT_INTERVAL_MS;
}

export function lostTxBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  const batch = readNonNegativeInt("LOST_TX_BATCH", DEFAULT_BATCH, env);
  return batch > 0 ? batch : DEFAULT_BATCH;
}

export function lostTxMinAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegativeInt("LOST_TX_MIN_AGE_MS", DEFAULT_MIN_AGE_MS, env);
}

export function lostTxRecheckMs(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegativeInt("LOST_TX_RECHECK_MS", DEFAULT_RECHECK_MS, env);
}

interface AbsentMark {
  at: number;
  nextEligible: number;
}

export interface LostTxCycleSummary {
  checked: number;
  found: number;
  absent: number;
  unknown: number;
  lost: number;
}

export interface LostTxDeps {
  db: Knex;
  probe(txid: string): Promise<TxProbe>;
  utxoManager: {
    invalidateOutputsOf(txid: string): Promise<number>;
    reconcile(icao: string, address: string): Promise<unknown>;
  };
  fundingUtxoManager: {
    reconcile(fundingWif: string): Promise<unknown>;
    noteOutputsInvalidated(txid: string, vouts: number[]): void;
    isFundingOutputConfirmed(txid: string, vout: number): boolean;
  };
  fundingWif: string;
  addressFor(icao: string): string;
  onQueued?: () => void | Promise<void>;
  /**
   * Present so a test can prove a lost verdict is not fed to the spend
   * governor. The detector never calls it: these rows are hours old and say
   * nothing about whether the network is refusing spends now.
   */
  noteTerminalRejection?: (broadcastAtMs?: number | null) => void;
  now?: () => number;
  minAgeMs?: number;
  recheckMs?: number;
  batch?: number;
}

/**
 * Finds SEEN_ON_NETWORK rows whose transactions are not on the chain.
 *
 * A single miss is not enough. The row is lost only after two definite
 * absences at least LOST_TX_RECHECK_MS apart, or one absence reported by two
 * different providers. Errors and rate limits are unknown and are skipped.
 * The cursor is in memory: last_checked_at belongs to the confirmation poller.
 */
export class LostTxDetector {
  private readonly absent = new Map<string, AbsentMark>();

  constructor(private readonly deps: LostTxDeps) {}

  async runOnce(): Promise<LostTxCycleSummary> {
    const now = this.deps.now?.() ?? Date.now();
    const minAgeMs = this.deps.minAgeMs ?? lostTxMinAgeMs();
    const recheckMs = this.deps.recheckMs ?? lostTxRecheckMs();
    const batch = this.deps.batch ?? lostTxBatchSize();
    const summary: LostTxCycleSummary = {
      checked: 0,
      found: 0,
      absent: 0,
      unknown: 0,
      lost: 0,
    };

    const rows = await this.selectCandidates(now, minAgeMs, batch);
    for (const row of rows) {
      const txid = String(row.txid).trim();
      summary.checked += 1;
      let probe: TxProbe;
      try {
        probe = await this.deps.probe(txid);
      } catch (err) {
        summary.unknown += 1;
        log.warn({ err, txid: txid.slice(0, 12) }, "Lost-transaction probe failed");
        continue;
      }

      if (probe.presence === "found") {
        this.absent.delete(txid);
        summary.found += 1;
        continue;
      }
      if (probe.presence !== "absent") {
        summary.unknown += 1;
        continue;
      }

      summary.absent += 1;
      const prior = this.absent.get(txid);
      const twoProviders = probe.providers.length >= 2;
      const twoChecks = prior != null && now - prior.at >= recheckMs && now >= prior.nextEligible;
      if (!twoProviders && !twoChecks) {
        this.rememberAbsent(txid, prior?.at ?? now, (prior?.at ?? now) + recheckMs);
        continue;
      }

      const lost = await this.confirmLost(txid, String(row.aircraft_icao ?? ""));
      if (lost) {
        summary.lost += 1;
        this.absent.delete(txid);
      }
    }

    log.info(
      {
        checked: summary.checked,
        found: summary.found,
        absent: summary.absent,
        unknown: summary.unknown,
        lost: summary.lost,
      },
      "Lost-transaction check complete",
    );
    return summary;
  }

  private rememberAbsent(txid: string, at: number, nextEligible: number): void {
    if (!this.absent.has(txid) && this.absent.size >= STATE_CAP) {
      const oldest = this.absent.keys().next().value;
      if (oldest) this.absent.delete(oldest);
    }
    this.absent.set(txid, { at, nextEligible });
  }

  private async selectCandidates(
    now: number,
    minAgeMs: number,
    batch: number,
  ): Promise<Array<{ txid: string; aircraft_icao?: string }>> {
    const cutoff = new Date(now - minAgeMs);
    const rows = await this.dbRows(cutoff, batch);
    const chosen: Array<{ txid: string; aircraft_icao?: string }> = [];
    for (const row of rows) {
      const txid = String(row.txid).trim();
      const mark = this.absent.get(txid);
      if (mark && mark.nextEligible > now) continue;
      chosen.push(row);
      if (chosen.length >= batch) break;
    }
    return chosen;
  }

  private async dbRows(
    cutoff: Date,
    batch: number,
  ): Promise<Array<{ txid: string; aircraft_icao?: string }>> {
    return this.deps.db("tx_results")
      .where({ status: "SEEN_ON_NETWORK" })
      .where("created_at", "<=", cutoff)
      .orderBy("created_at", "asc")
      .limit(batch * 8)
      .select("txid", "aircraft_icao") as Promise<Array<{ txid: string; aircraft_icao?: string }>>;
  }

  /**
   * Marks the row, drops outputs the lost transaction created, reconciles the
   * owning pool, and requeues the payload. Does not spend and does not notify
   * the spend governor.
   */
  private async confirmLost(txid: string, aircraftIcao: string): Promise<boolean> {
    const settled = await settleTerminalRejectionMark(this.deps.db, txid, {
      status: "LOST",
      reason: LOST_REASON,
    }, {
      isFundingConfirmed: (outputTxid, vout) =>
        this.deps.fundingUtxoManager.isFundingOutputConfirmed(outputTxid, vout),
    });

    if (settled.kind === "mined" || settled.kind === "present") {
      log.warn(
        { txid: txid.slice(0, 12), disposition: settled.kind },
        "Lost-transaction verdict ignored — the row is mined or was not updated",
      );
      return false;
    }

    try {
      await this.deps.utxoManager.invalidateOutputsOf(txid);
      const unwind = await deleteUnconfirmedOutputsOf(this.deps.db, txid, {
        isFundingConfirmed: (outputTxid, vout) =>
          this.deps.fundingUtxoManager.isFundingOutputConfirmed(outputTxid, vout),
      });
      if (unwind.fundingVouts.length > 0) {
        this.deps.fundingUtxoManager.noteOutputsInvalidated(txid, unwind.fundingVouts);
      }

      const icao = aircraftIcao.trim().toUpperCase();
      if (icao && icao !== FLEET_PSEUDO_ICAO) {
        await this.deps.utxoManager.reconcile(icao, this.deps.addressFor(icao));
      }
      if (!icao || icao === FLEET_PSEUDO_ICAO || unwind.fundingDeleted > 0) {
        await this.deps.fundingUtxoManager.reconcile(this.deps.fundingWif);
      }
    } catch (err) {
      log.error(
        { err, txid: txid.slice(0, 12) },
        "Failed to unwind outputs of a lost transaction — pool may still hold them",
      );
    }

    try {
      await rebufferRejectedTransaction(txid, {
        db: this.deps.db,
        maxRequeues: LOST_REQUEUE_ONCE,
        onQueued: this.deps.onQueued,
      });
    } catch (err) {
      log.error({ err, txid: txid.slice(0, 12) }, "Failed to requeue a lost transaction");
    }

    lostTxTotal.inc();
    log.error(
      { txid, icao: aircraftIcao, reason: LOST_REASON },
      "Transaction reported accepted but absent from the chain — marked LOST and requeued",
    );
    return true;
  }
}

export function startLostTxDetector(
  deps: LostTxDeps,
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof setInterval> | null {
  if (!lostTxDetectionEnabled(env)) return null;
  const detector = new LostTxDetector(deps);
  const intervalMs = lostTxCheckIntervalMs(env);
  const timer = setInterval(() => {
    void detector.runOnce().catch((err) => {
      log.error({ err }, "Lost-transaction check failed");
    });
  }, intervalMs);
  timer.unref?.();
  log.info({ intervalMs }, "Lost-transaction detection started");
  return timer;
}
