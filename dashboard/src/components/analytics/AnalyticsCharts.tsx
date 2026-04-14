"use client";

import { useRef } from "react";
import { useBlockchainStore } from "@/stores/blockchain-store";
import { useAircraftStore } from "@/stores/aircraft-store";
import { fmtBytes, fmtSats } from "@/lib/format";
import Panel from "@/components/ui/Panel";
import clsx from "clsx";

function StatTile({
  label,
  value,
  sub,
  colour = "text-electric-cyan",
}: {
  label: string;
  value: string;
  sub?: string;
  colour?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-panel-border/30 bg-panel-bg/20 backdrop-blur-lg px-3 py-3 text-center">
      <p className="hud-label text-[8px] mb-1.5">{label}</p>
      <p className={clsx("font-mono text-sm font-bold tabular-nums leading-none", colour)}>
        {value}
      </p>
      {sub && (
        <p className="text-[9px] font-mono text-hud-muted mt-1">{sub}</p>
      )}
    </div>
  );
}

function isLiveAircraft(lastSeen: number): boolean {
  return lastSeen > 0 && Date.now() - lastSeen < 120_000;
}

function formatTxRate(rate: number): string {
  if (rate >= 10) return rate.toFixed(1);
  if (rate >= 1) return rate.toFixed(2);
  return rate.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

const FLEET_COUNT_THROTTLE_MS = 2_000;

function useFleetCounts() {
  const lastRef = useRef({ tracked: 0, live: 0, airborne: 0, ts: 0 });
  return useAircraftStore((s) => {
    const now = Date.now();
    if (now - lastRef.current.ts < FLEET_COUNT_THROTTLE_MS) return lastRef.current;
    let live = 0;
    let airborne = 0;
    for (const ac of s.fleet.values()) {
      if (isLiveAircraft(ac.lastSeen)) {
        live++;
        if (!ac.onGround) airborne++;
      }
    }
    lastRef.current = { tracked: s.fleet.size, live, airborne, ts: now };
    return lastRef.current;
  });
}

export function AnalyticsCharts() {
  const summary = useBlockchainStore((s) => s.dailySummary);
  const { tracked, live: liveCount, airborne: airborneCount } = useFleetCounts();
  const trackedCount = summary.trackedAircraftCount || tracked;

  return (
    <Panel title="Analytics">
      <div className="space-y-4">
        {/* Fleet overview */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <StatTile
            label="Tracked Aircraft"
            value={trackedCount.toString()}
            sub={`${liveCount} live / ${airborneCount} airborne`}
          />
          <StatTile
            label="TX/s"
            value={formatTxRate(summary.txPerSecond)}
            sub="rolling 60s avg"
            colour="text-neon-amber"
          />
          <StatTile
            label="Transactions Today"
            value={summary.txCount.toLocaleString("en-GB")}
            colour="text-signal-green"
          />
        </div>

        {/* Blockchain metrics */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <StatTile
            label="On-Chain Data"
            value={fmtBytes(summary.totalBytes)}
            colour="text-electric-cyan"
          />
          <StatTile
            label="Miner Fees Today"
            value={fmtSats(summary.totalSats)}
            colour="text-neon-amber"
          />
          <StatTile
            label="Avg Tx Size"
            value={
              summary.txCount > 0
                ? fmtBytes(Math.round(summary.totalBytes / summary.txCount))
                : "—"
            }
            colour="text-hud-muted"
          />
        </div>

        {summary.txCount === 0 && (
          <div className="flex flex-col items-center justify-center py-4 gap-2">
            <p className="text-[11px] text-hud-muted">
              Analytics will populate once blockchain transactions begin.
            </p>
          </div>
        )}
      </div>
    </Panel>
  );
}
