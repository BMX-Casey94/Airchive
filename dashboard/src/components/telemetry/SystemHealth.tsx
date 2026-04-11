"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { clsx } from "clsx";
import useSWR from "swr";
import { apiBaseUrl, fetcher } from "@/lib/api";
import type { SystemHealth as SystemHealthDTO } from "@/types/dashboard";

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      className={clsx(
        "inline-block h-2.5 w-2.5 rounded-full",
        connected
          ? "bg-signal-green shadow-glow-green"
          : "bg-alert-red shadow-glow-red animate-pulse",
      )}
      aria-label={connected ? "Connected" : "Disconnected"}
    />
  );
}

function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1_000);
  const d = Math.floor(totalSec / 86_400);
  const h = Math.floor((totalSec % 86_400) / 3_600);
  const m = Math.floor((totalSec % 3_600) / 60);
  const s = totalSec % 60;

  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function MiniBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] font-mono">
        <span className="text-hud-muted truncate">{label}</span>
        <span className="data-readout">{value.toLocaleString("en-GB")} sats</span>
      </div>
      <div className="h-1.5 rounded-full bg-space-black border border-panel-border overflow-hidden">
        <div
          className="h-full bg-electric-cyan/70 rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function SystemHealth() {
  const { data, error, isLoading } = useSWR<SystemHealthDTO>(
    `${apiBaseUrl}/api/health`,
    fetcher,
    { refreshInterval: 5_000, dedupingInterval: 3_000 },
  );

  /* ── Live uptime counter ───────────────────────────────── */
  const baseUptime = useRef<number>(0);
  const baseTs = useRef<number>(Date.now());
  const [displayUptime, setDisplayUptime] = useState(0);

  useEffect(() => {
    if (data?.uptimeMs != null) {
      baseUptime.current = data.uptimeMs;
      baseTs.current = Date.now();
    }
  }, [data?.uptimeMs]);

  useEffect(() => {
    const iv = setInterval(() => {
      setDisplayUptime(baseUptime.current + (Date.now() - baseTs.current));
    }, 1_000);
    return () => clearInterval(iv);
  }, []);

  if (isLoading) {
    return (
      <div className="panel p-4 space-y-3 animate-pulse">
        <div className="h-3 w-28 rounded bg-panel-border" />
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-3 rounded bg-panel-border" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="panel-alert p-4 space-y-2">
        <p className="hud-label text-alert-red">System Health</p>
        <p className="text-xs text-alert-red/80">
          Unable to reach the gateway API. Check your connection.
        </p>
      </div>
    );
  }

  const maxBalance = data.utxoSummaries.reduce(
    (mx, u) => Math.max(mx, u.balanceSats),
    1,
  );

  return (
    <div className="panel p-4 space-y-4">
      <p className="hud-label">System Health</p>

      {/* ── Connection statuses ───────────────────────────── */}
      <div className="grid grid-cols-2 gap-3">
        <div className="flex items-center gap-2">
          <StatusDot connected={data.dbConnected} />
          <span className="text-xs text-white/80">Database</span>
        </div>
        <div className="flex items-center gap-2">
          <StatusDot connected={data.redisConnected} />
          <span className="text-xs text-white/80">Redis</span>
        </div>
      </div>

      {/* ── Uptime + pending writes ──────────────────────── */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="hud-label text-[9px]">Uptime</p>
          <p className="data-readout text-sm">{formatUptime(displayUptime)}</p>
        </div>
        <div>
          <p className="hud-label text-[9px]">Pending Writes</p>
          <p
            className={clsx(
              "font-mono text-sm tabular-nums",
              data.pendingWriteCount > 100
                ? "text-alert-red"
                : data.pendingWriteCount > 20
                  ? "text-neon-amber"
                  : "text-signal-green",
            )}
          >
            {data.pendingWriteCount.toLocaleString("en-GB")}
          </p>
        </div>
      </div>

      {/* ── Write rate per aircraft ───────────────────────── */}
      {Object.keys(data.aircraftWriteRates).length > 0 && (
        <div className="space-y-2">
          <p className="hud-label text-[9px]">Write Rate (tx/min)</p>
          {Object.entries(data.aircraftWriteRates).map(([icao, rates]) => {
            const ratio =
              rates.expected > 0 ? rates.actual / rates.expected : 0;
            return (
              <div key={icao} className="flex items-center gap-2 text-xs">
                <span className="font-mono text-hud-muted w-14 shrink-0">
                  {icao}
                </span>
                <div className="flex-1 h-1.5 rounded-full bg-space-black border border-panel-border overflow-hidden">
                  <div
                    className={clsx(
                      "h-full rounded-full transition-all duration-500",
                      ratio > 0.8
                        ? "bg-signal-green"
                        : ratio > 0.4
                          ? "bg-neon-amber"
                          : "bg-alert-red",
                    )}
                    style={{ width: `${Math.min(ratio * 100, 100)}%` }}
                  />
                </div>
                <span className="data-readout text-[10px] w-16 text-right shrink-0">
                  {rates.actual}/{rates.expected}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* ── UTXO pool summary ─────────────────────────────── */}
      {data.utxoSummaries.length > 0 && (
        <div className="space-y-2">
          <p className="hud-label text-[9px]">UTXO Pool</p>
          {data.utxoSummaries.map((u) => (
            <MiniBar
              key={u.icao}
              label={u.icao}
              value={u.balanceSats}
              max={maxBalance}
            />
          ))}
        </div>
      )}
    </div>
  );
}
