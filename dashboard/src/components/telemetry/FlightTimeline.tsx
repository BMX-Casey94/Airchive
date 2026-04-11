"use client";

import { useMemo } from "react";
import { clsx } from "clsx";
import { formatPhase } from "@/lib/format";
import type { PhaseSegment, FlightPhase } from "@/types/dashboard";

const PHASE_COLOUR: Record<FlightPhase, string> = {
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

const PHASE_GLOW: Record<FlightPhase, string> = {
  PARKED: "shadow-none",
  TAXI: "shadow-glow-amber",
  TAKEOFF: "shadow-glow-green",
  CLIMB: "shadow-glow-green",
  CRUISE: "shadow-glow-cyan",
  DESCENT: "shadow-glow-amber",
  APPROACH: "shadow-glow-amber",
  LANDING: "shadow-glow-red",
  TAXI_IN: "shadow-glow-amber",
  UNKNOWN: "shadow-none",
};

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1_000);
  if (totalSec < 60) return `${totalSec}s`;

  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;

  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

interface FlightTimelineProps {
  phases: PhaseSegment[];
  currentPhase?: FlightPhase;
}

export default function FlightTimeline({
  phases,
  currentPhase,
}: FlightTimelineProps) {
  const totalDuration = useMemo(
    () => phases.reduce((sum, p) => sum + p.durationMs, 0),
    [phases],
  );

  if (phases.length === 0) {
    return (
      <div className="panel p-4">
        <p className="hud-label">Flight Timeline</p>
        <p className="mt-2 text-sm text-hud-muted">
          No phase data available.
        </p>
      </div>
    );
  }

  return (
    <div className="panel p-4 space-y-3">
      <p className="hud-label">Flight Timeline</p>

      {/* ── Phase labels row ──────────────────────────────── */}
      <div className="flex" role="img" aria-label="Flight phase timeline">
        {phases.map((seg, i) => {
          const widthPercent =
            totalDuration > 0
              ? Math.max((seg.durationMs / totalDuration) * 100, 2)
              : 100 / phases.length;
          const display = formatPhase(seg.phase);
          const isCurrent = seg.phase === currentPhase && !seg.endTs;

          return (
            <div
              key={`${seg.phase}-${seg.startTs}-${i}`}
              className="flex flex-col items-center overflow-hidden"
              style={{ width: `${widthPercent}%` }}
            >
              <span
                className={clsx(
                  "text-[10px] font-mono truncate leading-tight mb-1",
                  display.colourClass,
                  isCurrent && "font-bold",
                )}
              >
                {display.label}
              </span>
            </div>
          );
        })}
      </div>

      {/* ── Coloured bar ──────────────────────────────────── */}
      <div className="flex h-3 rounded-full overflow-hidden bg-space-black border border-panel-border">
        {phases.map((seg, i) => {
          const widthPercent =
            totalDuration > 0
              ? Math.max((seg.durationMs / totalDuration) * 100, 2)
              : 100 / phases.length;
          const isCurrent = seg.phase === currentPhase && !seg.endTs;

          return (
            <div
              key={`bar-${seg.phase}-${seg.startTs}-${i}`}
              className={clsx(
                "h-full transition-all duration-300",
                PHASE_COLOUR[seg.phase],
                isCurrent && "animate-pulse-slow",
                isCurrent && PHASE_GLOW[seg.phase],
                i > 0 && "border-l border-space-black",
              )}
              style={{ width: `${widthPercent}%` }}
              title={`${formatPhase(seg.phase).label} — ${formatDuration(seg.durationMs)}`}
            />
          );
        })}
      </div>

      {/* ── Duration labels row ───────────────────────────── */}
      <div className="flex">
        {phases.map((seg, i) => {
          const widthPercent =
            totalDuration > 0
              ? Math.max((seg.durationMs / totalDuration) * 100, 2)
              : 100 / phases.length;

          return (
            <div
              key={`dur-${seg.phase}-${seg.startTs}-${i}`}
              className="flex justify-center overflow-hidden"
              style={{ width: `${widthPercent}%` }}
            >
              <span className="text-[9px] font-mono text-hud-muted truncate">
                {formatDuration(seg.durationMs)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
