import type { FastifyInstance } from "fastify";
import { getDb } from "@airchive/db";

type CountRow = { total: string | number } | undefined;

export async function flightRoutes(app: FastifyInstance): Promise<void> {
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
