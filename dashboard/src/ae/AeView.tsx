"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AeEngine } from "./engine/AeEngine";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useFleetStore } from "@/stores/fleet";
import { useAircraftStore } from "@/stores/aircraft-store";
import { loadPersistedTrails, persistTrails } from "@/lib/trail-persistence";
import { useActiveSessions } from "./useActiveSessions";
import FlightPanel from "./panel/FlightPanel";

/**
 * The /ae sandbox: one full-screen WebGL scene, one route back home, and the
 * flight dossier panel. Live data arrives through the same WebSocket hook and
 * Zustand stores as the rest of the dashboard — this component only bridges
 * store state into the imperative engine.
 */

const PERSIST_INTERVAL_MS = 10_000;
/** v2: absent keys default to dimmed; the old `ae-map-dim` key wrote "0" on first visit. */
const MAP_DIM_STORAGE_KEY = "ae-map-dim-v2";
const TORUS_DIM_STORAGE_KEY = "ae-torus-dim";

function selectBoth(icao: string | null): void {
  useFleetStore.getState().selectAircraft(icao);
  useAircraftStore.getState().selectAircraft(icao);
}

/** Absent keys default to dimmed (50%) so overlays stay readable first visit. */
function readPersistedDim(key: string): boolean {
  try {
    const v = window.localStorage.getItem(key);
    if (v === null) return true;
    return v === "1";
  } catch {
    return true;
  }
}

function persistDim(key: string, dimmed: boolean): void {
  try {
    window.localStorage.setItem(key, dimmed ? "1" : "0");
  } catch {
    // Storage unavailable (private mode); the toggle still works in-session.
  }
}

export default function AeView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<AeEngine | null>(null);
  const deepLinkApplied = useRef(false);
  const [contextLost, setContextLost] = useState(false);
  const [utc, setUtc] = useState("--:--:--");
  const [mapDimmed, setMapDimmed] = useState(() =>
    readPersistedDim(MAP_DIM_STORAGE_KEY),
  );
  const [torusDimmed, setTorusDimmed] = useState(() =>
    readPersistedDim(TORUS_DIM_STORAGE_KEY),
  );

  const { connected } = useWebSocket();
  const sessions = useActiveSessions();
  const trackedCount = useFleetStore((s) => s.aircraft.size);

  /* ── Engine lifecycle ─────────────────────────────────────── */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const engine = new AeEngine({
      container,
      onSelect: selectBoth,
      onContextLost: () => setContextLost(true),
    });
    engineRef.current = engine;
    if (process.env.NODE_ENV === "development") {
      // Dev-only escape hatch for scene inspection in headless smoke tests.
      const w = window as unknown as Record<string, unknown>;
      w.__aeEngine = engine;
      w.__fleetStore = useFleetStore;
    }

    const push = () => {
      const s = useFleetStore.getState();
      engine.syncData(s.aircraft, s.trails, s.selectedIcao);
    };
    push();
    const unsubscribe = useFleetStore.subscribe(push);

    return () => {
      unsubscribe();
      engineRef.current = null;
      engine.dispose();
    };
  }, []);

  /* ── Map / torus dim toggles ──────────────────────────────── */
  useEffect(() => {
    engineRef.current?.setMapDimmed(mapDimmed);
    persistDim(MAP_DIM_STORAGE_KEY, mapDimmed);
  }, [mapDimmed]);

  useEffect(() => {
    engineRef.current?.setTorusDimmed(torusDimmed);
    persistDim(TORUS_DIM_STORAGE_KEY, torusDimmed);
  }, [torusDimmed]);

  /* ── Trail persistence across reloads ─────────────────────── */
  useEffect(() => {
    let cancelled = false;
    void loadPersistedTrails().then((restored) => {
      if (!cancelled && restored.size > 0) {
        useFleetStore.getState().hydrateTrails(restored);
      }
    });
    const timer = setInterval(() => {
      void persistTrails(useFleetStore.getState().trails);
    }, PERSIST_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  /* ── Deep link: /ae?flight=<session-id> ───────────────────── */
  useEffect(() => {
    if (deepLinkApplied.current || sessions.length === 0) return;
    const flightId = new URLSearchParams(window.location.search).get("flight");
    if (!flightId) {
      deepLinkApplied.current = true;
      return;
    }
    const match = sessions.find((s) => s.id === flightId);
    if (match) {
      selectBoth(match.aircraftIcao.toUpperCase());
      deepLinkApplied.current = true;
    }
  }, [sessions]);

  /* ── UTC clock ────────────────────────────────────────────── */
  useEffect(() => {
    const tick = () => setUtc(new Date().toISOString().slice(11, 19));
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#010104]">
      <div ref={containerRef} className="absolute inset-0" />

      {/* ── Top HUD ──────────────────────────────────────────── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-3 sm:gap-3 sm:p-5">
        <Link
          href="/"
          className="panel pointer-events-auto flex items-center gap-2 px-3 py-2 font-mono text-xs tracking-widest text-white transition-colors hover:text-electric-cyan sm:px-4"
        >
          <span aria-hidden className="text-electric-cyan">←</span>
          AIRCHIVE
        </Link>

        <div className="panel flex items-center gap-2 px-3 py-2 font-mono text-[10px] tracking-wider sm:gap-3 sm:px-4 sm:text-[11px]">
          <span className="flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connected ? "bg-signal-green" : "bg-alert-red animate-pulse"
              }`}
            />
            <span className={connected ? "text-signal-green" : "text-alert-red"}>
              {connected ? "LIVE" : "OFFLINE"}
            </span>
          </span>
          <span className="text-panel-border">|</span>
          <span className="text-white">
            {sessions.length} ACTIVE · {trackedCount} TRACKED
          </span>
          <span className="hidden text-panel-border md:inline">|</span>
          <span className="hidden text-hud-muted md:inline">{utc} UTC</span>
        </div>
      </div>

      {/* ── Bottom-left: dim toggles + legend ────────────────── */}
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex select-none flex-col items-start gap-2 sm:bottom-4 sm:left-4">
        <div className="pointer-events-auto flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setMapDimmed((v) => !v)}
            aria-pressed={mapDimmed}
            aria-label="Dim the map to highlight aircraft"
            className={`panel px-3 py-1.5 font-mono text-[10px] tracking-widest transition-colors ${
              mapDimmed
                ? "border-electric-cyan/50 text-electric-cyan"
                : "text-hud-muted hover:text-white"
            }`}
          >
            MAP {mapDimmed ? "50%" : "100%"}
          </button>
          <button
            type="button"
            onClick={() => setTorusDimmed((v) => !v)}
            aria-pressed={torusDimmed}
            aria-label="Dim the toroidal field lines"
            className={`panel px-3 py-1.5 font-mono text-[10px] tracking-widest transition-colors ${
              torusDimmed
                ? "border-electric-cyan/50 text-electric-cyan"
                : "text-hud-muted hover:text-white"
            }`}
          >
            TORUS {torusDimmed ? "50%" : "100%"}
          </button>
        </div>
        <p className="hud-label">Azimuthal Equidistant · North Polar</p>
      </div>

      <FlightPanel sessions={sessions} />

      {/* ── WebGL context loss ───────────────────────────────── */}
      {contextLost && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#010104]/90">
          <div className="panel flex flex-col items-center gap-4 p-8 text-center">
            <p className="font-mono text-sm text-white">
              The graphics context was lost.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg border border-electric-cyan/40 px-4 py-2 font-mono text-xs tracking-widest text-electric-cyan transition-colors hover:bg-electric-cyan/10"
            >
              RELOAD VIEW
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
