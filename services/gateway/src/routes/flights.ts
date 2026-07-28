import type { FastifyInstance } from "fastify";
import { getDb } from "@airchive/db";
import {
  buildPhaseSegments,
  phaseMarkersFromEvents,
  type PhaseSegmentDTO,
} from "../lib/flight-phases.js";

type CountRow = { total: string | number } | undefined;

const DEFAULT_FLIGHTS_LIMIT = 50;
const MAX_FLIGHTS_LIMIT = 200;
const RECORD_TYPE_FLIGHT_EVENT = 2;
const MAX_EVENTS_PER_FLIGHT = 64;

interface FlightSessionRow {
  id: string;
  aircraft_icao: string;
  callsign: string | null;
  origin_icao: string | null;
  origin_name: string | null;
  dest_icao: string | null;
  dest_name: string | null;
  started_at: Date | string;
  ended_at: Date | string;
  total_tx_count: number | string;
  total_sats_spent: number | string;
}

interface CompletedFlightDTO {
  id: string;
  aircraftIcao: string;
  callsign: string;
  originIcao?: string;
  originName?: string;
  destIcao?: string;
  destName?: string;
  startedAt: string;
  endedAt: string;
  durationMin: number;
  totalTxCount: number;
  totalSatsSpent: number;
  phases: PhaseSegmentDTO[];
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export async function flightRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: string; offset?: string; icao?: string } }>(
    "/api/flights",
    async (request, reply) => {
      const limitRaw = request.query.limit;
      const limit =
        limitRaw === undefined || limitRaw.trim() === ""
          ? DEFAULT_FLIGHTS_LIMIT
          : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FLIGHTS_LIMIT) {
        return reply.status(400).send({
          success: false,
          error: `limit must be an integer between 1 and ${MAX_FLIGHTS_LIMIT}`,
        });
      }

      const offsetRaw = request.query.offset;
      const offset =
        offsetRaw === undefined || offsetRaw.trim() === "" ? 0 : Number(offsetRaw);
      if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
        return reply
          .status(400)
          .send({ success: false, error: "offset must be a non-negative integer" });
      }

      const icaoRaw = request.query.icao?.trim().toUpperCase();
      if (icaoRaw !== undefined && !/^[0-9A-F]{6}$/.test(icaoRaw)) {
        return reply.status(400).send({
          success: false,
          error: "icao must be six hexadecimal characters",
        });
      }

      const db = getDb();
      let query = db("flight_sessions").whereNotNull("ended_at");
      if (icaoRaw !== undefined) query = query.where({ aircraft_icao: icaoRaw });

      const sessions = (await query
        .orderBy("ended_at", "desc")
        .limit(limit)
        .offset(offset)) as FlightSessionRow[];

      if (sessions.length === 0) {
        return reply.send([]);
      }

      const flightIds = sessions.map((s) => s.id);
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

      const eventsByFlight = new Map<string, typeof eventRows>();
      for (const row of eventRows) {
        const existing = eventsByFlight.get(row.flight_id);
        if (existing) existing.push(row);
        else eventsByFlight.set(row.flight_id, [row]);
      }

      const flights: CompletedFlightDTO[] = sessions.map((session) => {
        const startedAt = toDate(session.started_at);
        const endedAt = toDate(session.ended_at);
        const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime());
        const markers = phaseMarkersFromEvents(eventsByFlight.get(session.id) ?? []);

        const flight: CompletedFlightDTO = {
          id: session.id,
          aircraftIcao: session.aircraft_icao,
          callsign: session.callsign ?? session.aircraft_icao,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMin: durationMs / 60_000,
          totalTxCount: Number(session.total_tx_count),
          totalSatsSpent: Number(session.total_sats_spent),
          phases: buildPhaseSegments(markers, endedAt.getTime()),
        };

        if (session.origin_icao) flight.originIcao = session.origin_icao;
        if (session.origin_name) flight.originName = session.origin_name;
        if (session.dest_icao) flight.destIcao = session.dest_icao;
        if (session.dest_name) flight.destName = session.dest_name;

        return flight;
      });

      return reply.send(flights);
    },
  );

  app.get<{
    Params: { icao: string };
    Querystring: { limit?: string; offset?: string };
  }>("/api/aircraft/:icao/flights", async (request, reply) => {
    const { icao } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? "20", 10), 100);
    const offset = parseInt(request.query.offset ?? "0", 10);
    const db = getDb();

    const [rows, countResult] = await Promise.all([
      db("flight_sessions")
        .where({ aircraft_icao: icao.toUpperCase() })
        .orderBy("started_at", "desc")
        .limit(limit)
        .offset(offset),
      db("flight_sessions")
        .where({ aircraft_icao: icao.toUpperCase() })
        .count("* as total")
        .first() as Promise<CountRow>,
    ]);

    return reply.send({
      success: true,
      data: rows,
      pagination: { limit, offset, total: Number(countResult?.total ?? 0) },
    });
  });

  app.get<{ Params: { flightId: string } }>("/api/flight/:flightId", async (request, reply) => {
    const { flightId } = request.params;
    const db = getDb();

    const session = await db("flight_sessions").where({ id: flightId }).first();
    if (!session) {
      return reply.status(404).send({ success: false, error: "Flight session not found" });
    }

    const events = await db("tx_results")
      .where({ flight_id: flightId, record_type: 2 })
      .orderBy("timestamp", "asc");

    const txCount = await (db("tx_results")
      .where({ flight_id: flightId })
      .count("* as total")
      .first() as Promise<CountRow>);

    return reply.send({
      success: true,
      data: {
        session,
        events,
        totalTransactions: Number(txCount?.total ?? 0),
      },
    });
  });
}
