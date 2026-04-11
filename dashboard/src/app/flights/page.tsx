"use client";

import { useState, useMemo, useCallback } from "react";
import Link from "next/link";
import useSWR from "swr";
import { clsx } from "clsx";
import { motion, AnimatePresence } from "framer-motion";
import { apiBaseUrl, fetcher } from "@/lib/api";
import { formatPhase } from "@/lib/format";
import type { CompletedFlight } from "@/types/dashboard";

const PHASE_BAR_COLOUR: Record<string, string> = {
  PARKED: "bg-muted-blue",
  TAXI: "bg-neon-amber",
  TAKEOFF: "bg-signal-green",
  CLIMB: "bg-signal-green",
  CRUISE: "bg-electric-cyan",
  DESCENT: "bg-neon-amber",
  APPROACH: "bg-neon-amber",
  LANDING: "bg-alert-red",
  TAXI_IN: "bg-neon-amber",
  UNKNOWN: "bg-muted-blue/50",
};

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function FlightCard({ flight }: { flight: CompletedFlight }) {
  const [expanded, setExpanded] = useState(false);

  const totalPhaseDuration = useMemo(
    () => flight.phases.reduce((s, p) => s + p.durationMs, 0),
    [flight.phases],
  );

  const costBsv = flight.totalSatsSpent / 1e8;

  return (
    <div className="panel overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left p-4 hover:bg-panel-bg/60 transition-colors"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <div className="flex flex-col items-center shrink-0">
              <span className="data-readout text-sm font-bold">
                {flight.callsign || flight.aircraftIcao}
              </span>
              <span className="text-[10px] text-hud-muted font-mono">
                {flight.aircraftIcao}
              </span>
            </div>
            <div className="h-8 w-px bg-panel-border" />
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="font-mono text-white truncate">
                {flight.originIcao ?? "???"}
              </span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4 shrink-0 text-electric-cyan"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13 7l5 5m0 0l-5 5m5-5H6"
                />
              </svg>
              <span className="font-mono text-white truncate">
                {flight.destIcao ?? "???"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-6 shrink-0">
            <div className="text-right">
              <p className="text-xs text-hud-muted">
                {formatDate(flight.startedAt)}
              </p>
              <p className="text-[10px] text-hud-muted font-mono">
                {formatTime(flight.startedAt)} — {formatTime(flight.endedAt)}
              </p>
            </div>
            <div className="text-right">
              <p className="data-readout text-sm">
                {formatDuration(flight.durationMin)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-neon-amber font-mono">
                {flight.totalTxCount.toLocaleString("en-GB")} tx
              </p>
            </div>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className={clsx(
                "h-4 w-4 text-hud-muted transition-transform",
                expanded && "rotate-180",
              )}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </div>
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-4 border-t border-panel-border pt-4">
              {/* ── Mini phase timeline ─────────────────────── */}
              {flight.phases.length > 0 && (
                <div className="space-y-2">
                  <p className="hud-label text-[9px]">Phase Timeline</p>
                  <div className="flex h-2.5 rounded-full overflow-hidden bg-space-black border border-panel-border">
                    {flight.phases.map((seg, i) => {
                      const pct =
                        totalPhaseDuration > 0
                          ? Math.max(
                              (seg.durationMs / totalPhaseDuration) * 100,
                              1.5,
                            )
                          : 100 / flight.phases.length;
                      return (
                        <div
                          key={`${seg.phase}-${i}`}
                          className={clsx(
                            "h-full",
                            PHASE_BAR_COLOUR[seg.phase] ?? "bg-muted-blue",
                            i > 0 && "border-l border-space-black",
                          )}
                          style={{ width: `${pct}%` }}
                          title={`${formatPhase(seg.phase).label} — ${Math.round(seg.durationMs / 60_000)}m`}
                        />
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {flight.phases.map((seg, i) => {
                      const display = formatPhase(seg.phase);
                      return (
                        <span
                          key={`label-${seg.phase}-${i}`}
                          className={clsx(
                            "text-[9px] font-mono",
                            display.colourClass,
                          )}
                        >
                          {display.label}{" "}
                          <span className="text-hud-muted">
                            {Math.round(seg.durationMs / 60_000)}m
                          </span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ── Cost breakdown ─────────────────────────── */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="hud-label text-[9px]">Duration</p>
                  <p className="data-readout text-sm">
                    {formatDuration(flight.durationMin)}
                  </p>
                </div>
                <div>
                  <p className="hud-label text-[9px]">Transactions</p>
                  <p className="font-mono text-sm text-neon-amber">
                    {flight.totalTxCount.toLocaleString("en-GB")}
                  </p>
                </div>
                <div>
                  <p className="hud-label text-[9px]">Cost (sats)</p>
                  <p className="data-readout text-sm">
                    {flight.totalSatsSpent.toLocaleString("en-GB")}
                  </p>
                </div>
                <div>
                  <p className="hud-label text-[9px]">Cost (BSV)</p>
                  <p className="font-mono text-sm text-signal-green">
                    {costBsv.toFixed(8)}
                  </p>
                </div>
              </div>

              {/* ── Link to explorer ───────────────────────── */}
              <div className="flex items-center gap-3">
                <Link
                  href={`/explorer/aircraft/${flight.aircraftIcao}`}
                  className="text-xs text-electric-cyan hover:text-white transition-colors underline underline-offset-2"
                >
                  View all transactions for {flight.aircraftIcao}
                </Link>
                {flight.originName && (
                  <span className="text-[10px] text-hud-muted">
                    From: {flight.originName}
                  </span>
                )}
                {flight.destName && (
                  <span className="text-[10px] text-hud-muted">
                    To: {flight.destName}
                  </span>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function FlightsPage() {
  const [search, setSearch] = useState("");
  const [aircraftFilter, setAircraftFilter] = useState("");

  const { data, error, isLoading } = useSWR<CompletedFlight[]>(
    `${apiBaseUrl}/api/flights?limit=100`,
    fetcher,
  );

  const filteredFlights = useMemo(() => {
    if (!data) return [];
    return data.filter((f) => {
      if (
        aircraftFilter &&
        f.aircraftIcao.toLowerCase() !== aircraftFilter.toLowerCase()
      ) {
        return false;
      }
      if (search) {
        const q = search.toLowerCase();
        return (
          f.callsign.toLowerCase().includes(q) ||
          f.aircraftIcao.toLowerCase().includes(q) ||
          f.originIcao?.toLowerCase().includes(q) ||
          f.destIcao?.toLowerCase().includes(q) ||
          f.originName?.toLowerCase().includes(q) ||
          f.destName?.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [data, search, aircraftFilter]);

  const uniqueAircraft = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.map((f) => f.aircraftIcao))].sort();
  }, [data]);

  return (
    <div className="min-h-screen bg-space-black p-6 space-y-6">
      {/* ── Header ────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-sm text-hud-muted hover:text-electric-cyan transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Dashboard
          </Link>
          <div>
            <h1 className="text-xl font-bold text-white">Flight History</h1>
            <p className="text-xs text-hud-muted">
              Completed flights with blockchain-backed records
            </p>
          </div>
        </div>
      </div>

      {/* ── Search / filter bar ───────────────────────────── */}
      <div className="panel p-4 flex flex-wrap items-end gap-4">
        <div className="space-y-1 flex-1 min-w-[200px]">
          <label className="text-[10px] text-hud-muted" htmlFor="flight-search">
            Search
          </label>
          <input
            id="flight-search"
            type="text"
            placeholder="Callsign, ICAO, airport…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="block w-full rounded-lg border border-panel-border bg-space-black px-3 py-1.5 text-xs font-mono text-white placeholder-hud-muted/50 focus:border-electric-cyan focus:outline-none focus:ring-1 focus:ring-electric-cyan/30"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] text-hud-muted" htmlFor="aircraft-filter">
            Aircraft
          </label>
          <select
            id="aircraft-filter"
            value={aircraftFilter}
            onChange={(e) => setAircraftFilter(e.target.value)}
            className="block w-40 rounded-lg border border-panel-border bg-space-black px-3 py-1.5 text-xs font-mono text-white focus:border-electric-cyan focus:outline-none focus:ring-1 focus:ring-electric-cyan/30"
          >
            <option value="">All aircraft</option>
            {uniqueAircraft.map((icao) => (
              <option key={icao} value={icao}>
                {icao.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
        {(search || aircraftFilter) && (
          <button
            onClick={() => {
              setSearch("");
              setAircraftFilter("");
            }}
            className="text-xs text-hud-muted hover:text-alert-red transition-colors pb-1.5"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* ── Flight list ───────────────────────────────────── */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="panel p-4 animate-pulse">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="h-5 w-16 rounded bg-panel-border" />
                  <div className="h-4 w-32 rounded bg-panel-border" />
                </div>
                <div className="flex items-center gap-4">
                  <div className="h-4 w-20 rounded bg-panel-border" />
                  <div className="h-4 w-12 rounded bg-panel-border" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="panel-alert p-8 text-center">
          <p className="text-sm text-alert-red">
            Failed to load flight history. Please try again.
          </p>
        </div>
      ) : filteredFlights.length > 0 ? (
        <div className="space-y-3">
          <p className="text-xs text-hud-muted font-mono">
            {filteredFlights.length} flight{filteredFlights.length !== 1 ? "s" : ""}
          </p>
          {filteredFlights.map((f) => (
            <FlightCard key={f.id} flight={f} />
          ))}
        </div>
      ) : (
        <div className="panel p-8 text-center">
          <p className="text-sm text-hud-muted">
            {data && data.length > 0
              ? "No flights match your search criteria."
              : "No completed flights recorded yet."}
          </p>
        </div>
      )}
    </div>
  );
}
