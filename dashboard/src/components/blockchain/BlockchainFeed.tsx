"use client";

import clsx from "clsx";
import { useBlockchainStore } from "@/stores/blockchain-store";
import { RecordType } from "@/types/airchive";
import type { BlockchainEntry } from "@/types/airchive";
import { truncateTxid, fmtTime, fmtBytes, fmtSats } from "@/lib/format";
import Panel from "@/components/ui/Panel";

function getDisplayTimestamp(entry: BlockchainEntry): number {
  const timestamp = Number(entry.timestamp);
  const createdAt = entry.created_at == null ? NaN : new Date(entry.created_at).getTime();

  if (Number.isFinite(createdAt)) {
    const now = Date.now();
    const timestampLooksFuture = Number.isFinite(timestamp) && timestamp > now + 60_000;
    const timestampLooksSkewed = Number.isFinite(timestamp) && Math.abs(timestamp - createdAt) > 10 * 60_000;
    if (timestampLooksFuture || timestampLooksSkewed) {
      return createdAt;
    }
  }

  return Number.isFinite(timestamp) ? timestamp : createdAt;
}

export default function BlockchainFeed() {
  const entries = useBlockchainStore((s) => s.entries);
  const summary = useBlockchainStore((s) => s.dailySummary);
  const visibleEntries = entries.slice(-36);

  const summaryBadge = (
    <span className="font-mono text-[10px] text-hud-muted tabular-nums">
      Today: {summary.txCount.toLocaleString("en-GB")} tx
      {" · "}
      {fmtBytes(summary.totalBytes)}
      <span className="hidden sm:inline">{" · "}</span>
      <br className="sm:hidden" />
      {fmtSats(summary.totalSats)}
    </span>
  );

  return (
    <Panel title="Blockchain Feed" headerAction={summaryBadge}>
      <div className="relative -mx-4 -mb-4 h-[420px] overflow-hidden px-4 pb-4">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-panel-bg via-panel-bg/80 to-transparent" />
        <div className="flex min-h-full flex-col justify-end">
          {visibleEntries.map((entry) => (
            <FeedRow key={entry.txid} entry={entry} />
          ))}

          {visibleEntries.length === 0 && (
            <div className="flex h-full items-center justify-center py-12 text-hud-muted text-sm">
              Awaiting blockchain transactions…
            </div>
          )}
        </div>
        {entries.length > visibleEntries.length && (
          <div className="pointer-events-none absolute inset-x-0 top-0 px-4 pt-2">
            <div className="inline-flex rounded-full border border-panel-border bg-space-black/80 px-2 py-1 font-mono text-[9px] text-hud-muted backdrop-blur">
              Live view showing latest {visibleEntries.length} transactions
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function FeedRow({ entry }: { entry: BlockchainEntry }) {
  const isFlightEvent = entry.record_type === RecordType.FLIGHT_EVENT;
  const isMined = entry.status === "MINED";
  const isFailed = entry.status === "FAILED";

  return (
    <div
      className={clsx(
        "flex items-center gap-3 py-2 border-b border-panel-border last:border-b-0",
        isFlightEvent && "bg-neon-amber/5 -mx-4 px-4",
      )}
    >
      {/* Timestamp */}
      <span className="flex-shrink-0 font-mono text-[11px] text-hud-muted tabular-nums w-[70px]">
        {fmtTime(getDisplayTimestamp(entry))}
      </span>

      {/* Aircraft ICAO badge */}
      <span className="flex-shrink-0 rounded bg-deep-navy px-1.5 py-0.5 font-mono text-[10px] text-electric-cyan tabular-nums border border-panel-border">
        {entry.aircraft_icao.toUpperCase()}
      </span>

      {/* TxID */}
      <span className="flex-shrink-0 font-mono text-[10px] text-signal-green/70 tabular-nums hidden sm:inline">
        {truncateTxid(entry.txid)}
      </span>

      {/* Payload size */}
      <span className="flex-shrink-0 font-mono text-[10px] text-hud-muted tabular-nums hidden md:inline">
        {fmtBytes(entry.size_bytes)}
      </span>

      {/* Flight event summary */}
      {isFlightEvent && entry.flight_event && (
        <span className="flex-1 truncate text-[11px] text-neon-amber min-w-0">
          {entry.flight_event.summary}
        </span>
      )}

      {!isFlightEvent && <span className="flex-1" />}

      {/* TX version badge */}
      {entry.chronicle_validated && (
        <span
          className="flex-shrink-0 rounded px-1 py-0.5 text-[8px] font-bold uppercase tracking-widest border border-violet-500/40 bg-violet-500/10 text-violet-400"
          title="Version 2 transaction — broadcast under BSV Chronicle rules (activated 7 Apr 2026, block 943,816)"
        >
          v2
        </span>
      )}

      {/* ARC status */}
      <span
        className={clsx(
          "flex-shrink-0 flex items-center gap-1 text-[10px] uppercase tracking-wider",
          isMined && "text-signal-green",
          !isMined && !isFailed && "text-neon-amber",
          isFailed && "text-alert-red",
        )}
      >
        <span
          className={clsx(
            "inline-block h-1.5 w-1.5 rounded-full",
            isMined && "bg-signal-green",
            !isMined && !isFailed && "bg-neon-amber",
            isFailed && "bg-alert-red",
          )}
        />
        {entry.status === "SEEN_ON_NETWORK" ? "SEEN" : entry.status}
      </span>
    </div>
  );
}
