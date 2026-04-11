import type { TelemetryRecord } from "@airchive/types";

const LAT_LON_THRESHOLD = 0.0001;
const ALT_THRESHOLD_FT = 25;
const GS_THRESHOLD_KTS = 2;
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

    const latDelta = Math.abs(record.lat - prev.lat);
    const lonDelta = Math.abs(record.lon - prev.lon);
    const altDelta = Math.abs(record.alt_baro - prev.alt_baro);
    const gsDelta = Math.abs(record.gs - prev.gs);

    if (
      latDelta <= LAT_LON_THRESHOLD &&
      lonDelta <= LAT_LON_THRESHOLD &&
      altDelta <= ALT_THRESHOLD_FT &&
      gsDelta <= GS_THRESHOLD_KTS
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
