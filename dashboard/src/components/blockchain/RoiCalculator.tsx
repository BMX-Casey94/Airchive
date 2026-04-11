"use client";

import { animate } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

/** Illustrative effective chain-write rate vs continuous 1 tx/s, derived from typical phase mix (CRUISE, TAXI, etc.). */
const ADAPTIVE_TX_PER_SECOND = 0.16;

const gbpFormatter = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
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

export interface RoiCalculatorProps {
  /** Spot BSV price in GBP for fee estimates (pitch default £32). */
  bsvPriceGbp?: number;
  /** Estimated average BSV consumed per on-chain telemetry write (nominal; network-dependent). */
  bsvPerTx?: number;
  className?: string;
}

export function RoiCalculator({
  bsvPriceGbp = 32,
  bsvPerTx = 0.000_004,
  className,
}: RoiCalculatorProps) {
  const [aircraft, setAircraft] = useState(24);
  const [hoursPerDay, setHoursPerDay] = useState(8);

  const flightSecondsPerDay = aircraft * hoursPerDay * 3600;

  const constantTx = Math.round(flightSecondsPerDay);
  const adaptiveTx = Math.round(flightSecondsPerDay * ADAPTIVE_TX_PER_SECOND);

  const constantBsv = constantTx * bsvPerTx;
  const adaptiveBsv = adaptiveTx * bsvPerTx;

  const constantGbp = constantBsv * bsvPriceGbp;
  const adaptiveGbp = adaptiveBsv * bsvPriceGbp;

  const savingsGbp = constantGbp - adaptiveGbp;
  const savingsPct =
    constantGbp > 0 ? Math.min(100, Math.max(0, (savingsGbp / constantGbp) * 100)) : 0;

  const animConstantTx = useAnimatedNumber(constantTx);
  const animAdaptiveTx = useAnimatedNumber(adaptiveTx);
  const animConstantBsv = useAnimatedNumber(constantBsv);
  const animAdaptiveBsv = useAnimatedNumber(adaptiveBsv);
  const animConstantGbp = useAnimatedNumber(constantGbp);
  const animAdaptiveGbp = useAnimatedNumber(adaptiveGbp);
  const animSavingsGbp = useAnimatedNumber(savingsGbp);
  const animSavingsPct = useAnimatedNumber(savingsPct);

  const fdrLow = aircraft * 15_000;
  const fdrHigh = aircraft * 40_000;

  return (
    <section
      className={clsx(
        "panel relative overflow-hidden border-electric-cyan/25 shadow-glow-cyan",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-electric-cyan/5 via-transparent to-neon-amber/5" />
      <div className="relative p-6 md:p-8">
        <h2 className="font-sans text-lg font-semibold tracking-tight text-white md:text-xl">
          Chain write economics (pitch)
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-hud-muted">
          Compare a constant 1 transaction per second per in-flight aircraft against Airchive&apos;s
          adaptive phase-based rate. Figures are indicative for stakeholder discussions, not
          financial advice.
        </p>

        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <label className="flex flex-col gap-2">
            <span className="hud-label">Aircraft in scope</span>
            <input
              type="range"
              min={1}
              max={1000}
              value={aircraft}
              onChange={(e) => setAircraft(Number(e.target.value))}
              className="accent-electric-cyan"
            />
            <span className="data-readout text-lg">{intFormatter.format(aircraft)}</span>
          </label>
          <label className="flex flex-col gap-2">
            <span className="hud-label">Average flight hours per aircraft per day</span>
            <input
              type="range"
              min={0}
              max={24}
              step={0.5}
              value={hoursPerDay}
              onChange={(e) => setHoursPerDay(Number(e.target.value))}
              className="accent-neon-amber"
            />
            <span className="data-readout text-lg">{hoursPerDay} h</span>
          </label>
        </div>

        <div className="mt-8 overflow-x-auto rounded-lg border border-panel-border bg-deep-navy/60">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-panel-border bg-panel-bg/80">
                <th className="px-4 py-3 font-medium text-hud-muted">Model</th>
                <th className="px-4 py-3 font-medium text-electric-cyan">Tx / day (fleet)</th>
                <th className="px-4 py-3 font-medium text-electric-cyan">BSV (est.)</th>
                <th className="px-4 py-3 font-medium text-electric-cyan">GBP (est.)</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              <tr className="border-b border-panel-border/80">
                <td className="px-4 py-3 font-medium text-white">Constant 1 tx/s</td>
                <td className="data-readout px-4 py-3">
                  {intFormatter.format(Math.round(animConstantTx))}
                </td>
                <td className="data-readout px-4 py-3 text-white/90">
                  {animConstantBsv.toFixed(6)}
                </td>
                <td className="data-readout px-4 py-3 text-neon-amber">
                  {gbpFormatter.format(animConstantGbp)}
                </td>
              </tr>
              <tr className="border-b border-panel-border/80">
                <td className="px-4 py-3 font-medium text-white">
                  Adaptive rate
                  <span className="mt-0.5 block text-xs font-normal text-hud-muted">
                    ~{ADAPTIVE_TX_PER_SECOND} tx/s equivalent (illustrative)
                  </span>
                </td>
                <td className="data-readout px-4 py-3">
                  {intFormatter.format(Math.round(animAdaptiveTx))}
                </td>
                <td className="data-readout px-4 py-3 text-white/90">
                  {animAdaptiveBsv.toFixed(6)}
                </td>
                <td className="data-readout px-4 py-3 text-neon-amber">
                  {gbpFormatter.format(animAdaptiveGbp)}
                </td>
              </tr>
              <tr className="bg-signal-green/5">
                <td className="px-4 py-3 font-semibold text-signal-green">Savings vs constant</td>
                <td className="px-4 py-3 text-hud-muted" colSpan={2}>
                  —
                </td>
                <td className="data-readout px-4 py-3 text-signal-green">
                  <span className="block">{gbpFormatter.format(animSavingsGbp)}</span>
                  <span className="text-xs text-signal-green/80">
                    {animSavingsPct.toFixed(1)}% lower chain footprint
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="mt-6 rounded-lg border border-neon-amber/25 bg-neon-amber/5 p-4">
          <h3 className="text-sm font-semibold text-neon-amber">vs. traditional FDR hardware</h3>
          <p className="mt-2 text-sm text-white/85">
            Industry FDR acquisition and lifecycle costs are often quoted around{" "}
            <strong className="text-white">£15,000–£40,000 per aircraft</strong> (capital,
            fit, certification, and maintenance vary widely). For this fleet size, that implies
            roughly{" "}
            <span className="data-readout text-neon-amber">
              {gbpFormatter.format(fdrLow)} – {gbpFormatter.format(fdrHigh)}
            </span>{" "}
            in hardware-class spend — before immutable, operator-owned chain records.
          </p>
        </div>

        <p className="mt-4 text-xs text-hud-muted">
          BSV price assumption: {gbpFormatter.format(bsvPriceGbp)} per BSV · {bsvPerTx} BSV per tx
          (adjust via component props for live pitch scenarios).
        </p>
      </div>
    </section>
  );
}
