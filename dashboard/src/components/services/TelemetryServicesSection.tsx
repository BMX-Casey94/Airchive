"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";

const CARD_ACCENT =
  "border-electric-cyan/30 shadow-glow-cyan hover:border-electric-cyan/40";

const services = [
  {
    tag: "Surveillance Archival",
    title: "Independent ADS-B Record",
    body:
      "Airchive archives live ADS-B surveillance — position, altitude, ground speed, heading, vertical rate, squawk and ground state — as a public record independent of any operator-held recorder. Each field is encoded into the transaction itself, so the record is decoded and read directly from the chain rather than checked against a digest held elsewhere.",
    stat: "9 fields",
    statLabel: "Per decoded record",
  },
  {
    tag: "Append-Only Telemetry",
    title: "Fixed at the Point of Writing",
    body:
      "Every record is written in a transaction signed with the aircraft's own secp256k1 key and chained to that aircraft's previous write. Once mined, a record cannot be altered, removed or back-dated without breaking the chain. The Analyst agent publishes its fleet summaries the same way, giving a second, independently signed layer of evidence.",
    stat: "0",
    statLabel: "Mutable records",
  },
  {
    tag: "Continuous Archival",
    title: "Phase-Aware Write Cadence",
    body:
      "Adaptive sampling density increases during critical flight phases — take-off, approach, turbulence events, and emergency declarations — whilst throttling during stable cruise to optimise on-chain cost. The Monitor agent cycles through every tracked aircraft at sub-second intervals, querying live telemetry and anchoring phase-milestone inscriptions at each transition.",
    stat: "≤ 1s",
    statLabel: "Critical-phase interval",
  },
  {
    tag: "Verifiable Audit Trail",
    title: "Proof You Can Check Yourself",
    body:
      "Every mined record's inclusion proof is recomputed against a block header this system holds and has proof-of-work checked itself — SPV, with no reliance on a trusted explorer. Any record can be traced back to its block and re-verified independently, and the decoded evidence chain for a whole flight can be replayed from the chain alone.",
    stat: "SPV",
    statLabel: "Verified, not asserted",
  },
  {
    tag: "Agent Marketplace",
    title: "Autonomous Agent Network",
    body:
      "Three autonomous BSV agents — Collector, Analyst, and Monitor — operate continuously within the platform. Each holds its own on-chain identity and wallet. Agents discover one another via the BRC-100 identity registry and exchange telemetry data products through peer-to-peer micropayments, creating a self-sustaining, programmable data economy around every tracked flight.",
    stat: "3",
    statLabel: "Live agents",
  },
] as const;

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.12 } },
};

const fadeUp = {
  hidden: { opacity: 0, y: 32 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.55, ease: "easeOut" } },
};

export function TelemetryServicesSection() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });

  return (
    <section ref={ref} className="lg:col-span-12 py-6">
      {/* Decorative divider */}
      <div className="flex items-center gap-4 mb-10">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-electric-cyan/20 to-transparent" />
        <span className="hud-label text-electric-cyan/70 whitespace-nowrap">
          Platform Capabilities
        </span>
        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-electric-cyan/20 to-transparent" />
      </div>

      {/* Headline block */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={inView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.5 }}
        className="text-center mb-12 max-w-3xl mx-auto"
      >
        <p className="hud-label text-neon-amber/80 mb-3 tracking-[0.25em]">
          Beyond the Black Box
        </p>
        <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold tracking-tight text-white leading-tight">
          <span className="block">Immutable Aircraft</span>
          <span className="block text-electric-cyan mt-1 md:mt-2">
            Telemetric Data
          </span>
        </h2>
        <p className="mt-5 text-xs md:text-sm text-hud-muted leading-relaxed max-w-2xl mx-auto">
          Airchive extends the aircraft black box into the blockchain era.
          Every sensor reading, every flight event, every phase transition —
          cryptographically sealed and permanently archived on BSV. A network
          of autonomous agents continuously monitors, analyses, and trades
          telemetry data on-chain, creating an unbreakable, self-auditing
          chain of evidence from wheels-up to touchdown.
        </p>
      </motion.div>

      {/* Service cards */}
      <motion.div
        variants={stagger}
        initial="hidden"
        animate={inView ? "visible" : "hidden"}
        className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
      >
        {services.map((s) => (
          <motion.article
            key={s.title}
            variants={fadeUp}
            className={`group relative panel flex flex-col items-center text-center border bg-panel-bg/50 backdrop-blur-xl p-6 transition-all duration-300 hover:bg-panel-bg/70 hover:scale-[1.015] ${CARD_ACCENT}`}
          >
            <span className="hud-label text-[10px] text-electric-cyan/70 mb-2">
              {s.tag}
            </span>

            <h3 className="text-base font-semibold text-white mb-2 leading-snug">
              {s.title}
            </h3>

            <p className="text-sm leading-relaxed text-hud-muted flex-1">
              {s.body}
            </p>

            <div className="mt-5 pt-4 border-t border-panel-border/30 w-full flex flex-col items-center gap-1">
              <span className="data-readout text-lg text-electric-cyan">
                {s.stat}
              </span>
              <span className="text-[10px] uppercase tracking-widest text-electric-cyan/50">
                {s.statLabel}
              </span>
            </div>
          </motion.article>
        ))}
      </motion.div>

      {/* Bottom CTA strip */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={inView ? { opacity: 1 } : {}}
        transition={{ delay: 0.6, duration: 0.5 }}
        className="mt-10 panel border border-electric-cyan/20 bg-panel-bg/40 backdrop-blur-xl px-8 py-8 flex flex-col items-center text-center gap-5"
      >
        <h3 className="text-base md:text-lg text-white font-semibold tracking-wide">
          Aircraft-grade immutability. Autonomous intelligence.
        </h3>
        <p className="text-sm text-hud-muted leading-relaxed max-w-3xl -mt-2">
          Designed for operators, insurers, and aviation regulators who demand
          tamper-proof telemetric evidence — backed by a live network of
          autonomous agents that never stop watching.
        </p>

        <div className="w-16 h-px bg-gradient-to-r from-transparent via-electric-cyan/30 to-transparent" />

        <p className="text-xs text-hud-muted/80 leading-relaxed max-w-2xl">
          Airchive archives the ADS-B signal your aircraft already broadcasts,
          so nothing needs to be fitted or changed to start building a record.
          Autonomous Collector, Analyst, and Monitor agents operate
          continuously — ingesting live telemetry, running anomaly detection,
          and publishing signed fleet analyses directly to the BSV blockchain.
          We are building towards deployments with airlines, MRO providers,
          charter operators, and aviation authorities.
        </p>
        <p className="text-xs text-white/70 leading-relaxed max-w-2xl">
          Interested in protecting your flight data with blockchain-grade
          integrity?{" "}
          <a
            href="https://x.com/BSVCasey"
            target="_blank"
            rel="noopener noreferrer"
            className="text-electric-cyan font-medium hover:text-electric-cyan/80 transition-colors underline-offset-2 hover:underline"
          >
            Get in touch
          </a>{" "}
          to discuss integration, pricing, and a tailored proof-of-concept
          for your operation.
        </p>

        <span className="hud-label text-[10px] text-electric-cyan/50 mt-1">
          BSV · MessagePack · secp256k1 · SPV · BRC-100
        </span>
      </motion.div>
    </section>
  );
}
