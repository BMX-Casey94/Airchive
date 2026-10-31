import { createLogger } from "@airchive/logger";
import { broadcastHold, type BroadcastHold } from "./broadcast-hold.js";
import type { FundingReconcileOutcome } from "./funding-utxo-manager.js";
import { readBoolEnv, readNonNegativeInt } from "./live-path-policy.js";
import { poolSweepFailuresTotal, poolSweepRowsTotal } from "./metrics.js";
import type { ReconcileCounts } from "./utxo-manager.js";

const log = createLogger({ service: "blockchain-writer:pool-sweep" });

const MAX_ATTEMPTS = 3;

export function poolSweepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBoolEnv("POOL_SWEEP_ON_START", false, env);
}

export function poolSweepDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegativeInt("POOL_SWEEP_DELAY_MS", 1_000, env);
}

export interface PoolSweepAircraft {
  icao: string;
  address: string;
}

export interface PoolSweepDeps {
  aircraft: PoolSweepAircraft[];
  utxoManager: {
    reconcile(
      icao: string,
      address: string,
      options?: { force?: boolean },
    ): Promise<ReconcileCounts>;
  };
  fundingUtxoManager: {
    reconcile(
      fundingWif: string,
      options?: { force?: boolean },
    ): Promise<FundingReconcileOutcome>;
  };
  fundingWif: string;
  hold?: BroadcastHold;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PoolSweepSummary {
  aircraftSwept: number;
  rowsDeleted: number;
  rowsInserted: number;
  failures: number;
  failedAircraft: string[];
  fundingSwept: boolean;
}

/**
 * Reconciles every aircraft pool, then the treasury, before any spend.
 * Broadcasting is held for the duration. An aircraft that still cannot be
 * read after three attempts stays blocked until a later reconcile applies;
 * its writes remain in pending_writes. The same applies to the treasury.
 */
export async function sweepPools(deps: PoolSweepDeps): Promise<PoolSweepSummary> {
  const hold = deps.hold ?? broadcastHold;
  const delayMs = deps.delayMs ?? poolSweepDelayMs();
  const sleep = deps.sleep ?? defaultSleep;
  const summary: PoolSweepSummary = {
    aircraftSwept: 0,
    rowsDeleted: 0,
    rowsInserted: 0,
    failures: 0,
    failedAircraft: [],
    fundingSwept: false,
  };

  hold.holdAll();
  try {
    for (const aircraft of deps.aircraft) {
      const outcome = await sweepAircraft(deps, aircraft, sleep, delayMs);
      if (outcome) {
        summary.aircraftSwept += 1;
        addRows(summary, outcome.added, outcome.removed);
      } else {
        summary.failures += 1;
        const icao = aircraft.icao.trim().toUpperCase();
        summary.failedAircraft.push(icao);
        hold.blockAircraft(icao);
        poolSweepFailuresTotal.inc({ pool: "aircraft" });
        log.error(
          { icao },
          "Aircraft pool sweep failed — spending stays blocked until a later reconcile applies",
        );
      }
      if (delayMs > 0) await sleep(delayMs);
    }

    const funding = await sweepFunding(deps, sleep, delayMs);
    if (funding) {
      summary.fundingSwept = true;
      addRows(summary, funding.added, funding.removed);
    } else {
      summary.failures += 1;
      summary.fundingSwept = false;
      hold.blockFunding();
      poolSweepFailuresTotal.inc({ pool: "funding" });
      log.error(
        "Treasury pool sweep failed — treasury spends stay blocked until a later reconcile applies",
      );
    }
  } finally {
    hold.releaseAll();
  }

  log.info(
    {
      aircraftSwept: summary.aircraftSwept,
      rowsDeleted: summary.rowsDeleted,
      rowsInserted: summary.rowsInserted,
      failures: summary.failures,
    },
    "Startup pool sweep complete",
  );
  return summary;
}

async function sweepAircraft(
  deps: PoolSweepDeps,
  aircraft: PoolSweepAircraft,
  sleep: (ms: number) => Promise<void>,
  delayMs: number,
): Promise<ReconcileCounts | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const outcome = await deps.utxoManager.reconcile(
        aircraft.icao,
        aircraft.address,
        { force: true },
      );
      if (outcome.applied) return outcome;
      log.warn(
        { icao: aircraft.icao, attempt },
        "Aircraft pool sweep attempt did not read the chain",
      );
    } catch (err) {
      log.warn(
        { err, icao: aircraft.icao, attempt },
        "Aircraft pool sweep attempt failed",
      );
    }
    if (attempt < MAX_ATTEMPTS && delayMs > 0) await sleep(delayMs * attempt);
  }
  return null;
}

async function sweepFunding(
  deps: PoolSweepDeps,
  sleep: (ms: number) => Promise<void>,
  delayMs: number,
): Promise<FundingReconcileOutcome | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const outcome = await deps.fundingUtxoManager.reconcile(deps.fundingWif, {
        force: true,
      });
      if (outcome.ok) return outcome;
      log.warn({ attempt }, "Treasury pool sweep attempt did not read the chain");
    } catch (err) {
      log.warn({ err, attempt }, "Treasury pool sweep attempt failed");
    }
    if (attempt < MAX_ATTEMPTS && delayMs > 0) await sleep(delayMs * attempt);
  }
  return null;
}

function addRows(summary: PoolSweepSummary, added: number, removed: number): void {
  summary.rowsInserted += added;
  summary.rowsDeleted += removed;
  if (added > 0) poolSweepRowsTotal.inc({ action: "inserted" }, added);
  if (removed > 0) poolSweepRowsTotal.inc({ action: "deleted" }, removed);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
