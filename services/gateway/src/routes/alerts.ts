import type { FastifyInstance } from "fastify";
import { getDb } from "@airchive/db";

type CountRow = { total: string | number } | undefined;

export async function alertRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      icao?: string;
      severity?: string;
      acknowledged?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/alerts", async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit ?? "50", 10), 500);
    const offset = parseInt(request.query.offset ?? "0", 10);
    const db = getDb();

    let query = db("alerts").orderBy("created_at", "desc").limit(limit).offset(offset);
    let countQuery = db("alerts");

    if (request.query.icao) {
      query = query.where({ aircraft_icao: request.query.icao.toUpperCase() });
      countQuery = countQuery.where({ aircraft_icao: request.query.icao.toUpperCase() });
    }
    if (request.query.severity) {
      query = query.where({ severity: request.query.severity.toUpperCase() });
      countQuery = countQuery.where({ severity: request.query.severity.toUpperCase() });
    }
    if (request.query.acknowledged !== undefined) {
      const ack = request.query.acknowledged === "true";
      query = query.where({ acknowledged: ack });
      countQuery = countQuery.where({ acknowledged: ack });
    }

    const [rows, countResult] = await Promise.all([
      query,
      countQuery.count("* as total").first() as Promise<CountRow>,
    ]);

    return reply.send({
      success: true,
      data: rows,
      pagination: { limit, offset, total: Number(countResult?.total ?? 0) },
    });
  });

  app.post<{ Params: { id: string } }>("/api/alerts/:id/acknowledge", {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const db = getDb();
    const updated = await db("alerts")
      .where({ id: request.params.id })
      .update({ acknowledged: true });

    if (!updated) {
      return reply.status(404).send({ success: false, error: "Alert not found" });
    }
    return reply.send({ success: true, data: { acknowledged: true } });
  });
}
