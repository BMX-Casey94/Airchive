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
const API_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000";

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
  ts?: number;
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
    walletAddress: (raw.wallet_address as string) || null,
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

const GLOBE_BATCH_INTERVAL_MS = 1_000;
const PRUNE_INTERVAL_MS = 60_000;
const STALE_AGE_MS = 300_000;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscriptionsRef = useRef<Set<string>>(new Set());
  const globeBatchRef = useRef<Map<string, Partial<GlobeAircraftState>>>(new Map());
  const globeFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchBusyRef = useRef({ metrics: false, fleet: false });

  const [connected, setConnected] = useState(false);

  const updateAircraft = useAircraftStore((s) => s.updateAircraft);
  const updateFleet = useAircraftStore((s) => s.updateFleet);
  const setWalletAddresses = useAircraftStore((s) => s.setWalletAddresses);
  const pushEntry = useBlockchainStore((s) => s.pushEntry);
  const setDailySummary = useBlockchainStore((s) => s.setDailySummary);
  const pushAlert = useAlertStore((s) => s.pushAlert);
  const bulkUpdateGlobe = useFleetStore((s) => s.bulkUpdate);
  const pushAgentEvent = useAgentStore((s) => s.pushEvent);

  const flushGlobeBatch = useCallback(() => {
    globeFlushTimer.current = null;
    const batch = globeBatchRef.current;
    if (batch.size === 0) return;
    const updates = Array.from(batch.entries());
    batch.clear();
    bulkUpdateGlobe(updates);
  }, [bulkUpdateGlobe]);

  const enqueueGlobeUpdate = useCallback(
    (icao: string, patch: Partial<GlobeAircraftState>) => {
      globeBatchRef.current.set(icao, patch);
      if (!globeFlushTimer.current) {
        globeFlushTimer.current = setTimeout(
          flushGlobeBatch,
          GLOBE_BATCH_INTERVAL_MS,
        );
      }
    },
    [flushGlobeBatch],
  );

  const sendMessage = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const backfillRecentTransactions = useCallback(() => {
    const setEntries = useBlockchainStore.getState().setEntries;
    const existingEntries = useBlockchainStore.getState().entries;
    fetch(`${API_URL}/api/transactions/recent?limit=50`)
      .then((r) => r.json())
      .then((json: { success: boolean; data?: BlockchainEntry[] }) => {
        if (json.success && json.data && json.data.length > 0) {
          const reversed = json.data.reverse();
          if (existingEntries.length === 0) {
            setEntries(reversed);
          } else {
            const existingTxids = new Set(existingEntries.map((e) => e.txid));
            const newEntries = reversed.filter((e) => !existingTxids.has(e.txid));
            if (newEntries.length > 0) {
              const merged = [...existingEntries, ...newEntries];
              setEntries(merged.slice(-200));
            }
          }
        }
      })
      .catch(() => {});
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

      backfillRecentTransactions();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as WsMessage;

        switch (msg.type) {
          case "telemetry": {
            const raw = msg.payload as RawTelemetry;
            updateAircraft(mapTelemetry(raw));
            enqueueGlobeUpdate(raw.icao, mapToGlobeState(raw));
            break;
          }
          case "telemetry_batch": {
            const batch = msg.payload as RawTelemetry[];
            updateFleet(batch.map(mapTelemetry));
            for (const raw of batch) {
              enqueueGlobeUpdate(raw.icao, mapToGlobeState(raw));
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
  }, [updateAircraft, updateFleet, pushEntry, setDailySummary, pushAlert, enqueueGlobeUpdate, pushAgentEvent, sendMessage, backfillRecentTransactions]);

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

    function fetchMetrics() {
      if (fetchBusyRef.current.metrics) return;
      fetchBusyRef.current.metrics = true;
      fetch(`${API_URL}/api/metrics`)
        .then((r) => r.json())
        .then((json: { success: boolean; data?: { transactions_today: number; bytes_on_chain_today: number; bsv_cost_today_sats: number; mined_today?: number; pending_today?: number; failed_today?: number; active_aircraft?: number; tx_per_second?: number } }) => {
          if (json.success && json.data) {
            setDailySummary({
              txCount: json.data.transactions_today,
              totalBytes: json.data.bytes_on_chain_today,
              totalSats: json.data.bsv_cost_today_sats,
              minedCount: json.data.mined_today ?? 0,
              pendingCount: json.data.pending_today ?? json.data.transactions_today,
              failedCount: json.data.failed_today ?? 0,
              trackedAircraftCount: json.data.active_aircraft ?? 0,
              txPerSecond: json.data.tx_per_second ?? 0,
            });
          }
        })
        .catch(() => {})
        .finally(() => { fetchBusyRef.current.metrics = false; });
    }

    fetchMetrics();

    function fetchFleetSnapshot() {
      if (fetchBusyRef.current.fleet) return;
      fetchBusyRef.current.fleet = true;
      fetch(`${API_URL}/api/fleet`)
        .then((r) => r.json())
        .then((json: { success: boolean; data?: RawTelemetry[] }) => {
          if (json.success && json.data) {
            updateFleet(json.data.map(mapTelemetry));
            const mapping: Record<string, string> = {};
            for (const ac of json.data) {
              if (typeof ac.wallet_address === "string" && ac.wallet_address) {
                mapping[ac.icao.toUpperCase()] = ac.wallet_address;
              }
            }
            if (Object.keys(mapping).length > 0) {
              setWalletAddresses(mapping);
            }
          }
        })
        .catch(() => {})
        .finally(() => { fetchBusyRef.current.fleet = false; });
    }

    fetchFleetSnapshot();
    const walletInterval = setInterval(fetchFleetSnapshot, 60_000);
    const metricsInterval = setInterval(fetchMetrics, 10_000);

    const pruneInterval = setInterval(() => {
      useAircraftStore.getState().pruneStale(STALE_AGE_MS);
      useFleetStore.getState().pruneStale(STALE_AGE_MS);
    }, PRUNE_INTERVAL_MS);

    return () => {
      clearInterval(metricsInterval);
      clearInterval(walletInterval);
      clearInterval(pruneInterval);
      if (globeFlushTimer.current) clearTimeout(globeFlushTimer.current);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect, setDailySummary, setWalletAddresses, updateFleet]);

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
