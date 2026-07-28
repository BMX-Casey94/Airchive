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
