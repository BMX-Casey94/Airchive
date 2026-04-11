import { AlertSeverity, type AlertRecord } from "@airchive/types";
import { randomUUID } from "node:crypto";

const WARNING_AFTER_MS = 30_000;
const CRITICAL_AFTER_MS = 120_000;
const CHECK_INTERVAL_MS = 10_000;

type SignalTier = "ok" | "warning" | "critical";

export class SignalLossMonitor {
  private readonly tracked: ReadonlySet<string>;
  private readonly lastSeen = new Map<string, number>();
  private readonly lastEmittedTier = new Map<string, SignalTier>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(trackedIcaos: string[]) {
    this.tracked = new Set(
      trackedIcaos.map((i) => i.trim().toUpperCase()).filter(Boolean),
    );
  }

  recordSeen(icao: string): void {
    const key = icao.trim().toUpperCase();
    this.lastSeen.set(key, Date.now());
    this.lastEmittedTier.set(key, "ok");
  }

  checkAll(): AlertRecord[] {
    const now = Date.now();
    const out: AlertRecord[] = [];

    for (const icao of this.tracked) {
      const seen = this.lastSeen.get(icao);
      if (seen === undefined) continue;

      const age = now - seen;
      let tier: SignalTier = "ok";
      if (age > CRITICAL_AFTER_MS) tier = "critical";
      else if (age > WARNING_AFTER_MS) tier = "warning";

      const prev = this.lastEmittedTier.get(icao) ?? "ok";
      if (tier === prev) continue;

      if (tier === "ok") {
        this.lastEmittedTier.set(icao, "ok");
        continue;
      }

      this.lastEmittedTier.set(icao, tier);

      const severity =
        tier === "critical" ? AlertSeverity.CRITICAL : AlertSeverity.WARNING;
      const id = randomUUID();
      const created_at = new Date();

      out.push({
        id,
        aircraft_icao: icao,
        severity,
        type: "SIGNAL_LOSS",
        message:
          tier === "critical"
            ? `Telemetry signal lost for more than ${CRITICAL_AFTER_MS / 1000} seconds`
            : `Telemetry signal stale for more than ${WARNING_AFTER_MS / 1000} seconds`,
        data: {
          seconds_since_last_message: Math.round(age / 1000),
          tier,
        },
        acknowledged: false,
        created_at,
      });
    }

    return out;
  }

  start(onTick: (alerts: AlertRecord[]) => void): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      onTick(this.checkAll());
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export { CHECK_INTERVAL_MS, WARNING_AFTER_MS, CRITICAL_AFTER_MS };
