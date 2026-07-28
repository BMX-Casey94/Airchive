"use client";

import { clsx } from "clsx";
import Link from "next/link";
import { useCallback, useState, type ReactNode } from "react";
import type { AircraftIdentity } from "@/hooks/useAircraftIdentity";

export const RECORD_TYPE_LABEL: Record<number, string> = {
  0x01: "Telemetry",
  0x02: "Flight Event",
  0x03: "Telemetry Delta",
  0x04: "Agent Record",
  0x05: "Agent Record",
};

export function recordTypeLabel(recordType: number): string {
  return (
    RECORD_TYPE_LABEL[recordType]
    ?? `0x${recordType.toString(16).padStart(2, "0")}`
  );
}

const RECORD_TYPE_ACCENT: Record<number, string> = {
  0x01: "border-electric-cyan/30 text-electric-cyan/90",
  0x02: "border-neon-amber/30 text-neon-amber/90",
  0x03: "border-electric-cyan/20 text-electric-cyan/70",
  0x04: "border-signal-green/30 text-signal-green/90",
  0x05: "border-signal-green/30 text-signal-green/90",
};

export function RecordTypeChip({ recordType }: { recordType: number }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded border px-2 py-0.5 font-mono text-[10px] whitespace-nowrap",
        RECORD_TYPE_ACCENT[recordType] ?? "border-panel-border text-hud-muted",
      )}
    >
      {recordTypeLabel(recordType)}
    </span>
  );
}

const STATUS_COPY: Record<string, string> = {
  MINED: "Confirmed",
  SEEN_ON_NETWORK: "Broadcast",
  FAILED: "Failed",
};

export function TxStatusBadge({
  status,
  size = "sm",
}: {
  status: string;
  size?: "sm" | "md";
}) {
  const tone =
    status === "MINED"
      ? "border-signal-green/40 bg-signal-green/10 text-signal-green"
      : status === "SEEN_ON_NETWORK"
        ? "border-neon-amber/40 bg-neon-amber/10 text-neon-amber"
        : "border-alert-red/40 bg-alert-red/10 text-alert-red";

  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border font-mono whitespace-nowrap",
        tone,
        size === "md" ? "px-3 py-1 text-xs" : "px-2 py-0.5 text-[10px]",
      )}
    >
      <span
        className={clsx(
          "h-1.5 w-1.5 rounded-full",
          status === "MINED"
            ? "bg-signal-green"
            : status === "SEEN_ON_NETWORK"
              ? "bg-neon-amber animate-pulse"
              : "bg-alert-red",
        )}
      />
      {STATUS_COPY[status] ?? status}
    </span>
  );
}

/**
 * Reports the writer's verification verdict, never an inference from the
 * presence of a proof. Unverified proofs are stored too, so a merkle path on
 * its own says only that one was received.
 */
export function SpvBadge({
  spvVerified,
  proofReceived,
  size = "md",
}: {
  spvVerified: boolean;
  proofReceived: boolean;
  size?: "sm" | "md";
}) {
  const label = spvVerified
    ? "SPV verified"
    : proofReceived
      ? "Proof received"
      : "Awaiting proof";

  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border font-mono whitespace-nowrap",
        spvVerified
          ? "border-signal-green/40 bg-signal-green/10 text-signal-green"
          : proofReceived
            ? "border-neon-amber/40 bg-neon-amber/10 text-neon-amber"
            : "border-panel-border bg-panel-bg/40 text-hud-muted",
        size === "md" ? "px-3 py-1 text-xs" : "px-2 py-0.5 text-[10px]",
      )}
    >
      <svg
        className="h-3.5 w-3.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        {spvVerified ? (
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
          />
        ) : (
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M20.618 5.984A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
          />
        )}
      </svg>
      {label}
    </span>
  );
}

export function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }, [value]);

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={`${label} to clipboard`}
      className={clsx(
        "shrink-0 rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
        copied
          ? "border-signal-green/60 text-signal-green"
          : "border-panel-border text-hud-muted hover:border-electric-cyan/60 hover:text-electric-cyan",
        className,
      )}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-panel-border/60 px-2.5 py-1.5 text-xs text-hud-muted transition-colors hover:border-electric-cyan/40 hover:text-electric-cyan"
    >
      <svg
        className="h-3.5 w-3.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
      </svg>
      {children}
    </Link>
  );
}

/**
 * Identity block shared by both explorer pages, so a transaction and the
 * aircraft it belongs to are introduced the same way: registration and type
 * first, hex code second.
 */
export function AircraftIdentityHeader({
  identity,
  backHref,
  backLabel,
  subtitle,
  actions,
}: {
  identity: AircraftIdentity;
  backHref: string;
  backLabel: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  const { icao, registration, typeCode, description, operator, callsign, live } =
    identity;

  return (
    <div className="panel relative overflow-hidden p-5">
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-electric-cyan/[0.07] via-transparent to-transparent"
        aria-hidden="true"
      />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <BackLink href={backHref}>{backLabel}</BackLink>

          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl font-bold leading-none tracking-tight text-white">
                {registration ?? icao}
              </h1>
              {typeCode && (
                <span className="rounded border border-electric-cyan/40 bg-electric-cyan/10 px-2 py-0.5 font-mono text-xs text-electric-cyan">
                  {typeCode}
                </span>
              )}
              <span
                className={clsx(
                  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                  live
                    ? "border-signal-green/40 text-signal-green"
                    : "border-panel-border text-hud-muted",
                )}
              >
                <span
                  className={clsx(
                    "h-1.5 w-1.5 rounded-full",
                    live ? "bg-signal-green animate-pulse" : "bg-hud-muted",
                  )}
                />
                {live ? "Transmitting" : "No live signal"}
              </span>
            </div>

            <p className="text-sm text-white/70">
              {description ?? "Aircraft type unknown"}
              {operator && <span className="text-hud-muted"> · {operator}</span>}
            </p>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-hud-muted">
              <span>
                ICAO <span className="data-readout">{icao}</span>
              </span>
              {callsign && (
                <span>
                  Callsign <span className="data-readout">{callsign}</span>
                </span>
              )}
              {subtitle}
            </div>
          </div>
        </div>

        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
