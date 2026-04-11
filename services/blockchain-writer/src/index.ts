import { createServer as createHttpServer } from "node:http";
import Redis from "ioredis";
import {
  RecordType,
  type FlightEventRecord,
  type TelemetryRecord,
} from "@airchive/types";
import { WalletVault } from "@airchive/crypto";
import { encodeTelemetryPayload, encodeFlightEventPayload } from "@airchive/telemetry-codec";
import {
  closeDb,
  getAllAircraft,
  getDb,
  insertTxResult,
  updateTxStatus,
  upsertAircraftConfig,
} from "@airchive/db";
import { createLogger } from "@airchive/logger";
import { loadConfig } from "./config.js";
import { ArcBroadcaster, type ArcCallbackPayload } from "./broadcaster.js";
import { UtxoManager } from "./utxo-manager.js";
import { AutoRefillMonitor } from "./auto-refill.js";
import { WriteBuffer } from "./write-buffer.js";
import { ConfirmationPoller } from "./confirmation-poller.js";
import { buildFlightEventTx, buildTelemetryTx } from "./tx-builder.js";
import { registry } from "./metrics.js";

const log = createLogger({ service: "blockchain-writer" });

const CONSOLIDATION_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const METRICS_PORT = Number(process.env.METRICS_PORT ?? "9091");

async function main(): Promise<void> {
  const config = loadConfig();
  log.info("Loading configuration");

  const vault = new WalletVault({ masterSeed: config.walletMasterSeed });

  const db = getDb();

  const dbAircraft = await getAllAircraft(db);
  const envIcaos = new Set(config.trackedAircraft);
  const fleetMap = new Map<string, { icao: string; wallet_index: number }>();

  for (const ac of dbAircraft) {
    fleetMap.set(ac.icao, { icao: ac.icao, wallet_index: ac.wallet_index });
    envIcaos.delete(ac.icao);
  }

  let autoIndex = dbAircraft.length > 0
    ? Math.max(...dbAircraft.map((a) => a.wallet_index)) + 1
    : 0;

  for (const icao of envIcaos) {
    if (!fleetMap.has(icao)) {
      fleetMap.set(icao, { icao, wallet_index: autoIndex++ });
    }
  }

  const fleet = Array.from(fleetMap.values());
  if (fleet.length === 0) {
    throw new Error("No aircraft configured. Set TRACKED_AIRCRAFT or populate aircraft_config table.");
  }

  for (const ac of fleet) {
    await upsertAircraftConfig(db, {
      icao: ac.icao,
      callsign: ac.icao,
      reg: "",
      aircraft_type: "",
      wallet_index: ac.wallet_index,
      enabled: true,
    });
  }
  log.info({ count: fleet.length }, "aircraft_config rows ensured");

  vault.registerFleet(fleet);
  log.info({ aircraft: fleet.map((a) => a.icao) }, "Fleet registered");

  const broadcaster = new ArcBroadcaster(config.arcUrl, config.arcApiKey);
  const utxoManager = new UtxoManager(db, config.wocApiUrl);
  const writeBuffer = new WriteBuffer(db, broadcaster, utxoManager, vault);
  const autoRefill = new AutoRefillMonitor(
    config,
    broadcaster,
    utxoManager,
    vault,
    fleet,
    config.refillIdleWindowMs,
  );

  log.info("Bootstrapping UTXO pools");
  for (const aircraft of fleet) {
    try {
      const address = vault.getAircraftAddress(aircraft.icao);
      await utxoManager.bootstrap(aircraft.icao, address);
    } catch (err) {
      log.error({ err, icao: aircraft.icao }, "UTXO bootstrap failed");
    }
    await new Promise((r) => setTimeout(r, 350));
  }

  await utxoManager.purgeSubThresholdUtxos();

  log.info("Running initial auto-refill check (force=true for bootstrap)");
  await autoRefill.checkAll(true).catch((err) =>
    log.error({ err }, "Initial auto-refill failed"),
  );

  broadcaster.on("status-update", (payload: ArcCallbackPayload) => {
    void handleArcCallback(payload);
  });

  async function handleArcCallback(payload: ArcCallbackPayload): Promise<void> {
    try {
      const status =
        payload.txStatus === "MINED" ? "MINED" as const : "SEEN_ON_NETWORK" as const;
      await updateTxStatus(
        db,
        payload.txid,
        status,
        payload.blockHeight,
        payload.merklePath,
      );
      log.debug(
        { txid: payload.txid, status: payload.txStatus },
        "TX status updated from ARC callback",
      );
    } catch (err) {
      log.error({ err, txid: payload.txid }, "ARC callback processing error");
    }
  }

  broadcaster.setupCallbackReceiver(config.arcCallbackPort);

  const publisher = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: config.redis.db,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
  });
  await publisher.connect();
  writeBuffer.setRedisPublisher(publisher);
  log.info("Redis publisher connected");

  const subscriber = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: config.redis.db,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
  });

  await subscriber.connect();
  log.info("Redis subscriber connected");

  const channels: string[] = [];
  for (const aircraft of fleet) {
    channels.push(`write:${aircraft.icao}`, `flight-event:${aircraft.icao}`);
  }
  await subscriber.subscribe(...channels);
  log.info({ channels: channels.length }, "Subscribed to Redis channels");

  subscriber.on("message", (channel: string, message: string) => {
    const sep = channel.indexOf(":");
    const prefix = channel.slice(0, sep);
    const icao = channel.slice(sep + 1);

    autoRefill.recordActivity(icao);

    if (prefix === "write") {
      void processTelemetryWrite(icao, message);
    } else if (prefix === "flight-event") {
      void processFlightEventWrite(icao, message);
    }
  });

  async function processTelemetryWrite(
    icao: string,
    raw: string,
  ): Promise<void> {
    let telemetry: TelemetryRecord;
    try {
      telemetry = JSON.parse(raw) as TelemetryRecord;
    } catch {
      log.error({ icao }, "Invalid telemetry JSON on write channel");
      return;
    }

    const privateKey = vault.getAircraftPrivateKey(icao);
    let utxo;

    try {
      utxo = await utxoManager.acquireUtxo(icao);
    } catch {
      autoRefill.requestRefill(icao);
      const payload = encodeTelemetryPayload(telemetry);
      await writeBuffer.buffer(icao, RecordType.TELEMETRY, payload, telemetry.flight_id);
      return;
    }

    try {
      const { tx, changeOutput } = await buildTelemetryTx({
        utxo,
        privateKey,
        telemetry,
        recordType: RecordType.TELEMETRY,
      });

      const result = await broadcaster.broadcast(tx, icao);

      if (result.status === "FAILED") {
        // UTXO was likely already spent on-chain (double-spend) — purge it
        await utxoManager.deleteStaleUtxo(utxo.txid, utxo.vout).catch(() => {});
        throw new Error("Broadcast returned FAILED");
      }

      const txid = result.txid;

      await utxoManager.recordSpend(
        utxo.txid,
        utxo.vout,
        txid,
        1,
        changeOutput.satoshis,
        changeOutput.lockingScript,
        icao,
      );

      const txResultRow = {
        txid,
        aircraft_icao: icao,
        record_type: RecordType.TELEMETRY,
        status: "SEEN_ON_NETWORK" as const,
        timestamp: Date.now(),
        fee_sats: Number(utxo.satoshis) - changeOutput.satoshis,
        size_bytes: tx.toBinary().length,
        flight_id: telemetry.flight_id,
      };
      await insertTxResult(db, txResultRow);
      await publisher.publish("txresult", JSON.stringify(txResultRow)).catch(() => {});
    } catch (err) {
      await utxoManager.releaseUtxo(utxo.txid, utxo.vout).catch(() => {});
      const payload = encodeTelemetryPayload(telemetry);
      await writeBuffer
        .buffer(icao, RecordType.TELEMETRY, payload, telemetry.flight_id)
        .catch(() => {});
      log.error({ err, icao }, "Telemetry write failed");
    }
  }

  async function processFlightEventWrite(
    icao: string,
    raw: string,
  ): Promise<void> {
    let event: FlightEventRecord;
    try {
      event = JSON.parse(raw) as FlightEventRecord;
    } catch {
      log.error({ icao }, "Invalid flight-event JSON");
      return;
    }

    const privateKey = vault.getAircraftPrivateKey(icao);
    let utxo;

    try {
      utxo = await utxoManager.acquireUtxo(icao);
    } catch {
      autoRefill.requestRefill(icao);
      const payload = encodeFlightEventPayload(event);
      await writeBuffer.buffer(icao, RecordType.FLIGHT_EVENT, payload, event.flight_id);
      return;
    }

    try {
      const { tx, changeOutput } = await buildFlightEventTx({
        utxo,
        privateKey,
        event,
      });

      const result = await broadcaster.broadcast(tx, icao);

      if (result.status === "FAILED") {
        await utxoManager.deleteStaleUtxo(utxo.txid, utxo.vout).catch(() => {});
        throw new Error("Broadcast returned FAILED");
      }

      const txid = result.txid;

      await utxoManager.recordSpend(
        utxo.txid,
        utxo.vout,
        txid,
        1,
        changeOutput.satoshis,
        changeOutput.lockingScript,
        icao,
      );

      const feResultRow = {
        txid,
        aircraft_icao: icao,
        record_type: RecordType.FLIGHT_EVENT,
        status: "SEEN_ON_NETWORK" as const,
        timestamp: Date.now(),
        fee_sats: Number(utxo.satoshis) - changeOutput.satoshis,
        size_bytes: tx.toBinary().length,
        flight_id: event.flight_id,
      };
      await insertTxResult(db, feResultRow);
      await publisher.publish("txresult", JSON.stringify(feResultRow)).catch(() => {});
    } catch (err) {
      await utxoManager.releaseUtxo(utxo.txid, utxo.vout).catch(() => {});
      const payload = encodeFlightEventPayload(event);
      await writeBuffer
        .buffer(icao, RecordType.FLIGHT_EVENT, payload, event.flight_id)
        .catch(() => {});
      log.error({ err, icao }, "Flight-event write failed");
    }
  }

  const consolidationInterval = setInterval(() => {
    void runConsolidation();
  }, CONSOLIDATION_INTERVAL_MS);

  async function runConsolidation(): Promise<void> {
    log.info("Running UTXO consolidation cycle");
    for (const aircraft of fleet) {
      try {
        const key = vault.getAircraftPrivateKey(aircraft.icao);
        await utxoManager.consolidate(
          aircraft.icao,
          key,
          broadcaster,
          config.consolidationThreshold,
        );
      } catch (err) {
        log.error({ err, icao: aircraft.icao }, "Consolidation error");
      }
    }
  }

  autoRefill.start();
  writeBuffer.startRetryLoop();

  const confirmationPoller = new ConfirmationPoller(db, config.wocApiUrl);
  confirmationPoller.start();

  startMetricsServer();

  function startMetricsServer(): void {
    const server = createHttpServer((_req, res) => {
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
    server.listen(METRICS_PORT, () => {
      log.info({ port: METRICS_PORT }, "Prometheus metrics server listening");
    });
  }

  async function shutdown(): Promise<void> {
    log.info("Graceful shutdown initiated");

    clearInterval(consolidationInterval);
    autoRefill.stop();
    writeBuffer.stopRetryLoop();
    confirmationPoller.stop();

    try {
      await subscriber.quit();
    } catch {
      subscriber.disconnect();
    }

    try {
      await publisher.quit();
    } catch {
      publisher.disconnect();
    }

    await broadcaster.closeCallbackReceiver();
    await closeDb();

    log.info("Shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  log.info(
    { aircraftCount: fleet.length },
    "Blockchain writer service started",
  );
}

main().catch((err) => {
  log.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
