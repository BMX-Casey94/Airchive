import type { FastifyInstance } from "fastify";
import { getDb } from "@airchive/db";
import { AlertSeverity } from "@airchive/types";

type CountRow = { total: string | number } | undefined;

const SEVERITIES = new Set<string>(Object.values(AlertSeverity));
const ICAO_PATTERN = /^[0-9A-Z]{1,8}$/;

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

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
    const limit = boundedInt(request.query.limit, 50, 1, 500);
    const offset = boundedInt(request.query.offset, 0, 0, 100_000);
    const icao = request.query.icao?.trim().toUpperCase();
    const severity = request.query.severity?.trim().toUpperCase();

    if (icao !== undefined && !ICAO_PATTERN.test(icao)) {
      return reply.status(400).send({ success: false, error: "Invalid icao" });
    }
    if (severity !== undefined && !SEVERITIES.has(severity)) {
      return reply.status(400).send({ success: false, error: "Invalid severity" });
    }

    const db = getDb();
    let query = db("alerts").orderBy("created_at", "desc").limit(limit).offset(offset);
    let countQuery = db("alerts");

    if (icao) {
      query = query.where({ aircraft_icao: icao });
      countQuery = countQuery.where({ aircraft_icao: icao });
    }
    if (severity) {
      query = query.where({ severity });
      countQuery = countQuery.where({ severity });
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
