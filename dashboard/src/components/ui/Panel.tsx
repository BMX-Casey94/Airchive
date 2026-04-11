"use client";

import { type ReactNode } from "react";
import clsx from "clsx";

interface PanelProps {
  title: string;
  children: ReactNode;
  className?: string;
  /** Optional element rendered in the top-right of the header (badge, button, etc.). */
  headerAction?: ReactNode;
}

export default function Panel({
  title,
  children,
  className,
  headerAction,
}: PanelProps) {
  return (
    <div
      className={clsx(
        "relative overflow-hidden rounded-xl border border-panel-border/40",
        "bg-panel-bg/30 backdrop-blur-xl shadow-glow-cyan",
        className,
      )}
    >
      {/* Scan-line overlay */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
      >
        <div className="absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-electric-cyan/20 to-transparent animate-scan-line" />
      </div>

      {/* Header */}
      <div className="relative z-20 flex items-center justify-between border-b border-panel-border/30 px-4 py-2.5">
        <h2 className="text-xs font-sans uppercase tracking-widest text-hud-muted select-none">
          {title}
        </h2>
        {headerAction && <div className="flex-shrink-0">{headerAction}</div>}
      </div>

      {/* Body */}
      <div className="relative z-20 p-4">{children}</div>
    </div>
  );
}
