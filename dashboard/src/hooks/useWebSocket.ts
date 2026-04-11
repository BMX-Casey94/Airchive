"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAircraftStore } from "@/stores/aircraft-store";
import { useBlockchainStore } from "@/stores/blockchain-store";
import { useAlertStore } from "@/stores/alert-store";
import { useFleetStore } from "@/stores/fleet";
import { useAgentStore } from "@/stores/agent-store";
import type { AircraftTelemetry } from "@/stores/aircraft-store";
import type { AlertRecord, BlockchainEntry } from "@/types/airchive";
import type { AircraftState as GlobeAircraftState } from "@/types/dashboard";

/* ── Constants ────────────────────────────────────────────────── */

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4001";

/* ── Raw telemetry shape from the gateway ────────────────────── */

interface RawTelemetry {
  icao: string;
  callsign?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number;
  gs?: number;
  track?: number;
  baro_rate?: number;
  squawk?: string;
  on_ground?: boolean;
  flight_phase?: string;
  flight_id?: string;
  timestamp?: number;
  [key: string]: unknown;
}

function hasValidPosition(raw: RawTelemetry): boolean {
  return (
    raw.lat != null &&
    raw.lon != null &&
    !(raw.lat === 0 && raw.lon === 0)
  );
}

function mapTelemetry(raw: RawTelemetry): AircraftTelemetry {
  const validPos = hasValidPosition(raw);
  return {
    icao: raw.icao,
    callsign: raw.callsign?.trim() || null,
    reg: (raw.reg as string) || null,
    aircraftType: (raw.aircraft_type as string) || null,
    aircraftDesc: (raw.aircraft_desc as string) || null,
    category: (raw.category as string) || null,
    latitude: validPos ? raw.lat! : null,
    longitude: validPos ? raw.lon! : null,
    altitude: raw.alt_baro ?? null,
    altGeom: (raw.alt_geom as number) ?? null,
    groundSpeed: raw.gs ?? null,
    ias: (raw.ias as number) ?? null,
    tas: (raw.tas as number) ?? null,
    mach: (raw.mach as number) ?? null,
    heading: raw.track ?? null,
    trueHeading: (raw.true_heading as number) ?? null,
    magHeading: (raw.mag_heading as number) ?? null,
    verticalRate: raw.baro_rate ?? null,
    geomRate: (raw.geom_rate as number) ?? null,
    roll: (raw.roll as number) ?? null,
    squawk: raw.squawk ?? null,
    emergency: (raw.emergency as string) ?? "none",
    onGround: raw.on_ground ?? false,
    phase: ((raw.flight_phase as string) ?? "UNKNOWN").toUpperCase() as AircraftTelemetry["phase"],
    flightId: raw.flight_id ?? null,
    lastSeen: (raw.ts as number) ?? Date.now(),
    windDir: (raw.wind_dir as number) ?? null,
    windSpeed: (raw.wind_speed as number) ?? null,
    oat: (raw.oat as number) ?? null,
    tat: (raw.tat as number) ?? null,
    navQnh: (raw.nav_qnh as number) ?? null,
    navAltMcp: (raw.nav_alt_mcp as number) ?? null,
    navAltFms: (raw.nav_alt_fms as number) ?? null,
    navHeading: (raw.nav_heading as number) ?? null,
    navModes: (raw.nav_modes as string[]) ?? [],
    originIcao: (raw.origin_icao as string) || null,
    originName: (raw.origin_name as string) || null,
    destIcao: (raw.dest_icao as string) || null,
    destName: (raw.dest_name as string) || null,
  };
}

function mapToGlobeState(raw: RawTelemetry): Partial<GlobeAircraftState> {
  const validPos = hasValidPosition(raw);
  const patch: Partial<GlobeAircraftState> = {
    icao: raw.icao,
    callsign: raw.callsign?.trim() ?? "",
    reg: (raw.reg as string) ?? "",
    aircraftType: (raw.aircraft_type as string) ?? "",
    squawk: raw.squawk ?? "",
    altBaro: raw.alt_baro ?? 0,
    altGeom: (raw.alt_geom as number) ?? 0,
    onGround: raw.on_ground ?? false,
    gs: raw.gs ?? 0,
    ias: (raw.ias as number) ?? 0,
    tas: (raw.tas as number) ?? 0,
    track: raw.track ?? 0,
    trueHeading: (raw.true_heading as number) ?? 0,
    baroRate: raw.baro_rate ?? 0,
    emergency: ((raw.emergency as string) ?? "none") as GlobeAircraftState["emergency"],
    phase: ((raw.flight_phase as string) ?? "UNKNOWN").toUpperCase() as GlobeAircraftState["phase"],
    flightId: raw.flight_id,
    lastSeen: (raw.ts as number) ?? Date.now(),
  };
  if (validPos) {
    patch.lat = raw.lat!;
    patch.lon = raw.lon!;
  }
  return patch;
}
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/* ── Message Types ────────────────────────────────────────────── */

interface WsMessage {
  type:
    | "telemetry"
    | "telemetry_batch"
    | "tx_result"
    | "alert"
    | "daily_stats"
    | "agent_activity"
    | "pong";
  payload: unknown;
}

/* ── Hook ─────────────────────────────────────────────────────── */

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscriptionsRef = useRef<Set<string>>(new Set());

  const [connected, setConnected] = useState(false);

  const updateAircraft = useAircraftStore((s) => s.updateAircraft);
  const updateFleet = useAircraftStore((s) => s.updateFleet);
  const pushEntry = useBlockchainStore((s) => s.pushEntry);
  const setDailySummary = useBlockchainStore((s) => s.setDailySummary);
  const pushAlert = useAlertStore((s) => s.pushAlert);
  const updateGlobeAircraft = useFleetStore((s) => s.updateAircraft);
  const pushAgentEvent = useAgentStore((s) => s.pushEvent);

  const sendMessage = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      backoffRef.current = INITIAL_BACKOFF_MS;

      if (subscriptionsRef.current.size > 0) {
        sendMessage({
          type: "subscribe",
          icaos: Array.from(subscriptionsRef.current),
        });
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as WsMessage;

        switch (msg.type) {
          case "telemetry": {
            const raw = msg.payload as RawTelemetry;
            updateAircraft(mapTelemetry(raw));
            updateGlobeAircraft(raw.icao, mapToGlobeState(raw));
            break;
          }
          case "telemetry_batch": {
            const batch = msg.payload as RawTelemetry[];
            updateFleet(batch.map(mapTelemetry));
            for (const raw of batch) {
              updateGlobeAircraft(raw.icao, mapToGlobeState(raw));
            }
            break;
          }
          case "tx_result":
            pushEntry(msg.payload as BlockchainEntry);
            break;
          case "alert":
            pushAlert(msg.payload as AlertRecord);
            break;
          case "daily_stats": {
            const p = msg.payload as {
              txCountToday: number;
              bytesOnChainToday: number;
              bsvCostToday: number;
            };
            setDailySummary({
              txCount: p.txCountToday,
              totalBytes: p.bytesOnChainToday,
              totalSats: p.bsvCostToday,
            });
            break;
          }
          case "agent_activity":
            pushAgentEvent(msg.payload as import("@/stores/agent-store").AgentEvent);
            break;
          default:
            break;
        }
      } catch {
        /* discard malformed frames */
      }
    };

    ws.onclose = () => {
      setConnected(false);
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateAircraft, updateFleet, pushEntry, setDailySummary, pushAlert, updateGlobeAircraft, pushAgentEvent, sendMessage]);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);

    reconnectTimer.current = setTimeout(() => {
      backoffRef.current = Math.min(
        backoffRef.current * 2,
        MAX_BACKOFF_MS,
      );
      connect();
    }, backoffRef.current);
  }, [connect]);

  /* ── Lifecycle ────────────────────────────────────────────── */

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  /* ── Subscribe / Unsubscribe ──────────────────────────────── */

  const subscribe = useCallback(
    (icaos: string[]) => {
      for (const icao of icaos) subscriptionsRef.current.add(icao);
      sendMessage({ type: "subscribe", icaos });
    },
    [sendMessage],
  );

  const unsubscribe = useCallback(
    (icaos: string[]) => {
      for (const icao of icaos) subscriptionsRef.current.delete(icao);
      sendMessage({ type: "unsubscribe", icaos });
    },
    [sendMessage],
  );

  return { connected, subscribe, unsubscribe } as const;
}
