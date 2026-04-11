import {
  FlightPhaseDetector,
  WriteRateController,
  isEmergencyCondition,
  getEmergencyDescription,
} from "@airchive/flight-phase";
import {
  FlightPhase,
  type FlightEventRecord,
  type FlightEventType,
  type FlightSession,
  type FlightStats,
  type PhaseTransition,
  type TelemetryRecord,
} from "@airchive/types";
import type { AirportLookup } from "@airchive/airports";
import { haversineDistanceMiles } from "@airchive/airports";
import { createLogger } from "@airchive/logger";
import { Redis } from "ioredis";
import type { Knex } from "knex";
import * as sessionManager from "./session-manager.js";

const log = createLogger({ service: "ingestion" });

function normaliseIcao(icao: string): string {
  return icao.trim().toUpperCase();
}

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
}

export class PhaseEngine {
  private readonly redis: Redis;

  private readonly airportLookup: AirportLookup;

  private readonly db: Knex;

  private readonly phaseDetector = new FlightPhaseDetector();

  private readonly writeRateController = new WriteRateController();

  private readonly activeSessions = new Map<string, FlightSession>();

  private readonly sequenceCounters = new Map<string, number>();

  private readonly sessionAggs = new Map<string, SessionAgg>();

  private readonly transitionBuffer: PhaseTransition[] = [];

  private subscriber: Redis | null = null;

  private subscribedChannels: string[] = [];

  private processChain = Promise.resolve();

  private unsubTransition: (() => void) | null = null;

  constructor(opts: PhaseEngineOptions) {
    this.redis = opts.redis;
    this.airportLookup = opts.airportLookup;
    this.db = opts.db;
    this.unsubTransition = this.phaseDetector.onTransition((t) => {
      this.transitionBuffer.push(t);
    });
  }

  async start(trackedAircraft: string[]): Promise<void> {
    if (this.subscriber) {
      log.warn("PhaseEngine.start called whilst already running");
      return;
    }

    const sub = this.redis.duplicate();
    this.subscriber = sub;

    sub.on("error", (err) => {
      log.error({ err: err.message }, "PhaseEngine Redis subscriber error");
    });

    sub.on("message", (channel, message) => {
      this.processChain = this.processChain
        .then(() => this.onTelemetryMessage(channel, message))
        .catch((e) => log.error({ err: e, channel }, "PhaseEngine message handler failed"));
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
  }

  async stop(): Promise<void> {
    if (this.unsubTransition) {
      this.unsubTransition();
      this.unsubTransition = null;
    }

    const sub = this.subscriber;
    this.subscriber = null;
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
    this.transitionBuffer.length = 0;
    const phase = this.phaseDetector.update(record);
    const transitions = this.transitionBuffer.splice(0);

    for (const t of transitions) {
      await this.handlePhaseTransition(t);
    }

    const emergency = isEmergencyCondition(record);
    this.writeRateController.setEmergencyOverride(icao, emergency);
    if (emergency) {
      const desc = getEmergencyDescription(record);
      log.warn({ icao, desc }, "Emergency condition active; write interval overridden");
    }

    const allowWrite = this.writeRateController.shouldWrite(icao, phase, record);
    if (allowWrite) {
      const payload = JSON.stringify(record);
      await this.redis.publish(`write:${icao}`, payload);
      this.writeRateController.recordWrite(icao);
      const session = this.activeSessions.get(icao);
      if (session) {
        await sessionManager.incrementTxCount(this.db, session.id);
        const agg = this.sessionAggs.get(icao);
        if (agg) agg.txCount += 1;
      }
    }

    const session = this.activeSessions.get(icao);
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
    this.accumulateTelemetry(icao, record);
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
    const callsign = record.callsign?.trim() || icao;
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

  private async handlePhaseTransition(t: PhaseTransition): Promise<void> {
    const icao = normaliseIcao(t.aircraft_icao);
    const rec = t.telemetry;
    const { from_phase: from, to_phase: to } = t;

    try {
      if (from === FlightPhase.PARKED && to === FlightPhase.TAXI) {
        const session = await sessionManager.startSession(
          this.db,
          icao,
          rec.callsign?.trim() || icao,
          this.airportLookup,
          rec.lat,
          rec.lon,
          FlightPhase.TAXI,
        );
        this.activeSessions.set(icao, session);
        const ts = rec.ts && Number.isFinite(rec.ts) ? rec.ts : Date.now();
        this.initSessionAgg(icao, session.id, ts, rec);
        const ev = this.generateFlightEvent("TAXI_START", rec, session, undefined);
        await this.publishFlightEvent(ev, icao);
        return;
      }

      let session = this.activeSessions.get(icao) ?? (await sessionManager.getActiveSession(this.db, icao));
      if (session && !this.activeSessions.has(icao)) {
        this.activeSessions.set(icao, session);
        if (!this.sessionAggs.has(icao)) {
          this.initSessionAgg(icao, session.id, startedAtMs(session), rec, session.total_tx_count);
        }
      }

      if (to === FlightPhase.TAKEOFF && !session) {
        session = await sessionManager.startSession(
          this.db,
          icao,
          rec.callsign?.trim() || icao,
          this.airportLookup,
          rec.lat,
          rec.lon,
          FlightPhase.TAKEOFF,
        );
        this.activeSessions.set(icao, session);
        const ts = rec.ts && Number.isFinite(rec.ts) ? rec.ts : Date.now();
        this.initSessionAgg(icao, session.id, ts, rec);
      }

      if (session) {
        await sessionManager.updateSessionPhase(this.db, session.id, to);
        const updated = { ...session, phase: to };
        this.activeSessions.set(icao, updated);
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
        const nearest = this.airportLookup.findNearest(rec.lat, rec.lon, 15);
        if (nearest && !session.dest_icao) {
          await sessionManager.updateSessionDest(this.db, session.id, nearest.icao_code, nearest.name);
          session.dest_icao = nearest.icao_code;
          session.dest_name = nearest.name;
          this.activeSessions.set(icao, session);
        }
        const stats = await this.resolveSessionStats(icao, rec);
        const ev = this.generateFlightEvent("LANDING", rec, session, stats);
        await this.publishFlightEvent(ev, icao);
      }

      if (from === FlightPhase.TAXI_IN && to === FlightPhase.PARKED && session) {
        const stats = await this.resolveSessionStats(icao, rec);
        const endTs = rec.ts && Number.isFinite(rec.ts) ? rec.ts : Date.now();
        const finalStats: FlightStats = {
          ...stats,
          duration_min: Math.max(0, (endTs - startedAtMs(session)) / 60_000),
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
      }
    } catch (err) {
      log.error({ err, icao, from, to }, "Phase transition handling failed");
    }
  }
}
