"use client";

import { clsx } from "clsx";
import { useCallback, useState } from "react";
import useSWR from "swr";
import { apiBaseUrl, fetcher } from "@/lib/api";

type FundingState = "HEALTHY" | "LOW" | "DRY" | "RECOVERING" | "UNKNOWN";

interface FundingPayload {
  state: FundingState;
  treasury_address?: string | null;
  balance_sats: number;
  utxo_count: number;
  burn_sats_per_hour?: number;
  runway_hours: number | null;
  state_since?: string;
  last_checked_at?: string | null;
  next_poll_at?: string | null;
  pending_writes: number;
  stale: boolean;
  reason?: string;
}

interface FundingResponse {
  success: boolean;
  data: FundingPayload;
}

const STATE_COPY: Record<FundingState, { label: string; detail: string }> = {
  HEALTHY: {
    label: "Treasury healthy",
    detail: "Aircraft and agent wallets are being topped up normally.",
  },
  LOW: {
    label: "Treasury low",
    detail: "Fund the wallet before the runway runs out.",
  },
  DRY: {
    label: "Treasury dry",
    detail:
      "Writes are being held, not discarded. Send funds to the funding wallet "
      + "and the system resumes on its own.",
  },
  RECOVERING: {
    label: "Recovering",
    detail: "Funds detected — refilling wallets and draining the held backlog.",
  },
  UNKNOWN: {
    label: "Awaiting writer",
    detail: "The blockchain writer has not reported funding health yet.",
  },
};

function formatRunway(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return "—";
  if (hours >= 48) return `${Math.round(hours / 24)}d`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours * 60)}m`;
}

/**
 * The treasury pays for every write, so the one action that fixes a dry system
 * is sending it coins. Showing the address — with a one-click copy — is what
 * turns the status panel from a report into something an operator or a
 * supporter can act on. Only ever a receive address; the WIF stays in the
 * writer.
 */
function TreasuryAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }, [address]);

  return (
    <div className="rounded-lg border border-panel-border/50 bg-space-black/40 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="hud-label text-[9px]">Treasury Address</p>
        <a
          href={`https://whatsonchain.com/address/${address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-hud-muted transition-colors hover:text-electric-cyan"
        >
          View on-chain ↗
        </a>
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-electric-cyan/90">
          {address}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label="Copy treasury address"
          className={clsx(
            "shrink-0 rounded border px-2 py-1 text-[10px] font-mono uppercase tracking-wider transition-colors",
            copied
              ? "border-signal-green/60 text-signal-green"
              : "border-panel-border text-hud-muted hover:border-electric-cyan/60 hover:text-electric-cyan",
          )}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="text-[10px] leading-snug text-hud-muted">
        BSV sent here funds aircraft and agent wallets automatically. Send nothing
        you are not happy to spend on public infrastructure.
      </p>
    </div>
  );
}

export default function FundingStatus() {
  const { data, error, isLoading } = useSWR<FundingResponse>(
    `${apiBaseUrl}/api/system/funding`,
    fetcher,
    { refreshInterval: 15_000, dedupingInterval: 10_000 },
  );

  if (isLoading) {
    return (
      <div className="panel p-4 animate-pulse">
        <div className="h-3 w-32 rounded bg-panel-border" />
      </div>
    );
  }

  if (error || !data?.data) {
    return (
      <div className="panel-alert p-4 space-y-1">
        <p className="hud-label text-alert-red">Treasury</p>
        <p className="text-xs text-alert-red/80">
          Unable to read funding state from the gateway.
        </p>
      </div>
    );
  }

  const funding = data.data;
  const state = funding.state;
  const copy = STATE_COPY[state] ?? STATE_COPY.UNKNOWN;
  const critical = state === "DRY";
  const warning = state === "LOW" || state === "RECOVERING" || funding.stale;

  return (
    <div className={clsx("p-4 space-y-3", critical ? "panel-alert" : "panel")}>
      <div className="flex items-center justify-between gap-3">
        <p
          className={clsx(
            "hud-label",
            critical ? "text-alert-red" : warning ? "text-neon-amber" : undefined,
          )}
        >
          Treasury
        </p>
        <span
          className={clsx(
            "px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider border",
            critical
              ? "border-alert-red/60 text-alert-red animate-pulse"
              : state === "LOW"
                ? "border-neon-amber/60 text-neon-amber"
                : state === "RECOVERING"
                  ? "border-electric-cyan/60 text-electric-cyan"
                  : "border-signal-green/50 text-signal-green",
          )}
        >
          {copy.label}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <p className="hud-label text-[9px]">Balance</p>
          <p className="data-readout text-sm">
            {funding.balance_sats.toLocaleString("en-GB")}
            <span className="text-hud-muted text-[10px]"> sats</span>
          </p>
        </div>
        <div
          title={
            "Estimated time until the treasury reaches zero at the current "
            + "spend rate, averaged over the last 30 minutes. Covers the whole "
            + "treasury drain — aircraft refills and agent top-ups, not just "
            + "transaction fees."
          }
        >
          <p className="hud-label text-[9px]">Runway</p>
          <p
            className={clsx(
              "font-mono text-sm tabular-nums",
              critical ? "text-alert-red" : "text-white/80",
            )}
          >
            {formatRunway(funding.runway_hours)}
          </p>
        </div>
        <div
          title={
            "Rows awaiting a retry after a failed broadcast. Telemetry is "
            + "coalesced to the latest sample per aircraft, so this counts "
            + "affected aircraft plus individual flight events — not the "
            + "number of deferred telemetry samples."
          }
        >
          <p className="hud-label text-[9px]">Retry Backlog</p>
          <p
            className={clsx(
              "font-mono text-sm tabular-nums",
              funding.pending_writes > 100 ? "text-neon-amber" : "text-white/80",
            )}
          >
            {funding.pending_writes.toLocaleString("en-GB")}
          </p>
        </div>
      </div>

      <p className="text-[11px] leading-snug text-hud-muted">
        {funding.reason ?? copy.detail}
      </p>

      {funding.treasury_address && <TreasuryAddress address={funding.treasury_address} />}

      {funding.stale && state !== "UNKNOWN" && (
        <p className="text-[10px] text-neon-amber/80">
          Last reported over two minutes ago — the writer may be down.
        </p>
      )}
    </div>
  );
}
