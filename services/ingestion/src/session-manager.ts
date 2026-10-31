import type { Knex } from "knex";
import { FlightPhase, type FlightSession, type FlightStats } from "@airchive/types";
import { normaliseAirportIcao, type AirportLookup } from "@airchive/airports";
import { createLogger } from "@airchive/logger";
import {
  createFlightSession,
  getActiveSession as selectActiveSession,
  updateFlightSession,
} from "@airchive/db";

const log = createLogger({ service: "ingestion" });

const AIRPORT_NAME_MAX_LENGTH = 100;

/** Trim and cap an airport name so it fits `flight_sessions` varchar(100). */
export function airportNameForStorage(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) {
    return undefined;
  }
  const characters = Array.from(trimmed);
  if (characters.length <= AIRPORT_NAME_MAX_LENGTH) {
    return trimmed;
  }
  return characters.slice(0, AIRPORT_NAME_MAX_LENGTH).join("");
}

export async function startSession(
  db: Knex,
  icao: string,
  callsign: string,
  airportLookup: AirportLookup,
  lat: number,
  lon: number,
  initialPhase: FlightPhase = FlightPhase.TAXI,
): Promise<FlightSession> {
  const nearest = airportLookup.findNearest(lat, lon, 10);
  const originIcao = normaliseAirportIcao(nearest?.icao_code);
  const originName = nearest ? airportNameForStorage(nearest.name) : undefined;
  if (nearest && originIcao === null) {
    log.debug(
      { aircraft: icao },
      "Origin stored by name; no 4-character ICAO",
    );
  }
  return createFlightSession(db, {
    aircraft_icao: icao,
    callsign,
    origin_icao: originIcao ?? undefined,
    origin_name: originName,
    phase: initialPhase,
  });
}

/**
 * Session for an aircraft first observed already airborne (entering ADS-B
 * coverage mid-flight). The origin is deliberately left unresolved: the
 * departure was never witnessed, and "nearest airport" to a cruising
 * aircraft is whatever it happens to be overflying — actively wrong, not
 * merely unknown.
 */
export async function startAirborneSession(
  db: Knex,
  icao: string,
  callsign: string,
  initialPhase: FlightPhase,
): Promise<FlightSession> {
  return createFlightSession(db, {
    aircraft_icao: icao,
    callsign,
    phase: initialPhase,
  });
}

/**
 * Closes a session whose real ending was never observed (coverage loss, or a
 * later departure proving the previous flight finished). `ended_at` is
 * backdated to the last known activity so durations stay honest; the phase
 * is left as last observed rather than pretending the aircraft parked.
 */
export async function expireSession(
  db: Knex,
  session: FlightSession,
  lastActivityMs: number,
): Promise<void> {
  const startedMs =
    session.started_at instanceof Date
      ? session.started_at.getTime()
      : Date.parse(String(session.started_at));
  const endedMs = Math.max(
    Number.isFinite(startedMs) ? startedMs : lastActivityMs,
    lastActivityMs,
  );
  await updateFlightSession(db, session.id, {
    ended_at: new Date(endedMs),
  });
}

export async function updateSessionPhase(
  db: Knex,
  sessionId: string,
  phase: FlightPhase,
): Promise<void> {
  await updateFlightSession(db, sessionId, { phase });
}

export async function closeSession(
  db: Knex,
  sessionId: string,
  stats: FlightStats,
): Promise<void> {
  await updateFlightSession(db, sessionId, {
    ended_at: new Date(),
    phase: FlightPhase.PARKED,
    total_tx_count: stats.total_tx_count,
    total_sats_spent: stats.total_bsv_sats,
  });
}

export async function updateSessionDest(
  db: Knex,
  sessionId: string,
  destIcao: string | null,
  destName: string,
): Promise<void> {
  const code = normaliseAirportIcao(destIcao);
  if (typeof destIcao === "string" && destIcao.trim() !== "" && code === null) {
    const length = destIcao.trim().length;
    throw new Error(
      `Destination ICAO cannot be stored (length ${length}); flight_sessions.dest_icao is varchar(4)`,
    );
  }
  const destNameStored = airportNameForStorage(destName);
  const updates: { dest_icao?: string; dest_name?: string } = {};
  if (code) {
    updates.dest_icao = code;
  }
  if (destNameStored) {
    updates.dest_name = destNameStored;
  }
  if (updates.dest_icao === undefined && updates.dest_name === undefined) {
    return;
  }
  await updateFlightSession(db, sessionId, updates);
}

export async function getActiveSession(
  db: Knex,
  icao: string,
): Promise<FlightSession | null> {
  const row = await selectActiveSession(db, icao);
  return row ?? null;
}

export async function incrementTxCount(db: Knex, sessionId: string): Promise<void> {
  await db("flight_sessions")
    .where({ id: sessionId })
    .update({ total_tx_count: db.raw("total_tx_count + 1") });
}
