import type { FastifyInstance } from "fastify";
import type { TelemetryRecord } from "@airchive/types";
import { getDb } from "@airchive/db";

const aircraftState = new Map<string, TelemetryRecord & { phase?: string; flight_id?: string; last_updated: number }>();

export function updateAircraftState(record: TelemetryRecord & { phase?: string; flight_id?: string }): void {
  aircraftState.set(record.icao.toUpperCase(), { ...record, last_updated: Date.now() });
}

export async function fleetRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/fleet", async (_request, reply) => {
    const fleet = Array.from(aircraftState.values()).map((a) => ({
      icao: a.icao,
      callsign: a.callsign,
      lat: a.lat,
      lon: a.lon,
      alt_baro: a.alt_baro,
      gs: a.gs,
      track: a.track,
      on_ground: a.on_ground,
      phase: a.phase ?? "UNKNOWN",
      flight_id: a.flight_id,
      last_updated: a.last_updated,
    }));
    return reply.send({ success: true, data: fleet });
  });

  app.get<{ Params: { icao: string } }>("/api/aircraft/:icao", async (request, reply) => {
    const icao = request.params.icao.toUpperCase();
    const current = aircraftState.get(icao);
    if (!current) {
      return reply.status(404).send({ success: false, error: "Aircraft not found or not tracked" });
    }

    const db = getDb();
    const sessions = await db("flight_sessions")
      .where({ aircraft_icao: icao })
      .orderBy("started_at", "desc")
      .limit(1);

    const recentTx = await db("tx_results")
      .where({ aircraft_icao: icao })
      .orderBy("timestamp", "desc")
      .limit(10);

    return reply.send({
      success: true,
      data: {
        current,
        activeSession: sessions[0] ?? null,
        recentTransactions: recentTx,
      },
    });
  });
}
