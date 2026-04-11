"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import useSWR from "swr";
import { clsx } from "clsx";
import { apiBaseUrl, fetcher } from "@/lib/api";
import { truncateTxId, formatTimestamp } from "@/lib/format";
import type { TxResultDTO, DecodedPayload } from "@/types/dashboard";
import { use } from "react";

const PAGE_SIZE = 25;

const RECORD_TYPE_LABEL: Record<number, string> = {
  0x01: "Telemetry",
  0x02: "Flight Event",
  0x03: "Telemetry Delta",
};

const STATUS_BADGE: Record<string, { bg: string; text: string }> = {
  SEEN_ON_NETWORK: {
    bg: "bg-neon-amber/20 border-neon-amber/40",
    text: "text-neon-amber",
  },
  MINED: {
    bg: "bg-signal-green/20 border-signal-green/40",
    text: "text-signal-green",
  },
  FAILED: {
    bg: "bg-alert-red/20 border-alert-red/40",
    text: "text-alert-red",
  },
};

function ExpandedPayload({ txid }: { txid: string }) {
  const { data, error, isLoading } = useSWR<DecodedPayload>(
    `${apiBaseUrl}/api/explorer/tx/${txid}/decode`,
    fetcher,
  );

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-2 py-2">
        <div className="h-3 w-3/4 rounded bg-panel-border" />
        <div className="h-3 w-1/2 rounded bg-panel-border" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <p className="text-xs text-alert-red/80 py-2">
        Failed to decode payload.
      </p>
    );
  }

  return (
    <div className="space-y-3 py-3 border-t border-panel-border mt-2">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <span className="text-hud-muted">Protocol</span>
        <span className="data-readout">{data.protocolId} v{data.version}</span>
        <span className="text-hud-muted">ICAO</span>
        <span className="data-readout">{data.icaoHex}</span>
        <span className="text-hud-muted">Record Type</span>
        <span className="data-readout">
          {RECORD_TYPE_LABEL[data.recordType] ?? `0x${data.recordType.toString(16).padStart(2, "0")}`}
        </span>
        <span className="text-hud-muted">Timestamp</span>
        <span className="data-readout">
          {new Date(data.timestamp).toLocaleString("en-GB")}
        </span>
      </div>

      {Object.keys(data.fields).length > 0 && (
        <details className="group">
          <summary className="hud-label cursor-pointer select-none hover:text-electric-cyan transition-colors text-[10px]">
            Decoded Fields ({Object.keys(data.fields).length})
          </summary>
          <pre className="mt-2 text-[10px] font-mono text-electric-cyan/80 bg-space-black rounded-lg p-3 overflow-x-auto border border-panel-border max-h-60 overflow-y-auto">
            {JSON.stringify(data.fields, null, 2)}
          </pre>
        </details>
      )}

      <details className="group">
        <summary className="hud-label cursor-pointer select-none hover:text-neon-amber transition-colors text-[10px]">
          Raw OP_RETURN Hex
        </summary>
        <pre className="mt-2 text-[10px] font-mono text-neon-amber/80 bg-space-black rounded-lg p-3 overflow-x-auto border border-panel-border break-all">
          {data.rawHex}
        </pre>
      </details>
    </div>
  );
}

function TxRow({ tx }: { tx: TxResultDTO }) {
  const [expanded, setExpanded] = useState(false);
  const badge = STATUS_BADGE[tx.status] ?? STATUS_BADGE.FAILED;

  return (
    <div className="panel p-3 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-left group min-w-0"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className={clsx(
              "h-3.5 w-3.5 shrink-0 text-hud-muted transition-transform",
              expanded && "rotate-90",
            )}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <Link
            href={`/explorer/tx/${tx.txid}`}
            className="data-readout text-xs hover:text-white transition-colors truncate"
            onClick={(e) => e.stopPropagation()}
          >
            {truncateTxId(tx.txid)}
          </Link>
        </button>

        <div className="flex items-center gap-3 shrink-0">
          <span className="text-[10px] font-mono text-hud-muted">
            {RECORD_TYPE_LABEL[tx.recordType] ?? "Unknown"}
          </span>
          <span className="text-[10px] font-mono text-hud-muted">
            {tx.feeSats} sats
          </span>
          <span className="text-[10px] font-mono text-hud-muted">
            {tx.sizeBytes} B
          </span>
          <span
            className={clsx(
              "text-[10px] font-mono px-2 py-0.5 rounded-full border",
              badge.bg,
              badge.text,
            )}
          >
            {tx.status}
          </span>
          <span className="text-[10px] text-hud-muted">
            {formatTimestamp(tx.timestamp)}
          </span>
        </div>
      </div>

      {expanded && <ExpandedPayload txid={tx.txid} />}
    </div>
  );
}

export default function AircraftExplorerPage({
  params,
}: {
  params: Promise<{ icao: string }>;
}) {
  const { icao } = use(params);
  const [page, setPage] = useState(0);
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");

  const queryParams = useMemo(() => {
    const p = new URLSearchParams({
      limit: PAGE_SIZE.toString(),
      offset: (page * PAGE_SIZE).toString(),
    });
    if (timeFrom) p.set("from", new Date(timeFrom).getTime().toString());
    if (timeTo) p.set("to", new Date(timeTo).getTime().toString());
    return p.toString();
  }, [page, timeFrom, timeTo]);

  const { data, error, isLoading } = useSWR<TxResultDTO[]>(
    `${apiBaseUrl}/api/explorer/aircraft/${icao}/transactions?${queryParams}`,
    fetcher,
  );

  const handleExportCsv = useCallback(() => {
    if (!data || data.length === 0) return;

    const headers = [
      "txid",
      "recordType",
      "status",
      "blockHeight",
      "timestamp",
      "feeSats",
      "sizeBytes",
      "flightId",
    ];
    const rows = data.map((tx) =>
      [
        tx.txid,
        RECORD_TYPE_LABEL[tx.recordType] ?? tx.recordType,
        tx.status,
        tx.blockHeight ?? "",
        new Date(tx.timestamp).toISOString(),
        tx.feeSats,
        tx.sizeBytes,
        tx.flightId ?? "",
      ].join(","),
    );
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `airchive-${icao}-transactions.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data, icao]);

  return (
    <div className="min-h-screen bg-space-black p-6 space-y-6">
      {/* ── Header ────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-sm text-hud-muted hover:text-electric-cyan transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Dashboard
          </Link>
          <div>
            <h1 className="text-xl font-bold text-white">
              Aircraft{" "}
              <span className="data-readout">{icao.toUpperCase()}</span>
            </h1>
            <p className="text-xs text-hud-muted">
              On-chain transaction explorer
            </p>
          </div>
        </div>
        <button
          onClick={handleExportCsv}
          disabled={!data || data.length === 0}
          className={clsx(
            "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono border transition-all",
            data && data.length > 0
              ? "border-electric-cyan/40 text-electric-cyan hover:bg-electric-cyan/10 hover:shadow-glow-cyan"
              : "border-panel-border text-hud-muted cursor-not-allowed",
          )}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
          Export CSV
        </button>
      </div>

      {/* ── Time-range filters ────────────────────────────── */}
      <div className="panel p-4">
        <p className="hud-label text-[9px] mb-2">Time Range Filter</p>
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <label className="text-[10px] text-hud-muted" htmlFor="filter-from">
              From
            </label>
            <input
              id="filter-from"
              type="datetime-local"
              value={timeFrom}
              onChange={(e) => {
                setTimeFrom(e.target.value);
                setPage(0);
              }}
              className="block w-48 rounded-lg border border-panel-border bg-space-black px-3 py-1.5 text-xs font-mono text-white focus:border-electric-cyan focus:outline-none focus:ring-1 focus:ring-electric-cyan/30"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-hud-muted" htmlFor="filter-to">
              To
            </label>
            <input
              id="filter-to"
              type="datetime-local"
              value={timeTo}
              onChange={(e) => {
                setTimeTo(e.target.value);
                setPage(0);
              }}
              className="block w-48 rounded-lg border border-panel-border bg-space-black px-3 py-1.5 text-xs font-mono text-white focus:border-electric-cyan focus:outline-none focus:ring-1 focus:ring-electric-cyan/30"
            />
          </div>
          {(timeFrom || timeTo) && (
            <button
              onClick={() => {
                setTimeFrom("");
                setTimeTo("");
                setPage(0);
              }}
              className="text-xs text-hud-muted hover:text-alert-red transition-colors pb-1"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* ── Transaction list ──────────────────────────────── */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="panel p-3 animate-pulse">
              <div className="h-4 w-full rounded bg-panel-border" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="panel-alert p-4">
          <p className="text-sm text-alert-red">
            Failed to load transactions. Please try again.
          </p>
        </div>
      ) : data && data.length > 0 ? (
        <div className="space-y-2">
          {data.map((tx) => (
            <TxRow key={tx.txid} tx={tx} />
          ))}
        </div>
      ) : (
        <div className="panel p-8 text-center">
          <p className="text-sm text-hud-muted">
            No transactions found for this aircraft
            {(timeFrom || timeTo) && " within the selected time range"}.
          </p>
        </div>
      )}

      {/* ── Pagination ────────────────────────────────────── */}
      {data && data.length > 0 && (
        <div className="flex items-center justify-between">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className={clsx(
              "px-4 py-2 rounded-lg text-xs font-mono border transition-all",
              page > 0
                ? "border-panel-border text-white hover:border-electric-cyan/40 hover:text-electric-cyan"
                : "border-panel-border/50 text-hud-muted/50 cursor-not-allowed",
            )}
          >
            Previous
          </button>
          <span className="text-xs text-hud-muted font-mono">
            Page {page + 1}
          </span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={data.length < PAGE_SIZE}
            className={clsx(
              "px-4 py-2 rounded-lg text-xs font-mono border transition-all",
              data.length >= PAGE_SIZE
                ? "border-panel-border text-white hover:border-electric-cyan/40 hover:text-electric-cyan"
                : "border-panel-border/50 text-hud-muted/50 cursor-not-allowed",
            )}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
