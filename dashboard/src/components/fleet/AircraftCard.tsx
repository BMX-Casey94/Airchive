"use client";

import { motion } from "framer-motion";
import clsx from "clsx";
import type { AircraftState } from "@/types/airchive";
import PhaseBadge from "@/components/ui/PhaseBadge";
import { fmtAltitude, fmtSpeed, fmtHeading, truncateTxid } from "@/lib/format";

interface AircraftCardProps {
  aircraft: AircraftState;
  selected: boolean;
  onClick: () => void;
}

export default function AircraftCard({
  aircraft,
  selected,
  onClick,
}: AircraftCardProps) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
      className={clsx(
        "relative w-full rounded-xl border p-3 text-left transition-colors",
        "bg-panel-bg/25 backdrop-blur-xl",
        selected
          ? "border-electric-cyan/60 shadow-glow-cyan"
          : "border-panel-border hover:border-muted-blue",
      )}
    >
      {/* Selected glow indicator */}
      {selected && (
        <div
          aria-hidden
          className="absolute inset-0 rounded-xl ring-1 ring-electric-cyan/30 pointer-events-none"
        />
      )}

      {/* Header: ICAO + Callsign */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[11px] text-hud-muted tabular-nums">
            {aircraft.icao.toUpperCase()}
          </span>
          <span className="font-mono text-sm text-white truncate">
            {aircraft.callsign || "—"}
          </span>
        </div>
        <PhaseBadge phase={aircraft.phase} />
      </div>

      {/* Aircraft type */}
      <p className="text-[11px] text-hud-muted mb-2 truncate">
        {aircraft.aircraft_type || "Unknown type"}
      </p>

      {/* Data readouts */}
      <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
        <Readout label="ALT" value={fmtAltitude(aircraft.alt_baro)} unit="ft" />
        <Readout label="GS" value={fmtSpeed(aircraft.gs)} unit="kts" />
        <Readout label="HDG" value={fmtHeading(aircraft.track)} />
      </div>

      {/* Last TxID */}
      {aircraft.last_txid && (
        <div className="mt-2 pt-2 border-t border-panel-border">
          <span className="hud-label">Last Tx</span>
          <p className="font-mono text-[10px] text-signal-green/80 tabular-nums mt-0.5">
            {truncateTxid(aircraft.last_txid)}
          </p>
        </div>
      )}
    </motion.button>
  );
}

function Readout({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-wider text-hud-muted">
        {label}
      </span>
      <span className="font-mono text-xs text-electric-cyan tabular-nums leading-tight">
        {value}
        {unit && (
          <span className="text-[8px] text-hud-muted ml-0.5">{unit}</span>
        )}
      </span>
    </div>
  );
}
