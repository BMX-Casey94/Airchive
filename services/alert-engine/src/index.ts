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

/** Alerts raised by other services and already persisted by them. */
const SYSTEM_ALERT_CHANNEL = "alerts";
/** Bounded so a long-running process cannot accumulate ids indefinitely. */
const DISPATCHED_ALERT_MEMORY = 500;

let running = true;

const dispatchedAlertIds = new Set<string>();

function rememberDispatched(id: string): boolean {
  if (dispatchedAlertIds.has(id)) return false;
  dispatchedAlertIds.add(id);
  if (dispatchedAlertIds.size > DISPATCHED_ALERT_MEMORY) {
    const oldest = dispatchedAlertIds.values().next().value;
    if (oldest !== undefined) dispatchedAlertIds.delete(oldest);
  }
  return true;
}

function parseExternalAlert(raw: string): AlertRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.message !== "string") return null;
  if (typeof rec.severity !== "string" || typeof rec.type !== "string") return null;

  return {
    id: rec.id,
    aircraft_icao:
      typeof rec.aircraft_icao === "string" ? rec.aircraft_icao : "SYSTEM",
    flight_id: typeof rec.flight_id === "string" ? rec.flight_id : undefined,
    severity: rec.severity as AlertRecord["severity"],
    type: rec.type,
    message: rec.message,
    data:
      rec.data !== null && typeof rec.data === "object"
        ? (rec.data as Record<string, unknown>)
        : {},
    acknowledged: false,
    created_at:
      typeof rec.created_at === "string" ? new Date(rec.created_at) : new Date(),
  };
}

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

  const channels: string[] = config.trackedAircraft.flatMap((icao) => {
    const u = icao.trim().toUpperCase();
    return [`telemetry:${u}`, `phase:${u}`];
  });
  // System-level alerts (treasury dry, recovery) are raised by other services
  // and persisted there; the engine owns dispatch so notification config lives
  // in exactly one place.
  channels.push(SYSTEM_ALERT_CHANNEL);

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
    if (channel === SYSTEM_ALERT_CHANNEL) {
      const alert = parseExternalAlert(message);
      // Already persisted by the publisher, so this is dispatch only.
      if (alert === null || !rememberDispatched(alert.id)) return;
      await n.notify(alert);
      return;
    }

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
