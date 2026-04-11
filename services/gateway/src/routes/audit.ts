import type { FastifyInstance } from "fastify";
import { getDb } from "@airchive/db";

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { flightId: string } }>("/api/audit/flight/:flightId/full", async (request, reply) => {
    const { flightId } = request.params;
    const db = getDb();

    const session = await db("flight_sessions").where({ id: flightId }).first();
    if (!session) {
      return reply.status(404).send({ success: false, error: "Flight session not found" });
    }

    const records = await db("tx_results")
      .where({ flight_id: flightId })
      .orderBy("timestamp", "asc");

    return reply.send({
      success: true,
      data: {
        session,
        records: records.map((r: any) => ({
          txid: r.txid,
          record_type: r.record_type,
          status: r.status,
          block_height: r.block_height,
          merkle_path: r.merkle_path,
          timestamp: r.timestamp,
          fee_sats: r.fee_sats,
          size_bytes: r.size_bytes,
        })),
        total_records: records.length,
        audit_generated_at: new Date().toISOString(),
      },
    });
  });

  app.get<{ Params: { flightId: string } }>("/api/audit/flight/:flightId/summary", async (request, reply) => {
    const { flightId } = request.params;
    const db = getDb();

    const session = await db("flight_sessions").where({ id: flightId }).first();
    if (!session) {
      return reply.status(404).send({ success: false, error: "Flight session not found" });
    }

    const events = await db("tx_results")
      .where({ flight_id: flightId, record_type: 2 })
      .orderBy("timestamp", "asc");

    return reply.send({
      success: true,
      data: {
        session,
        events,
        total_telemetry_records: session.total_tx_count,
        total_bsv_sats: session.total_sats_spent,
      },
    });
  });

  app.get<{ Params: { txid: string } }>("/api/audit/verify/:txid", async (request, reply) => {
    const { txid } = request.params;
    const db = getDb();

    const tx = await db("tx_results").where({ txid }).first();
    if (!tx) {
      return reply.status(404).send({ success: false, error: "Transaction not found" });
    }

    const verified = tx.status === "MINED" && tx.merkle_path != null;

    return reply.send({
      success: true,
      data: {
        txid: tx.txid,
        status: tx.status,
        block_height: tx.block_height,
        merkle_path: tx.merkle_path,
        spv_verified: verified,
        aircraft_icao: tx.aircraft_icao,
        timestamp: tx.timestamp,
      },
    });
  });
}
