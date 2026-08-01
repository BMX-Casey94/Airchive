"use client";

import { useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import { useFleetStore } from "@/stores/fleet";
import { useAircraftStore } from "@/stores/aircraft-store";
import { haversineMiles } from "../engine/projection";
import type { ActiveSessionDTO } from "../useActiveSessions";

/**
 * Slide-in dossier for the selected flight: identity, route, live telemetry,
 * distance flown, an altitude profile of the whole trail and the on-chain
 * session tallies. All figures come from the stores the rest of the dashboard
 * already maintains; the session row comes from /api/sessions/active.
 */

interface FlightPanelProps {
  sessions: ActiveSessionDTO[];
}

const PHASE_STYLE: Record<string, string> = {
  PARKED: "text-neon-amber border-neon-amber/40",
  TAXI: "text-neon-amber border-neon-amber/40",
  TAXI_IN: "text-neon-amber border-neon-amber/40",
  TAKEOFF: "text-electric-cyan border-electric-cyan/40",
  CLIMB: "text-electric-cyan border-electric-cyan/40",
  CRUISE: "text-signal-green border-signal-green/40",
  DESCENT: "text-electric-cyan border-electric-cyan/40",
  APPROACH: "text-electric-cyan border-electric-cyan/40",
  LANDING: "text-electric-cyan border-electric-cyan/40",
};

const MAX_CHART_POINTS = 200;

function formatNumber(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${Math.round(value).toLocaleString("en-GB")}${unit}`;
}

function formatDuration(startedAt: string): string {
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const mins = Math.floor(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-panel-border/40 bg-space-black/40 px-3 py-2">
      <p className="hud-label text-[9px]">{label}</p>
      <p className="data-readout mt-0.5 text-sm">{value}</p>
    </div>
  );
}

export default function FlightPanel({ sessions }: FlightPanelProps) {
  const selectedIcao = useFleetStore((s) => s.selectedIcao);
  const selectFleet = useFleetStore((s) => s.selectAircraft);
  const selectAircraft = useAircraftStore((s) => s.selectAircraft);
  const aircraft = useFleetStore((s) =>
    selectedIcao ? s.aircraft.get(selectedIcao) : undefined,
  );
  const telemetry = useAircraftStore((s) =>
    selectedIcao ? s.fleet.get(selectedIcao) : undefined,
  );
  const trail = useFleetStore((s) =>
    selectedIcao ? s.trails.get(selectedIcao) : undefined,
  );

  const session = useMemo(
    () =>
      selectedIcao
        ? sessions.find(
            (s) => s.aircraftIcao.toUpperCase() === selectedIcao.toUpperCase(),
          )
        : undefined,
    [sessions, selectedIcao],
  );

  const distanceMiles = useMemo(() => {
    if (!trail || trail.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < trail.length; i += 1) {
      const a = trail[i - 1]!;
      const b = trail[i]!;
      total += haversineMiles(a.lat, a.lon, b.lat, b.lon);
    }
    return total;
  }, [trail]);

  const chartData = useMemo(() => {
    if (!trail || trail.length < 2) return [];
    const stride = Math.max(1, Math.ceil(trail.length / MAX_CHART_POINTS));
    return trail
      .filter((_, i) => i % stride === 0 || i === trail.length - 1)
      .map((p) => ({ ts: p.ts, alt: Math.max(0, p.alt) }));
  }, [trail]);

  const close = () => {
    selectFleet(null);
    selectAircraft(null);
  };

  const phase = (aircraft?.phase ?? session?.phase ?? "UNKNOWN").toUpperCase();
  const phaseStyle = PHASE_STYLE[phase] ?? "text-hud-muted border-panel-border";

  const callsign =
    aircraft?.callsign || telemetry?.callsign || session?.callsign || selectedIcao;
  const reg = aircraft?.reg || telemetry?.reg || "";
  const acType = aircraft?.aircraftType || telemetry?.aircraftType || "";

  const originIcao = session?.originIcao ?? telemetry?.originIcao ?? null;
  const originName = session?.originName ?? telemetry?.originName ?? null;
  const destIcao = session?.destIcao ?? telemetry?.destIcao ?? null;
  const destName = session?.destName ?? telemetry?.destName ?? null;

  return (
    <AnimatePresence>
      {selectedIcao && (
        <motion.aside
          key={selectedIcao}
          initial={{ x: 400, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 400, opacity: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 30 }}
          className="panel pointer-events-auto absolute bottom-4 right-4 top-16 z-20 flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-4 overflow-y-auto p-5"
        >
          <div className="flex items-start justify-between">
            <div>
              <p className="font-mono text-xl font-semibold tracking-wide text-white">
                {callsign}
              </p>
              <p className="mt-0.5 text-xs text-hud-muted">
                {[reg, acType].filter(Boolean).join(" · ") || selectedIcao}
              </p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close flight details"
              className="rounded-md border border-panel-border/50 px-2 py-1 text-xs text-hud-muted transition-colors hover:border-electric-cyan/50 hover:text-electric-cyan"
            >
              ✕
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] tracking-widest ${phaseStyle}`}
            >
              {phase}
            </span>
            {session && (
              <span className="font-mono text-[10px] tracking-wider text-hud-muted">
                AIRBORNE {formatDuration(session.startedAt)}
              </span>
            )}
          </div>

          <div className="rounded-lg border border-panel-border/40 bg-space-black/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="data-readout text-base">{originIcao ?? "————"}</p>
                <p className="truncate text-[10px] text-hud-muted">
                  {originName ?? "Origin unresolved"}
                </p>
              </div>
              <span className="shrink-0 text-electric-cyan/70">➔</span>
              <div className="min-w-0 text-right">
                <p className="data-readout text-base">{destIcao ?? "————"}</p>
                <p className="truncate text-[10px] text-hud-muted">
                  {destName ?? "Destination unresolved"}
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Stat label="Altitude" value={formatNumber(aircraft?.altBaro, " ft")} />
            <Stat label="Ground speed" value={formatNumber(aircraft?.gs, " kt")} />
            <Stat label="Track" value={formatNumber(aircraft?.track, "°")} />
            <Stat
              label="Vertical rate"
              value={formatNumber(aircraft?.baroRate, " fpm")}
            />
          </div>

          <div className="rounded-lg border border-panel-border/40 bg-space-black/40 px-3 py-2">
            <div className="flex items-baseline justify-between">
              <p className="hud-label text-[9px]">Distance flown</p>
              <p className="text-[9px] text-hud-muted">
                {trail?.length ?? 0} points
              </p>
            </div>
            <p className="data-readout mt-0.5 text-sm">
              {distanceMiles < 10
                ? distanceMiles.toFixed(1)
                : Math.round(distanceMiles).toLocaleString("en-GB")}{" "}
              miles
            </p>
          </div>

          {chartData.length > 1 && (
            <div className="rounded-lg border border-panel-border/40 bg-space-black/40 p-3">
              <p className="hud-label mb-1 text-[9px]">Altitude profile</p>
              <div className="h-16">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="aeAlt" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#00F5FF" stopOpacity={0.5} />
                        <stop offset="100%" stopColor="#00F5FF" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <YAxis hide domain={[0, "dataMax"]} />
                    <Area
                      type="monotone"
                      dataKey="alt"
                      stroke="#00F5FF"
                      strokeWidth={1.5}
                      fill="url(#aeAlt)"
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {session && (
            <div className="grid grid-cols-2 gap-2">
              <Stat
                label="On-chain writes"
                value={session.totalTxCount.toLocaleString("en-GB")}
              />
              <Stat
                label="Sats spent"
                value={session.totalSatsSpent.toLocaleString("en-GB")}
              />
            </div>
          )}

          <a
            href={`/explorer/aircraft/${selectedIcao}`}
            className="mt-auto rounded-lg border border-electric-cyan/30 px-3 py-2 text-center font-mono text-xs tracking-widest text-electric-cyan transition-colors hover:border-electric-cyan/60 hover:bg-electric-cyan/10"
          >
            OPEN IN EXPLORER →
          </a>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
