import type { FastifyInstance } from "fastify";
import { getDb, getFundingState, TREASURY_SCOPE } from "@airchive/db";

type CountRow = { total: string | number } | undefined;

/**
 * The writer only re-evaluates funding on its own cadence, so a stale row means
 * the writer is not running rather than that funding is fine.
 */
const FUNDING_STALE_AFTER_MS = 120_000;

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  const startTime = Date.now();

  app.get("/api/metrics", async (_request, reply) => {
    const db = getDb();
    const todayStartMs = new Date();
    todayStartMs.setUTCHours(0, 0, 0, 0);
    const todayEpoch = todayStartMs.getTime();
    const recentWindowEpoch = Date.now() - 60_000;

    const [txToday, totalBytes, aircraftCount, pendingCount, totalSats, minedToday, failedToday, pendingToday, recentTxCount] = await Promise.all([
      db("tx_results")
        .where("timestamp", ">=", todayEpoch)
        .count("* as total")
        .first() as Promise<CountRow>,
      db("tx_results")
        .where("timestamp", ">=", todayEpoch)
        .sum("size_bytes as total")
        .first() as Promise<CountRow>,
      db("aircraft_config")
        .where({ enabled: true })
        .count("* as total")
        .first() as Promise<CountRow>,
      db("pending_writes")
        .count("* as total")
        .first() as Promise<CountRow>,
      db("tx_results")
        .where("timestamp", ">=", todayEpoch)
        .sum("fee_sats as total")
        .first() as Promise<CountRow>,
      db("tx_results")
        .where("timestamp", ">=", todayEpoch)
        .where("status", "MINED")
        .count("* as total")
        .first() as Promise<CountRow>,
      db("tx_results")
        .where("timestamp", ">=", todayEpoch)
        .where("status", "FAILED")
        .count("* as total")
        .first() as Promise<CountRow>,
      db("tx_results")
        .where("timestamp", ">=", todayEpoch)
        .where("status", "SEEN_ON_NETWORK")
        .count("* as total")
        .first() as Promise<CountRow>,
      db("tx_results")
        .where("created_at", ">=", new Date(recentWindowEpoch))
        .count("* as total")
        .first() as Promise<CountRow>,
    ]);

    const txTodayNum = Number(txToday?.total ?? 0);
    const minedNum = Number(minedToday?.total ?? 0);
    const failedNum = Number(failedToday?.total ?? 0);
    const pendingTodayNum = Number(pendingToday?.total ?? 0);
    const txPerSecond = Number(recentTxCount?.total ?? 0) / 60;

    return reply.send({
      success: true,
      data: {
        transactions_today: txTodayNum,
        bytes_on_chain_today: Number(totalBytes?.total ?? 0),
        bsv_cost_today_sats: Number(totalSats?.total ?? 0),
        active_aircraft: Number(aircraftCount?.total ?? 0),
        pending_writes: Number(pendingCount?.total ?? 0),
        mined_today: minedNum,
        pending_today: pendingTodayNum,
        failed_today: failedNum,
        tx_per_second: txPerSecond,
      },
    });
  });

  app.get("/api/system/funding", async (_request, reply) => {
    const db = getDb();
    const row = await getFundingState(db, TREASURY_SCOPE).catch(() => undefined);

    if (!row) {
      return reply.send({
        success: true,
        data: {
          state: "UNKNOWN",
          reason: "The blockchain writer has not reported funding health yet",
          balance_sats: 0,
          utxo_count: 0,
          runway_hours: null,
          pending_writes: 0,
          stale: true,
        },
      });
    }

    const [pendingCount, dryAircraft] = await Promise.all([
      (db("pending_writes").count("* as total").first() as Promise<CountRow>)
        .catch(() => ({ total: 0 })),
      (db("utxo_pool")
        .where({ is_locked: false })
        .countDistinct("aircraft_icao as total")
        .first() as Promise<CountRow>).catch(() => ({ total: 0 })),
    ]);

    const lastChecked = row.last_checked_at ? new Date(row.last_checked_at) : null;
    const stale =
      lastChecked === null || Date.now() - lastChecked.getTime() > FUNDING_STALE_AFTER_MS;
    const balance = Number(row.balance_sats ?? 0);
    const burn = Number(row.burn_sats_per_hour ?? 0);

    return reply.send({
      success: true,
      data: {
        state: row.state,
        balance_sats: balance,
        utxo_count: row.utxo_count,
        burn_sats_per_hour: burn,
        runway_hours: burn > 0 ? balance / burn : null,
        state_since: row.state_since,
        last_checked_at: row.last_checked_at,
        next_poll_at: row.next_poll_at,
        consecutive_dry_polls: row.consecutive_dry_polls,
        pending_writes: Number(pendingCount?.total ?? 0),
        funded_aircraft: Number(dryAircraft?.total ?? 0),
        details: row.details,
        stale,
      },
    });
  });

  app.get("/api/system/health", async (_request, reply) => {
    const db = getDb();
    let dbHealthy = false;
    let redisHealthy = false;

    try {
      await db.raw("SELECT 1");
      dbHealthy = true;
    } catch { /* db down */ }

    try {
      const redisClient = (app as any).redis;
      if (redisClient) {
        await redisClient.ping();
        redisHealthy = true;
      }
    } catch { /* redis down */ }

    const [utxoSummary, pendingCount] = await Promise.all([
      db("utxo_pool")
        .select("aircraft_icao")
        .count("* as utxo_count")
        .sum("satoshis as balance")
        .where({ is_locked: false })
        .groupBy("aircraft_icao")
        .catch(() => []),
      (db("pending_writes").count("* as total").first() as Promise<CountRow>).catch(() => ({ total: 0 })),
    ]);

    const healthy = dbHealthy && redisHealthy;
    return reply.status(healthy ? 200 : 503).send({
      success: healthy,
      data: {
        status: healthy ? "healthy" : "degraded",
        uptime_ms: Date.now() - startTime,
        database: dbHealthy ? "connected" : "disconnected",
        redis: redisHealthy ? "connected" : "disconnected",
        pending_write_buffer: Number(pendingCount?.total ?? 0),
        utxo_pools: utxoSummary,
      },
    });
  });
}
