import { createDb, closeDb } from "@airchive/db";
import { createLogger } from "@airchive/logger";
import express from "express";
import { createServer } from "node:http";

import { loadConfig } from "./config.js";
import { AirchiveLookupService } from "./lookup-service.js";
import { createRoutes } from "./routes.js";
import { attachWebSocketServer } from "./ws-server.js";

const log = createLogger({ service: "overlay-node" });

function applyPostgresEnv(c: ReturnType<typeof loadConfig>["postgres"]): void {
  process.env.POSTGRES_HOST = c.host;
  process.env.POSTGRES_PORT = String(c.port);
  process.env.POSTGRES_DB = c.database;
  process.env.POSTGRES_USER = c.user;
  process.env.POSTGRES_PASSWORD = c.password;
}

async function main(): Promise<void> {
  const config = loadConfig();
  applyPostgresEnv(config.postgres);

  const db = createDb();
  const lookup = new AirchiveLookupService(db);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use(createRoutes(lookup));

  const server = createServer(app);
  const { notifyNewTx, close: closeWs } = attachWebSocketServer(server, {
    path: config.wsPath,
  });

  app.locals.notifyNewTx = notifyNewTx;

  await new Promise<void>((resolve, reject) => {
    server.listen(config.overlayPort, () => {
      log.info(
        { port: config.overlayPort, wsPath: config.wsPath, topic: config.topicName },
        "Overlay HTTP and WebSocket listening",
      );
      resolve();
    });
    server.on("error", reject);
  });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info({ signal }, "Shutting down overlay node");
    await closeWs().catch((e) => log.error(e, "WebSocket server close error"));
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await closeDb().catch((e) => log.error(e, "Database close error"));
    log.info("Shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((e) => {
  log.error(e, "Fatal error starting overlay node");
  process.exit(1);
});
