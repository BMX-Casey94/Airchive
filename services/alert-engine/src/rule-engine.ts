import type { Knex } from "knex";
import {
  AlertSeverity,
  FlightPhase,
  isEmergencySquawk,
  type AlertRecord,
  type TelemetryRecord,
} from "@airchive/types";
import { insertAlert, type NewAlert } from "@airchive/db";
import { randomUUID } from "node:crypto";
import { PhaseAnomalyDetector } from "./phase-anomaly.js";

const LOW_ALT_PHASE_EXCLUSIONS = new Set<FlightPhase>([
  FlightPhase.TAKEOFF,
  FlightPhase.APPROACH,
  FlightPhase.LANDING,
]);

function normaliseIcao(icao: string): string {
  return icao.trim().toUpperCase();
}

export class AlertRuleEngine {
  private readonly phaseAnomaly = new PhaseAnomalyDetector();
  private readonly lastPhaseByIcao = new Map<string, FlightPhase>();

  constructor(private readonly db: Knex) {}

  async evaluate(
    record: TelemetryRecord,
    currentPhase: FlightPhase,
  ): Promise<AlertRecord[]> {
    const icao = normaliseIcao(record.icao);
    const previousPhase = this.lastPhaseByIcao.get(icao) ?? null;
    this.lastPhaseByIcao.set(icao, currentPhase);

    const candidates: Array<AlertRecord | null> = [
      this.ruleExtremeRoll(record),
      this.ruleRapidAltitudeLoss(record),
      this.ruleLowAltitude(record, currentPhase),
      this.ruleExcessiveSpeed(record),
      this.ruleEmergencySquawk(record),
      previousPhase !== null && previousPhase !== currentPhase
        ? this.phaseAnomaly.checkTransition(icao, previousPhase, currentPhase)
        : null,
    ];

    const triggered: AlertRecord[] = [];
    for (const c of candidates) {
      if (c !== null) triggered.push(c);
    }

    for (const alert of triggered) {
      await this.persist(alert);
    }

    return triggered;
  }

  private async persist(alert: AlertRecord): Promise<void> {
    const row: NewAlert = {
      id: alert.id,
      aircraft_icao: alert.aircraft_icao,
      flight_id: alert.flight_id,
      severity: alert.severity,
      type: alert.type,
      message: alert.message,
      data: alert.data,
    };
    await insertAlert(this.db, row);
  }

  private ruleExtremeRoll(record: TelemetryRecord): AlertRecord | null {
    if (record.on_ground) return null;
    const roll = record.roll;
    if (!Number.isFinite(roll) || Math.abs(roll) <= 45) return null;
    return this.buildAlert(record, {
      severity: AlertSeverity.CRITICAL,
      type: "EXTREME_ROLL",
      message: `Extreme roll angle ${roll.toFixed(1)}° detected whilst airborne`,
      data: { roll_deg: roll },
    });
  }

  private ruleRapidAltitudeLoss(record: TelemetryRecord): AlertRecord | null {
    const rate = record.baro_rate;
    if (!Number.isFinite(rate) || rate >= -4000) return null;
    return this.buildAlert(record, {
      severity: AlertSeverity.CRITICAL,
      type: "RAPID_ALTITUDE_LOSS",
      message: `Barometric rate of descent ${rate.toFixed(0)} ft/min exceeds threshold`,
      data: { baro_rate_ft_min: rate },
    });
  }

  private ruleLowAltitude(
    record: TelemetryRecord,
    phase: FlightPhase,
  ): AlertRecord | null {
    if (record.on_ground) return null;
    const alt = record.alt_baro;
    if (!Number.isFinite(alt) || alt >= 1000) return null;
    if (LOW_ALT_PHASE_EXCLUSIONS.has(phase)) return null;
    return this.buildAlert(record, {
      severity: AlertSeverity.WARNING,
      type: "LOW_ALTITUDE",
      message: `Low barometric altitude ${alt.toFixed(0)} ft outside expected flight phases`,
      data: { alt_baro_ft: alt, phase },
    });
  }

  private ruleExcessiveSpeed(record: TelemetryRecord): AlertRecord | null {
    const gs = record.gs;
    const alt = record.alt_baro;
    if (!Number.isFinite(gs) || !Number.isFinite(alt)) return null;
    if (alt >= 10_000 || gs <= 600) return null;
    return this.buildAlert(record, {
      severity: AlertSeverity.WARNING,
      type: "EXCESSIVE_SPEED",
      message: `Ground speed ${gs.toFixed(0)} kt exceeds limit below 10,000 ft`,
      data: { gs_kts: gs, alt_baro_ft: alt },
    });
  }

  private ruleEmergencySquawk(record: TelemetryRecord): AlertRecord | null {
    const code = record.squawk?.trim() ?? "";
    if (!isEmergencySquawk(code)) return null;
    return this.buildAlert(record, {
      severity: AlertSeverity.EMERGENCY,
      type: "EMERGENCY_SQUAWK",
      message: `Emergency transponder code ${code} active`,
      data: { squawk: code },
    });
  }

  private buildAlert(
    record: TelemetryRecord,
    partial: Omit<NewAlert, "aircraft_icao" | "flight_id" | "id"> & {
      flight_id?: string;
    },
  ): AlertRecord {
    const id = randomUUID();
    const now = new Date();
    return {
      id,
      aircraft_icao: normaliseIcao(record.icao),
      flight_id: partial.flight_id ?? record.flight_id,
      severity: partial.severity,
      type: partial.type,
      message: partial.message,
      data: partial.data,
      acknowledged: false,
      created_at: now,
    };
  }
}
