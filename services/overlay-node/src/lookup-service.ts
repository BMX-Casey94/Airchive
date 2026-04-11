import type {
  FlightEventRecord,
  FlightSession,
  TelemetryRecord,
} from "@airchive/types";
import type { Knex } from "knex";

import { parseAirchiveTx } from "./tx-parser.js";

const ICAO_HEX = /^[0-9a-fA-F]{6}$/;
const TXID_HEX = /^[0-9a-fA-F]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface FlightSessionJson {
  id: string;
  aircraft_icao: string;
  callsign: string | null;
  origin_icao: string | null;
  origin_name: string | null;
  dest_icao: string | null;
  dest_name: string | null;
  phase: string;
  started_at: string;
  ended_at: string | null;
  total_tx_count: number;
  total_sats_spent: string | number;
}

export interface TxLookupRow {
  txid: string;
  aircraft_icao: string;
  record_type: number;
  status: string;
  block_height: number | null;
  merkle_path: string | null;
  timestamp: number;
  fee_sats: number;
  size_bytes: number;
  flight_id: string | null;
  created_at: string;
  flight_session: FlightSessionJson | null;
  payload: TelemetryRecord | FlightEventRecord | null;
}

function normaliseIcao(icao: string): string {
  const u = icao.trim().toUpperCase();
  if (!ICAO_HEX.test(u)) {
    throw new RangeError("ICAO must be six hexadecimal characters");
  }
  return u;
}

function normaliseTxid(txid: string): string {
  const u = txid.trim().toLowerCase();
  if (!TXID_HEX.test(u)) {
    throw new RangeError("Transaction id must be 64 hexadecimal characters");
  }
  return u;
}

function normaliseFlightId(id: string): string {
  const u = id.trim();
  if (!UUID_RE.test(u)) {
    throw new RangeError("Flight id must be a UUID");
  }
  return u;
}

function bufferFromRow(raw: unknown): Buffer | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.length > 0 ? raw : null;
  }
  if (raw instanceof Uint8Array) {
    return raw.length > 0 ? Buffer.from(raw) : null;
  }
  return null;
}

function sessionFromJoin(row: Record<string, unknown>): FlightSessionJson | null {
  const id = row.fs_id;
  if (typeof id !== "string" || id === "") {
    return null;
  }
  return {
    id,
    aircraft_icao: String(row.fs_aircraft_icao ?? ""),
    callsign: row.fs_callsign === null || row.fs_callsign === undefined
      ? null
      : String(row.fs_callsign),
    origin_icao: row.fs_origin_icao === null || row.fs_origin_icao === undefined
      ? null
      : String(row.fs_origin_icao),
    origin_name: row.fs_origin_name === null || row.fs_origin_name === undefined
      ? null
      : String(row.fs_origin_name),
    dest_icao: row.fs_dest_icao === null || row.fs_dest_icao === undefined
      ? null
      : String(row.fs_dest_icao),
    dest_name: row.fs_dest_name === null || row.fs_dest_name === undefined
      ? null
      : String(row.fs_dest_name),
    phase: String(row.fs_phase ?? ""),
    started_at:
      row.fs_started_at instanceof Date
        ? row.fs_started_at.toISOString()
        : String(row.fs_started_at ?? ""),
    ended_at:
      row.fs_ended_at === null || row.fs_ended_at === undefined
        ? null
        : row.fs_ended_at instanceof Date
          ? row.fs_ended_at.toISOString()
          : String(row.fs_ended_at),
    total_tx_count: Number(row.fs_total_tx_count ?? 0),
    total_sats_spent: row.fs_total_sats_spent as string | number,
  };
}

function mapTxRow(
  row: Record<string, unknown>,
  payload: TelemetryRecord | FlightEventRecord | null,
): TxLookupRow {
  const created =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at ?? "");
  return {
    txid: String(row.txid),
    aircraft_icao: String(row.aircraft_icao),
    record_type: Number(row.record_type),
    status: String(row.status),
    block_height:
      row.block_height === null || row.block_height === undefined
        ? null
        : Number(row.block_height),
    merkle_path:
      row.merkle_path === null || row.merkle_path === undefined
        ? null
        : String(row.merkle_path),
    timestamp: Number(row.timestamp),
    fee_sats: Number(row.fee_sats),
    size_bytes: Number(row.size_bytes),
    flight_id:
      row.flight_id === null || row.flight_id === undefined
        ? null
        : String(row.flight_id),
    created_at: created,
    flight_session: sessionFromJoin(row),
    payload,
  };
}

function decodePayloadFromRow(row: Record<string, unknown>): TelemetryRecord | FlightEventRecord | null {
  const buf = bufferFromRow(row.op_return);
  if (buf === null) {
    return null;
  }
  try {
    return parseAirchiveTx(buf).payload;
  } catch {
    return null;
  }
}

export class AirchiveLookupService {
  constructor(private readonly db: Knex) {}

  private baseTxQuery() {
    return this.db("tx_results as t")
      .leftJoin("flight_sessions as fs", "t.flight_id", "fs.id")
      .select(
        "t.*",
        "fs.id as fs_id",
        "fs.aircraft_icao as fs_aircraft_icao",
        "fs.callsign as fs_callsign",
        "fs.origin_icao as fs_origin_icao",
        "fs.origin_name as fs_origin_name",
        "fs.dest_icao as fs_dest_icao",
        "fs.dest_name as fs_dest_name",
        "fs.phase as fs_phase",
        "fs.started_at as fs_started_at",
        "fs.ended_at as fs_ended_at",
        "fs.total_tx_count as fs_total_tx_count",
        "fs.total_sats_spent as fs_total_sats_spent",
      );
  }

  async lookupByIcao(
    icao: string,
    limit = 50,
    offset = 0,
  ): Promise<{ rows: TxLookupRow[]; total: number }> {
    const icaoNorm = normaliseIcao(icao);
    const lim = Math.min(Math.max(1, limit), 500);
    const off = Math.max(0, offset);

    const q = this.baseTxQuery().where("t.aircraft_icao", icaoNorm);

    const [rows, countRow] = await Promise.all([
      q.clone().orderBy("t.timestamp", "desc").limit(lim).offset(off),
      this.db("tx_results").where({ aircraft_icao: icaoNorm }).count<{ c: string | number }>("* as c").first(),
    ]);

    const total = Number(countRow?.c ?? 0);
    const mapped = (rows as Record<string, unknown>[]).map((r) =>
      mapTxRow(r, decodePayloadFromRow(r)),
    );
    return { rows: mapped, total };
  }

  async lookupByTxId(txid: string): Promise<TxLookupRow | null> {
    const id = normaliseTxid(txid);
    const row = (await this.baseTxQuery().where("t.txid", id).first()) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) {
      return null;
    }
    return mapTxRow(row, decodePayloadFromRow(row));
  }

  async lookupByTimeRange(
    icao: string,
    from: number,
    to: number,
  ): Promise<TxLookupRow[]> {
    const icaoNorm = normaliseIcao(icao);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      throw new RangeError("Invalid time range: from and to must be finite and from <= to");
    }
    const rows = (await this.baseTxQuery()
      .where("t.aircraft_icao", icaoNorm)
      .andWhereBetween("t.timestamp", [from, to])
      .orderBy("t.timestamp", "asc")) as Record<string, unknown>[];
    return rows.map((r) => mapTxRow(r, decodePayloadFromRow(r)));
  }

  async lookupByFlightSession(flightId: string): Promise<TxLookupRow[]> {
    const fid = normaliseFlightId(flightId);
    const rows = (await this.baseTxQuery()
      .where("t.flight_id", fid)
      .orderBy("t.timestamp", "asc")) as Record<string, unknown>[];
    return rows.map((r) => mapTxRow(r, decodePayloadFromRow(r)));
  }

  async getFlightSessions(
    icao: string,
    limit = 50,
    offset = 0,
  ): Promise<{ rows: FlightSessionJson[]; total: number }> {
    const icaoNorm = normaliseIcao(icao);
    const lim = Math.min(Math.max(1, limit), 200);
    const off = Math.max(0, offset);

    const [rows, countRow] = await Promise.all([
      this.db("flight_sessions")
        .where({ aircraft_icao: icaoNorm })
        .orderBy("started_at", "desc")
        .limit(lim)
        .offset(off),
      this.db("flight_sessions")
        .where({ aircraft_icao: icaoNorm })
        .count<{ c: string | number }>("* as c")
        .first(),
    ]);

    const total = Number(countRow?.c ?? 0);
    const mapped: FlightSessionJson[] = (rows as FlightSession[]).map((r) => ({
      id: r.id,
      aircraft_icao: r.aircraft_icao,
      callsign: r.callsign ?? null,
      origin_icao: r.origin_icao ?? null,
      origin_name: r.origin_name ?? null,
      dest_icao: r.dest_icao ?? null,
      dest_name: r.dest_name ?? null,
      phase: r.phase,
      started_at:
        r.started_at instanceof Date ? r.started_at.toISOString() : String(r.started_at),
      ended_at:
        r.ended_at === undefined || r.ended_at === null
          ? null
          : r.ended_at instanceof Date
            ? r.ended_at.toISOString()
            : String(r.ended_at),
      total_tx_count: r.total_tx_count,
      total_sats_spent: r.total_sats_spent,
    }));
    return { rows: mapped, total };
  }

  async getLatestRecords(
    icao: string,
    count = 20,
  ): Promise<TxLookupRow[]> {
    const icaoNorm = normaliseIcao(icao);
    const n = Math.min(Math.max(1, count), 200);
    const rows = (await this.baseTxQuery()
      .where("t.aircraft_icao", icaoNorm)
      .orderBy("t.timestamp", "desc")
      .limit(n)) as Record<string, unknown>[];
    return rows.map((r) => mapTxRow(r, decodePayloadFromRow(r)));
  }

  async ping(): Promise<boolean> {
    await this.db.raw("select 1");
    return true;
  }
}
