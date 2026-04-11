"use client";

import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import useSWR from "swr";
import { apiBaseUrl, fetcher } from "@/lib/api";
import type { BlockchainStats } from "@/types/dashboard";

function useAnimatedCounter(target: number, durationMs = 800): number {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef<number | undefined>(undefined);
  const startRef = useRef<{ value: number; ts: number }>({ value: 0, ts: 0 });

  useEffect(() => {
    startRef.current = { value: display, ts: performance.now() };

    const animate = (now: number) => {
      const elapsed = now - startRef.current.ts;
      const progress = Math.min(elapsed / durationMs, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(
        startRef.current.value + (target - startRef.current.value) * eased,
      );
      setDisplay(current);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // Only re-trigger when target changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs]);

  return display;
}

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  glowClass?: string;
  colourClass?: string;
}

function StatCard({
  label,
  value,
  sub,
  glowClass = "shadow-glow-cyan",
  colourClass = "text-electric-cyan",
}: StatCardProps) {
  return (
    <div
      className={clsx(
        "panel flex flex-col items-center justify-center px-4 py-5 text-center min-w-[140px]",
        glowClass,
      )}
    >
      <p className="hud-label text-[9px] mb-2">{label}</p>
      <p className={clsx("font-mono text-2xl font-bold tabular-nums", colourClass)}>
        {value}
      </p>
      {sub && (
        <p className="text-[10px] font-mono text-hud-muted mt-1">{sub}</p>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(2)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

function formatSats(sats: number): string {
  if (sats < 1_000) return `${sats}`;
  if (sats < 1_000_000) return `${(sats / 1_000).toFixed(1)}K`;
  return `${(sats / 1_000_000).toFixed(2)}M`;
}

export default function StatsPanel() {
  const { data, error, isLoading } = useSWR<BlockchainStats>(
    `${apiBaseUrl}/api/stats/blockchain`,
    fetcher,
    { refreshInterval: 10_000, dedupingInterval: 5_000 },
  );

  const animatedTx = useAnimatedCounter(data?.totalTxToday ?? 0);

  if (isLoading) {
    return (
      <div className="flex gap-4 overflow-x-auto pb-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="panel flex flex-col items-center px-4 py-5 min-w-[140px] animate-pulse"
          >
            <div className="h-2 w-16 rounded bg-panel-border mb-3" />
            <div className="h-6 w-20 rounded bg-panel-border" />
          </div>
        ))}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="panel-alert p-4">
        <p className="hud-label text-alert-red">Blockchain Stats</p>
        <p className="text-xs text-alert-red/80 mt-1">
          Unable to load blockchain statistics.
        </p>
      </div>
    );
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      <StatCard
        label="Transactions Today"
        value={animatedTx.toLocaleString("en-GB")}
      />
      <StatCard
        label="On-Chain Data"
        value={formatBytes(data.totalBytesOnChain)}
        colourClass="text-signal-green"
        glowClass="shadow-glow-green"
      />
      <StatCard
        label="Cost Today"
        value={`${formatSats(data.costTodaySats)} sats`}
        sub={`≈ £${data.costTodayGbp.toFixed(2)}`}
        colourClass="text-neon-amber"
        glowClass="shadow-glow-amber"
      />
      <StatCard
        label="Active Aircraft"
        value={data.activeAircraftCount.toString()}
        colourClass="text-electric-cyan"
      />
      <StatCard
        label="Adaptive Savings"
        value={`${data.adaptiveRateSavingsPercent.toFixed(0)}%`}
        sub="cost reduction vs 1tx/s"
        colourClass="text-signal-green"
        glowClass="shadow-glow-green"
      />
    </div>
  );
}
