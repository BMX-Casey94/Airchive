import type { Knex } from "knex";
import {
  FlightPhase,
  type AircraftConfig,
  type AlertRecord,
  type AlertSeverity,
  type FlightSession,
  type PendingWrite,
  type TxResult,
  type UTXORecord,
} from "@airchive/types";

export interface DbAircraftConfigRow {
  icao: string;
  callsign: string | null;
  reg: string | null;
  aircraft_type: string | null;
  wallet_index: number;
  wallet_address: string | null;
  enabled: boolean;
  created_at: Date;
}

export type UtxoPoolRow = UTXORecord;

export type FlightSessionRow = FlightSession;

export type PendingWriteRow = PendingWrite;

export interface TxResultRow extends TxResult {
  flight_id: string | null;
  created_at: Date;
}

export type AlertRow = AlertRecord;

declare module "knex/types/tables" {
  interface Tables {
    aircraft_config: DbAircraftConfigRow;
    utxo_pool: UtxoPoolRow;
    flight_sessions: FlightSessionRow;
    pending_writes: PendingWriteRow;
    tx_results: TxResultRow;
    alerts: AlertRow;
  }
}

export type NewUtxo = Pick<
  UTXORecord,
  "aircraft_icao" | "txid" | "vout" | "satoshis" | "locking_script"
> & { is_locked?: boolean };

export async function getAvailableUtxo(
  db: Knex,
  icao: string,
): Promise<UtxoPoolRow | undefined> {
  return db("utxo_pool")
    .where({ aircraft_icao: icao, is_locked: false })
    .orderBy("satoshis", "desc")
    .first();
}

export async function lockUtxo(
  db: Knex,
  txid: string,
  vout: number,
): Promise<number> {
  return db("utxo_pool").where({ txid, vout }).update({ is_locked: true });
}

export async function insertUtxo(db: Knex, record: NewUtxo): Promise<void> {
  await db("utxo_pool")
    .insert({
      ...record,
      is_locked: record.is_locked ?? false,
    })
    .onConflict(["txid", "vout"])
    .ignore();
}

export async function deleteUtxo(
  db: Knex,
  txid: string,
  vout: number,
): Promise<number> {
  return db("utxo_pool").where({ txid, vout }).delete();
}

export async function getUtxoPoolBalance(
  db: Knex,
  icao: string,
): Promise<bigint | null> {
  const row = await db("utxo_pool")
    .where({ aircraft_icao: icao, is_locked: false })
    .sum({ sum: "satoshis" })
    .first();
  const raw = row?.sum;
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  return BigInt(String(raw));
}

export async function getUtxoCount(db: Knex, icao: string): Promise<number> {
  const row = await db("utxo_pool")
    .where({ aircraft_icao: icao })
    .count<{ count: string | number }>("* as count")
    .first();
  const n = row?.count;
  if (n === undefined || n === null) {
    return 0;
  }
  return typeof n === "number" ? n : Number(n);
}

export type NewFlightSession = Omit<
  FlightSession,
  "id" | "started_at" | "ended_at" | "total_tx_count" | "total_sats_spent"
> & {
  started_at?: Date;
  phase?: FlightPhase;
};

export type FlightSessionUpdates = Partial<
  Omit<FlightSessionRow, "id" | "started_at">
>;

export async function createFlightSession(
  db: Knex,
  session: NewFlightSession,
): Promise<FlightSessionRow> {
  const [row] = await db("flight_sessions")
    .insert({
      aircraft_icao: session.aircraft_icao,
      callsign: session.callsign,
      origin_icao: session.origin_icao,
      origin_name: session.origin_name,
      dest_icao: session.dest_icao,
      dest_name: session.dest_name,
      phase: session.phase ?? FlightPhase.PARKED,
      started_at: session.started_at ?? db.fn.now(),
      total_tx_count: 0,
      total_sats_spent: 0,
    })
    .returning("*");
  if (row === undefined) {
    throw new Error("createFlightSession: no row returned");
  }
  return row;
}

export async function updateFlightSession(
  db: Knex,
  id: string,
  updates: FlightSessionUpdates,
): Promise<number> {
  return db("flight_sessions").where({ id }).update(updates);
}

export async function getActiveSession(
  db: Knex,
  icao: string,
): Promise<FlightSessionRow | undefined> {
  return db("flight_sessions")
    .where({ aircraft_icao: icao })
    .whereNull("ended_at")
    .orderBy("started_at", "desc")
    .first();
}

export async function getFlightSessions(
  db: Knex,
  icao: string,
  limit = 50,
  offset = 0,
): Promise<FlightSessionRow[]> {
  return db("flight_sessions")
    .where({ aircraft_icao: icao })
    .orderBy("started_at", "desc")
    .limit(limit)
    .offset(offset);
}

export type NewPendingWrite = Pick<
  PendingWrite,
  "aircraft_icao" | "record_type" | "payload"
> & { flight_id?: string };

export async function insertPendingWrite(
  db: Knex,
  write: NewPendingWrite,
): Promise<void> {
  await db("pending_writes").insert({
    aircraft_icao: write.aircraft_icao,
    record_type: write.record_type,
    payload: Buffer.isBuffer(write.payload)
      ? write.payload
      : Buffer.from(write.payload),
    flight_id: write.flight_id,
  });
}

export async function getPendingWrites(
  db: Knex,
  limit: number,
): Promise<PendingWriteRow[]> {
  return db("pending_writes")
    .where("retry_count", "<", 10)
    .orderBy("created_at", "asc")
    .limit(limit);
}

export async function markWriteRetried(
  db: Knex,
  id: number,
  error: string,
): Promise<number> {
  return db("pending_writes")
    .where({ id })
    .update({
      last_error: error,
      retry_count: db.raw("retry_count + 1"),
    });
}

export async function deletePendingWrite(
  db: Knex,
  id: number,
): Promise<number> {
  return db("pending_writes").where({ id }).delete();
}

export type NewTxResult = TxResult & { flight_id?: string };

export async function insertTxResult(
  db: Knex,
  result: NewTxResult,
): Promise<void> {
  await db("tx_results").insert({
    txid: result.txid,
    aircraft_icao: result.aircraft_icao,
    record_type: result.record_type,
    status: result.status,
    block_height: result.block_height,
    merkle_path: result.merkle_path,
    timestamp: result.timestamp,
    fee_sats: result.fee_sats,
    size_bytes: result.size_bytes,
    flight_id: result.flight_id,
    chronicle_validated: result.chronicle_validated ?? false,
  });
}

export async function updateTxStatus(
  db: Knex,
  txid: string,
  status: TxResult["status"],
  blockHeight?: number,
  merklePath?: string,
): Promise<number> {
  const patch: Record<string, unknown> = { status };
  if (blockHeight !== undefined) {
    patch.block_height = blockHeight;
  }
  if (merklePath !== undefined) {
    patch.merkle_path = merklePath;
  }
  return db("tx_results").where({ txid }).update(patch);
}

export async function getTxResults(
  db: Knex,
  icao: string,
  limit = 50,
  offset = 0,
): Promise<TxResultRow[]> {
  return db("tx_results")
    .where({ aircraft_icao: icao })
    .orderBy("timestamp", "desc")
    .limit(limit)
    .offset(offset);
}

export type NewAlert = Omit<
  AlertRecord,
  "id" | "created_at" | "acknowledged"
> & { id?: string; acknowledged?: boolean };

export async function insertAlert(db: Knex, alert: NewAlert): Promise<void> {
  await db("alerts").insert({
    ...(alert.id !== undefined ? { id: alert.id } : {}),
    aircraft_icao: alert.aircraft_icao,
    flight_id: alert.flight_id,
    severity: alert.severity,
    type: alert.type,
    message: alert.message,
    data: alert.data,
    acknowledged: alert.acknowledged ?? false,
  });
}

export interface AlertQueryFilters {
  icao?: string;
  severity?: AlertSeverity | string;
  acknowledged?: boolean;
  limit?: number;
  offset?: number;
}

export async function getAlerts(
  db: Knex,
  filters: AlertQueryFilters,
): Promise<AlertRow[]> {
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
  let q = db("alerts").orderBy("created_at", "desc").limit(limit).offset(offset);
  if (filters.icao !== undefined) {
    q = q.andWhere({ aircraft_icao: filters.icao });
  }
  if (filters.severity !== undefined) {
    q = q.andWhere({ severity: filters.severity });
  }
  if (filters.acknowledged !== undefined) {
    q = q.andWhere({ acknowledged: filters.acknowledged });
  }
  return q;
}

export async function acknowledgeAlert(
  db: Knex,
  id: string,
): Promise<number> {
  return db("alerts").where({ id }).update({ acknowledged: true });
}

/* ── Funding UTXO Pool ──────────────────────────────────────── */

export interface FundingUtxoRow {
  txid: string;
  vout: number;
  satoshis: number;
  locking_script: string;
  is_locked: boolean;
  created_at: Date;
}

export async function getFundingUtxoCount(db: Knex): Promise<number> {
  const row = await db("funding_utxo_pool")
    .count<{ count: string | number }>("* as count")
    .first();
  const n = row?.count;
  if (n === undefined || n === null) return 0;
  return typeof n === "number" ? n : Number(n);
}

export async function getFundingUtxoBalance(db: Knex): Promise<number> {
  const row = await db("funding_utxo_pool")
    .where({ is_locked: false })
    .sum({ sum: "satoshis" })
    .first();
  const raw = row?.sum;
  if (raw === null || raw === undefined || raw === "") return 0;
  return Number(raw);
}

export async function insertFundingUtxo(
  db: Knex,
  record: { txid: string; vout: number; satoshis: number; locking_script: string },
): Promise<void> {
  await db("funding_utxo_pool")
    .insert({ ...record, is_locked: false })
    .onConflict(["txid", "vout"])
    .ignore();
}

export async function acquireFundingUtxo(
  db: Knex,
  minSats: number,
): Promise<FundingUtxoRow | undefined> {
  return db.transaction(async (trx) => {
    const utxo = await trx("funding_utxo_pool")
      .where({ is_locked: false })
      .where("satoshis", ">=", minSats)
      .orderBy("satoshis", "desc")
      .forUpdate()
      .skipLocked()
      .first<FundingUtxoRow | undefined>();

    if (!utxo) return undefined;

    await trx("funding_utxo_pool")
      .where({ txid: utxo.txid, vout: utxo.vout })
      .update({ is_locked: true });

    return utxo;
  });
}

export async function releaseFundingUtxo(
  db: Knex,
  txid: string,
  vout: number,
): Promise<void> {
  await db("funding_utxo_pool")
    .where({ txid, vout })
    .update({ is_locked: false });
}

export async function deleteFundingUtxo(
  db: Knex,
  txid: string,
  vout: number,
): Promise<number> {
  return db("funding_utxo_pool").where({ txid, vout }).delete();
}

export async function unlockAllFundingUtxos(db: Knex): Promise<number> {
  return db("funding_utxo_pool")
    .where({ is_locked: true })
    .update({ is_locked: false });
}

export async function unlockAllAircraftUtxos(db: Knex): Promise<number> {
  return db("utxo_pool")
    .where({ is_locked: true })
    .update({ is_locked: false });
}

export async function getAircraftConfig(
  db: Knex,
  icao: string,
): Promise<DbAircraftConfigRow | undefined> {
  return db("aircraft_config").where({ icao }).first();
}

export async function getAllAircraftConfig(db: Knex): Promise<DbAircraftConfigRow[]> {
  return db("aircraft_config")
    .orderBy("wallet_index", "asc")
    .orderBy("icao", "asc");
}

export async function getAllAircraft(db: Knex): Promise<DbAircraftConfigRow[]> {
  return db("aircraft_config")
    .where({ enabled: true })
    .orderBy("wallet_index", "asc")
    .orderBy("icao", "asc");
}

export async function upsertAircraftConfig(
  db: Knex,
  config: AircraftConfig,
): Promise<void> {
  const insertRow: Record<string, string | number | boolean | null> = {
    icao: config.icao,
    callsign: config.callsign,
    reg: config.reg,
    aircraft_type: config.aircraft_type,
    wallet_index: config.wallet_index,
    enabled: config.enabled,
  };
  const mergeRow: Record<string, string | number | boolean | null> = {
    callsign: config.callsign,
    reg: config.reg,
    aircraft_type: config.aircraft_type,
    wallet_index: config.wallet_index,
    enabled: config.enabled,
  };

  if (config.wallet_address !== undefined) {
    insertRow.wallet_address = config.wallet_address;
    mergeRow.wallet_address = config.wallet_address;
  }

  await db("aircraft_config")
    .insert(insertRow)
    .onConflict("icao")
    .merge(mergeRow);
}
