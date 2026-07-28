import {
  type FlightPhase,
  DEFAULT_WRITE_RATES,
  MIN_WRITE_INTERVAL_MS,
  type TelemetryRecord,
} from "@airchive/types";
import { isEmergencyCondition } from "./emergency";

export type WriteRateOverrides = Partial<Record<FlightPhase, number>>;

/**
 * Thresholds at which a state change is significant enough to record
 * immediately rather than waiting for the next interval tick. A clock-driven
 * sampler will always miss the moment a manoeuvre starts; these catch it.
 */
export interface SignificantChangeThresholds {
  /** Heading change in degrees (shortest angular distance). */
  headingDeg: number;
  /** Barometric altitude change in feet. */
  altitudeFt: number;
  /** Vertical rate magnitude in feet per minute treated as a climb/descent. */
  verticalRateFpm: number;
}

export const DEFAULT_SIGNIFICANT_CHANGE: SignificantChangeThresholds = {
  headingDeg: 10,
  altitudeFt: 500,
  verticalRateFpm: 1_000,
};

/** The last values that were actually written, per aircraft. */
interface WrittenState {
  phase: FlightPhase;
  squawk: string;
  onGround: boolean;
  headingDeg: number;
  altitudeFt: number;
  /** Sign of the vertical rate once it exceeds the threshold: -1, 0 or 1. */
  verticalRateBand: number;
}

export class WriteRateController {
  private readonly lastWriteMs = new Map<string, number>();
  private readonly emergencyOverrides = new Set<string>();
  private readonly proximityOverrides = new Set<string>();
  private readonly writtenState = new Map<string, WrittenState>();
  private readonly rates: Record<FlightPhase, number>;
  private readonly thresholds: SignificantChangeThresholds;

  constructor(
    overrides?: WriteRateOverrides,
    thresholds?: Partial<SignificantChangeThresholds>,
  ) {
    this.rates = { ...DEFAULT_WRITE_RATES, ...overrides };
    this.thresholds = { ...DEFAULT_SIGNIFICANT_CHANGE, ...thresholds };
  }

  shouldWrite(icao: string, phase: FlightPhase, record: TelemetryRecord): boolean {
    const key = normaliseIcao(icao);
    const last = this.lastWriteMs.get(key);
    if (last === undefined) return true;

    // A significant state change is recorded the moment it is observed. The
    // interval only governs how often an otherwise unchanging aircraft is
    // sampled, so this never reduces fidelity — only adds to it.
    if (this.hasSignificantChange(key, phase, record)) return true;

    const interval = this.getIntervalMs(key, phase, record);
    return Date.now() - last >= interval;
  }

  /**
   * Why the next write would be emitted, for metrics and diagnostics.
   * Returns null when the write would be rate-limited.
   */
  getWriteTrigger(
    icao: string,
    phase: FlightPhase,
    record: TelemetryRecord,
  ): "first" | "event" | "interval" | null {
    const key = normaliseIcao(icao);
    if (!this.lastWriteMs.has(key)) return "first";
    if (this.hasSignificantChange(key, phase, record)) return "event";
    const interval = this.getIntervalMs(key, phase, record);
    const last = this.lastWriteMs.get(key)!;
    return Date.now() - last >= interval ? "interval" : null;
  }

  recordWrite(icao: string, phase?: FlightPhase, record?: TelemetryRecord): void {
    const key = normaliseIcao(icao);
    this.lastWriteMs.set(key, Date.now());
    if (phase !== undefined && record !== undefined) {
      this.writtenState.set(key, this.snapshot(phase, record));
    }
  }

  setEmergencyOverride(icao: string, active: boolean): void {
    const key = normaliseIcao(icao);
    if (active) this.emergencyOverrides.add(key);
    else this.emergencyOverrides.delete(key);
  }

  /**
   * Forces full-rate sampling near an airport. Departure and arrival are the
   * highest-value parts of a flight and phase detection lags the manoeuvre, so
   * proximity is a more reliable trigger than the phase alone.
   */
  setProximityOverride(icao: string, active: boolean): void {
    const key = normaliseIcao(icao);
    if (active) this.proximityOverrides.add(key);
    else this.proximityOverrides.delete(key);
  }

  getIntervalMs(icao: string, phase: FlightPhase, record?: TelemetryRecord): number {
    const key = normaliseIcao(icao);
    if (this.emergencyOverrides.has(key)) return MIN_WRITE_INTERVAL_MS;
    if (record !== undefined && isEmergencyCondition(record)) return MIN_WRITE_INTERVAL_MS;
    const base = this.rates[phase];
    const interval = Number.isFinite(base) ? base : MIN_WRITE_INTERVAL_MS;
    // Never slows an aircraft down — only raises the rate towards the floor.
    if (this.proximityOverrides.has(key)) {
      return Math.min(interval, MIN_WRITE_INTERVAL_MS);
    }
    return interval;
  }

  reset(icao: string): void {
    const key = normaliseIcao(icao);
    this.lastWriteMs.delete(key);
    this.emergencyOverrides.delete(key);
    this.proximityOverrides.delete(key);
    this.writtenState.delete(key);
  }

  private hasSignificantChange(
    key: string,
    phase: FlightPhase,
    record: TelemetryRecord,
  ): boolean {
    const previous = this.writtenState.get(key);
    // Nothing to compare against. The genuine first write is already handled by
    // the absent last-write timestamp, so fall through to the interval rather
    // than treating every tick as a change.
    if (!previous) return false;

    const current = this.snapshot(phase, record);

    if (current.phase !== previous.phase) return true;
    if (current.onGround !== previous.onGround) return true;
    if (current.squawk !== previous.squawk) return true;
    if (current.verticalRateBand !== previous.verticalRateBand) return true;

    if (
      Number.isFinite(current.headingDeg)
      && Number.isFinite(previous.headingDeg)
      && angularDeltaDeg(current.headingDeg, previous.headingDeg) >= this.thresholds.headingDeg
    ) {
      return true;
    }

    if (
      Number.isFinite(current.altitudeFt)
      && Number.isFinite(previous.altitudeFt)
      && Math.abs(current.altitudeFt - previous.altitudeFt) >= this.thresholds.altitudeFt
    ) {
      return true;
    }

    return false;
  }

  private snapshot(phase: FlightPhase, record: TelemetryRecord): WrittenState {
    return {
      phase,
      squawk: record.squawk ?? "",
      onGround: record.on_ground === true,
      headingDeg: headingOf(record),
      altitudeFt: record.alt_baro,
      verticalRateBand: verticalRateBand(record, this.thresholds.verticalRateFpm),
    };
  }
}

/** Prefers true heading, falling back through magnetic heading to ground track. */
function headingOf(record: TelemetryRecord): number {
  if (Number.isFinite(record.true_heading)) return record.true_heading;
  if (Number.isFinite(record.mag_heading)) return record.mag_heading;
  return record.track;
}

/** Barometric rate is authoritative; geometric rate is the fallback. */
function verticalRateBand(record: TelemetryRecord, thresholdFpm: number): number {
  const rate = Number.isFinite(record.baro_rate) && record.baro_rate !== 0
    ? record.baro_rate
    : record.geom_rate;
  if (!Number.isFinite(rate)) return 0;
  if (rate >= thresholdFpm) return 1;
  if (rate <= -thresholdFpm) return -1;
  return 0;
}

/** Shortest angular distance between two bearings, in degrees. */
function angularDeltaDeg(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function normaliseIcao(icao: string): string {
  return icao.trim().toUpperCase();
}
