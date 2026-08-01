import type { FastifyInstance } from "fastify";
import {
  getDb,
  getActiveFlightSessions,
  getSessionPath,
  type FlightSessionRow,
  type SessionPathPoint,
} from "@airchive/db";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_PATH_POINTS = 1_500;
const MIN_PATH_POINTS = 50;
const MAX_PATH_POINTS = 4_000;
const MAX_ACTIVE_SESSIONS = 100;
/**
 * Active paths grow at ~1 point per few seconds, so a short server-side cache
 * absorbs every dashboard tab polling at once without observable staleness.
 */
const ACTIVE_CACHE_TTL_MS = 2_000;

/**
 * Wire format for one path point: `[ts, lat, lon, alt_baro, gs, track]`.
 * Tuples rather than objects roughly halve the JSON payload for long paths.
 */
type WirePathPoint = [
  number,
  number,
  number,
  number | null,
  number | null,
  number | null,
];

interface ActiveSessionDTO {
  id: string;
  aircraftIcao: string;
  callsign: string;
  originIcao: string | null;
  originName: string | null;
  destIcao: string | null;
  destName: string | null;
  phase: string;
  startedAt: string;
  totalTxCount: number;
  totalSatsSpent: number;
  path: WirePathPoint[];
}

function toWirePath(points: SessionPathPoint[]): WirePathPoint[] {
  return points.map((p) => [
    Number(p.ts),
    p.lat,
    p.lon,
    p.alt_baro,
    p.gs,
    p.track,
  ]);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function parsePoints(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PATH_POINTS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_PATH_POINTS || n > MAX_PATH_POINTS) {
    return null;
  }
  return n;
}

function toActiveSessionDTO(
  session: FlightSessionRow,
  path: SessionPathPoint[],
): ActiveSessionDTO {
  return {
    id: session.id,
    aircraftIcao: session.aircraft_icao,
    callsign: session.callsign ?? session.aircraft_icao,
    originIcao: session.origin_icao ?? null,
    originName: session.origin_name ?? null,
    destIcao: session.dest_icao ?? null,
    destName: session.dest_name ?? null,
    phase: String(session.phase),
    startedAt: toDate(session.started_at).toISOString(),
    totalTxCount: Number(session.total_tx_count),
    totalSatsSpent: Number(session.total_sats_spent),
    path: toWirePath(path),
  };
}

let activeCache: { at: number; points: number; body: unknown } | null = null;

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Every open flight session with its stored path from take-off (or taxi
   * start) to the latest persisted position. The dashboard stitches live
   * WebSocket telemetry onto the end of these baselines.
   */
  app.get<{ Querystring: { points?: string } }>(
    "/api/sessions/active",
    async (request, reply) => {
      const points = parsePoints(request.query.points);
      if (points === null) {
        return reply.status(400).send({
          success: false,
          error: `points must be an integer between ${MIN_PATH_POINTS} and ${MAX_PATH_POINTS}`,
        });
      }

      const now = Date.now();
      if (
        activeCache
        && activeCache.points === points
        && now - activeCache.at < ACTIVE_CACHE_TTL_MS
      ) {
        return reply.send(activeCache.body);
      }

      const db = getDb();
      const sessions = await getActiveFlightSessions(db, MAX_ACTIVE_SESSIONS);
      const paths = await Promise.all(
        sessions.map((s) => getSessionPath(db, s.id, points)),
      );

      const body = {
        success: true,
        data: sessions.map((s, i) => toActiveSessionDTO(s, paths[i] ?? [])),
      };
      activeCache = { at: now, points, body };
      return reply.send(body);
    },
  );

  /** Stored path for any single flight, active or completed. */
  app.get<{ Params: { flightId: string }; Querystring: { points?: string } }>(
    "/api/flights/:flightId/path",
    async (request, reply) => {
      const flightId = request.params.flightId;
      if (!UUID_RE.test(flightId)) {
        return reply
          .status(400)
          .send({ success: false, error: "flightId must be a UUID" });
      }

      const points = parsePoints(request.query.points);
      if (points === null) {
        return reply.status(400).send({
          success: false,
          error: `points must be an integer between ${MIN_PATH_POINTS} and ${MAX_PATH_POINTS}`,
        });
      }

      const db = getDb();
      const session = await db("flight_sessions")
        .where({ id: flightId })
        .first();
      if (!session) {
        return reply
          .status(404)
          .send({ success: false, error: "Flight session not found" });
      }

      const path = await getSessionPath(db, flightId, points);
      return reply.send({
        success: true,
        data: {
          flightId,
          aircraftIcao: session.aircraft_icao,
          active: session.ended_at == null,
          path: toWirePath(path),
        },
      });
    },
  );
}
