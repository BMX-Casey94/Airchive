"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useAlertStore } from "@/stores/alert-store";

const SQUAWK_DESCRIPTIONS: Record<string, string> = {
  "7700": "General Emergency",
  "7600": "Radio Failure (NORDO)",
  "7500": "Unlawful Interference (Hijack)",
};

export default function EmergencyOverlay() {
  const emergencyActive = useAlertStore((s) => s.emergencyActive);
  const emergencyInfo = useAlertStore((s) => s.emergencyInfo);
  const dismiss = useAlertStore((s) => s.dismissEmergency);

  return (
    <AnimatePresence>
      {emergencyActive && emergencyInfo && (
        <motion.div
          key="emergency-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm"
        >
          <motion.div
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.8, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 20 }}
            className="relative flex flex-col items-center gap-6 rounded-2xl border border-alert-red/50 bg-panel-bg/95 px-10 py-10 shadow-glow-red max-w-md mx-4"
          >
            {/* Pulsing warning icon */}
            <div className="relative flex items-center justify-center">
              <span className="absolute h-20 w-20 rounded-full bg-alert-red/20 animate-ping" />
              <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-alert-red/30 border-2 border-alert-red text-3xl">
                ⚠
              </span>
            </div>

            {/* Squawk code */}
            <div className="flex flex-col items-center gap-1">
              <span className="font-mono text-4xl font-bold text-alert-red tabular-nums tracking-wider">
                {emergencyInfo.squawk}
              </span>
              <span className="text-sm text-alert-red/80 uppercase tracking-widest">
                {SQUAWK_DESCRIPTIONS[emergencyInfo.squawk] ??
                  emergencyInfo.description}
              </span>
            </div>

            {/* Aircraft info */}
            <div className="flex flex-col items-center gap-1">
              <span className="font-mono text-xl text-white">
                {emergencyInfo.callsign || emergencyInfo.icao}
              </span>
              <span className="font-mono text-xs text-hud-muted tabular-nums">
                ICAO {emergencyInfo.icao.toUpperCase()}
              </span>
            </div>

            {/* Acknowledge button */}
            <button
              type="button"
              onClick={dismiss}
              className="mt-2 rounded-lg border border-alert-red/50 bg-alert-red/20 px-8 py-2.5 text-sm font-mono uppercase tracking-widest text-alert-red transition-colors hover:bg-alert-red/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-alert-red/50"
            >
              Acknowledge
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
