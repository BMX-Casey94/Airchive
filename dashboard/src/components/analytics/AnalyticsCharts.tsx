"use client";

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

export function AnalyticsCharts() {
  const summary = useBlockchainStore((s) => s.dailySummary);
  const fleet = useAircraftStore((s) => s.fleet);

  const aircraftCount = fleet.size;
  const airborneCount = Array.from(fleet.values()).filter(
    (ac) => !ac.onGround,
  ).length;

  const minedCount = summary.minedCount;
  const pendingCount = summary.pendingCount;
  const failedCount = summary.failedCount;
  const totalStatusCount = minedCount + pendingCount + failedCount;

  return (
    <Panel title="Analytics">
      <div className="space-y-4">
        {/* Fleet overview */}
        <div className="grid grid-cols-2 gap-2">
          <StatTile
            label="Active Aircraft"
            value={aircraftCount.toString()}
            sub={`${airborneCount} airborne`}
          />
          <StatTile
            label="Transactions Today"
            value={summary.txCount.toLocaleString("en-GB")}
            colour="text-signal-green"
          />
        </div>

        {/* Blockchain metrics */}
        <div className="grid grid-cols-3 gap-2">
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

        {/* Transaction status breakdown */}
        {totalStatusCount > 0 && (
          <div className="space-y-2">
            <p className="hud-label text-[9px]">Transaction Status</p>
            <div className="flex gap-2 h-2 rounded-full overflow-hidden bg-space-black border border-panel-border">
              {minedCount > 0 && (
                <div
                  className="h-full bg-signal-green rounded-full transition-all duration-500"
                  style={{
                    width: `${(minedCount / totalStatusCount) * 100}%`,
                  }}
                  title={`${minedCount} mined`}
                />
              )}
              {pendingCount > 0 && (
                <div
                  className="h-full bg-neon-amber rounded-full transition-all duration-500"
                  style={{
                    width: `${(pendingCount / totalStatusCount) * 100}%`,
                  }}
                  title={`${pendingCount} pending`}
                />
              )}
              {failedCount > 0 && (
                <div
                  className="h-full bg-alert-red rounded-full transition-all duration-500"
                  style={{
                    width: `${(failedCount / totalStatusCount) * 100}%`,
                  }}
                  title={`${failedCount} failed`}
                />
              )}
            </div>
            <div className="flex justify-between text-[9px] font-mono">
              <span className="text-signal-green">{minedCount} mined</span>
              <span className="text-neon-amber">{pendingCount} pending</span>
              <span className="text-alert-red">{failedCount} failed</span>
            </div>
          </div>
        )}

        {totalStatusCount === 0 && summary.txCount === 0 && (
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
