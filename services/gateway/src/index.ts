import Fastify from "fastify";
import { Redis } from "ioredis";
import { createLogger } from "@airchive/logger";
import { getDb, closeDb } from "@airchive/db";
import { createCorsOriginDelegate, loadConfig } from "./config.js";
import { registerAuth } from "./plugins/auth.js";
import { fleetRoutes, updateAircraftState } from "./routes/fleet.js";
import { historyRoutes } from "./routes/history.js";
import { flightRoutes } from "./routes/flights.js";
import { explorerRoutes } from "./routes/explorer.js";
import { alertRoutes } from "./routes/alerts.js";
import { metricsRoutes } from "./routes/metrics.js";
import { auditRoutes } from "./routes/audit.js";
import { WsHub } from "./ws-hub.js";
import { createServer } from "node:http";

const log = createLogger({ service: "gateway" });

async function main(): Promise<void> {
  const config = loadConfig();

  const app = Fastify({ logger: false });

  if (config.corsOrigin === "*") {
    log.warn(
      "CORS_ORIGIN is '*': any site can read this API from a visitor's browser. "
        + "Set it to a comma-separated list of the dashboard origins.",
    );
  } else {
    log.info(
      { corsOrigin: config.corsOrigin },
      "CORS allow-list loaded (trailing slashes stripped)",
    );
  }
  await app.register(import("@fastify/cors"), {
    origin: createCorsOriginDelegate(config.corsOrigin),
    // Preflight must succeed for the dashboard's polling/SWR calls; without
    // this, browsers report opaque CORS failures rather than the real cause.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  // The dashboard polls fleet/metrics/funding/transactions every few seconds
  // from one browser. The old ceiling of 100/min is crossed within the first
  // page load; @fastify/rate-limit then answers 429 without CORS headers, and
  // Chrome surfaces that as a CORS block — which is exactly the "works for a
  // couple of seconds, then Application error" symptom.
  await app.register(import("@fastify/rate-limit"), {
    max: Number(process.env.GATEWAY_RATE_LIMIT_MAX ?? "2000"),
    timeWindow: "1 minute",
    allowList: (req) => req.method === "OPTIONS",
  });

  await registerAuth(app, config);

  const db = getDb();
  await db.raw("SELECT 1");
  log.info("Database connected");

  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
  });
  redis.on("error", (err) => {
    log.warn({ err: err.message }, "Gateway Redis error");
  });
  await redis.connect();
  log.info("Redis connected");

  (app as any).redis = redis;

  const subscriber = redis.duplicate();
  subscriber.on("error", (err) => {
    log.warn({ err: err.message }, "Gateway Redis subscriber error");
  });
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
  await app.register(explorerRoutes);
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
