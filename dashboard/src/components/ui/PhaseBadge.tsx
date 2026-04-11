"use client";

import clsx from "clsx";
import { FlightPhase } from "@/types/airchive";

interface PhaseBadgeProps {
  phase: FlightPhase;
}

const PHASE_STYLES: Record<FlightPhase, string> = {
  [FlightPhase.PARKED]:
    "bg-gray-600/30 text-gray-400 border-gray-500/40",
  [FlightPhase.TAXI]:
    "bg-neon-amber/15 text-neon-amber border-neon-amber/40",
  [FlightPhase.TAXI_IN]:
    "bg-neon-amber/15 text-neon-amber border-neon-amber/40",
  [FlightPhase.TAKEOFF]:
    "bg-electric-cyan/15 text-electric-cyan border-electric-cyan/40",
  [FlightPhase.LANDING]:
    "bg-electric-cyan/15 text-electric-cyan border-electric-cyan/40",
  [FlightPhase.CLIMB]:
    "bg-blue-500/15 text-blue-400 border-blue-400/40",
  [FlightPhase.DESCENT]:
    "bg-blue-500/15 text-blue-400 border-blue-400/40",
  [FlightPhase.APPROACH]:
    "bg-blue-500/15 text-blue-400 border-blue-400/40",
  [FlightPhase.CRUISE]:
    "bg-signal-green/15 text-signal-green border-signal-green/40",
};

export default function PhaseBadge({ phase }: PhaseBadgeProps) {
  const isEmergency = phase === ("EMERGENCY" as string);

  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full border px-2 py-0.5",
        "text-[10px] font-mono uppercase tracking-wider leading-none",
        isEmergency
          ? "bg-alert-red/20 text-alert-red border-alert-red/50 animate-pulse"
          : PHASE_STYLES[phase] ?? "bg-gray-600/30 text-gray-400 border-gray-500/40",
      )}
    >
      {phase.replace("_", " ")}
    </span>
  );
}
