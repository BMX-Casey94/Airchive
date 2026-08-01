"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

/**
 * Below the sm breakpoint the dossier docks as a bottom sheet (sliding up)
 * instead of a right-hand rail (sliding in), so the map stays visible above
 * it on phones.
 */
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return narrow;
}

function formatNumber(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
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

function Chevron({ direction }: { direction: "up" | "down" }) {
  return (
    <svg
      viewBox="0 0 12 12"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path
        d={
          direction === "up"
            ? "M2.5 7.5 L6 4 L9.5 7.5"
            : "M2.5 4.5 L6 8 L9.5 4.5"
        }
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function FlightPanel({ sessions }: FlightPanelProps) {
  const isNarrow = useIsNarrow();
  /** Mobile-only: shrinks the bottom sheet to a title bar so the map shows. */
  const [collapsed, setCollapsed] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** The selection the scroll hint has already been shown for. */
  const hintShownFor = useRef<string | null>(null);
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

  // A new selection always reopens the sheet fully.
  useEffect(() => {
    setCollapsed(false);
  }, [selectedIcao]);

  // Brief bouncing-chevron cue that the sheet scrolls — shown once per
  // selection on mobile, after the spring-in has settled, and only when the
  // content actually overflows.
  useEffect(() => {
    if (!selectedIcao || !isNarrow || collapsed) return;
    if (hintShownFor.current === selectedIcao) return;

    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const measureTimer = setTimeout(() => {
      const el = scrollRef.current;
      if (!el || el.scrollHeight <= el.clientHeight + 12) return;
      hintShownFor.current = selectedIcao;
      setShowHint(true);
      hideTimer = setTimeout(() => setShowHint(false), 1_500);
    }, 350);

    return () => {
      clearTimeout(measureTimer);
      if (hideTimer) clearTimeout(hideTimer);
      setShowHint(false);
    };
  }, [selectedIcao, isNarrow, collapsed]);

  const phase = (aircraft?.phase ?? session?.phase ?? "UNKNOWN").toUpperCase();
  const phaseStyle = PHASE_STYLE[phase] ?? "text-hud-muted border-panel-border";

  const callsign =
    aircraft?.callsign ||
    telemetry?.callsign ||
    session?.callsign ||
    selectedIcao;
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
          initial={isNarrow ? { y: 360, opacity: 0 } : { x: 400, opacity: 0 }}
          animate={isNarrow ? { y: 0, opacity: 1 } : { x: 0, opacity: 1 }}
          exit={isNarrow ? { y: 360, opacity: 0 } : { x: 400, opacity: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 30 }}
          className="panel pointer-events-auto absolute inset-x-3 bottom-3 z-20 flex max-h-[58vh] flex-col overflow-hidden sm:inset-x-auto sm:bottom-4 sm:right-4 sm:top-16 sm:max-h-none sm:w-[340px] sm:max-w-[calc(100vw-2rem)]"
        >
          {isNarrow && collapsed ? (
            <div className="flex items-center gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <p className="min-w-0 flex-1 truncate font-mono text-base font-semibold tracking-wide text-white">
                {callsign}
              </p>
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[9px] tracking-widest ${phaseStyle}`}
              >
                {phase}
              </span>
              <button
                type="button"
                onClick={() => setCollapsed(false)}
                aria-label="Expand flight details"
                className="shrink-0 rounded-md border border-panel-border/50 px-2 py-1.5 text-hud-muted transition-colors hover:border-electric-cyan/50 hover:text-electric-cyan"
              >
                <Chevron direction="up" />
              </button>
              <button
                type="button"
                onClick={close}
                aria-label="Close flight details"
                className="shrink-0 rounded-md border border-panel-border/50 px-2 py-1 text-xs text-hud-muted transition-colors hover:border-electric-cyan/50 hover:text-electric-cyan"
              >
                ✕
              </button>
            </div>
          ) : (
            <>
              <div
                ref={scrollRef}
                onScroll={() => setShowHint(false)}
                className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:gap-4 sm:p-5"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-mono text-xl font-semibold tracking-wide text-white">
                      {callsign}
                    </p>
                    <p className="mt-0.5 text-xs text-hud-muted">
                      {[reg, acType].filter(Boolean).join(" · ") ||
                        selectedIcao}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setCollapsed(true)}
                      aria-label="Minimise flight details"
                      className="rounded-md border border-panel-border/50 px-2 py-1.5 text-hud-muted transition-colors hover:border-electric-cyan/50 hover:text-electric-cyan sm:hidden"
                    >
                      <Chevron direction="down" />
                    </button>
                    <button
                      type="button"
                      onClick={close}
                      aria-label="Close flight details"
                      className="rounded-md border border-panel-border/50 px-2 py-1 text-xs text-hud-muted transition-colors hover:border-electric-cyan/50 hover:text-electric-cyan"
                    >
                      ✕
                    </button>
                  </div>
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
                      <p className="data-readout text-base">
                        {originIcao ?? "————"}
                      </p>
                      <p className="truncate text-[10px] text-hud-muted">
                        {originName ?? "Origin unresolved"}
                      </p>
                    </div>
                    <span className="shrink-0 text-electric-cyan/70">➔</span>
                    <div className="min-w-0 text-right">
                      <p className="data-readout text-base">
                        {destIcao ?? "————"}
                      </p>
                      <p className="truncate text-[10px] text-hud-muted">
                        {destName ?? "Destination unresolved"}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <Stat
                    label="Altitude"
                    value={formatNumber(aircraft?.altBaro, " ft")}
                  />
                  <Stat
                    label="Ground speed"
                    value={formatNumber(aircraft?.gs, " kt")}
                  />
                  <Stat
                    label="Track"
                    value={formatNumber(aircraft?.track, "°")}
                  />
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
                    <p className="hud-label mb-1 text-[9px]">
                      Altitude profile
                    </p>
                    <div className="h-16">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart
                          data={chartData}
                          margin={{ top: 2, right: 0, bottom: 0, left: 0 }}
                        >
                          <defs>
                            <linearGradient
                              id="aeAlt"
                              x1="0"
                              y1="0"
                              x2="0"
                              y2="1"
                            >
                              <stop
                                offset="0%"
                                stopColor="#00F5FF"
                                stopOpacity={0.5}
                              />
                              <stop
                                offset="100%"
                                stopColor="#00F5FF"
                                stopOpacity={0.02}
                              />
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
              </div>

              <AnimatePresence>
                {showHint && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2"
                  >
                    <motion.div
                      animate={{ y: [0, 5, 0] }}
                      transition={{
                        duration: 0.7,
                        repeat: Infinity,
                        ease: "easeInOut",
                      }}
                      className="flex h-7 w-7 items-center justify-center rounded-full border border-electric-cyan/40 bg-space-black/85 text-electric-cyan shadow-[0_0_14px_rgba(0,245,255,0.3)]"
                    >
                      <Chevron direction="down" />
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
