import {
  FlightPhaseDetector,
  WriteRateController,
  isEmergencyCondition,
  getEmergencyDescription,
  type WriteRateOverrides,
} from "@airchive/flight-phase";
import {
  FlightPhase,
  normaliseCallsign,
  type FlightEventRecord,
  type FlightEventType,
  type FlightSession,
  type FlightStats,
  type PhaseTransition,
  type TelemetryRecord,
} from "@airchive/types";
import type { AirportLookup } from "@airchive/airports";
import { haversineDistanceMiles } from "@airchive/airports";
import { expireStaleFlightSessions, getSessionLastPositionTs } from "@airchive/db";
import { createLogger } from "@airchive/logger";
import { Redis } from "ioredis";
import type { Knex } from "knex";
import * as sessionManager from "./session-manager.js";
import { SessionPositionRecorder } from "./session-position-recorder.js";
import {
  phaseEngineMessagesTotal,
  phaseEngineWriteDecisionsTotal,
} from "./metrics.js";

const log = createLogger({ service: "ingestion" });

function normaliseIcao(icao: string): string {
  return icao.trim().toUpperCase();
}

/** Radius within which departures and arrivals are recorded at full rate. */
const AIRPORT_PROXIMITY_MILES = 10;
/**
 * Above this altitude an aircraft is overflying, not arriving. Without the
 * ceiling, cruise traffic over a busy region would sit permanently at 1 Hz.
 */
const AIRPORT_PROXIMITY_MAX_ALT_FT = 10_000;

/**
 * A TAKEOFF observed after this much telemetry silence is a new flight: the
 * previous session ended somewhere out of coverage and must not be continued,
 * or the new flight inherits the old flight's origin and path. Go-arounds and
 * touch-and-goes have continuous telemetry, so they are unaffected.
 */
const NEW_FLIGHT_GAP_MS = 30 * 60_000;
/**
 * Ceiling on how stale an open database session may be and still be resumed
 * for an aircraft picked up mid-air. Long enough to survive transoceanic
 * ADS-B coverage gaps within one flight; beyond it, a landing plus a new
 * departure is the likelier explanation, and an unresolved origin is far
 * better than a wrong one.
 */
const RESUME_MAX_GAP_MS = 3 * 60 * 60_000;
/**
 * Open sessions with no recorded position for this long are presumed to have
 * ended out of coverage. The sweep is what stops `flight_sessions` filling
 * with zombies that inflate the active count and get wrongly resumed days
 * later.
 */
const STALE_SESSION_AFTER_MS = 6 * 60 * 60_000;
const SESSION_SWEEP_INTERVAL_MS = 15 * 60_000;
/**
 * Destination resolution during APPROACH: below this altitude an airliner is
 * minutes from touchdown, so the nearest airport within the radius is almost
 * certainly where it is going. At the top of the approach band (10,000 ft)
 * the nearest field could still be an unrelated one under the descent path.
 */
const DEST_RESOLVE_MAX_ALT_FT = 6_000;
const DEST_RESOLVE_RADIUS_MILES = 12;
/**
 * Never resolve an origin airport from a position this high: a "take-off"
 * detected at altitude is a data artefact, and the nearest airport to it is
 * whatever happens to be overflown.
 */
const ORIGIN_RESOLVE_MAX_ALT_FT = 10_000;

const AIRBORNE_PHASES = new Set<FlightPhase>([
  FlightPhase.TAKEOFF,
  FlightPhase.CLIMB,
  FlightPhase.CRUISE,
  FlightPhase.DESCENT,
  FlightPhase.APPROACH,
  FlightPhase.LANDING,
]);

function headingDeg(record: TelemetryRecord): number {
  const t = record.track;
  if (Number.isFinite(t)) return Math.round(t) % 360;
  const m = record.mag_heading;
  if (Number.isFinite(m)) return Math.round(m) % 360;
  const th = record.true_heading;
  if (Number.isFinite(th)) return Math.round(th) % 360;
  return 0;
}

function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return "0m";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatDistanceMiles(miles: number): string {
  if (!Number.isFinite(miles) || miles < 0) return "0";
  return miles < 10 ? miles.toFixed(1) : String(Math.round(miles));
}

function startedAtMs(session: FlightSession): number {
  const d = session.started_at;
  if (d instanceof Date) return d.getTime();
  if (typeof d === "string") return Date.parse(d);
  return Date.now();
}

interface SessionAgg {
  sessionId: string;
  startTs: number;
  lastLat: number;
  lastLon: number;
  distanceMiles: number;
  maxAltFt: number;
  gsSum: number;
  gsCount: number;
  txCount: number;
}

export interface PhaseEngineOptions {
  redis: Redis;
  airportLookup: AirportLookup;
  db: Knex;
  writeRateOverrides?: WriteRateOverrides;
}

export class PhaseEngine {
  private readonly redis: Redis;

  private readonly airportLookup: AirportLookup;

  private readonly db: Knex;

  private readonly phaseDetector = new FlightPhaseDetector();

  private readonly writeRateController: WriteRateController;

  private readonly positionRecorder: SessionPositionRecorder;

  private readonly activeSessions = new Map<string, FlightSession>();

  private readonly sequenceCounters = new Map<string, number>();

  private readonly sessionAggs = new Map<string, SessionAgg>();

  /** Timestamp of each aircraft's previous telemetry frame, for gap detection. */
  private readonly lastFrameTsByIcao = new Map<string, number>();

  /** Airframes whose first-contact session resolution has already run. */
  private readonly sessionResolutionDone = new Set<string>();

  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  private subscriber: Redis | null = null;

  private subscribedChannels: string[] = [];

  private readonly processChainsByIcao = new Map<string, Promise<void>>();

  constructor(opts: PhaseEngineOptions) {
    this.redis = opts.redis;
    this.airportLookup = opts.airportLookup;
    this.db = opts.db;
    this.writeRateController = new WriteRateController(opts.writeRateOverrides);
    this.positionRecorder = new SessionPositionRecorder(opts.db);
  }

  async start(trackedAircraft: string[]): Promise<void> {
    if (this.subscriber) {
      log.warn("PhaseEngine.start called whilst already running");
      return;
    }

    const sub = this.redis.duplicate({
      lazyConnect: true,
      keepAlive: 10_000,
      retryStrategy: (times) => Math.min(times * 500, 5_000),
    });
    this.subscriber = sub;

    sub.on("error", (err) => {
      log.error({ err: err.message }, "PhaseEngine Redis subscriber error");
    });

    sub.on("reconnecting", (delayMs: number) => {
      log.warn({ delayMs }, "PhaseEngine Redis subscriber reconnecting");
    });

    sub.on("message", (channel, message) => {
      this.queueTelemetryMessage(channel, message);
    });

    const channels = trackedAircraft.map((icao) => `telemetry:${normaliseIcao(icao)}`);
    this.subscribedChannels = channels;

    try {
      if (sub.status !== "ready") {
        await sub.connect();
      }
      if (channels.length > 0) {
        await sub.subscribe(...channels);
      }
      log.info({ channels: channels.length }, "PhaseEngine subscribed to telemetry");
    } catch (err) {
      this.subscriber = null;
      this.subscribedChannels = [];
      sub.disconnect();
      throw err;
    }

    // Sweep immediately so a backlog of zombie sessions is cleared at deploy
    // time rather than on the first interval tick.
    this.sweepTimer = setInterval(() => {
      void this.sweepStaleSessions();
    }, SESSION_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
    void this.sweepStaleSessions();
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    await this.positionRecorder.stop().catch(() => {});
    const sub = this.subscriber;
    this.subscriber = null;
    this.processChainsByIcao.clear();
    if (!sub) return;

    try {
      if (this.subscribedChannels.length > 0) {
        await sub.unsubscribe(...this.subscribedChannels);
      }
      sub.removeAllListeners("message");
      await sub.quit();
    } catch (err) {
      log.warn({ err }, "PhaseEngine subscriber shutdown");
      sub.disconnect();
    }

    this.subscribedChannels = [];
  }

  private queueTelemetryMessage(channel: string, message: string): void {
    const prefix = "telemetry:";
    if (!channel.startsWith(prefix)) return;

    const icao = normaliseIcao(channel.slice(prefix.length));
    const previous = this.processChainsByIcao.get(icao) ?? Promise.resolve();
    let next: Promise<void>;
    next = previous
      .catch(() => {})
      .then(() => this.onTelemetryMessage(channel, message))
      .catch((err) => {
        log.error({ err, channel, icao }, "PhaseEngine message handler failed");
      })
      .finally(() => {
        if (this.processChainsByIcao.get(icao) === next) {
          this.processChainsByIcao.delete(icao);
        }
      });
    this.processChainsByIcao.set(icao, next);
  }

  private detectPhaseUpdate(
    record: TelemetryRecord,
  ): { phase: FlightPhase; transitions: PhaseTransition[] } {
    const detector = this.phaseDetector as FlightPhaseDetector & {
      updateWithTransitions?: (
        input: TelemetryRecord,
      ) => { phase: FlightPhase; transitions: PhaseTransition[] };
    };

    if (typeof detector.updateWithTransitions === "function") {
      return detector.updateWithTransitions(record);
    }

    const transitions: PhaseTransition[] = [];
    const icao = normaliseIcao(record.icao);
    const unsubscribe = this.phaseDetector.onTransition((transition) => {
      if (normaliseIcao(transition.aircraft_icao) === icao) {
        transitions.push(transition);
      }
    });

    try {
      const phase = this.phaseDetector.update(record);
      return { phase, transitions };
    } finally {
      unsubscribe();
    }
  }

  /**
   * True within {@link AIRPORT_PROXIMITY_MILES} of any airport. Only meaningful
   * at low altitude — an airliner at cruise passes over airports constantly and
   * must not be treated as arriving. Returns false when the airport database is
   * empty, leaving phase-based rates in charge.
   */
  private isNearAirport(record: TelemetryRecord): boolean {
    if (this.airportLookup.count === 0) return false;
    if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon)) return false;
    if (
      Number.isFinite(record.alt_baro)
      && record.alt_baro > AIRPORT_PROXIMITY_MAX_ALT_FT
      && record.on_ground !== true
    ) {
      return false;
    }

    const nearest = this.airportLookup.findNearest(
      record.lat,
      record.lon,
      AIRPORT_PROXIMITY_MILES,
    );
    if (!nearest) return false;

    return (
      haversineDistanceMiles(record.lat, record.lon, nearest.lat, nearest.lon)
      <= AIRPORT_PROXIMITY_MILES
    );
  }

  private async onTelemetryMessage(channel: string, message: string): Promise<void> {
    const prefix = "telemetry:";
    if (!channel.startsWith(prefix)) return;

    let record: TelemetryRecord;
    try {
      record = JSON.parse(message) as TelemetryRecord;
    } catch {
      log.warn({ channel }, "Discarding invalid telemetry JSON");
      return;
    }

    const icao = normaliseIcao(record.icao);
    const { phase, transitions } = this.detectPhaseUpdate(record);
    phaseEngineMessagesTotal.inc();

    for (const t of transitions) {
      await this.handlePhaseTransition(t);
    }

    // An aircraft first seen already airborne fires no phase transition (the
    // detector seeds its state silently), so transitions alone can never
    // adopt or create its session. Resolve once per airframe on first contact.
    if (!this.activeSessions.has(icao) && !this.sessionResolutionDone.has(icao)) {
      this.sessionResolutionDone.add(icao);
      await this.resolveSessionOnFirstContact(icao, phase, record);
    }

    const emergency = isEmergencyCondition(record);
    this.writeRateController.setEmergencyOverride(icao, emergency);
    if (emergency) {
      const desc = getEmergencyDescription(record);
      log.warn({ icao, desc }, "Emergency condition active; write interval overridden");
    }

    this.writeRateController.setProximityOverride(icao, this.isNearAirport(record));

    const trigger = this.writeRateController.getWriteTrigger(icao, phase, record);
    phaseEngineWriteDecisionsTotal.inc({
      phase,
      decision: trigger ?? "rate_limited",
    });
    if (trigger !== null) {
      const payload = JSON.stringify(record);
      await this.redis.publish(`write:${icao}`, payload);
      this.writeRateController.recordWrite(icao, phase, record);
      const session = this.activeSessions.get(icao);
      if (session) {
        await sessionManager.incrementTxCount(this.db, session.id);
        const agg = this.sessionAggs.get(icao);
        if (agg) agg.txCount += 1;
      }
    }

    const session = this.activeSessions.get(icao);
    if (session) {
      this.positionRecorder.record(session.id, phase, record);
      // On approach and low, the nearest airport is where this flight is
      // going — fill the destination now instead of waiting for touchdown.
      if (
        !session.dest_icao
        && phase === FlightPhase.APPROACH
        && Number.isFinite(record.alt_baro)
        && record.alt_baro < DEST_RESOLVE_MAX_ALT_FT
      ) {
        await this.maybeResolveDest(icao, session, record, DEST_RESOLVE_RADIUS_MILES);
      }
    }
    const enriched: Record<string, unknown> = {
      ...record,
      flight_phase: phase,
      flight_id: session?.id,
      origin_icao: session?.origin_icao,
      origin_name: session?.origin_name,
      dest_icao: session?.dest_icao,
      dest_name: session?.dest_name,
    };
    await this.redis.publish("broadcast", JSON.stringify(enriched));
    // The dashboard treats any `broadcast` as "this aircraft is live", but the
    // writer only ever saw the rate-limited `write:` channel. Publishing the
    // same liveness edge keeps refill's view of activity identical to the
    // operator's, so a visibly-flying aircraft can never be judged idle.
    await this.redis.publish("aircraft-activity", icao);
    this.accumulateTelemetry(icao, record);
    // Updated last, so during transition handling the map still holds the
    // previous frame's timestamp — that gap is what NEW_FLIGHT_GAP_MS tests.
    this.lastFrameTsByIcao.set(
      icao,
      Number.isFinite(record.ts) && record.ts > 0 ? record.ts : Date.now(),
    );
  }

  private accumulateTelemetry(icao: string, record: TelemetryRecord): void {
    const agg = this.sessionAggs.get(icao);
    if (!agg) return;

    const lat = record.lat;
    const lon = record.lon;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      if (Number.isFinite(agg.lastLat) && Number.isFinite(agg.lastLon)) {
        agg.distanceMiles += haversineDistanceMiles(agg.lastLat, agg.lastLon, lat, lon);
      }
      agg.lastLat = lat;
      agg.lastLon = lon;
    }

    const alt = record.alt_baro;
    if (Number.isFinite(alt) && alt > agg.maxAltFt) {
      agg.maxAltFt = alt;
    }

    const gs = record.gs;
    if (Number.isFinite(gs) && gs >= 0) {
      agg.gsSum += gs;
      agg.gsCount += 1;
    }
  }

  private nextEventSeq(icao: string): number {
    const key = normaliseIcao(icao);
    const n = (this.sequenceCounters.get(key) ?? 0) + 1;
    this.sequenceCounters.set(key, n);
    return n;
  }

  private buildPartialStats(icao: string, record: TelemetryRecord): FlightStats {
    const agg = this.sessionAggs.get(icao);
    const now = record.ts && Number.isFinite(record.ts) ? record.ts : Date.now();
    const startTs = agg?.startTs ?? now;
    const durationMin = Math.max(0, (now - startTs) / 60_000);
    const avgGs =
      agg && agg.gsCount > 0 ? agg.gsSum / agg.gsCount : Number.isFinite(record.gs) ? record.gs : 0;
    return {
      duration_min: durationMin,
      distance_miles: agg?.distanceMiles ?? 0,
      max_alt_ft: agg?.maxAltFt ?? (Number.isFinite(record.alt_baro) ? record.alt_baro : 0),
      avg_gs_kts: avgGs,
      total_tx_count: agg?.txCount ?? 0,
      total_bsv_sats: 0,
    };
  }

  private async resolveSessionStats(icao: string, record: TelemetryRecord): Promise<FlightStats> {
    const partial = this.buildPartialStats(icao, record);
    const row = await sessionManager.getActiveSession(this.db, icao);
    if (row) {
      partial.total_tx_count = row.total_tx_count;
      partial.total_bsv_sats = row.total_sats_spent;
    }
    return partial;
  }

  private generateFlightEvent(
    event: FlightEventType,
    record: TelemetryRecord,
    session: FlightSession | null,
    stats: FlightStats | undefined,
  ): FlightEventRecord {
    const icao = normaliseIcao(record.icao);
    const callsign = normaliseCallsign(record.callsign, icao) ?? icao;
    const reg = record.reg?.trim() || "";
    const acType = record.aircraft_type?.trim() || "unknown";
    const hdg = headingDeg(record);
    const alt = Number.isFinite(record.alt_baro) ? Math.round(record.alt_baro) : 0;
    const gs = Number.isFinite(record.gs) ? Math.round(record.gs) : 0;

    const nearest = this.airportLookup.findNearest(record.lat, record.lon, 15);
    const airportIcao = nearest?.icao_code;
    const airportName = nearest?.name;

    const flightId = session?.id ?? `orphan-${icao}`;

    let summary = "";

    switch (event) {
      case "TAXI_START": {
        const origin =
          session?.origin_name && session.origin_icao
            ? `${session.origin_name} (${session.origin_icao})`
            : airportName && airportIcao
              ? `${airportName} (${airportIcao})`
              : "unknown airfield";
        summary = `${callsign} (${reg}, ${acType}) taxiing at ${origin}, heading ${hdg}°, ${alt} ft baro, ${gs} kt groundspeed.`;
        break;
      }
      case "TAKEOFF": {
        const origin =
          session?.origin_name && session.origin_icao
            ? `${session.origin_name} (${session.origin_icao})`
            : airportName && airportIcao
              ? `${airportName} (${airportIcao})`
              : "departure point";
        const dest =
          session?.dest_name && session.dest_icao
            ? `${session.dest_name} (${session.dest_icao})`
            : null;
        const destPhrase = dest ? `heading to ${dest}` : "destination not yet known";
        summary = `${callsign} (${reg}, ${acType}) taking off from ${origin}, ${destPhrase}.`;
        break;
      }
      case "TOP_OF_CLIMB":
        summary = `${callsign} (${reg}) level at cruise: ${alt} ft baro, ${gs} kt, track ${hdg}°.`;
        break;
      case "TOP_OF_DESCENT":
        summary = `${callsign} (${reg}) top of descent: ${alt} ft baro, ${gs} kt, track ${hdg}°.`;
        break;
      case "LANDING": {
        const apt =
          airportName && airportIcao ? `${airportName} (${airportIcao})` : "destination";
        const st = stats;
        if (st) {
          summary = `${callsign} landed at ${apt}, flight duration so far: ${formatDuration(st.duration_min)}, distance flown: ${formatDistanceMiles(st.distance_miles)} miles, max altitude: ${Math.round(st.max_alt_ft)} ft.`;
        } else {
          summary = `${callsign} landing at ${apt}, ${alt} ft baro, ${gs} kt.`;
        }
        break;
      }
      case "PARKED": {
        const apt =
          airportName && airportIcao ? `${airportName} (${airportIcao})` : "stand";
        const st = stats;
        if (st) {
          summary = `${callsign} parked at ${apt}, flight duration: ${formatDuration(st.duration_min)}, distance: ${formatDistanceMiles(st.distance_miles)} miles, max altitude: ${Math.round(st.max_alt_ft)} ft.`;
        } else {
          summary = `${callsign} parked at ${apt}.`;
        }
        break;
      }
      default:
        summary = `${callsign} (${reg}) — ${event}`;
    }

    const destIcao = session?.dest_icao;
    const destName = session?.dest_name;

    return {
      type: "FLIGHT_EVENT",
      event,
      flight_id: flightId,
      icao,
      callsign,
      reg,
      summary,
      airport_icao: airportIcao,
      airport_name: airportName,
      destination_icao: destIcao,
      destination_name: destName,
      lat: record.lat,
      lon: record.lon,
      alt_baro: record.alt_baro,
      gs: record.gs,
      track: headingDeg(record),
      flight_stats: stats,
    };
  }

  private async publishFlightEvent(record: FlightEventRecord, icao: string): Promise<void> {
    this.nextEventSeq(icao);
    await this.redis.publish(`flight-event:${normaliseIcao(icao)}`, JSON.stringify(record));
  }

  private initSessionAgg(
    icao: string,
    sessionId: string,
    startTs: number,
    record: TelemetryRecord,
    initialTxCount = 0,
  ): void {
    const lat = record.lat;
    const lon = record.lon;
    this.sessionAggs.set(icao, {
      sessionId,
      startTs,
      lastLat: Number.isFinite(lat) ? lat : NaN,
      lastLon: Number.isFinite(lon) ? lon : NaN,
      distanceMiles: 0,
      maxAltFt: Number.isFinite(record.alt_baro) ? record.alt_baro : 0,
      gsSum: Number.isFinite(record.gs) && record.gs >= 0 ? record.gs : 0,
      gsCount: Number.isFinite(record.gs) && record.gs >= 0 ? 1 : 0,
      txCount: initialTxCount,
    });
  }

  /**
   * Resume an open database session only if it shows recent life. A session
   * whose last recorded position is older than `maxGapMs` is expired instead:
   * resuming it would attribute the new observation — and its origin and
   * path — to a flight that finished out of coverage.
   */
  private async adoptDbSession(
    icao: string,
    rec: TelemetryRecord,
    recTs: number,
    maxGapMs: number,
  ): Promise<FlightSession | null> {
    const dbSession = await sessionManager.getActiveSession(this.db, icao);
    if (!dbSession) return null;

    const lastMs =
      (await getSessionLastPositionTs(this.db, dbSession.id))
      ?? startedAtMs(dbSession);
    if (recTs - lastMs > maxGapMs) {
      await sessionManager.expireSession(this.db, dbSession, lastMs);
      log.info(
        {
          icao,
          sessionId: dbSession.id,
          gapMinutes: Math.round((recTs - lastMs) / 60_000),
        },
        "Open session too stale to resume; expired",
      );
      return null;
    }

    this.activeSessions.set(icao, dbSession);
    if (!this.sessionAggs.has(icao)) {
      this.initSessionAgg(
        icao,
        dbSession.id,
        startedAtMs(dbSession),
        rec,
        dbSession.total_tx_count,
      );
    }
    return dbSession;
  }

  /** Expire one session (backdating `ended_at`) and drop its runtime state. */
  private async retireSession(
    icao: string,
    session: FlightSession,
    lastActivityMs?: number,
  ): Promise<void> {
    const lastMs =
      lastActivityMs
      ?? (await getSessionLastPositionTs(this.db, session.id))
      ?? startedAtMs(session);
    await sessionManager.expireSession(this.db, session, lastMs);
    if (this.activeSessions.get(icao)?.id === session.id) {
      this.activeSessions.delete(icao);
      this.sessionAggs.delete(icao);
    }
    this.positionRecorder.clearAircraft(icao);
    log.info(
      { icao, sessionId: session.id, lastSeen: new Date(lastMs).toISOString() },
      "Retired stale flight session",
    );
  }

  /** Close whatever open session an aircraft still holds before a new departure. */
  private async retireLingering(icao: string): Promise<void> {
    const session =
      this.activeSessions.get(icao)
      ?? (await sessionManager.getActiveSession(this.db, icao));
    if (!session) return;
    await this.retireSession(icao, session, this.lastFrameTsByIcao.get(icao));
  }

  /**
   * One-time session decision when an aircraft first appears in coverage:
   * a recently-active open session resumes (ingestion restart, brief blip);
   * a stale one is expired rather than poisoning the new observation with a
   * previous flight's origin and path; and airborne aircraft left without a
   * usable session get a fresh origin-less one, so mid-ocean pickups still
   * record a path from here on.
   */
  private async resolveSessionOnFirstContact(
    icao: string,
    phase: FlightPhase,
    record: TelemetryRecord,
  ): Promise<void> {
    try {
      const recTs =
        Number.isFinite(record.ts) && record.ts > 0 ? record.ts : Date.now();
      const airborne = AIRBORNE_PHASES.has(phase);
      // On the ground, any open session is a finished flight unless it is
      // minutes old; in the air, tolerate the long gaps oceanic coverage
      // holes produce within a single flight.
      const maxGap = airborne ? RESUME_MAX_GAP_MS : NEW_FLIGHT_GAP_MS;

      let session = await this.adoptDbSession(icao, record, recTs, maxGap);
      if (!session && airborne) {
        session = await sessionManager.startAirborneSession(
          this.db,
          icao,
          normaliseCallsign(record.callsign, icao) ?? icao,
          phase,
        );
        this.activeSessions.set(icao, session);
        this.initSessionAgg(icao, session.id, recTs, record);
        this.positionRecorder.record(session.id, phase, record, true);
        log.info(
          { icao, sessionId: session.id, phase },
          "Started airborne session at first contact",
        );
      }
    } catch (err) {
      log.error({ err, icao }, "First-contact session resolution failed");
    }
  }

  /** Resolve an unset destination to the nearest airport, in DB and memory. */
  private async maybeResolveDest(
    icao: string,
    session: FlightSession,
    rec: TelemetryRecord,
    radiusMiles: number,
  ): Promise<void> {
    if (session.dest_icao) return;
    try {
      const nearest = this.airportLookup.findNearest(rec.lat, rec.lon, radiusMiles);
      if (!nearest) return;
      await sessionManager.updateSessionDest(
        this.db,
        session.id,
        nearest.icao_code,
        nearest.name,
      );
      session.dest_icao = nearest.icao_code;
      session.dest_name = nearest.name;
      this.activeSessions.set(icao, session);
      log.info(
        { icao, sessionId: session.id, dest: nearest.icao_code },
        "Destination resolved",
      );
    } catch (err) {
      log.warn({ err, icao }, "Destination resolution failed");
    }
  }

  /** Periodic close of open sessions that stopped showing life hours ago. */
  private async sweepStaleSessions(): Promise<void> {
    try {
      const expired = await expireStaleFlightSessions(
        this.db,
        Date.now() - STALE_SESSION_AFTER_MS,
      );
      if (expired.length === 0) return;
      for (const row of expired) {
        const icao = normaliseIcao(row.aircraft_icao);
        if (this.activeSessions.get(icao)?.id === row.id) {
          this.activeSessions.delete(icao);
          this.sessionAggs.delete(icao);
          this.positionRecorder.clearAircraft(icao);
        }
      }
      log.info({ expired: expired.length }, "Expired stale flight sessions");
    } catch (err) {
      log.error({ err }, "Stale session sweep failed");
    }
  }

  private async handlePhaseTransition(t: PhaseTransition): Promise<void> {
    const icao = normaliseIcao(t.aircraft_icao);
    const rec = t.telemetry;
    const { from_phase: from, to_phase: to } = t;
    const recTs = Number.isFinite(rec.ts) && rec.ts > 0 ? rec.ts : Date.now();

    try {
      if (from === FlightPhase.PARKED && to === FlightPhase.TAXI) {
        // A fresh departure is proof the previous flight is over. Any session
        // still open belongs to that flight and must not swallow this one —
        // that is how a Kuala Lumpur departure ends up labelled "London
        // Gatwick".
        await this.retireLingering(icao);
        const session = await sessionManager.startSession(
          this.db,
          icao,
          normaliseCallsign(rec.callsign, icao) ?? icao,
          this.airportLookup,
          rec.lat,
          rec.lon,
          FlightPhase.TAXI,
        );
        this.activeSessions.set(icao, session);
        this.initSessionAgg(icao, session.id, recTs, rec);
        this.positionRecorder.record(session.id, FlightPhase.TAXI, rec, true);
        const ev = this.generateFlightEvent("TAXI_START", rec, session, undefined);
        await this.publishFlightEvent(ev, icao);
        return;
      }

      let session: FlightSession | null = this.activeSessions.get(icao) ?? null;
      if (!session) {
        session = await this.adoptDbSession(icao, rec, recTs, RESUME_MAX_GAP_MS);
      }

      // A take-off after a long telemetry silence is a new flight: whatever
      // session we hold ended out of coverage. Retire it so the new flight
      // starts with its own origin and an empty path.
      if (to === FlightPhase.TAKEOFF && session) {
        const prevTs = this.lastFrameTsByIcao.get(icao);
        if (prevTs !== undefined && recTs - prevTs > NEW_FLIGHT_GAP_MS) {
          await this.retireSession(icao, session, prevTs);
          session = null;
        }
      }

      if (to === FlightPhase.TAKEOFF && !session) {
        const lowEnough =
          rec.on_ground === true
          || (Number.isFinite(rec.alt_baro) && rec.alt_baro < ORIGIN_RESOLVE_MAX_ALT_FT);
        session = lowEnough
          ? await sessionManager.startSession(
              this.db,
              icao,
              normaliseCallsign(rec.callsign, icao) ?? icao,
              this.airportLookup,
              rec.lat,
              rec.lon,
              FlightPhase.TAKEOFF,
            )
          : await sessionManager.startAirborneSession(
              this.db,
              icao,
              normaliseCallsign(rec.callsign, icao) ?? icao,
              FlightPhase.TAKEOFF,
            );
        this.activeSessions.set(icao, session);
        this.initSessionAgg(icao, session.id, recTs, rec);
      }

      // Coverage pickup mid-flight: record the rest of the journey under a
      // fresh session with an honestly-unresolved origin.
      if (!session && AIRBORNE_PHASES.has(to)) {
        session = await sessionManager.startAirborneSession(
          this.db,
          icao,
          normaliseCallsign(rec.callsign, icao) ?? icao,
          to,
        );
        this.activeSessions.set(icao, session);
        this.initSessionAgg(icao, session.id, recTs, rec);
        log.info(
          { icao, sessionId: session.id, phase: to },
          "Started airborne session for mid-flight coverage pickup",
        );
      }

      if (session) {
        await sessionManager.updateSessionPhase(this.db, session.id, to);
        const updated = { ...session, phase: to };
        this.activeSessions.set(icao, updated);
        // Phase boundaries are the points a stored path can least afford to
        // miss: they anchor take-off, landing and parked positions exactly.
        this.positionRecorder.record(session.id, to, rec, true);
      }

      if (to === FlightPhase.TAKEOFF && session) {
        const stats = await this.resolveSessionStats(icao, rec);
        const ev = this.generateFlightEvent("TAKEOFF", rec, session, stats);
        await this.publishFlightEvent(ev, icao);
      }

      if (to === FlightPhase.CRUISE && session) {
        const stats = await this.resolveSessionStats(icao, rec);
        const ev = this.generateFlightEvent("TOP_OF_CLIMB", rec, session, stats);
        await this.publishFlightEvent(ev, icao);
      }

      if (to === FlightPhase.DESCENT && session) {
        const stats = await this.resolveSessionStats(icao, rec);
        const ev = this.generateFlightEvent("TOP_OF_DESCENT", rec, session, stats);
        await this.publishFlightEvent(ev, icao);
      }

      if (to === FlightPhase.LANDING && session) {
        await this.maybeResolveDest(icao, session, rec, 15);
        const stats = await this.resolveSessionStats(icao, rec);
        const ev = this.generateFlightEvent("LANDING", rec, session, stats);
        await this.publishFlightEvent(ev, icao);
      }

      // Any arrival at PARKED ends the flight. Requiring the TAXI_IN→PARKED
      // edge specifically used to leave sessions open whenever an aircraft
      // went LANDING→PARKED directly (sparse telemetry, short taxi), which
      // was one of the ways zombie sessions accumulated.
      if (to === FlightPhase.PARKED && from !== FlightPhase.PARKED && session) {
        const stats = await this.resolveSessionStats(icao, rec);
        const finalStats: FlightStats = {
          ...stats,
          duration_min: Math.max(0, (recTs - startedAtMs(session)) / 60_000),
        };
        const fresh = await sessionManager.getActiveSession(this.db, icao);
        if (fresh) {
          finalStats.total_tx_count = fresh.total_tx_count;
          finalStats.total_bsv_sats = fresh.total_sats_spent;
        }
        const ev = this.generateFlightEvent("PARKED", rec, session, finalStats);
        await this.publishFlightEvent(ev, icao);
        await sessionManager.closeSession(this.db, session.id, finalStats);
        this.activeSessions.delete(icao);
        this.sessionAggs.delete(icao);
        this.writeRateController.reset(icao);
        this.positionRecorder.clearAircraft(icao);
        // Make the completed flight's tail durable promptly rather than on
        // the next timer tick, so /api/flights/:id/path is complete as soon
        // as the session closes.
        await this.positionRecorder.flush();
      }
    } catch (err) {
      log.error({ err, icao, from, to }, "Phase transition handling failed");
    }
  }
}
