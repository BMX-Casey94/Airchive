"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useWebSocket } from "@/hooks/useWebSocket";

/* ── Lazy-loaded dashboard sections ──────────────────────────── */

const GlobeView = dynamic(() => import("@/components/globe/GlobeView"), {
  ssr: false,
  loading: () => (
    <div className="relative h-full min-h-[50vh] w-full bg-space-black flex items-center justify-center">
      <div className="text-center space-y-4">
        <div className="relative mx-auto h-20 w-20">
          <div className="absolute inset-0 rounded-full border-2 border-electric-cyan/30 animate-ping" />
          <div className="absolute inset-2 rounded-full border border-electric-cyan/60 animate-pulse-slow" />
          <div className="absolute inset-4 rounded-full bg-electric-cyan/10" />
        </div>
        <p className="hud-label animate-pulse">Initialising Globe&hellip;</p>
      </div>
    </div>
  ),
});

const FleetStatusGrid = dynamic(
  () =>
    import("@/components/fleet/FleetStatusGrid").then(
      (m) => m.FleetStatusGrid,
    ),
  { ssr: false },
);

const SelectedAircraftPanel = dynamic(
  () =>
    import("@/components/aircraft/SelectedAircraftPanel").then(
      (m) => m.SelectedAircraftPanel,
    ),
  { ssr: false },
);

const BlockchainFeed = dynamic(
  () => import("@/components/blockchain/BlockchainFeed"),
  { ssr: false },
);

const AnalyticsCharts = dynamic(
  () =>
    import("@/components/analytics/AnalyticsCharts").then(
      (m) => m.AnalyticsCharts,
    ),
  { ssr: false },
);

const AlertsPanel = dynamic(
  () =>
    import("@/components/alerts/AlertsPanel").then((m) => m.AlertsPanel),
  { ssr: false },
);

const EmergencyOverlay = dynamic(
  () => import("@/components/alerts/EmergencyOverlay"),
  { ssr: false },
);

const FundingStatus = dynamic(
  () => import("@/components/system/FundingStatus"),
  { ssr: false },
);

const TelemetryServicesSection = dynamic(
  () =>
    import("@/components/services/TelemetryServicesSection").then(
      (m) => m.TelemetryServicesSection,
    ),
  { ssr: false },
);

const AgentMarketplace = dynamic(
  () =>
    import("@/components/agents/AgentMarketplace").then(
      (m) => m.AgentMarketplace,
    ),
  { ssr: false },
);

/* ── Loading Skeleton ────────────────────────────────────────── */

function PanelSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={`panel animate-pulse flex items-center justify-center ${className ?? ""}`}
    >
      <div className="flex flex-col items-center gap-2">
        <div className="h-1 w-16 rounded-full bg-panel-border" />
        <span className="hud-label text-[10px]">Loading…</span>
      </div>
    </div>
  );
}

/* ── Dashboard Logo ───────────────────────────────────────────── */

function DashboardLogo() {
  return (
    <div className="flex flex-col items-center pt-[19rem] pb-[24rem] lg:pt-[22rem] lg:pb-[28rem] overflow-hidden">
      <div className="group relative">
        {/* Ambient glow behind logo */}
        <div
          aria-hidden
          className="absolute -inset-12 rounded-full opacity-40 blur-3xl animate-pulse-slow"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(0,245,255,0.25) 0%, rgba(0,245,255,0) 70%)",
          }}
        />

        {/* Secondary warm glow */}
        <div
          aria-hidden
          className="absolute -inset-16 rounded-full opacity-20 blur-3xl"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(255,184,0,0.15) 0%, transparent 70%)",
            animation: "glowShift 6s ease-in-out infinite alternate",
          }}
        />

        {/* Logo image */}
        <img
          src="/Airchive-logo.png"
          alt="Airchive"
          className="relative z-10 h-32 lg:h-44 w-auto object-contain drop-shadow-[0_0_40px_rgba(0,245,255,0.2)]"
          draggable={false}
        />

        {/* Sweeping light streak across the logo */}
        <div
          aria-hidden
          className="absolute inset-0 z-20 overflow-hidden pointer-events-none"
          style={{
            WebkitMaskImage: "url('/Airchive-logo.png')",
            WebkitMaskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            maskImage: "url('/Airchive-logo.png')",
            maskSize: "contain",
            maskRepeat: "no-repeat",
            maskPosition: "center",
          }}
        >
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.15) 45%, rgba(0,245,255,0.2) 50%, rgba(255,255,255,0.15) 55%, transparent 60%)",
              animation: "sheen 4s ease-in-out infinite",
            }}
          />
        </div>
      </div>
    </div>
  );
}

/* ── AE Map Banner ───────────────────────────────────────────── */

function AeMapBanner() {
  return (
    <section className="lg:col-span-12">
      <Link
        href="/ae"
        className="panel group relative block overflow-hidden px-3.5 py-2.5 transition-colors hover:border-electric-cyan/40 sm:px-5 sm:py-4"
      >
        {/* Soft cyan wash that answers the hover */}
        <div
          aria-hidden
          className="absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
          style={{
            background:
              "radial-gradient(ellipse at right center, rgba(0,245,255,0.07) 0%, transparent 60%)",
          }}
        />

        <div className="relative flex items-center justify-between gap-3 sm:gap-4">
          <div className="flex min-w-0 items-center gap-3 sm:gap-4">
            {/* Miniature polar disc */}
            <div className="relative h-8 w-8 shrink-0 sm:h-12 sm:w-12" aria-hidden>
              <div className="absolute inset-0 rounded-full border border-electric-cyan/50" />
              <div className="absolute inset-[5px] rounded-full border border-electric-cyan/30 sm:inset-[7px]" />
              <div className="absolute inset-[10px] rounded-full border border-electric-cyan/20 sm:inset-[14px]" />
              <div className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-electric-cyan shadow-[0_0_8px_rgba(0,245,255,0.8)] sm:h-1.5 sm:w-1.5" />
            </div>

            <div className="min-w-0">
              <p className="hud-label text-[9px] text-electric-cyan/70 sm:text-xs">
                Azimuthal Equidistant · North Polar
              </p>
              <p className="mt-0.5 font-mono text-xs leading-snug text-white sm:mt-1 sm:truncate sm:text-sm">
                See the fleet from a different perspective
                <span className="hidden sm:inline">
                  {" "}
                  — live flights across the polar disc
                </span>
              </p>
            </div>
          </div>

          <span className="shrink-0 whitespace-nowrap font-mono text-xs tracking-widest text-electric-cyan transition-transform duration-300 group-hover:translate-x-1">
            <span className="hidden sm:inline">OPEN AE MAP </span>→
          </span>
        </div>
      </Link>
    </section>
  );
}

/* ── Dashboard ───────────────────────────────────────────────── */

export default function DashboardPage() {
  useWebSocket();

  return (
    <main className="relative min-h-screen p-3 lg:p-4 overflow-x-hidden max-w-full">
      <EmergencyOverlay />

      <DashboardLogo />

      <div className="grid grid-cols-1 gap-3 lg:gap-4 lg:grid-cols-12 auto-rows-min">
        {/* ── Row 1: 3D Globe (full width, hero) ──────────── */}
        <section className="lg:col-span-12" style={{ minHeight: "50vh" }}>
          <Suspense fallback={<PanelSkeleton className="h-full min-h-[50vh]" />}>
            <GlobeView />
          </Suspense>
        </section>

        {/* ── Alternative projection: the /ae polar map ────── */}
        <AeMapBanner />

        {/* ── Row 2: Aircraft Telemetry Services (full width) ────── */}
        <Suspense fallback={<PanelSkeleton className="h-96 lg:col-span-12" />}>
          <TelemetryServicesSection />
        </Suspense>

        {/* ── Row 3: Fleet Status (7/12) + Selected Aircraft (5/12) */}
        <section className="lg:col-span-7">
          <Suspense fallback={<PanelSkeleton className="h-80" />}>
            <FleetStatusGrid />
          </Suspense>
        </section>

        <section className="lg:col-span-5">
          <Suspense fallback={<PanelSkeleton className="h-80" />}>
            <SelectedAircraftPanel />
          </Suspense>
        </section>

        {/* ── Row 4: Agent Marketplace (full width) ──────── */}
        <Suspense fallback={<PanelSkeleton className="h-72 lg:col-span-12" />}>
          <AgentMarketplace />
        </Suspense>

        {/* ── Row 5: Blockchain Feed (4/12) + Analytics (4/12) + Alerts (4/12) */}
        <section className="lg:col-span-4">
          <Suspense fallback={<PanelSkeleton className="h-72" />}>
            <BlockchainFeed />
          </Suspense>
        </section>

        <section className="lg:col-span-4 flex flex-col gap-3">
          <Suspense fallback={<PanelSkeleton className="h-72" />}>
            <AnalyticsCharts />
          </Suspense>
          <Link
            href="/wallets"
            className="group flex items-center justify-between gap-3 rounded-lg border border-panel-border/40 bg-panel-bg/30 px-4 py-3 backdrop-blur-lg transition-colors hover:border-electric-cyan/35 hover:bg-electric-cyan/5"
          >
            <div className="min-w-0">
              <p className="hud-label text-[9px]">Fleet wallets</p>
              <p className="text-sm text-white/85 group-hover:text-electric-cyan transition-colors">
                Aircraft Wallets
              </p>
              <p className="mt-0.5 text-[10px] text-hud-muted">
                BIP44 addresses, type and operator
              </p>
            </div>
            <span
              className="shrink-0 font-mono text-xs text-electric-cyan/70 group-hover:text-electric-cyan"
              aria-hidden="true"
            >
              →
            </span>
          </Link>
        </section>

        <section className="lg:col-span-4">
          <Suspense fallback={<PanelSkeleton className="h-72" />}>
            <AlertsPanel />
          </Suspense>
        </section>

        {/* ── Row 6: Treasury health ───────────────────────── */}
        <section className="lg:col-span-12">
          <Suspense fallback={<PanelSkeleton className="h-24" />}>
            <FundingStatus />
          </Suspense>
        </section>
      </div>

      {/* Footer */}
      <footer className="mt-6 pb-4 text-center">
        <p className="text-[10px] font-mono text-hud-muted/40 tracking-wider">
          AIRCHIVE v0.1.0 — Immutable Aviation Telemetry on BSV Blockchain
        </p>
      </footer>
    </main>
  );
}
