import Link from "next/link";
import { RoiCalculator } from "@/components/blockchain/RoiCalculator";

export const metadata = {
  title: "Airchive — Demo",
  description: "Immutable flight data on the BSV blockchain — pitch and demo landing",
};

const features = [
  {
    title: "Real-time telemetry",
    body: "Fused ADS-B streams normalised into a single canonical record model, pushed live to operators and downstream services.",
    accent: "shadow-glow-cyan border-electric-cyan/30",
  },
  {
    title: "Adaptive write rates",
    body: "Phase-aware throttling reduces on-chain volume whilst preserving dense sampling during take-off, approach, and emergencies.",
    accent: "shadow-glow-amber border-neon-amber/30",
  },
  {
    title: "Flight event summaries",
    body: "Structured milestones — pushback, rotation, cruise, landing — ready for audit trails, insurers, and safety analytics.",
    accent: "shadow-glow-green border-signal-green/25",
  },
] as const;

export default function DemoPage() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-space-black text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(0,245,255,0.12),transparent)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(27,45,69,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(27,45,69,0.08)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />

      <div className="relative mx-auto flex max-w-5xl flex-col px-6 pb-24 pt-16 md:pt-24">
        <p className="hud-label mb-4 text-electric-cyan/90">BSV · aviation · immutability</p>
        <h1 className="font-sans text-5xl font-bold tracking-[0.2em] text-white md:text-7xl">
          AIRCHIVE
        </h1>
        <p className="mt-4 max-w-xl text-lg text-hud-muted md:text-xl">
          Immutable flight data on BSV blockchain
        </p>

        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {features.map((f) => (
            <article
              key={f.title}
              className={`panel flex flex-col border bg-panel-bg/70 p-6 backdrop-blur-md ${f.accent}`}
            >
              <h2 className="text-base font-semibold text-white">{f.title}</h2>
              <p className="mt-3 text-sm leading-relaxed text-hud-muted">{f.body}</p>
            </article>
          ))}
        </div>

        <div className="mt-12 flex flex-wrap items-center gap-4">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-lg bg-electric-cyan px-8 py-3 text-sm font-semibold uppercase tracking-widest text-space-black transition hover:bg-electric-cyan/90"
          >
            Enter dashboard
          </Link>
          <span className="text-xs text-hud-muted">
            Requires a running gateway and WebSocket endpoint (see README).
          </span>
        </div>

        <div className="mt-20">
          <RoiCalculator />
        </div>
      </div>
    </main>
  );
}
