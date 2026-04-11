import { createServer as createHttpServer } from "node:http";
import { Redis } from "ioredis";
import { PrivateKey } from "@bsv/sdk";
import { createLogger } from "@airchive/logger";
import { getDb, closeDb } from "@airchive/db";
import { loadConfig } from "./config.js";
import { CollectorAgent } from "./collector-agent.js";
import { AnalystAgent } from "./analyst-agent.js";
import { MonitorAgent } from "./monitor-agent.js";
import { AgentActivityPublisher } from "./activity-publisher.js";
import { DirectPaymentSender } from "./direct-payment.js";
import { registry } from "./metrics.js";

const log = createLogger({ service: "agent-marketplace" });

const IDENTITY_REGISTRY_URL = "https://identity.babbage.systems";
const MESSAGEBOX_HOST = "https://messagebox.babbage.systems";

function createStubWallet(hexKey: string): any {
  const pk = PrivateKey.fromString(hexKey, 16);
  const address = pk.toAddress();
  const identityKey = Buffer.from(pk.toPublicKey().encode(true) as number[]).toString("hex");

  const noop = async () => ({ txid: "stub" });
  return {
    getIdentityKey: () => identityKey,
    getAddress: () => address,
    registerIdentityTag: async (tag: string) => ({ tag }),
    lookupIdentityByTag: async () => [],
    inscribeText: noop,
    sendMessageBoxPayment: async () => { throw new Error("Stub wallet — no ServerWallet available"); },
    listIncomingPayments: async () => [],
    acceptIncomingPayment: noop,
    certifyForMessageBox: noop,
    getBalance: async () => ({ spendableSatoshis: 0, totalSatoshis: 0, spendableOutputs: 0 }),
  };
}

async function createAgentWallet(
  envVar: string,
  network: "main" | "testnet",
  storageUrl: string,
): Promise<any> {
  let key = process.env[envVar];
  if (!key) {
    const { generatePrivateKey } = await import("@bsv/simple/server");
    key = generatePrivateKey();
    log.info({ envVar }, `No ${envVar} set — generated ephemeral key`);
  }

  try {
    const { ServerWallet } = await import("@bsv/simple/server");

    const walletPromise = ServerWallet.create({
      privateKey: key,
      network,
      storageUrl,
    });

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`ServerWallet.create timed out for ${envVar}`)), 30_000),
    );

    const wallet = await Promise.race([walletPromise, timeout]);

    (wallet as any).defaults.registryUrl = IDENTITY_REGISTRY_URL;
    (wallet as any).defaults.messageBoxHost = MESSAGEBOX_HOST;

    return wallet;
  } catch (err) {
    log.warn(
      { envVar, err: (err as Error).message },
      "ServerWallet creation failed — using stub wallet (direct payments still work)",
    );
    return createStubWallet(key);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  log.info("Agent Marketplace starting");

  const db = getDb();
  try {
    await db.raw("SELECT 1");
    log.info("PostgreSQL connected");
  } catch (err) {
    log.fatal({ err }, "PostgreSQL unreachable");
    process.exit(1);
  }

  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
  });
  await redis.connect();
  log.info("Redis connected");

  const activityPub = new AgentActivityPublisher(redis);

  log.info("Initialising Collector agent wallet...");
  const collectorWallet = await createAgentWallet(
    config.collectorKeyEnv,
    config.network,
    config.storageUrl,
  );
  log.info(
    { identityKey: collectorWallet.getIdentityKey(), address: collectorWallet.getAddress() },
    "Collector wallet ready",
  );

  log.info("Initialising Analyst agent wallet...");
  const analystWallet = await createAgentWallet(
    config.analystKeyEnv,
    config.network,
    config.storageUrl,
  );
  log.info(
    { identityKey: analystWallet.getIdentityKey(), address: analystWallet.getAddress() },
    "Analyst wallet ready",
  );

  log.info("Initialising Monitor agent wallet...");
  const monitorWallet = await createAgentWallet(
    config.monitorKeyEnv,
    config.network,
    config.storageUrl,
  );
  log.info(
    { identityKey: monitorWallet.getIdentityKey(), address: monitorWallet.getAddress() },
    "Monitor wallet ready",
  );

  log.info(
    {
      collectorAddress: collectorWallet.getAddress(),
      analystAddress: analystWallet.getAddress(),
      monitorAddress: monitorWallet.getAddress(),
    },
    "=== AGENT FUNDING ADDRESSES ===",
  );

  for (const [name, w] of [["collector", collectorWallet], ["analyst", analystWallet], ["monitor", monitorWallet]] as const) {
    try {
      const bal = await (w as any).getBalance();
      log.info(
        { agent: name, spendableSats: bal.spendableSatoshis, totalSats: bal.totalSatoshis, outputs: bal.spendableOutputs },
        "Agent wallet internal balance",
      );
    } catch (err) {
      log.warn({ agent: name, err: (err as Error).message }, "Could not query agent wallet balance");
    }
  }

  const arcUrl = process.env.TAAL_ARC_URL ?? "https://arc.taal.com";
  const arcApiKey = process.env.TAAL_ARC_API_KEY ?? "";
  const wocUrl = process.env.WOC_API_URL ?? "https://api.whatsonchain.com/v1/bsv/main";

  let directPay: DirectPaymentSender | null = null;
  if (arcApiKey) {
    directPay = new DirectPaymentSender(wocUrl, arcUrl, arcApiKey);
    directPay.registerKey("collector", process.env[config.collectorKeyEnv] ?? "");
    directPay.registerKey("analyst", process.env[config.analystKeyEnv] ?? "");
    directPay.registerKey("monitor", process.env[config.monitorKeyEnv] ?? "");
    log.info("Direct P2PKH payment sender initialised (bypasses ServerWallet for payments)");
  }

  function wrapWalletWithDirectPay<T extends { sendMessageBoxPayment(to: string, sats: number): Promise<any>; inscribeText(text: string): Promise<any> }>(
    wallet: T,
    senderLabel: string,
    recipientLabel: string,
  ): T {
    if (!directPay) return wallet;
    const dp = directPay;
    return new Proxy(wallet, {
      get(target, prop, receiver) {
        if (prop === "sendMessageBoxPayment") {
          return async (_to: string, sats: number) => {
            try {
              return await dp.sendPayment(senderLabel, recipientLabel, sats);
            } catch (err) {
              log.debug({ err: (err as Error).message, from: senderLabel, to: recipientLabel }, "Direct payment failed");
              throw err;
            }
          };
        }
        if (prop === "inscribeText") {
          return async (text: string) => {
            try {
              return await dp.inscribe(senderLabel, text);
            } catch (err) {
              log.debug({ err: (err as Error).message, from: senderLabel }, "Direct inscription failed");
              throw err;
            }
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  const wrappedMonitorWallet = wrapWalletWithDirectPay(monitorWallet, "monitor", "collector");
  const wrappedAnalystWallet = wrapWalletWithDirectPay(analystWallet, "analyst", "collector");

  const collector = new CollectorAgent(redis, db, config.trackedAircraft, activityPub);
  const analyst = new AnalystAgent(collector, activityPub, config.analysisIntervalMs);
  const monitor = new MonitorAgent(
    collector,
    activityPub,
    config.trackedAircraft,
    config.monitorIntervalMs,
  );

  await collector.start(collectorWallet);
  await activityPub.publishStatus("collector", "running");

  await analyst.start(wrappedAnalystWallet);
  await activityPub.publishStatus("analyst", "running");

  await monitor.start(wrappedMonitorWallet);
  await activityPub.publishStatus("monitor", "running");

  const metricsServer = createHttpServer((_req, res) => {
    registry
      .metrics()
      .then((metrics) => {
        res.writeHead(200, { "Content-Type": registry.contentType });
        res.end(metrics);
      })
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
  });
  metricsServer.listen(config.metricsPort, () => {
    log.info({ port: config.metricsPort }, "Agent metrics server listening");
  });

  // Re-broadcast agent status every 30s so late-connecting dashboards see "running"
  const STATUS_HEARTBEAT_MS = 30_000;
  const statusHeartbeat = setInterval(() => {
    void activityPub.publishStatus("collector", "running");
    void activityPub.publishStatus("analyst", "running");
    void activityPub.publishStatus("monitor", "running");
  }, STATUS_HEARTBEAT_MS);

  log.info(
    {
      collector: collectorWallet.getIdentityKey().slice(0, 16) + "...",
      analyst: analystWallet.getIdentityKey().slice(0, 16) + "...",
      monitor: monitorWallet.getIdentityKey().slice(0, 16) + "...",
      analysisInterval: config.analysisIntervalMs,
      monitorInterval: config.monitorIntervalMs,
      aircraft: config.trackedAircraft.length,
    },
    "Agent Marketplace fully operational — 3 agents running",
  );

  async function shutdown(signal: string): Promise<void> {
    log.info({ signal }, "Shutting down Agent Marketplace");

    clearInterval(statusHeartbeat);

    await monitor.stop();
    await analyst.stop();
    await collector.stop();

    metricsServer.close();

    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }

    await closeDb();
    log.info("Shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
