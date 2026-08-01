import { FlightPhase, type TelemetryRecord } from "@airchive/types";
import { insertSessionPositions, type NewSessionPosition } from "@airchive/db";
import { createLogger } from "@airchive/logger";
import type { Knex } from "knex";

const log = createLogger({ service: "ingestion" });

/**
 * Minimum spacing between stored points per phase. Turns and altitude changes
 * happen on the ground and near airports, so those phases sample densely;
 * cruise is close to a straight line and needs far fewer points. A two-hour
 * cruise stores ~480 rows; a whole flight typically lands well under 1,000.
 */
const SAMPLE_INTERVAL_MS: Record<FlightPhase, number> = {
  [FlightPhase.PARKED]: 60_000,
  [FlightPhase.TAXI]: 5_000,
  [FlightPhase.TAKEOFF]: 2_000,
  [FlightPhase.CLIMB]: 5_000,
  [FlightPhase.CRUISE]: 15_000,
  [FlightPhase.DESCENT]: 5_000,
  [FlightPhase.APPROACH]: 2_000,
  [FlightPhase.LANDING]: 2_000,
  [FlightPhase.TAXI_IN]: 5_000,
};

/** ~30 m in degrees of latitude; below this the aircraft has not visibly moved. */
const MIN_MOVE_DEG = 0.0003;
/** A stationary aircraft still gets a liveness point this often. */
const STATIONARY_INTERVAL_MS = 60_000;
const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_BATCH_SIZE = 500;
/** Requeue ceiling so a database outage cannot grow memory without bound. */
const MAX_RETAINED_ON_FAILURE = 2_000;

/**
 * Buffers downsampled positions for active flight sessions and batch-inserts
 * them into `session_positions`. Sampling is phase-aware and skips stationary
 * jitter, mirroring the write-rate controller's philosophy without touching
 * the on-chain write path.
 */
export class SessionPositionRecorder {
  private readonly db: Knex;

  private buffer: NewSessionPosition[] = [];

  private readonly lastSampleByIcao = new Map<
    string,
    { ts: number; lat: number; lon: number }
  >();

  private flushTimer: ReturnType<typeof setInterval> | null = null;

  private flushing = false;

  constructor(db: Knex) {
    this.db = db;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  /**
   * Consider one telemetry frame for persistence. `forced` bypasses the
   * sampling gate — used at phase transitions so the exact take-off, landing
   * and parked points are always part of the stored path.
   */
  record(
    flightId: string,
    phase: FlightPhase,
    record: TelemetryRecord,
    forced = false,
  ): void {
    const lat = record.lat;
    const lon = record.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (lat === 0 && lon === 0) return;

    const ts = Number.isFinite(record.ts) && record.ts > 0 ? record.ts : Date.now();
    const icao = record.icao.trim().toUpperCase();

    const last = this.lastSampleByIcao.get(icao);
    if (!forced && last) {
      const interval = SAMPLE_INTERVAL_MS[phase] ?? 15_000;
      if (ts - last.ts < interval) return;
      const moved =
        Math.abs(lat - last.lat) > MIN_MOVE_DEG
        || Math.abs(lon - last.lon) > MIN_MOVE_DEG;
      if (!moved && ts - last.ts < STATIONARY_INTERVAL_MS) return;
    }

    this.lastSampleByIcao.set(icao, { ts, lat, lon });
    this.buffer.push({
      flight_id: flightId,
      aircraft_icao: icao,
      ts,
      lat,
      lon,
      alt_baro: Number.isFinite(record.alt_baro) ? Math.round(record.alt_baro) : null,
      gs: Number.isFinite(record.gs) ? Math.round(record.gs) : null,
      track: Number.isFinite(record.track) ? Math.round(record.track) : null,
      phase,
    });

    if (this.buffer.length >= FLUSH_BATCH_SIZE) {
      void this.flush();
    }
  }

  /** Drop sampling state once a session closes so the next flight starts clean. */
  clearAircraft(icao: string): void {
    this.lastSampleByIcao.delete(icao.trim().toUpperCase());
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await insertSessionPositions(this.db, batch);
    } catch (err) {
      log.error(
        { err, points: batch.length },
        "Session position flush failed; requeueing",
      );
      this.buffer = [...batch, ...this.buffer].slice(-MAX_RETAINED_ON_FAILURE);
    } finally {
      this.flushing = false;
    }
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
