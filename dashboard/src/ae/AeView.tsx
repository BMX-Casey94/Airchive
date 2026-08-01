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

function selectBoth(icao: string | null): void {
  useFleetStore.getState().selectAircraft(icao);
  useAircraftStore.getState().selectAircraft(icao);
}

export default function AeView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const deepLinkApplied = useRef(false);
  const [contextLost, setContextLost] = useState(false);
  const [utc, setUtc] = useState("--:--:--");

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
      engine.dispose();
    };
  }, []);

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
    <div className="fixed inset-0 overflow-hidden bg-[#02040a]">
      <div ref={containerRef} className="absolute inset-0" />

      {/* ── Top HUD ──────────────────────────────────────────── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-4 sm:p-5">
        <Link
          href="/"
          className="panel pointer-events-auto flex items-center gap-2 px-4 py-2 font-mono text-xs tracking-widest text-white transition-colors hover:text-electric-cyan"
        >
          <span aria-hidden className="text-electric-cyan">←</span>
          AIRCHIVE
        </Link>

        <div className="panel flex items-center gap-3 px-4 py-2 font-mono text-[11px] tracking-wider">
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
          <span className="text-panel-border">|</span>
          <span className="text-hud-muted">{utc} UTC</span>
        </div>
      </div>

      {/* ── Bottom-left legend ───────────────────────────────── */}
      <div className="pointer-events-none absolute bottom-4 left-4 z-10 select-none">
        <p className="hud-label">Azimuthal Equidistant · North Polar</p>
      </div>

      <FlightPanel sessions={sessions} />

      {/* ── WebGL context loss ───────────────────────────────── */}
      {contextLost && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#02040a]/90">
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
