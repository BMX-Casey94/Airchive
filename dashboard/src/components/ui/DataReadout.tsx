"use client";

import clsx from "clsx";

interface DataReadoutProps {
  label: string;
  value: string | number;
  unit?: string;
  /** Tailwind text colour class. Defaults to electric cyan. */
  colour?: string;
}

export default function DataReadout({
  label,
  value,
  unit,
  colour = "text-electric-cyan",
}: DataReadoutProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="hud-label">{label}</span>
      <div className="flex items-baseline gap-1">
        <span className={clsx("font-mono text-lg tabular-nums leading-none", colour)}>
          {value}
        </span>
        {unit && (
          <span className="text-[10px] uppercase tracking-wider text-hud-muted">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}
