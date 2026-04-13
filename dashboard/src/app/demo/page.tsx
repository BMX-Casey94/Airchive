import Link from "next/link";
import { RoiCalculator } from "@/components/blockchain/RoiCalculator";

export const metadata = {
  title: "Airchive — Chain Write Economics",
  description: "On-chain cost calculator for BSV aircraft telemetry — compare naive vs adaptive write rates",
};

const features = [
  {
    title: "Real-time telemetry",
    body: "Fused ADS-B streams from adsb.fi, OpenSky, and RTL-SDR normalised into a single canonical record model, pushed live via WebSocket.",
    accent: "border-electric-cyan/25 bg-electric-cyan/[0.03]",
  },
  {
    title: "Adaptive write rates",
    body: "Phase-aware throttling: 1s during takeoff/climb/landing, 3s cruise, 15s taxi. Reduces chain volume whilst preserving dense sampling when it matters.",
    accent: "border-neon-amber/25 bg-neon-amber/[0.03]",
  },
  {
    title: "Chronicle-era transactions",
    body: "All telemetry broadcasts use tx.version = 2, opting into BSV's Chronicle ruleset (activated 7 Apr 2026, block 943,816).",
    accent: "border-violet-500/25 bg-violet-500/[0.03]",
  },
  {
    title: "19 active wallets",
    body: "15 HD-derived aircraft wallets + 3 autonomous AI agent wallets + 1 treasury. Each aircraft manages its own UTXO chain for zero-contention parallel writes.",
    accent: "border-signal-green/25 bg-signal-green/[0.03]",
  },
  {
    title: "BSV overlay node",
    body: "Self-hosted overlay with tm_airchive topic manager — indexes every Airchive transaction for lookup by ICAO, txid, time range, or flight session.",
    accent: "border-electric-cyan/25 bg-electric-cyan/[0.03]",
  },
  {
    title: "AI agent marketplace",
    body: "Three autonomous agents (Collector, Analyst, Monitor) discover each other via BRC-100, exchange data via MessageBox P2P, and settle micropayments on-chain.",
    accent: "border-neon-amber/25 bg-neon-amber/[0.03]",
  },
] as const;

export default function DemoPage() {
  return (
    <main className="relative min-h-screen overflow-hidden text-white">
      <div className="relative mx-auto flex max-w-6xl flex-col px-6 pb-24 pt-16 md:pt-20">
        {/* Header */}
        <div className="text-center">
          <p className="hud-label mb-3 text-electric-cyan/80">BSV Hackathon 2026 · Chronicle era</p>
          <h1 className="font-sans text-5xl font-bold tracking-[0.15em] text-white md:text-7xl">
            AIRCHIVE
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-lg text-hud-muted">
            Immutable flight data on BSV blockchain
          </p>
        </div>

        {/* Feature grid */}
        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <article
              key={f.title}
              className={`panel flex flex-col items-center border p-5 text-center backdrop-blur-md transition-all hover:scale-[1.01] ${f.accent}`}
            >
              <h2 className="text-sm font-semibold text-white">{f.title}</h2>
              <p className="mt-3 text-xs leading-relaxed text-hud-muted">{f.body}</p>
            </article>
          ))}
        </div>

        {/* CTA */}
        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-lg bg-electric-cyan px-8 py-3 text-sm font-semibold uppercase tracking-widest text-space-black transition hover:bg-electric-cyan/90 hover:shadow-[0_0_20px_rgba(0,245,255,0.3)]"
          >
            Open dashboard
          </Link>
          <Link
            href="/wallets"
            className="inline-flex items-center justify-center rounded-lg border border-electric-cyan/30 bg-electric-cyan/[0.06] px-8 py-3 text-sm font-semibold uppercase tracking-widest text-electric-cyan transition hover:bg-electric-cyan/10"
          >
            View wallets
          </Link>
        </div>

        {/* Economics calculator */}
        <div className="mt-16">
          <RoiCalculator />
        </div>

        {/* Footer note */}
        <p className="mt-8 text-center text-xs text-hud-muted">
          Built by @BSVCasey · Solo dev · All on-chain transactions verifiable via{" "}
          <a
            href="https://whatsonchain.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-electric-cyan/70 hover:text-electric-cyan"
          >
            WhatsonChain
          </a>
        </p>
      </div>
    </main>
  );
}
