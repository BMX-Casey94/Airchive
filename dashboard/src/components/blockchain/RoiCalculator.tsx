"use client";

import { animate } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

/**
 * Weighted-average tx/s during active flight, derived from Airchive's
 * actual write-rate table and a typical commercial phase mix:
 *   CRUISE  70% @ 3s  = 0.333 tx/s
 *   CLIMB   8%  @ 1s  = 1.000 tx/s
 *   DESCENT 7%  @ 2s  = 0.500 tx/s
 *   APPROACH 5% @ 2s  = 0.500 tx/s
 *   TAKEOFF 2%  @ 1s  = 1.000 tx/s
 *   LANDING 2%  @ 1s  = 1.000 tx/s
 *   TAXI    6%  @ 15s = 0.067 tx/s
 *   Weighted ≈ 0.39 tx/s
 */
const ADAPTIVE_TX_PER_SECOND = 0.39;

const BSV_PRICE_GBP = 11.9;

/**
 * Fee = ceil((bytes / 1000) × 100 × 1.1)
 * Aircraft telemetry tx ≈ 738 bytes → ceil(0.738 × 110) = 82 sats
 * Agent tx ≈ 226 bytes → ceil(0.226 × 110) = 25 sats
 * The calculator models aircraft telemetry (the vast majority of writes).
 */
const SATS_PER_TX = 82;
const BSV_PER_TX = SATS_PER_TX / 100_000_000;

const gbpFormatter = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const intFormatter = new Intl.NumberFormat("en-GB");

function useAnimatedNumber(target: number, durationSec = 0.55): number {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);

  useEffect(() => {
    const start = fromRef.current;
    const controls = animate(start, target, {
      duration: durationSec,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (latest) => setDisplay(latest),
      onComplete: () => {
        fromRef.current = target;
      },
    });
    return () => controls.stop();
  }, [target, durationSec]);

  return display;
}

export function RoiCalculator({ className }: { className?: string }) {
  const [aircraft, setAircraft] = useState(50);
  const [hoursPerDay, setHoursPerDay] = useState(8);

  const flightSecondsPerDay = aircraft * hoursPerDay * 3600;

  const constantTx = Math.round(flightSecondsPerDay);
  const adaptiveTx = Math.round(flightSecondsPerDay * ADAPTIVE_TX_PER_SECOND);

  const constantBsv = constantTx * BSV_PER_TX;
  const adaptiveBsv = adaptiveTx * BSV_PER_TX;

  const constantGbp = constantBsv * BSV_PRICE_GBP;
  const adaptiveGbp = adaptiveBsv * BSV_PRICE_GBP;

  const savingsGbp = constantGbp - adaptiveGbp;
  const savingsPct =
    constantGbp > 0 ? Math.min(100, Math.max(0, (savingsGbp / constantGbp) * 100)) : 0;

  const animConstantTx = useAnimatedNumber(constantTx);
  const animAdaptiveTx = useAnimatedNumber(adaptiveTx);
  const animConstantGbp = useAnimatedNumber(constantGbp);
  const animAdaptiveGbp = useAnimatedNumber(adaptiveGbp);
  const animSavingsGbp = useAnimatedNumber(savingsGbp);
  const animSavingsPct = useAnimatedNumber(savingsPct);

  const adaptiveSats = adaptiveTx * SATS_PER_TX;
  const animAdaptiveSats = useAnimatedNumber(adaptiveSats);

  return (
    <section
      className={clsx(
        "panel relative overflow-hidden border-electric-cyan/20",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-electric-cyan/[0.03] via-transparent to-neon-amber/[0.03]" />
      <div className="relative p-6 md:p-8">
        <div className="flex items-center gap-3 mb-1">
          <div className="h-px flex-1 bg-gradient-to-r from-electric-cyan/40 to-transparent" />
          <span className="hud-label text-electric-cyan/80">Economics</span>
          <div className="h-px flex-1 bg-gradient-to-l from-electric-cyan/40 to-transparent" />
        </div>
        <h2 className="text-center font-sans text-xl font-semibold tracking-tight text-white md:text-2xl">
          On-Chain Write Cost Calculator
        </h2>
        <p className="mx-auto mt-2 max-w-2xl text-center text-sm text-hud-muted">
          Compare a naive 1 tx/s per in-flight aircraft against Airchive&apos;s adaptive
          phase-based write rate. Adjust the sliders to model your fleet.
        </p>

        {/* Sliders */}
        <div className="mt-8 grid gap-8 md:grid-cols-2">
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="hud-label">Fleet size</span>
              <span className="data-readout text-2xl font-bold">{intFormatter.format(aircraft)}</span>
            </div>
            <input
              type="range"
              min={1}
              max={500}
              value={aircraft}
              onChange={(e) => setAircraft(Number(e.target.value))}
              className="w-full h-2 rounded-full appearance-none cursor-pointer bg-panel-border/60
                [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5
                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-electric-cyan
                [&::-webkit-slider-thumb]:shadow-[0_0_12px_rgba(0,245,255,0.5)]
                [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-electric-cyan/60
                [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full
                [&::-moz-range-thumb]:bg-electric-cyan [&::-moz-range-thumb]:border-2
                [&::-moz-range-thumb]:border-electric-cyan/60"
            />
            <div className="flex justify-between text-[10px] text-hud-muted">
              <span>1</span>
              <span>500</span>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="hud-label">Avg flight hours / aircraft / day</span>
              <span className="data-readout text-2xl font-bold">{hoursPerDay}h</span>
            </div>
            <input
              type="range"
              min={1}
              max={18}
              step={0.5}
              value={hoursPerDay}
              onChange={(e) => setHoursPerDay(Number(e.target.value))}
              className="w-full h-2 rounded-full appearance-none cursor-pointer bg-panel-border/60
                [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5
                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-neon-amber
                [&::-webkit-slider-thumb]:shadow-[0_0_12px_rgba(255,184,0,0.5)]
                [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-neon-amber/60
                [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full
                [&::-moz-range-thumb]:bg-neon-amber [&::-moz-range-thumb]:border-2
                [&::-moz-range-thumb]:border-neon-amber/60"
            />
            <div className="flex justify-between text-[10px] text-hud-muted">
              <span>1h</span>
              <span>18h</span>
            </div>
          </div>
        </div>

        {/* Results cards */}
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border border-panel-border/50 bg-deep-navy/40 p-5">
            <span className="hud-label text-alert-red/80">Naive 1 tx/s</span>
            <p className="mt-2 data-readout text-2xl text-white">
              {intFormatter.format(Math.round(animConstantTx))}
            </p>
            <p className="text-xs text-hud-muted">transactions / day</p>
            <p className="mt-2 text-sm font-semibold text-neon-amber">
              {gbpFormatter.format(animConstantGbp)}
            </p>
          </div>

          <div className="rounded-lg border border-electric-cyan/30 bg-electric-cyan/[0.04] p-5">
            <span className="hud-label text-electric-cyan">Airchive adaptive</span>
            <p className="mt-2 data-readout text-2xl text-electric-cyan">
              {intFormatter.format(Math.round(animAdaptiveTx))}
            </p>
            <p className="text-xs text-hud-muted">transactions / day</p>
            <p className="mt-2 text-sm font-semibold text-neon-amber">
              {gbpFormatter.format(animAdaptiveGbp)}
            </p>
            <p className="mt-1 text-xs text-hud-muted">
              {intFormatter.format(Math.round(animAdaptiveSats))} sats total
            </p>
          </div>

          <div className="rounded-lg border border-signal-green/30 bg-signal-green/[0.04] p-5">
            <span className="hud-label text-signal-green">Savings</span>
            <p className="mt-2 text-2xl font-bold text-signal-green">
              {gbpFormatter.format(animSavingsGbp)}
            </p>
            <p className="text-xs text-hud-muted">per day vs naive approach</p>
            <p className="mt-2 data-readout text-lg text-signal-green">
              {animSavingsPct.toFixed(1)}%
            </p>
            <p className="text-xs text-hud-muted">lower chain footprint</p>
          </div>
        </div>

        {/* Write rate breakdown */}
        <div className="mt-6 overflow-hidden rounded-lg border border-panel-border/40 bg-deep-navy/30">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-panel-border/40">
                <th className="px-4 py-2.5 font-medium text-hud-muted">Phase</th>
                <th className="px-4 py-2.5 font-medium text-hud-muted">Interval</th>
                <th className="px-4 py-2.5 font-medium text-hud-muted">tx/s</th>
                <th className="px-4 py-2.5 font-medium text-hud-muted">% of flight</th>
              </tr>
            </thead>
            <tbody className="tabular-nums text-slate-300">
              <tr className="border-b border-panel-border/20">
                <td className="px-4 py-2">TAKEOFF / LANDING</td>
                <td className="px-4 py-2 data-readout">1s</td>
                <td className="px-4 py-2 data-readout">1.00</td>
                <td className="px-4 py-2 text-hud-muted">~4%</td>
              </tr>
              <tr className="border-b border-panel-border/20">
                <td className="px-4 py-2">CLIMB</td>
                <td className="px-4 py-2 data-readout">1s</td>
                <td className="px-4 py-2 data-readout">1.00</td>
                <td className="px-4 py-2 text-hud-muted">~8%</td>
              </tr>
              <tr className="border-b border-panel-border/20">
                <td className="px-4 py-2">DESCENT / APPROACH</td>
                <td className="px-4 py-2 data-readout">2s</td>
                <td className="px-4 py-2 data-readout">0.50</td>
                <td className="px-4 py-2 text-hud-muted">~12%</td>
              </tr>
              <tr className="border-b border-panel-border/20 bg-electric-cyan/[0.02]">
                <td className="px-4 py-2 font-medium text-electric-cyan">CRUISE</td>
                <td className="px-4 py-2 data-readout">3s</td>
                <td className="px-4 py-2 data-readout">0.33</td>
                <td className="px-4 py-2 text-hud-muted">~70%</td>
              </tr>
              <tr>
                <td className="px-4 py-2">TAXI</td>
                <td className="px-4 py-2 data-readout">15s</td>
                <td className="px-4 py-2 data-readout">0.07</td>
                <td className="px-4 py-2 text-hud-muted">~6%</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-1 text-[11px] text-hud-muted">
          <span>BSV price: <strong className="text-slate-300">£{BSV_PRICE_GBP.toFixed(2)}</strong></span>
          <span>Avg fee: <strong className="text-slate-300">{SATS_PER_TX} sats/tx</strong> (110 sat/KB × ~738 bytes)</span>
          <span>Effective rate: <strong className="text-slate-300">~{ADAPTIVE_TX_PER_SECOND} tx/s</strong> (weighted avg)</span>
          <span>Emergency: <strong className="text-alert-red/80">1s</strong> (squawk 7700/7600/7500)</span>
        </div>
      </div>
    </section>
  );
}
