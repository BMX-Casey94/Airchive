import { Redis } from "ioredis";
import {
  FlightPhase,
  type AlertRecord,
  type PhaseTransition,
  type TelemetryRecord,
} from "@airchive/types";
import { closeDb, getDb, insertAlert, type NewAlert } from "@airchive/db";
import { createLogger } from "@airchive/logger";
import { FlightPhaseDetector } from "@airchive/flight-phase";
import { loadConfig } from "./config.js";
import { AlertRuleEngine } from "./rule-engine.js";
import { SignalLossMonitor } from "./signal-monitor.js";
import { PhaseAnomalyDetector } from "./phase-anomaly.js";
import { AlertNotifier } from "./notifier.js";

const log = createLogger({ service: "alert-engine" });

let running = true;

function toNewAlert(a: AlertRecord): NewAlert {
  return {
    id: a.id,
    aircraft_icao: a.aircraft_icao,
    flight_id: a.flight_id,
    severity: a.severity,
    type: a.type,
    message: a.message,
    data: a.data,
  };
}

function isFlightPhase(v: unknown): v is FlightPhase {
  return (
    typeof v === "string" &&
    (Object.values(FlightPhase) as string[]).includes(v)
  );
}

function parsePhasePayload(
  raw: string,
  tracked: ReadonlySet<string>,
): Pick<PhaseTransition, "aircraft_icao" | "from_phase" | "to_phase"> | null {
  let o: unknown;
  try {
    o = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (o === null || typeof o !== "object") return null;
  const rec = o as Record<string, unknown>;
  const icaoRaw =
    typeof rec.aircraft_icao === "string"
      ? rec.aircraft_icao
      : typeof rec.icao === "string"
        ? rec.icao
        : "";
  const icao = icaoRaw.trim().toUpperCase();
  if (!icao || !tracked.has(icao)) return null;
  if (!isFlightPhase(rec.from_phase) || !isFlightPhase(rec.to_phase)) {
    return null;
  }
  return {
    aircraft_icao: icao,
    from_phase: rec.from_phase,
    to_phase: rec.to_phase,
  };
}

function parseTelemetry(raw: string, tracked: ReadonlySet<string>): TelemetryRecord | null {
  let o: unknown;
  try {
    o = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (o === null || typeof o !== "object") return null;
  const rec = o as Partial<TelemetryRecord>;
  if (typeof rec.icao !== "string") return null;
  const icao = rec.icao.trim().toUpperCase();
  if (!tracked.has(icao)) return null;
  return o as TelemetryRecord;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.trackedAircraft.length === 0) {
    log.fatal("TRACKED_AIRCRAFT is empty — nothing to monitor");
    process.exit(1);
  }

  const tracked = new Set(config.trackedAircraft);
  const db = getDb();
  const phaseDetector = new FlightPhaseDetector();
  const ruleEngine = new AlertRuleEngine(db);
  const phaseAnomaly = new PhaseAnomalyDetector();
  const notifier = new AlertNotifier(log, config.notifications);
  const signalMonitor = new SignalLossMonitor(config.trackedAircraft);

  const redisOpts = {
    host: config.redis.host,
    port: config.redis.port,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      if (times > 10) return null;
      return Math.min(times * 500, 5000);
    },
  };

  const redis = new Redis(redisOpts);
  const subscriber = new Redis({ ...redisOpts });

  redis.on("error", (err: Error) => {
    log.error({ err: err.message }, "Redis client error");
  });
  subscriber.on("error", (err: Error) => {
    log.error({ err: err.message }, "Redis subscriber error");
  });

  await redis.connect();
  await subscriber.connect();

  const channels = config.trackedAircraft.flatMap((icao) => {
    const u = icao.trim().toUpperCase();
    return [`telemetry:${u}`, `phase:${u}`] as const;
  });

  await subscriber.subscribe(...channels);
  log.info(
    { channels: channels.length, aircraft: config.trackedAircraft },
    "Subscribed to telemetry and phase channels",
  );

  subscriber.on("message", (channel: string, message: string | Buffer) => {
    if (!running) return;
    const payload =
      typeof message === "string" ? message : message.toString("utf8");
    void handleRedisMessage(
      channel,
      payload,
      tracked,
      phaseDetector,
      ruleEngine,
      phaseAnomaly,
      notifier,
      db,
      signalMonitor,
    ).catch((err) => {
      log.error({ err, channel }, "Message handler failed");
    });
  });

  signalMonitor.start((alerts) => {
    if (!running || alerts.length === 0) return;
    void (async () => {
      for (const a of alerts) {
        try {
          await insertAlert(db, toNewAlert(a));
          await notifier.notify(a);
        } catch (err) {
          log.error({ err, alertId: a.id }, "Signal loss alert pipeline failed");
        }
      }
    })();
  });

  async function handleRedisMessage(
    channel: string,
    message: string,
    tr: ReadonlySet<string>,
    detector: FlightPhaseDetector,
    engine: AlertRuleEngine,
    anomaly: PhaseAnomalyDetector,
    n: AlertNotifier,
    database: typeof db,
    sig: SignalLossMonitor,
  ): Promise<void> {
    if (channel.startsWith("telemetry:")) {
      const record = parseTelemetry(message, tr);
      if (record === null) return;
      sig.recordSeen(record.icao);
      const phase = detector.update(record);
      const alerts = await engine.evaluate(record, phase);
      for (const a of alerts) {
        await n.notify(a);
      }
      return;
    }

    if (channel.startsWith("phase:")) {
      const payload = parsePhasePayload(message, tr);
      if (payload === null) return;
      const alert = anomaly.checkTransition(
        payload.aircraft_icao,
        payload.from_phase,
        payload.to_phase,
      );
      if (alert === null) return;
      await insertAlert(database, toNewAlert(alert));
      await n.notify(alert);
    }
  }

  async function shutdown(signal: string): Promise<void> {
    if (!running) return;
    running = false;
    log.info({ signal }, "Shutting down");
    signalMonitor.stop();
    await subscriber.quit().catch(() => {});
    await redis.quit().catch(() => {});
    await closeDb();
    process.exit(0);
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  log.info("Alert engine running");
}

void main().catch((err) => {
  log.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
