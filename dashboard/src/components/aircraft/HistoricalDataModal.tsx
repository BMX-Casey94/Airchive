"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import useSWR from "swr";
import clsx from "clsx";
import { apiBaseUrl, fetcher } from "@/lib/api";
import {
  fmtAltitude,
  fmtHeading,
  fmtSpeed,
  formatPhase,
  formatTimestamp,
  truncateTxid,
} from "@/lib/format";
import type { TxResultDTO } from "@/types/dashboard";

const PAGE_SIZE = 50;
const RECORD_TYPE_TELEMETRY = 1;

const CONFIRMATION: Record<string, { label: string; className: string }> = {
  MINED: {
    label: "Confirmed",
    className: "border-signal-green/40 bg-signal-green/10 text-signal-green",
  },
  SEEN_ON_NETWORK: {
    label: "Pending",
    className: "border-neon-amber/40 bg-neon-amber/10 text-neon-amber",
  },
  FAILED: {
    label: "Failed",
    className: "border-alert-red/40 bg-alert-red/10 text-alert-red",
  },
};

function ConfirmationCell({ tx }: { tx: TxResultDTO }) {
  const badge = CONFIRMATION[tx.status] ?? CONFIRMATION.FAILED!;

  return (
    <div className="flex flex-col items-end gap-0.5">
      <span
        className={clsx(
          "inline-flex rounded border px-2 py-0.5 text-[10px] font-medium",
          badge.className,
        )}
      >
        {badge.label}
      </span>
      {tx.blockHeight != null && (
        <span className="font-mono text-[9px] text-hud-muted tabular-nums">
          Block {tx.blockHeight.toLocaleString("en-GB")}
        </span>
      )}
    </div>
  );
}

function PositionCell({ tx }: { tx: TxResultDTO }) {
  const lat = tx.telemetry?.latitude;
  const lon = tx.telemetry?.longitude;
  if (lat == null || lon == null) return <span className="text-hud-muted">—</span>;
  return (
    <span className="tabular-nums">
      {lat.toFixed(4)}°, {lon.toFixed(4)}°
    </span>
  );
}

interface HistoricalDataModalProps {
  icao: string;
  callsign: string | null;
  onClose: () => void;
}

export default function HistoricalDataModal({
  icao,
  callsign,
  onClose,
}: HistoricalDataModalProps) {
  const [mounted, setMounted] = useState(false);
  const [page, setPage] = useState(0);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const query = new URLSearchParams({
    limit: PAGE_SIZE.toString(),
    offset: (page * PAGE_SIZE).toString(),
    recordType: RECORD_TYPE_TELEMETRY.toString(),
    decode: "true",
  });

  const { data, error, isLoading } = useSWR<TxResultDTO[]>(
    `${apiBaseUrl}/api/explorer/aircraft/${icao}/transactions?${query.toString()}`,
    fetcher,
    { revalidateOnFocus: false },
  );

  if (!mounted) return null;

  const rows = data ?? [];

  return createPortal(
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Historical telemetry for ${icao.toUpperCase()}`}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-panel-border/60 bg-panel-bg/95 shadow-glow-cyan"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-panel-border/50 px-5 py-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-electric-cyan">
              Historical Data
            </h2>
            <p className="font-mono text-[11px] text-hud-muted">
              {callsign || icao.toUpperCase()} · On-chain telemetry records
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close historical data"
            className="rounded-lg border border-panel-border px-3 py-1.5 text-xs text-hud-muted transition-colors hover:border-alert-red/50 hover:text-alert-red"
          >
            Close
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-auto">
          {isLoading && (
            <div className="flex items-center gap-2 px-5 py-8 text-sm text-hud-muted">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-electric-cyan border-t-transparent" />
              Loading historical telemetry…
            </div>
          )}

          {error && !isLoading && (
            <p className="px-5 py-8 text-sm text-alert-red">
              Failed to load historical telemetry: {(error as Error).message}
            </p>
          )}

          {!isLoading && !error && rows.length === 0 && (
            <p className="px-5 py-8 text-sm text-hud-muted">
              {page > 0
                ? "No further records on this page."
                : "No on-chain telemetry recorded for this aircraft yet."}
            </p>
          )}

          {!isLoading && !error && rows.length > 0 && (
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-panel-bg/95 backdrop-blur">
                <tr className="border-b border-panel-border/50 text-xs uppercase tracking-wider text-hud-muted">
                  <th className="px-4 py-3">Timestamp</th>
                  <th className="px-4 py-3 text-right">Altitude</th>
                  <th className="px-4 py-3 text-right">Speed</th>
                  <th className="px-4 py-3 text-right">Heading</th>
                  <th className="px-4 py-3">Phase</th>
                  <th className="px-4 py-3">Position</th>
                  <th className="px-4 py-3">Transaction</th>
                  <th className="px-4 py-3 text-right">Confirmation</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((tx) => {
                  const phase = formatPhase(tx.phase ?? "UNKNOWN");
                  return (
                    <tr
                      key={tx.txid}
                      className="border-b border-panel-border/30 transition-colors hover:bg-panel-bg/60"
                    >
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-300 tabular-nums">
                        {formatTimestamp(tx.timestamp)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-white tabular-nums">
                        {tx.telemetry?.altitudeFt != null
                          ? `${fmtAltitude(tx.telemetry.altitudeFt)} ft`
                          : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-electric-cyan tabular-nums">
                        {tx.telemetry?.groundSpeedKts != null
                          ? `${fmtSpeed(tx.telemetry.groundSpeedKts)} kts`
                          : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-white tabular-nums">
                        {tx.telemetry?.headingDeg != null
                          ? fmtHeading(tx.telemetry.headingDeg)
                          : "—"}
                      </td>
                      <td
                        className={clsx(
                          "px-4 py-2.5 font-mono text-xs",
                          phase.colourClass,
                        )}
                      >
                        {phase.label}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-slate-300">
                        <PositionCell tx={tx} />
                      </td>
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/explorer/tx/${tx.txid}`}
                          className="font-mono text-xs text-electric-cyan underline-offset-2 transition-colors hover:text-white hover:underline"
                        >
                          {truncateTxid(tx.txid)}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5">
                        <ConfirmationCell tx={tx} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-panel-border/50 px-5 py-3">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className={clsx(
              "rounded-lg border px-4 py-1.5 text-xs font-mono transition-colors",
              page > 0
                ? "border-panel-border text-white hover:border-electric-cyan/40 hover:text-electric-cyan"
                : "cursor-not-allowed border-panel-border/50 text-hud-muted/50",
            )}
          >
            Previous
          </button>
          <span className="font-mono text-xs text-hud-muted">
            Page {page + 1}
            {rows.length > 0 && ` · ${rows.length} record${rows.length !== 1 ? "s" : ""}`}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => p + 1)}
            disabled={rows.length < PAGE_SIZE}
            className={clsx(
              "rounded-lg border px-4 py-1.5 text-xs font-mono transition-colors",
              rows.length >= PAGE_SIZE
                ? "border-panel-border text-white hover:border-electric-cyan/40 hover:text-electric-cyan"
                : "cursor-not-allowed border-panel-border/50 text-hud-muted/50",
            )}
          >
            Next
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
