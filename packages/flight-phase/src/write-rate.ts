import {
  type FlightPhase,
  DEFAULT_WRITE_RATES,
  type TelemetryRecord,
} from "@airchive/types";
import { isEmergencyCondition } from "./emergency";

export type WriteRateOverrides = Partial<Record<FlightPhase, number>>;

export class WriteRateController {
  private readonly lastWriteMs = new Map<string, number>();
  private readonly emergencyOverrides = new Set<string>();
  private readonly rates: Record<FlightPhase, number>;

  constructor(overrides?: WriteRateOverrides) {
    this.rates = { ...DEFAULT_WRITE_RATES, ...overrides };
  }

  shouldWrite(icao: string, phase: FlightPhase, record: TelemetryRecord): boolean {
    const key = normaliseIcao(icao);
    const now = Date.now();
    const interval = this.getIntervalMs(key, phase, record);
    const last = this.lastWriteMs.get(key);
    if (last === undefined) return true;
    return now - last >= interval;
  }

  recordWrite(icao: string): void {
    const key = normaliseIcao(icao);
    this.lastWriteMs.set(key, Date.now());
  }

  setEmergencyOverride(icao: string, active: boolean): void {
    const key = normaliseIcao(icao);
    if (active) this.emergencyOverrides.add(key);
    else this.emergencyOverrides.delete(key);
  }

  getIntervalMs(icao: string, phase: FlightPhase, record?: TelemetryRecord): number {
    const key = normaliseIcao(icao);
    if (this.emergencyOverrides.has(key)) return 1_000;
    if (record !== undefined && isEmergencyCondition(record)) return 1_000;
    const base = this.rates[phase];
    return Number.isFinite(base) ? base : 1_000;
  }

  reset(icao: string): void {
    const key = normaliseIcao(icao);
    this.lastWriteMs.delete(key);
    this.emergencyOverrides.delete(key);
  }
}

function normaliseIcao(icao: string): string {
  return icao.trim().toUpperCase();
}
