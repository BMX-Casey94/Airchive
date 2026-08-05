import type { Knex } from "knex";
import {
  FlightPhase,
  RecordType,
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
  reject_requeues: number;
  reject_status: string | null;
  reject_reason: string | null;
  reject_competing_txs: string[] | null;
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
    session_positions: SessionPositionRow;
  }
}

/* ── Session position stream (flight-path persistence) ──────── */

export interface SessionPositionRow {
  id: number;
  flight_id: string;
  aircraft_icao: string;
  /** Epoch milliseconds. Postgres returns bigint columns as strings. */
  ts: number | string;
  lat: number;
  lon: number;
  alt_baro: number | null;
  gs: number | null;
  track: number | null;
  phase: string | null;
}

export type NewSessionPosition = Omit<SessionPositionRow, "id">;

export type SessionPathPoint = Pick<
  SessionPositionRow,
  "ts" | "lat" | "lon" | "alt_baro" | "gs" | "track"
>;

export async function insertSessionPositions(
  db: Knex,
  rows: NewSessionPosition[],
): Promise<void> {
  if (rows.length === 0) return;
  await db("session_positions").insert(rows);
}

/**
 * Full path for one flight, oldest first. When the stored stream exceeds
 * `maxPoints` the result is thinned evenly — keeping the first and last
 * points — rather than truncated, so the route's overall shape survives at
 * any cap. Mirrors the dashboard's client-side trail-thinning philosophy.
 */
export async function getSessionPath(
  db: Knex,
  flightId: string,
  maxPoints = 1_500,
): Promise<SessionPathPoint[]> {
  const countRow = await db("session_positions")
    .where({ flight_id: flightId })
    .count<{ count: string | number }>("* as count")
    .first();
  const total = Number(countRow?.count ?? 0);
  if (total === 0) return [];

  if (total <= maxPoints) {
    return db("session_positions")
      .where({ flight_id: flightId })
      .orderBy("ts", "asc")
      .select("ts", "lat", "lon", "alt_baro", "gs", "track");
  }

  const step = Math.ceil(total / maxPoints);
  const result = await db.raw(
    `select ts, lat, lon, alt_baro, gs, track
       from (select ts, lat, lon, alt_baro, gs, track,
                    row_number() over (order by ts asc) as rn
               from session_positions
              where flight_id = ?) p
      where (p.rn - 1) % ? = 0 or p.rn = ?
      order by ts asc`,
    [flightId, step, total],
  );
  return (result as { rows: SessionPathPoint[] }).rows;
}

export async function getActiveFlightSessions(
  db: Knex,
  limit = 100,
): Promise<FlightSessionRow[]> {
  return db("flight_sessions")
    .whereNull("ended_at")
    .orderBy("started_at", "desc")
    .limit(limit);
}

/**
 * Open sessions with evidence of life: a stored position inside the activity
 * window, or a session young enough that the recorder may not have flushed
 * yet. One row per airframe (the newest) so a lingering zombie can never sit
 * alongside the real flight. Sessions that ended out of ADS-B coverage stay
 * open in the table until the sweeper catches them, so `ended_at IS NULL`
 * alone badly overstates activity.
 */
export async function getLiveFlightSessions(
  db: Knex,
  activeSinceEpochMs: number,
  limit = 100,
): Promise<FlightSessionRow[]> {
  const result = await db.raw(
    `select * from (
       select distinct on (fs.aircraft_icao) fs.*
         from flight_sessions fs
        where fs.ended_at is null
          and (
            exists (select 1 from session_positions sp
                     where sp.flight_id = fs.id and sp.ts >= ?)
            or fs.started_at >= to_timestamp(? / 1000.0)
          )
        order by fs.aircraft_icao asc, fs.started_at desc
     ) live
     order by live.started_at desc
     limit ?`,
    [activeSinceEpochMs, activeSinceEpochMs, limit],
  );
  return (result as { rows: FlightSessionRow[] }).rows;
}

/** Epoch ms of the newest stored position for a flight, or null if none. */
export async function getSessionLastPositionTs(
  db: Knex,
  flightId: string,
): Promise<number | null> {
  const row = await db("session_positions")
    .where({ flight_id: flightId })
    .max<{ max: string | number | null }>("ts as max")
    .first();
  const v = row?.max;
  return v === null || v === undefined ? null : Number(v);
}

/**
 * Closes every open session whose last sign of life predates `cutoffEpochMs`.
 * A session's "last activity" is its newest stored position, falling back to
 * `started_at` for sessions that never recorded one. `ended_at` is backdated
 * to that moment rather than now(), so the recorded duration reflects when
 * the aircraft was actually last seen — not how long the zombie survived.
 * Returns the expired rows so callers can drop matching in-memory state.
 */
export async function expireStaleFlightSessions(
  db: Knex,
  cutoffEpochMs: number,
): Promise<Array<{ id: string; aircraft_icao: string }>> {
  const result = await db.raw(
    `with activity as (
       select fs.id,
              greatest(
                coalesce((select max(sp.ts) from session_positions sp
                           where sp.flight_id = fs.id), 0)::bigint,
                (extract(epoch from fs.started_at) * 1000)::bigint
              ) as last_ms
         from flight_sessions fs
        where fs.ended_at is null
     )
     update flight_sessions f
        set ended_at = to_timestamp(a.last_ms / 1000.0)
       from activity a
      where f.id = a.id
        and a.last_ms < ?
     returning f.id, f.aircraft_icao`,
    [cutoffEpochMs],
  );
  return (result as { rows: Array<{ id: string; aircraft_icao: string }> }).rows;
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
> & { flight_id?: string; preserved?: boolean };

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
    preserved: write.preserved ?? false,
  });
}

/**
 * Collapses an aircraft's deferred telemetry to its latest sample. Rows
 * flagged `preserved` are invisible to this path in both directions: they are
 * never chosen as the row to overwrite, and never deleted as superseded. A
 * backlog held through a funding outage therefore survives the first ordinary
 * deferral that follows recovery, which would otherwise have wiped it.
 */
export async function upsertPendingTelemetryWrite(
  db: Knex,
  write: NewPendingWrite,
): Promise<"inserted" | "replaced"> {
  return db.transaction(async (trx) => {
    const payload = Buffer.isBuffer(write.payload)
      ? write.payload
      : Buffer.from(write.payload);

    const existing = await trx("pending_writes")
      .where({
        aircraft_icao: write.aircraft_icao,
        record_type: RecordType.TELEMETRY,
        preserved: false,
      })
      .orderBy("id", "desc")
      .first<PendingWriteRow | undefined>();

    if (!existing) {
      await trx("pending_writes").insert({
        aircraft_icao: write.aircraft_icao,
        record_type: RecordType.TELEMETRY,
        payload,
        flight_id: write.flight_id,
        preserved: false,
      });
      return "inserted";
    }

    await trx("pending_writes")
      .where({ id: existing.id })
      .update({
        payload,
        flight_id: write.flight_id,
        created_at: trx.fn.now(),
        retry_count: 0,
        last_error: trx.raw("NULL"),
      });

    await trx("pending_writes")
      .where({
        aircraft_icao: write.aircraft_icao,
        record_type: RecordType.TELEMETRY,
        preserved: false,
      })
      .whereNot({ id: existing.id })
      .delete();

    return "replaced";
  });
}

export async function coalescePendingTelemetryWrites(db: Knex): Promise<number> {
  return db("pending_writes as older")
    .where("older.record_type", RecordType.TELEMETRY)
    .where("older.preserved", false)
    .whereExists(
      db("pending_writes as newer")
        .select(db.raw("1"))
        .whereRaw("newer.record_type = older.record_type")
        .whereRaw("newer.aircraft_icao = older.aircraft_icao")
        .whereRaw("newer.preserved = false")
        .whereRaw("newer.id > older.id"),
    )
    .delete();
}

/**
 * Ages out an outage backlog. Without a ceiling an unattended dry treasury
 * would accumulate roughly a million rows a day at the measured write rate,
 * so the oldest are dropped once they fall outside the retention window —
 * the newest telemetry is the part still worth broadcasting.
 */
export async function prunePreservedWrites(
  db: Knex,
  olderThan: Date,
): Promise<number> {
  return db("pending_writes")
    .where({ preserved: true })
    .where("created_at", "<", olderThan)
    .delete();
}

export async function getPreservedWriteCount(db: Knex): Promise<number> {
  const row = await db("pending_writes")
    .where({ preserved: true })
    .count<{ count: string | number }>("* as count")
    .first();
  return Number(row?.count ?? 0);
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

export async function getPendingWriteCount(db: Knex): Promise<number> {
  const row = await db("pending_writes")
    .count<{ count: string | number }>("* as count")
    .first();
  const n = row?.count;
  if (n === undefined || n === null) return 0;
  return typeof n === "number" ? n : Number(n);
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

export async function markWriteDeferred(
  db: Knex,
  id: number,
  error: string,
): Promise<number> {
  return db("pending_writes")
    .where({ id })
    .update({
      last_error: error,
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
    op_return: result.op_return ? Buffer.from(result.op_return) : null,
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

export interface TxRejectDetail {
  status: string;
  reason?: string | null;
  competingTxs?: string[] | null;
}

/**
 * Marks a transaction FAILED and records the upstream reject diagnosis.
 * Returns 0 when the row is already MINED (stale ordering) or missing.
 */
export async function markTxRejected(
  db: Knex,
  txid: string,
  detail: TxRejectDetail,
): Promise<number> {
  const rejectStatus = detail.status.trim().toUpperCase().slice(0, 40);
  const reason = normaliseRejectReason(detail.reason);
  const competing = normaliseCompetingTxs(detail.competingTxs);

  return db("tx_results")
    .where({ txid })
    .whereNot({ status: "MINED" })
    .update({
      status: "FAILED",
      reject_status: rejectStatus || null,
      reject_reason: reason,
      reject_competing_txs: competing,
    });
}

function normaliseRejectReason(reason: string | null | undefined): string | null {
  if (reason == null) return null;
  const trimmed = reason.trim();
  if (!trimmed) return null;
  // Cap so a hostile/verbose upstream cannot inflate row size unbounded.
  return trimmed.length > 2_000 ? `${trimmed.slice(0, 2_000)}…` : trimmed;
}

function normaliseCompetingTxs(
  competingTxs: string[] | null | undefined,
): string[] | null {
  if (!competingTxs?.length) return null;
  return competingTxs
    .map((txid) => txid.trim().toLowerCase())
    .filter((txid) => txid.length > 0)
    .slice(0, 20);
}

export interface RejectRequeueClaim {
  txid: string;
  aircraft_icao: string;
  record_type: number;
  flight_id: string | null;
  op_return: Buffer;
  reject_requeues: number;
  reject_status: string | null;
  reject_reason: string | null;
  reject_competing_txs: string[] | null;
}

/**
 * Atomically claims one reject-requeue slot for a failed transaction.
 * Returns null when the row is missing, has no envelope, is mined, or has
 * already been re-queued `maxRequeues` times.
 */
export async function claimRejectRequeue(
  db: Knex,
  txid: string,
  maxRequeues: number,
): Promise<RejectRequeueClaim | null> {
  const safeMax = Math.max(1, Math.floor(maxRequeues));

  return db.transaction(async (trx) => {
    const row = await trx("tx_results")
      .where({ txid })
      .whereNot({ status: "MINED" })
      .whereNotNull("op_return")
      .forUpdate()
      .first<{
        txid: string;
        aircraft_icao: string;
        record_type: number;
        flight_id: string | null;
        op_return: Buffer;
        reject_requeues: number | string | null;
        reject_status: string | null;
        reject_reason: string | null;
        reject_competing_txs: string[] | string | null;
      }>();

    if (!row?.op_return) return null;

    const current = Number(row.reject_requeues ?? 0);
    if (!Number.isFinite(current) || current >= safeMax) return null;

    const next = current + 1;
    await trx("tx_results").where({ txid }).update({ reject_requeues: next });

    return {
      txid: row.txid,
      aircraft_icao: row.aircraft_icao,
      record_type: Number(row.record_type),
      flight_id: row.flight_id,
      op_return: Buffer.isBuffer(row.op_return)
        ? row.op_return
        : Buffer.from(row.op_return),
      reject_requeues: next,
      reject_status: row.reject_status ?? null,
      reject_reason: row.reject_reason ?? null,
      reject_competing_txs: parseCompetingTxs(row.reject_competing_txs),
    };
  });
}

function parseCompetingTxs(
  value: string[] | string | null | undefined,
): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return normaliseCompetingTxs(value);
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed)
        ? normaliseCompetingTxs(parsed.map(String))
        : null;
    } catch {
      return null;
    }
  }
  return null;
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
  /** When the lock was taken, so locks orphaned by a crash can be reclaimed. */
  locked_at?: Date | null;
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
      .update({ is_locked: true, locked_at: trx.fn.now() });

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
    .update({ is_locked: false, locked_at: null });
}

/**
 * Reclaim funding locks held past `ttlMs`. Mirrors the aircraft-pool sweep so a
 * crash mid-refill cannot permanently strand treasury capacity.
 */
export async function reclaimStaleFundingLocks(
  db: Knex,
  ttlMs: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - ttlMs);
  return db("funding_utxo_pool")
    .where({ is_locked: true })
    .where((builder) => {
      void builder.where("locked_at", "<", cutoff).orWhereNull("locked_at");
    })
    .update({ is_locked: false, locked_at: null });
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
    .update({ is_locked: false, locked_at: null });
}

export async function unlockAllAircraftUtxos(db: Knex): Promise<number> {
  return db("utxo_pool")
    .where({ is_locked: true })
    .update({ is_locked: false, locked_at: null });
}

/* ── Funding state machine ──────────────────────────────────── */

export const TREASURY_SCOPE = "TREASURY";

export type FundingStateName = "HEALTHY" | "LOW" | "DRY" | "RECOVERING";

export interface FundingStateRow {
  scope: string;
  state: FundingStateName;
  balance_sats: string | number;
  utxo_count: number;
  state_since: Date;
  last_checked_at: Date | null;
  last_alert_at: Date | null;
  next_poll_at: Date | null;
  consecutive_dry_polls: number;
  burn_sats_per_hour: string | number;
  details: Record<string, unknown>;
  updated_at: Date;
}

export interface FundingStateUpdate {
  state: FundingStateName;
  balance_sats: number;
  utxo_count: number;
  /** Only bumped when the state actually changes, so it measures dwell time. */
  resetSince: boolean;
  next_poll_at?: Date | null;
  consecutive_dry_polls?: number;
  burn_sats_per_hour?: number;
  last_alert_at?: Date | null;
  details?: Record<string, unknown>;
}

export async function getFundingState(
  db: Knex,
  scope: string,
): Promise<FundingStateRow | undefined> {
  return db("funding_state").where({ scope }).first();
}

export async function getAllFundingStates(db: Knex): Promise<FundingStateRow[]> {
  return db("funding_state").orderBy("scope", "asc");
}

export async function upsertFundingState(
  db: Knex,
  scope: string,
  update: FundingStateUpdate,
): Promise<void> {
  const now = db.fn.now();
  const row: Record<string, unknown> = {
    scope,
    state: update.state,
    balance_sats: update.balance_sats,
    utxo_count: update.utxo_count,
    last_checked_at: now,
    updated_at: now,
  };
  if (update.resetSince) row.state_since = now;
  if (update.next_poll_at !== undefined) row.next_poll_at = update.next_poll_at;
  if (update.consecutive_dry_polls !== undefined) {
    row.consecutive_dry_polls = update.consecutive_dry_polls;
  }
  if (update.burn_sats_per_hour !== undefined) {
    row.burn_sats_per_hour = Math.max(0, Math.round(update.burn_sats_per_hour));
  }
  if (update.last_alert_at !== undefined) row.last_alert_at = update.last_alert_at;
  if (update.details !== undefined) row.details = JSON.stringify(update.details);

  const { scope: _scope, ...merge } = row;
  await db("funding_state").insert(row).onConflict("scope").merge(merge);
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

  // Ensure-on-boot paths often pass empty identity placeholders. Never let those
  // wipe reg / type / callsign learned from live telemetry on a prior run.
  const mergeRow: Record<string, unknown> = {
    wallet_index: config.wallet_index,
    enabled: config.enabled,
    callsign: db.raw(
      `CASE WHEN EXCLUDED.callsign IS NULL OR BTRIM(EXCLUDED.callsign) = '' OR UPPER(EXCLUDED.callsign) = UPPER(EXCLUDED.icao) THEN aircraft_config.callsign ELSE EXCLUDED.callsign END`,
    ),
    reg: db.raw(
      `CASE WHEN EXCLUDED.reg IS NULL OR BTRIM(EXCLUDED.reg) = '' THEN aircraft_config.reg ELSE EXCLUDED.reg END`,
    ),
    aircraft_type: db.raw(
      `CASE WHEN EXCLUDED.aircraft_type IS NULL OR BTRIM(EXCLUDED.aircraft_type) = '' THEN aircraft_config.aircraft_type ELSE EXCLUDED.aircraft_type END`,
    ),
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

/** Persist ADS-B identity fields when the feed supplies them. No-op if empty. */
export async function updateAircraftIdentity(
  db: Knex,
  icao: string,
  identity: {
    callsign?: string | null;
    reg?: string | null;
    aircraft_type?: string | null;
  },
): Promise<void> {
  const upper = icao.trim().toUpperCase();
  const patch: Record<string, string> = {};

  const reg = identity.reg?.trim();
  if (reg) patch.reg = reg;

  const aircraftType = identity.aircraft_type?.trim();
  if (aircraftType) patch.aircraft_type = aircraftType;

  const callsign = identity.callsign?.trim();
  if (callsign && callsign.toUpperCase() !== upper) {
    patch.callsign = callsign;
  }

  if (Object.keys(patch).length === 0) return;

  await db("aircraft_config").where({ icao: upper }).update(patch);
}

/* ── Agent marketplace activity ─────────────────────────────── */

export type AgentActivityEventType =
  | "discovery"
  | "transaction"
  | "analysis"
  | "message";

export interface NewAgentActivity {
  event_type: AgentActivityEventType;
  agent: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export async function insertAgentActivity(
  db: Knex,
  event: NewAgentActivity,
): Promise<void> {
  await db("agent_activity").insert({
    event_type: event.event_type,
    agent: event.agent,
    timestamp: event.timestamp,
    data: event.data ?? {},
  });
}

export interface AgentDayMetrics {
  payments: number;
  earnedSats: number;
  spentSats: number;
  discoveries: number;
}

/**
 * Day totals for the marketplace tiles. UTC midnight matches `/api/metrics`,
 * so Analytics and Agent Marketplace agree on what "today" means.
 */
export async function getAgentDayMetrics(
  db: Knex,
  sinceEpochMs: number,
): Promise<AgentDayMetrics> {
  const [payments, discoveries, earned, spent] = await Promise.all([
    db("agent_activity")
      .where({ event_type: "transaction" })
      .where("timestamp", ">=", sinceEpochMs)
      .count("* as total")
      .first() as Promise<{ total?: string | number } | undefined>,
    db("agent_activity")
      .where({ event_type: "discovery" })
      .where("timestamp", ">=", sinceEpochMs)
      .count("* as total")
      .first() as Promise<{ total?: string | number } | undefined>,
    db("agent_activity")
      .where({ event_type: "transaction", agent: "collector" })
      .where("timestamp", ">=", sinceEpochMs)
      .select(
        db.raw("coalesce(sum((data->>'amountSats')::bigint), 0)::bigint as total"),
      )
      .first() as Promise<{ total?: string | number } | undefined>,
    db("agent_activity")
      .where({ event_type: "transaction" })
      .whereNot({ agent: "collector" })
      .where("timestamp", ">=", sinceEpochMs)
      .select(
        db.raw("coalesce(sum((data->>'amountSats')::bigint), 0)::bigint as total"),
      )
      .first() as Promise<{ total?: string | number } | undefined>,
  ]);

  return {
    payments: Number(payments?.total ?? 0),
    earnedSats: Number(earned?.total ?? 0),
    spentSats: Number(spent?.total ?? 0),
    discoveries: Number(discoveries?.total ?? 0),
  };
}
