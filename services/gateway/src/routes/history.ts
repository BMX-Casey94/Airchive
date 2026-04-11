import type { FastifyInstance } from "fastify";
import { getDb } from "@airchive/db";

type CountRow = { total: string | number } | undefined;

export async function historyRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { icao: string };
    Querystring: { from?: string; to?: string; limit?: string; offset?: string };
  }>("/api/aircraft/:icao/history", async (request, reply) => {
    const { icao } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? "100", 10), 1000);
    const offset = parseInt(request.query.offset ?? "0", 10);
    const db = getDb();

    let query = db("tx_results")
      .where({ aircraft_icao: icao.toUpperCase(), record_type: 1 })
      .orderBy("timestamp", "desc")
      .limit(limit)
      .offset(offset);

    if (request.query.from) {
      query = query.where("timestamp", ">=", parseInt(request.query.from, 10));
    }
    if (request.query.to) {
      query = query.where("timestamp", "<=", parseInt(request.query.to, 10));
    }

    const [rows, countResult] = await Promise.all([
      query,
      db("tx_results")
        .where({ aircraft_icao: icao.toUpperCase(), record_type: 1 })
        .count("* as total")
        .first() as Promise<CountRow>,
    ]);

    return reply.send({
      success: true,
      data: rows,
      pagination: { limit, offset, total: Number(countResult?.total ?? 0) },
    });
  });

  app.get<{
    Params: { icao: string };
    Querystring: { limit?: string; offset?: string };
  }>("/api/aircraft/:icao/transactions", async (request, reply) => {
    const { icao } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? "50", 10), 500);
    const offset = parseInt(request.query.offset ?? "0", 10);
    const db = getDb();

    const [rows, countResult] = await Promise.all([
      db("tx_results")
        .where({ aircraft_icao: icao.toUpperCase() })
        .orderBy("timestamp", "desc")
        .limit(limit)
        .offset(offset),
      db("tx_results")
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
}
