import type { Knex } from "knex";
import { markTxRejected, type TxRejectDetail } from "@airchive/db";

export interface PoolUnwind {
  aircraftDeleted: number;
  aircraftIcaos: string[];
  aircraftVouts: number[];
  fundingDeleted: number;
  fundingVouts: number[];
  /** Aircraft rows left in place because unconfirmed_depth is 0 (settled). */
  aircraftConfirmedSkipped: number;
  /** Funding rows left in place because this process has seen them confirmed. */
  fundingConfirmedSkipped: number;
}

export type SettledRejection =
  | { kind: "recorded"; marked: number }
  | { kind: "mined" }
  | { kind: "present" }
  | ({ kind: "missing" } & PoolUnwind);

export interface MissingTxUnwindOptions {
  /**
   * Funding outputs this process has already seen at a positive chain height.
   * Those are not deleted. Unknown outputs (including ones from before this
   * process started) are deleted; reconcile puts back any the chain still lists.
   */
  isFundingConfirmed?: (txid: string, vout: number) => boolean;
}

/**
 * Marks the tx_results row when one exists and is not MINED.
 * When the row is missing, deletes unconfirmed pool outputs created by that
 * txid. A MINED row and confirmed aircraft outputs (depth 0) are left untouched.
 */
export async function settleTerminalRejectionMark(
  db: Knex,
  txid: string,
  detail: TxRejectDetail,
  options: MissingTxUnwindOptions = {},
): Promise<SettledRejection> {
  const normalised = txid.trim();
  const marked = await markTxRejected(db, normalised, detail);
  if (marked > 0) return { kind: "recorded", marked };

  const row = await db("tx_results")
    .where({ txid: normalised })
    .first("status") as { status?: string } | undefined;
  if (row) {
    const status = String(row.status ?? "").trim().toUpperCase();
    if (status === "MINED") return { kind: "mined" };
    return { kind: "present" };
  }

  const unwind = await deleteUnconfirmedOutputsOf(db, normalised, options);
  return { kind: "missing", ...unwind };
}

export async function deleteUnconfirmedOutputsOf(
  db: Knex,
  txid: string,
  options: MissingTxUnwindOptions = {},
): Promise<PoolUnwind> {
  const normalised = txid.trim();
  const aircraftRows = await db("utxo_pool")
    .where({ txid: normalised })
    .select("txid", "vout", "aircraft_icao", "unconfirmed_depth") as Array<{
      txid: string;
      vout: number;
      aircraft_icao?: string;
      unconfirmed_depth?: number | string | null;
    }>;

  const aircraftIcaos = new Set<string>();
  const aircraftVouts: number[] = [];
  let aircraftDeleted = 0;
  let aircraftConfirmedSkipped = 0;

  for (const row of aircraftRows) {
    const depth = Number(row.unconfirmed_depth ?? 0);
    if (!Number.isFinite(depth) || depth <= 0) {
      aircraftConfirmedSkipped += 1;
      continue;
    }
    const vout = Number(row.vout);
    const deleted = await db("utxo_pool")
      .where({ txid: normalised, vout })
      .delete();
    if (deleted > 0) {
      aircraftDeleted += deleted;
      aircraftVouts.push(vout);
      const icao = row.aircraft_icao?.trim().toUpperCase();
      if (icao) aircraftIcaos.add(icao);
    }
  }

  const fundingRows = await db("funding_utxo_pool")
    .where({ txid: normalised })
    .select("txid", "vout") as Array<{ txid: string; vout: number }>;

  const fundingVouts: number[] = [];
  let fundingDeleted = 0;
  let fundingConfirmedSkipped = 0;

  for (const row of fundingRows) {
    const vout = Number(row.vout);
    if (options.isFundingConfirmed?.(normalised, vout)) {
      fundingConfirmedSkipped += 1;
      continue;
    }
    const deleted = await db("funding_utxo_pool")
      .where({ txid: normalised, vout })
      .delete();
    if (deleted > 0) {
      fundingDeleted += deleted;
      fundingVouts.push(vout);
    }
  }

  return {
    aircraftDeleted,
    aircraftIcaos: [...aircraftIcaos],
    aircraftVouts,
    fundingDeleted,
    fundingVouts,
    aircraftConfirmedSkipped,
    fundingConfirmedSkipped,
  };
}
