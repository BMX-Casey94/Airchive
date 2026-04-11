import type { Knex } from "knex";
import { FlightPhase, type FlightSession, type FlightStats } from "@airchive/types";
import type { AirportLookup } from "@airchive/airports";
import {
  createFlightSession,
  getActiveSession as selectActiveSession,
  updateFlightSession,
} from "@airchive/db";

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
  return createFlightSession(db, {
    aircraft_icao: icao,
    callsign,
    origin_icao: nearest?.icao_code,
    origin_name: nearest?.name,
    phase: initialPhase,
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
  destIcao: string,
  destName: string,
): Promise<void> {
  await updateFlightSession(db, sessionId, {
    dest_icao: destIcao,
    dest_name: destName,
  });
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
