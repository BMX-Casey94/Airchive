import Fastify from "fastify";
import { Redis } from "ioredis";
import { createLogger } from "@airchive/logger";
import { getDb, closeDb } from "@airchive/db";
import { loadConfig } from "./config.js";
import { registerAuth } from "./plugins/auth.js";
import { fleetRoutes, updateAircraftState } from "./routes/fleet.js";
import { historyRoutes } from "./routes/history.js";
import { flightRoutes } from "./routes/flights.js";
import { alertRoutes } from "./routes/alerts.js";
import { metricsRoutes } from "./routes/metrics.js";
import { auditRoutes } from "./routes/audit.js";
import { WsHub } from "./ws-hub.js";
import { createServer } from "node:http";

const log = createLogger({ service: "gateway" });

async function main(): Promise<void> {
  const config = loadConfig();

  const app = Fastify({ logger: false });

  await app.register(import("@fastify/cors"), { origin: config.corsOrigin });
  await app.register(import("@fastify/rate-limit"), {
    max: 100,
    timeWindow: "1 minute",
  });

  await registerAuth(app, config);

  const db = getDb();
  await db.raw("SELECT 1");
  log.info("Database connected");

  const redis = new Redis({ host: config.redis.host, port: config.redis.port, lazyConnect: true });
  await redis.connect();
  log.info("Redis connected");

  (app as any).redis = redis;

  const subscriber = redis.duplicate();
  await subscriber.connect();
  await subscriber.subscribe("broadcast");
  subscriber.on("message", (_channel: string, message: string) => {
    try {
      const record = JSON.parse(message);
      if (record.icao) updateAircraftState(record);
    } catch { /* ignore */ }
  });

  await app.register(fleetRoutes);
  await app.register(historyRoutes);
  await app.register(flightRoutes);
  await app.register(alertRoutes);
  await app.register(metricsRoutes);
  await app.register(auditRoutes);

  const httpServer = createServer(app.server);
  const wsHub = new WsHub();
  await wsHub.start(httpServer, config.redis);

  await app.listen({ port: config.port, host: "0.0.0.0" });
  log.info({ port: config.port }, "Gateway API listening");

  httpServer.listen(config.wsPort, "0.0.0.0", () => {
    log.info({ port: config.wsPort }, "WebSocket hub listening");
  });

  const shutdown = async () => {
    log.info("Shutting down gateway...");
    await wsHub.stop();
    subscriber.disconnect();
    redis.disconnect();
    await app.close();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.fatal(err, "Gateway failed to start");
  process.exit(1);
});
