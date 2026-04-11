"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";

const CARD_ACCENT =
  "border-electric-cyan/30 shadow-glow-cyan hover:border-electric-cyan/40";

const services = [
  {
    tag: "Black Box Integration",
    title: "Flight Data Recorder Companion",
    body:
      "Airchive operates as a parallel, tamper-proof data layer alongside traditional FDR/CVR systems. Full structured telemetry — altitude, heading, airspeed, vertical rate, engine parameters — is encoded into each on-chain record (compact MessagePack in OP_RETURN), so investigators can decode and read the actual sensor fields, not merely verify a digest.",
    stat: "Full payload",
    statLabel: "Decodable records",
  },
  {
    tag: "Immutable Telemetry",
    title: "Tamper-Proof Data at Source",
    body:
      "Telemetric payloads are cryptographically signed at the aircraft edge node before transmission. Once written to the BSV blockchain, records cannot be altered, deleted, or back-dated — providing regulators, insurers, and investigators with mathematically verifiable chain-of-custody from sensor to archive.",
    stat: "0",
    statLabel: "Mutable records",
  },
  {
    tag: "Continuous Archival",
    title: "Phase-Aware Write Cadence",
    body:
      "Adaptive sampling density increases during critical flight phases — take-off, approach, turbulence events, and emergency declarations — whilst throttling during stable cruise to optimise on-chain cost. Every phase transition is timestamped and anchored to an immutable milestone record.",
    stat: "≤ 1s",
    statLabel: "Critical-phase interval",
  },
  {
    tag: "Regulatory Compliance",
    title: "Audit-Ready Evidence Chain",
    body:
      "Full ICAO Annex 6 and EASA Part-CAT alignment. Blockchain-anchored records satisfy data-retention mandates with cryptographic proof of completeness — no gaps, no overwrites. Export flight envelopes, event summaries, and decoded telemetry in regulator-accepted formats at the click of a button.",
    stat: "100%",
    statLabel: "Data completeness",
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
          Aircraft Services
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
          cryptographically sealed and permanently archived on BSV, creating an
          unbreakable chain of evidence from wheels-up to touchdown.
        </p>
      </motion.div>

      {/* Service cards */}
      <motion.div
        variants={stagger}
        initial="hidden"
        animate={inView ? "visible" : "hidden"}
        className="grid gap-4 md:grid-cols-2 lg:grid-cols-4"
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
          Aircraft-grade immutability.
        </h3>
        <p className="text-sm text-hud-muted leading-relaxed max-w-3xl -mt-2">
          Designed for operators, insurers, and aviation regulators who demand
          tamper-proof telemetric evidence.
        </p>

        <div className="w-16 h-px bg-gradient-to-r from-transparent via-electric-cyan/30 to-transparent" />

        <p className="text-xs text-hud-muted/80 leading-relaxed max-w-2xl">
          Whether you operate a single aircraft or an entire fleet, Airchive
          integrates seamlessly with your existing avionics, ground stations,
          and maintenance systems. We work with airlines, MRO providers,
          charter operators, military organisations, and aviation regulators
          to deliver immutable telemetry as a service — no hardware changes
          required.
        </p>
        <p className="text-xs text-white/70 leading-relaxed max-w-2xl">
          Interested in protecting your flight data with blockchain-grade
          integrity?{" "}
          <span className="text-electric-cyan font-medium">
            Get in touch
          </span>{" "}
          to discuss integration, pricing, and a tailored proof-of-concept
          for your operation.
        </p>

        <span className="hud-label text-[10px] text-electric-cyan/50 mt-1">
          BSV · MessagePack · Ed25519
        </span>
      </motion.div>
    </section>
  );
}
