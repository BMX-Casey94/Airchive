import type { FastifyInstance } from "fastify";
import { getDb } from "@airchive/db";
import { createLogger } from "@airchive/logger";
import {
  bufferFromColumn,
  fetchEnvelopeFromNetwork,
  tryDecodeEnvelope,
  type DecodedEnvelope,
} from "../lib/op-return.js";
import {
  phaseAt,
  phaseMarkersFromEvents,
  type PhaseMarker,
  type PhaseName,
} from "../lib/flight-phases.js";

const log = createLogger({ service: "gateway" });

const ICAO_HEX = /^[0-9a-fA-F]{6}$/;
const TXID_HEX = /^[0-9a-fA-F]{64}$/;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const RECORD_TYPE_FLIGHT_EVENT = 2;
const MAX_EVENTS_PER_FLIGHT = 64;
/**
 * Hard ceiling on a single CSV export. Beyond this the operator should narrow
 * the time range rather than shipping an unbounded download through the
 * gateway's memory.
 */
const MAX_CSV_ROWS = 100_000;
const CSV_BATCH_SIZE = 500;

const RECORD_TYPE_LABEL: Record<number, string> = {
  1: "Telemetry",
  2: "Flight Event",
  3: "Telemetry Delta",
  4: "Agent Record",
  5: "Agent Record",
};

/**
 * Recovering an envelope from a miner API costs a network round trip, so a
 * listing repairs only a handful of pre-schema rows per request. The remainder
 * are served undecoded rather than holding the response open.
 */
const MAX_NETWORK_DECODES_PER_REQUEST = 6;

/** The envelope column is large, so it is only read when a decode is requested. */
const TX_COLUMNS = [
  "txid",
  "aircraft_icao",
  "record_type",
  "status",
  "block_height",
  "merkle_path",
  "spv_verified",
  "timestamp",
  "fee_sats",
  "size_bytes",
  "flight_id",
  "created_at",
] as const;

interface TxRow {
  txid: string;
  aircraft_icao: string;
  record_type: number | string;
  status: string;
  block_height: number | string | null;
  merkle_path: string | null;
  spv_verified: boolean | null;
  timestamp: number | string;
  fee_sats: number | string;
  size_bytes: number | string;
  flight_id: string | null;
  created_at: Date | string;
  op_return?: unknown;
}

interface TelemetrySampleDTO {
  callsign: string | null;
  /** Identity carried in the envelope itself, so the explorer can name an
   *  aircraft from its own on-chain records rather than live fleet state. */
  registration: string | null;
  aircraftType: string | null;
  aircraftDesc: string | null;
  latitude: number | null;
  longitude: number | null;
  altitudeFt: number | null;
  groundSpeedKts: number | null;
  headingDeg: number | null;
  verticalRateFpm: number | null;
  onGround: boolean | null;
  squawk: string | null;
}

interface TxResultDTO {
  txid: string;
  aircraftIcao: string;
  recordType: number;
  status: string;
  blockHeight?: number;
  merklePath?: string;
  /**
   * True only when the writer verified the inclusion proof against a block
   * header it holds and has itself proof-of-work checked. The presence of
   * `merklePath` means a proof was *received*, which is a much weaker claim —
   * unverified proofs are stored too — so the UI must never infer verification
   * from it.
   */
  spvVerified: boolean;
  timestamp: number;
  feeSats: number;
  sizeBytes: number;
  flightId?: string;
  createdAt: string;
  phase?: PhaseName;
  telemetry?: TelemetrySampleDTO | null;
}

function finiteOrNull(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function parseEpochMs(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) return null;
  return n;
}

function isTruthyFlag(raw: string | undefined): boolean {
  return raw === "true" || raw === "1";
}

/** RFC 4180: quote every cell so commas and newlines in decoded JSON stay safe. */
function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function recordTypeLabel(recordType: number): string {
  return RECORD_TYPE_LABEL[recordType]
    ?? `0x${recordType.toString(16).padStart(2, "0")}`;
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function mapTxRow(row: TxRow): TxResultDTO {
  const dto: TxResultDTO = {
    txid: row.txid,
    aircraftIcao: row.aircraft_icao,
    recordType: Number(row.record_type),
    status: row.status,
    timestamp: Number(row.timestamp),
    feeSats: Number(row.fee_sats),
    sizeBytes: Number(row.size_bytes),
    createdAt: toIsoString(row.created_at),
    spvVerified: row.spv_verified === true,
  };

  const blockHeight = finiteOrNull(row.block_height);
  if (blockHeight !== null) dto.blockHeight = blockHeight;
  if (row.merkle_path) dto.merklePath = row.merkle_path;
  if (row.flight_id) dto.flightId = row.flight_id;

  return dto;
}

function telemetryFromFields(
  fields: Record<string, unknown>,
): TelemetrySampleDTO {
  return {
    callsign: stringOrNull(fields.callsign),
    registration: stringOrNull(fields.reg),
    aircraftType: stringOrNull(fields.aircraft_type),
    aircraftDesc: stringOrNull(fields.aircraft_desc),
    latitude: finiteOrNull(fields.lat),
    longitude: finiteOrNull(fields.lon),
    altitudeFt: finiteOrNull(fields.alt_baro) ?? finiteOrNull(fields.alt_geom),
    groundSpeedKts: finiteOrNull(fields.gs),
    headingDeg:
      finiteOrNull(fields.track) ??
      finiteOrNull(fields.true_heading) ??
      finiteOrNull(fields.mag_heading),
    verticalRateFpm:
      finiteOrNull(fields.baro_rate) ?? finiteOrNull(fields.geom_rate),
    onGround: typeof fields.on_ground === "boolean" ? fields.on_ground : null,
    squawk: stringOrNull(fields.squawk),
  };
}

/**
 * Resolves the envelope for a row, preferring the stored column and falling
 * back to the miner APIs for rows written before that column existed.
 */
async function resolveEnvelopes(
  rows: TxRow[],
): Promise<Map<string, DecodedEnvelope>> {
  const decoded = new Map<string, DecodedEnvelope>();
  const missing: string[] = [];

  for (const row of rows) {
    const stored = bufferFromColumn(row.op_return);
    if (stored === null) {
      missing.push(row.txid);
      continue;
    }
    const envelope = tryDecodeEnvelope(stored);
    if (envelope !== null) decoded.set(row.txid, envelope);
  }

  const repairable = missing.slice(0, MAX_NETWORK_DECODES_PER_REQUEST);
  if (repairable.length === 0) return decoded;

  const recovered = await Promise.all(
    repairable.map(async (txid) => {
      try {
        const envelope = await fetchEnvelopeFromNetwork(txid);
        return envelope === null
          ? null
          : ([txid, tryDecodeEnvelope(envelope)] as const);
      } catch (err) {
        log.warn(
          { txid, err: err instanceof Error ? err.message : String(err) },
          "Envelope recovery from upstream failed",
        );
        return null;
      }
    }),
  );

  for (const entry of recovered) {
    if (entry === null) continue;
    const [txid, envelope] = entry;
    if (envelope !== null) decoded.set(txid, envelope);
  }

  return decoded;
}

/** Phase timelines for every flight referenced by the supplied rows. */
async function resolvePhaseMarkers(
  rows: TxRow[],
): Promise<Map<string, PhaseMarker[]>> {
  const flightIds = [
    ...new Set(
      rows
        .map((row) => row.flight_id)
        .filter((id): id is string => typeof id === "string" && id !== ""),
    ),
  ];
  if (flightIds.length === 0) return new Map();

  const db = getDb();
  const eventRows = (await db("tx_results")
    .select("flight_id", "timestamp", "op_return")
    .whereIn("flight_id", flightIds)
    .where({ record_type: RECORD_TYPE_FLIGHT_EVENT })
    .orderBy("timestamp", "asc")
    .limit(flightIds.length * MAX_EVENTS_PER_FLIGHT)) as Array<{
    flight_id: string;
    timestamp: string | number;
    op_return?: unknown;
  }>;

  const grouped = new Map<string, typeof eventRows>();
  for (const row of eventRows) {
    const existing = grouped.get(row.flight_id);
    if (existing) existing.push(row);
    else grouped.set(row.flight_id, [row]);
  }

  const markers = new Map<string, PhaseMarker[]>();
  for (const [flightId, events] of grouped) {
    markers.set(flightId, phaseMarkersFromEvents(events));
  }
  return markers;
}

export async function explorerRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { icao: string };
    Querystring: {
      limit?: string;
      offset?: string;
      from?: string;
      to?: string;
      recordType?: string;
      decode?: string;
    };
  }>("/api/explorer/aircraft/:icao/transactions", async (request, reply) => {
    const icao = request.params.icao.trim().toUpperCase();
    if (!ICAO_HEX.test(icao)) {
      return reply.status(400).send({
        success: false,
        error: "ICAO must be six hexadecimal characters",
      });
    }

    const limit = parseBoundedInt(request.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    if (limit === null) {
      return reply.status(400).send({
        success: false,
        error: `limit must be an integer between 1 and ${MAX_LIMIT}`,
      });
    }

    const offset = parseBoundedInt(request.query.offset, 0, 0, 1_000_000);
    if (offset === null) {
      return reply.status(400).send({
        success: false,
        error: "offset must be a non-negative integer",
      });
    }

    const from = parseEpochMs(request.query.from);
    const to = parseEpochMs(request.query.to);
    if (from === null || to === null) {
      return reply.status(400).send({
        success: false,
        error: "from and to must be epoch milliseconds",
      });
    }
    if (from !== undefined && to !== undefined && from > to) {
      return reply.status(400).send({
        success: false,
        error: "from must not be later than to",
      });
    }

    const recordTypeRaw = request.query.recordType;
    const recordType =
      recordTypeRaw === undefined || recordTypeRaw.trim() === ""
        ? undefined
        : Number(recordTypeRaw);
    // 1 telemetry, 2 flight event, 3 telemetry delta, 4/5 agent records.
    if (recordType !== undefined && ![1, 2, 3, 4, 5].includes(recordType)) {
      return reply.status(400).send({
        success: false,
        error: "recordType must be between 1 and 5",
      });
    }

    const wantsDecode = isTruthyFlag(request.query.decode);
    const db = getDb();

    let query = db("tx_results")
      .select(wantsDecode ? [...TX_COLUMNS, "op_return"] : [...TX_COLUMNS])
      .where({ aircraft_icao: icao });
    if (recordType !== undefined) query = query.where({ record_type: recordType });
    if (from !== undefined) query = query.where("timestamp", ">=", from);
    if (to !== undefined) query = query.where("timestamp", "<=", to);

    const rows = (await query
      .orderBy("timestamp", "desc")
      .limit(limit)
      .offset(offset)) as unknown as TxRow[];

    if (!wantsDecode) {
      return reply.send(rows.map(mapTxRow));
    }

    const [envelopes, markers] = await Promise.all([
      resolveEnvelopes(rows),
      resolvePhaseMarkers(rows),
    ]);

    const decorated = rows.map((row) => {
      const dto = mapTxRow(row);
      const envelope = envelopes.get(row.txid);
      dto.telemetry = envelope ? telemetryFromFields(envelope.fields) : null;
      dto.phase = row.flight_id
        ? phaseAt(markers.get(row.flight_id) ?? [], Number(row.timestamp))
        : "UNKNOWN";
      return dto;
    });

    return reply.send(decorated);
  });

  /**
   * Lifetime write totals for one aircraft. The listing is paginated, so
   * anything derived from a page describes the page rather than the aircraft;
   * these aggregates are the only honest source for a headline figure.
   */
  app.get<{
    Params: { icao: string };
    Querystring: { from?: string; to?: string };
  }>("/api/explorer/aircraft/:icao/summary", async (request, reply) => {
    const icao = request.params.icao.trim().toUpperCase();
    if (!ICAO_HEX.test(icao)) {
      return reply.status(400).send({
        success: false,
        error: "ICAO must be six hexadecimal characters",
      });
    }

    const from = parseEpochMs(request.query.from);
    const to = parseEpochMs(request.query.to);
    if (from === null || to === null) {
      return reply.status(400).send({
        success: false,
        error: "from and to must be epoch milliseconds",
      });
    }

    const db = getDb();
    let query = db("tx_results").where({ aircraft_icao: icao });
    if (from !== undefined) query = query.where("timestamp", ">=", from);
    if (to !== undefined) query = query.where("timestamp", "<=", to);

    const row = (await query
      .select(
        db.raw("count(*)::bigint as total"),
        db.raw("coalesce(sum(fee_sats), 0)::bigint as fee_sats"),
        db.raw("coalesce(sum(size_bytes), 0)::bigint as size_bytes"),
        db.raw("min(timestamp)::bigint as first_seen"),
        db.raw("max(timestamp)::bigint as last_seen"),
        db.raw("count(*) filter (where status = 'MINED')::bigint as mined"),
        db.raw(
          "count(*) filter (where status = 'SEEN_ON_NETWORK')::bigint as pending",
        ),
        db.raw("count(*) filter (where status = 'FAILED')::bigint as failed"),
        db.raw("count(*) filter (where spv_verified)::bigint as spv_verified"),
      )
      .first()) as Record<string, string | number | null> | undefined;

    return reply.send({
      success: true,
      data: {
        icao,
        total: Number(row?.total ?? 0),
        feeSats: Number(row?.fee_sats ?? 0),
        sizeBytes: Number(row?.size_bytes ?? 0),
        firstSeen: row?.first_seen != null ? Number(row.first_seen) : null,
        lastSeen: row?.last_seen != null ? Number(row.last_seen) : null,
        mined: Number(row?.mined ?? 0),
        pending: Number(row?.pending ?? 0),
        failed: Number(row?.failed ?? 0),
        spvVerified: Number(row?.spv_verified ?? 0),
      },
    });
  });

  /**
   * Full-history CSV for one aircraft. The paginated list only ever holds one
   * page in the browser; this endpoint is what "Export CSV" actually means.
   *
   * Decoded fields are included as a JSON column (and the common telemetry
   * columns are flattened for spreadsheets). Raw OP_RETURN hex is deliberately
   * omitted — it is large, opaque, and never what an analyst opens Excel for.
   * Envelopes are decoded from the stored column only; pre-schema rows without
   * `op_return` leave `decodedFields` blank rather than hammering miner APIs
   * for every line of a bulk export.
   */
  app.get<{
    Params: { icao: string };
    Querystring: { from?: string; to?: string; recordType?: string };
  }>("/api/explorer/aircraft/:icao/export.csv", async (request, reply) => {
    const icao = request.params.icao.trim().toUpperCase();
    if (!ICAO_HEX.test(icao)) {
      return reply.status(400).send({
        success: false,
        error: "ICAO must be six hexadecimal characters",
      });
    }

    const from = parseEpochMs(request.query.from);
    const to = parseEpochMs(request.query.to);
    if (from === null || to === null) {
      return reply.status(400).send({
        success: false,
        error: "from and to must be epoch milliseconds",
      });
    }
    if (from !== undefined && to !== undefined && from > to) {
      return reply.status(400).send({
        success: false,
        error: "from must not be later than to",
      });
    }

    const recordTypeRaw = request.query.recordType;
    const recordType =
      recordTypeRaw === undefined || recordTypeRaw.trim() === ""
        ? undefined
        : Number(recordTypeRaw);
    if (recordType !== undefined && ![1, 2, 3, 4, 5].includes(recordType)) {
      return reply.status(400).send({
        success: false,
        error: "recordType must be between 1 and 5",
      });
    }

    const db = getDb();
    let countQuery = db("tx_results").where({ aircraft_icao: icao });
    if (recordType !== undefined) {
      countQuery = countQuery.where({ record_type: recordType });
    }
    if (from !== undefined) countQuery = countQuery.where("timestamp", ">=", from);
    if (to !== undefined) countQuery = countQuery.where("timestamp", "<=", to);

    const countRow = (await countQuery
      .count<{ total: string | number }>("* as total")
      .first()) as { total?: string | number } | undefined;
    const total = Number(countRow?.total ?? 0);
    if (total > MAX_CSV_ROWS) {
      return reply.status(413).send({
        success: false,
        error:
          `Export would contain ${total.toLocaleString("en-GB")} rows `
          + `(limit ${MAX_CSV_ROWS.toLocaleString("en-GB")}). Narrow the time `
          + "range or record-type filter and try again.",
        total,
        limit: MAX_CSV_ROWS,
      });
    }

    const headers = [
      "txid",
      "aircraftIcao",
      "recordType",
      "status",
      "spvVerified",
      "blockHeight",
      "timestamp",
      "feeSats",
      "sizeBytes",
      "flightId",
      "protocolId",
      "protocolVersion",
      "callsign",
      "registration",
      "aircraftType",
      "latitude",
      "longitude",
      "altitudeFt",
      "groundSpeedKts",
      "headingDeg",
      "verticalRateFpm",
      "squawk",
      "onGround",
      "decodedFields",
    ];

    const chunks: string[] = [`${headers.map(csvCell).join(",")}\r\n`];
    let offset = 0;

    while (offset < total) {
      let pageQuery = db("tx_results")
        .select([...TX_COLUMNS, "op_return"])
        .where({ aircraft_icao: icao });
      if (recordType !== undefined) {
        pageQuery = pageQuery.where({ record_type: recordType });
      }
      if (from !== undefined) pageQuery = pageQuery.where("timestamp", ">=", from);
      if (to !== undefined) pageQuery = pageQuery.where("timestamp", "<=", to);

      const rows = (await pageQuery
        .orderBy("timestamp", "desc")
        .orderBy("txid", "asc")
        .limit(CSV_BATCH_SIZE)
        .offset(offset)) as unknown as TxRow[];

      if (rows.length === 0) break;

      for (const row of rows) {
        const stored = bufferFromColumn(row.op_return);
        const envelope = stored === null ? null : tryDecodeEnvelope(stored);
        const fields = envelope?.fields ?? {};
        const telemetry = envelope ? telemetryFromFields(fields) : null;

        chunks.push(
          [
            row.txid,
            row.aircraft_icao,
            recordTypeLabel(Number(row.record_type)),
            row.status,
            row.spv_verified === true ? "true" : "false",
            row.block_height ?? "",
            new Date(Number(row.timestamp)).toISOString(),
            Number(row.fee_sats),
            Number(row.size_bytes),
            row.flight_id ?? "",
            envelope?.protocolId ?? "",
            envelope?.version ?? "",
            telemetry?.callsign ?? "",
            typeof fields.reg === "string" ? fields.reg : "",
            typeof fields.aircraft_type === "string" ? fields.aircraft_type : "",
            telemetry?.latitude ?? "",
            telemetry?.longitude ?? "",
            telemetry?.altitudeFt ?? "",
            telemetry?.groundSpeedKts ?? "",
            telemetry?.headingDeg ?? "",
            telemetry?.verticalRateFpm ?? "",
            telemetry?.squawk ?? "",
            telemetry?.onGround == null ? "" : telemetry.onGround ? "true" : "false",
            envelope ? JSON.stringify(fields) : "",
          ]
            .map(csvCell)
            .join(",")
            + "\r\n",
        );
      }

      offset += rows.length;
      if (rows.length < CSV_BATCH_SIZE) break;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        `attachment; filename="airchive-${icao}-${stamp}.csv"`,
      )
      .header("Cache-Control", "no-store")
      .send(chunks.join(""));
  });

  app.get<{ Params: { txid: string } }>(
    "/api/explorer/tx/:txid",
    async (request, reply) => {
      const txid = request.params.txid.trim().toLowerCase();
      if (!TXID_HEX.test(txid)) {
        return reply.status(400).send({
          success: false,
          error: "Transaction id must be 64 hexadecimal characters",
        });
      }

      const db = getDb();
      const row = (await db("tx_results")
        .select([...TX_COLUMNS])
        .where({ txid })
        .first()) as TxRow | undefined;

      if (row === undefined) {
        return reply
          .status(404)
          .send({ success: false, error: "Transaction not found" });
      }

      return reply.send(mapTxRow(row));
    },
  );

  app.get<{ Params: { txid: string } }>(
    "/api/explorer/tx/:txid/decode",
    async (request, reply) => {
      const txid = request.params.txid.trim().toLowerCase();
      if (!TXID_HEX.test(txid)) {
        return reply.status(400).send({
          success: false,
          error: "Transaction id must be 64 hexadecimal characters",
        });
      }

      const db = getDb();
      const row = (await db("tx_results")
        .select("txid", "op_return")
        .where({ txid })
        .first()) as Pick<TxRow, "txid" | "op_return"> | undefined;

      if (row === undefined) {
        return reply
          .status(404)
          .send({ success: false, error: "Transaction not found" });
      }

      const stored = bufferFromColumn(row.op_return);
      let decoded = stored === null ? null : tryDecodeEnvelope(stored);

      if (decoded === null) {
        try {
          const recovered = await fetchEnvelopeFromNetwork(txid);
          if (recovered !== null) decoded = tryDecodeEnvelope(recovered);
        } catch (err) {
          log.warn(
            { txid, err: err instanceof Error ? err.message : String(err) },
            "Envelope recovery from upstream failed",
          );
        }
      }

      if (decoded === null) {
        return reply.status(404).send({
          success: false,
          error: "No decodable AIRCHIVE payload available for this transaction",
        });
      }

      return reply.send(decoded);
    },
  );
}
