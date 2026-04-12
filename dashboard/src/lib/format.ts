/**
 * Formatting utilities for the Airchive dashboard.
 * UK English, imperial aviation units (feet, knots, nautical miles).
 */

import type { FlightPhase } from "@/types/dashboard";

/** Truncate a BSV TxID for display (first 8 + last 4 chars). */
export function truncateTxid(txid: string, head = 8, tail = 4): string {
  if (txid.length <= head + tail + 3) return txid;
  return `${txid.slice(0, head)}…${txid.slice(-tail)}`;
}

/** Alias for explorer pages (`truncateTxId`). */
export const truncateTxId = truncateTxid;

/** Full UK-style date/time for transaction and log rows. */
export function formatTimestamp(input: string | number | Date): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

const PHASE_LABEL: Record<FlightPhase, string> = {
  PARKED: "Parked",
  TAXI: "Taxi",
  TAKEOFF: "Take-off",
  CLIMB: "Climb",
  CRUISE: "Cruise",
  DESCENT: "Descent",
  APPROACH: "Approach",
  LANDING: "Landing",
  TAXI_IN: "Taxi in",
  UNKNOWN: "Unknown",
};

const PHASE_TEXT_CLASS: Record<FlightPhase, string> = {
  PARKED: "text-hud-muted",
  TAXI: "text-neon-amber",
  TAKEOFF: "text-signal-green",
  CLIMB: "text-signal-green",
  CRUISE: "text-electric-cyan",
  DESCENT: "text-neon-amber",
  APPROACH: "text-neon-amber",
  LANDING: "text-alert-red",
  TAXI_IN: "text-neon-amber",
  UNKNOWN: "text-hud-muted/80",
};

export function formatPhase(phase: FlightPhase): {
  label: string;
  colourClass: string;
} {
  return {
    label: PHASE_LABEL[phase] ?? phase,
    colourClass: PHASE_TEXT_CLASS[phase] ?? "text-hud-muted",
  };
}

/** Format altitude with thousands separator and "ft" unit. */
export function fmtAltitude(feet: number | null | undefined): string {
  if (feet == null) return "—";
  return `${feet.toLocaleString("en-GB")}`;
}

/** Format speed in knots. */
export function fmtSpeed(knots: number | null | undefined): string {
  if (knots == null) return "—";
  return `${Math.round(knots).toLocaleString("en-GB")}`;
}

/** Format Mach number to 3 decimal places. */
export function fmtMach(mach: number | null | undefined): string {
  if (mach == null || mach <= 0) return "—";
  return `M ${mach.toFixed(3)}`;
}

/** Format heading as 3-digit padded degrees. */
export function fmtHeading(degrees: number | null | undefined): string {
  if (degrees == null) return "—";
  return `${Math.round(degrees).toString().padStart(3, "0")}°`;
}

/** Format vertical rate with sign and colour hint. */
export function fmtVerticalRate(fpm: number | null | undefined): string {
  if (fpm == null) return "—";
  const sign = fpm >= 0 ? "+" : "";
  return `${sign}${Math.round(fpm).toLocaleString("en-GB")}`;
}

/** Format a timestamp (epoch ms) to HH:MM:SS. */
export function fmtTime(epochMs: number | string | null | undefined): string {
  const ms = typeof epochMs === "string" ? Number(epochMs) : epochMs;
  if (ms == null || Number.isNaN(ms)) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Format a timestamp to HH:MM:SS.mmm for precise log display. */
export function fmtTimePrecise(epochMs: number): string {
  const d = new Date(epochMs);
  const hms = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${hms}.${ms}`;
}

/** Format byte count to human-readable size. */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Format satoshis to readable sats count. */
export function fmtSats(sats: number): string {
  return `${sats.toLocaleString("en-GB")} sats`;
}

/** Relative time label: "5s ago", "2m ago", etc. */
export function fmtRelativeTime(epochMs: number): string {
  const delta = Math.max(0, Date.now() - epochMs);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Format wind direction and speed. */
export function fmtWind(
  dir: number | null | undefined,
  speed: number | null | undefined,
): string {
  if (dir == null || speed == null) return "—";
  return `${Math.round(dir).toString().padStart(3, "0")}° / ${Math.round(speed)} kts`;
}
