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

const GROUND_PHASES: ReadonlySet<string> = new Set(["PARKED", "TAXI", "TAXI_IN", "UNKNOWN"]);

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
        if (!GROUND_PHASES.has(ac.phase)) airborne++;
      }
    }
    lastRef.current = { tracked: s.fleet.size, live, airborne, ts: now };
    return lastRef.current;
  });
}

/**
 * The socket carries every transaction as it happens, so the browser can time
 * its own window. This is what the tile shows when the metrics endpoint is
 * unreachable, and it is also the only rate available before the first poll.
 */
function useLocalTxRate(): number {
  const recentTxTimes = useBlockchainStore((s) => s.recentTxTimes);
  const cutoff = Date.now() - 60_000;
  let count = 0;
  for (const t of recentTxTimes) {
    if (t >= cutoff) count++;
  }
  return count / 60;
}

export function AnalyticsCharts() {
  const summary = useBlockchainStore((s) => s.dailySummary);
  const metricsSource = useBlockchainStore((s) => s.metricsSource);
  const localTxRate = useLocalTxRate();
  const { tracked, live: liveCount, airborne: airborneCount } = useFleetCounts();
  const trackedCount = summary.trackedAircraftCount || tracked;

  const fromGateway = metricsSource === "gateway";
  // Falling back to the socket-derived rate keeps the tile truthful rather than
  // showing a confident zero while the API is unreachable.
  const txRate = fromGateway ? summary.txPerSecond : localTxRate;
  // Without the gateway these counters are not day totals at all: they are
  // whatever this browser has watched since the page loaded.
  const periodLabel = fromGateway ? "Today" : "This Session";

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
            value={formatTxRate(txRate)}
            sub={fromGateway ? "rolling 60s avg" : "rolling 60s avg (local)"}
            colour="text-neon-amber"
          />
          <StatTile
            label={`Transactions ${periodLabel}`}
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
            label={`Miner Fees ${periodLabel}`}
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

        {!fromGateway && (
          <p className="text-[10px] font-mono text-neon-amber/80 text-center">
            Gateway metrics unavailable — totals cover this session only.
          </p>
        )}

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
