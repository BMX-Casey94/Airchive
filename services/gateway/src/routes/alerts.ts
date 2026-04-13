import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getDb } from "@airchive/db";
import type { Redis } from "ioredis";
import { AlertSeverity } from "@airchive/types";

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

  app.post<{ Body: { icao?: string } }>("/api/alerts/test", {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const db = getDb();
    const requestedIcao = request.body?.icao?.trim().toUpperCase();

    const aircraftRow = requestedIcao
      ? await db("aircraft_config")
        .where({ icao: requestedIcao, enabled: true })
        .select("icao")
        .first<{ icao: string } | undefined>()
      : await db("aircraft_config")
        .where({ enabled: true })
        .select("icao")
        .orderBy("wallet_index", "asc")
        .first<{ icao: string } | undefined>();

    if (!aircraftRow) {
      return reply.status(404).send({
        success: false,
        error: requestedIcao
          ? `Aircraft ${requestedIcao} not found in enabled fleet`
          : "No enabled aircraft available for test alert",
      });
    }

    const createdAt = new Date();
    const alert = {
      id: randomUUID(),
      aircraft_icao: aircraftRow.icao,
      severity: AlertSeverity.WARNING,
      type: "SYSTEM_TEST",
      message: `Simulated alert triggered from dashboard for ${aircraftRow.icao}`,
      data: {
        simulated: true,
        source: "dashboard",
        triggered_at: createdAt.toISOString(),
      },
      acknowledged: false,
      created_at: createdAt,
    };

    await db("alerts").insert({
      ...alert,
      flight_id: db.raw("NULL"),
    });

    const redis = (app as any).redis as Redis | undefined;
    await redis?.publish("alerts", JSON.stringify(alert)).catch(() => {});

    return reply.send({ success: true, data: alert });
  });
}
