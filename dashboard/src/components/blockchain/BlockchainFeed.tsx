"use client";

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import { useBlockchainStore } from "@/stores/blockchain-store";
import { RecordType } from "@/types/airchive";
import type { BlockchainEntry } from "@/types/airchive";
import { truncateTxid, fmtTime, fmtBytes, fmtSats } from "@/lib/format";
import Panel from "@/components/ui/Panel";

export default function BlockchainFeed() {
  const entries = useBlockchainStore((s) => s.entries);
  const summary = useBlockchainStore((s) => s.dailySummary);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  const summaryBadge = (
    <span className="font-mono text-[10px] text-hud-muted tabular-nums">
      Today: {summary.txCount.toLocaleString("en-GB")} tx
      {" · "}
      {fmtBytes(summary.totalBytes)}
      {" · "}
      {fmtSats(summary.totalSats)}
    </span>
  );

  return (
    <Panel title="Blockchain Feed" headerAction={summaryBadge}>
      <div
        ref={scrollRef}
        className="max-h-[420px] overflow-y-auto -mx-4 -mb-4 px-4 pb-4"
      >
        <AnimatePresence initial={false}>
          {entries.map((entry) => (
            <FeedRow key={entry.txid} entry={entry} />
          ))}
        </AnimatePresence>

        {entries.length === 0 && (
          <div className="flex items-center justify-center py-12 text-hud-muted text-sm">
            Awaiting blockchain transactions…
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
    <motion.div
      initial={{ opacity: 0, x: -24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -12 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className={clsx(
        "flex items-center gap-3 py-2 border-b border-panel-border last:border-b-0",
        isFlightEvent && "bg-neon-amber/5 -mx-4 px-4",
      )}
    >
      {/* Timestamp */}
      <span className="flex-shrink-0 font-mono text-[11px] text-hud-muted tabular-nums w-[70px]">
        {fmtTime(entry.timestamp)}
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

      {/* Chronicle badge */}
      {entry.chronicle_validated && (
        <span
          className="flex-shrink-0 rounded px-1 py-0.5 text-[8px] font-bold uppercase tracking-widest border border-violet-500/40 bg-violet-500/10 text-violet-400"
          title="Chronicle-era transaction (tx.version = 2) — opts into BSV Chronicle ruleset activated 7 Apr 2026"
        >
          Chronicle
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
    </motion.div>
  );
}
