import type { TelemetryRecord } from "@airchive/types";

/**
 * Dedup exists to drop repeats of the same observation arriving from multiple
 * feeds — not to rate-limit. Thresholds sized for a stationary aircraft on a
 * stand discard real signal from one in flight, where a 20 ft drift or a 2 kt
 * speed trim is a genuine state change worth recording. Airborne aircraft
 * therefore get much tighter thresholds.
 */
interface DedupThresholds {
  latLonDeg: number;
  altitudeFt: number;
  groundSpeedKts: number;
}

const GROUND_THRESHOLDS: DedupThresholds = {
  latLonDeg: 0.0001,
  altitudeFt: 25,
  groundSpeedKts: 2,
};

const AIRBORNE_THRESHOLDS: DedupThresholds = {
  latLonDeg: 0.00002,
  altitudeFt: 10,
  groundSpeedKts: 1,
};

const MAX_SILENCE_MS = 60_000;

interface LastSeen {
  lat: number;
  lon: number;
  alt_baro: number;
  gs: number;
  on_ground: boolean;
  publishedAt: number;
}

export class DedupFilter {
  private readonly lastSeen = new Map<string, LastSeen>();

  shouldPublish(record: TelemetryRecord): boolean {
    const key = record.icao.toUpperCase();
    const prev = this.lastSeen.get(key);

    if (!prev) return true;

    const now = Date.now();
    if (now - prev.publishedAt >= MAX_SILENCE_MS) return true;

    if (record.on_ground !== prev.on_ground) return true;

    const thresholds = thresholdsFor(record, prev);
    const latDelta = Math.abs(record.lat - prev.lat);
    const lonDelta = Math.abs(record.lon - prev.lon);
    const altDelta = Math.abs(record.alt_baro - prev.alt_baro);
    const gsDelta = Math.abs(record.gs - prev.gs);

    if (
      latDelta <= thresholds.latLonDeg &&
      lonDelta <= thresholds.latLonDeg &&
      altDelta <= thresholds.altitudeFt &&
      gsDelta <= thresholds.groundSpeedKts
    ) {
      return false;
    }

    return true;
  }

  recordPublished(record: TelemetryRecord): void {
    const key = record.icao.toUpperCase();
    this.lastSeen.set(key, {
      lat: record.lat,
      lon: record.lon,
      alt_baro: record.alt_baro,
      gs: record.gs,
      on_ground: record.on_ground,
      publishedAt: Date.now(),
    });
  }
}

/**
 * Treats an aircraft as airborne if either the current or previous observation
 * says so, so the transition itself is never judged by ground thresholds.
 */
function thresholdsFor(record: TelemetryRecord, prev: LastSeen): DedupThresholds {
  const airborne = record.on_ground === false || prev.on_ground === false;
  return airborne ? AIRBORNE_THRESHOLDS : GROUND_THRESHOLDS;
}
