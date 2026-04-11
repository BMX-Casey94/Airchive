"use client";

import { useRef, useEffect } from "react";
import clsx from "clsx";
import { useAlertStore } from "@/stores/alert-store";
import { AlertSeverity } from "@/types/airchive";
import type { AlertRecord } from "@/types/airchive";
import { fmtTimePrecise } from "@/lib/format";
import Panel from "@/components/ui/Panel";

const SEVERITY_ICON: Record<string, string> = {
  INFO: "ℹ",
  WARNING: "⚠",
  CRITICAL: "✦",
  EMERGENCY: "☢",
};

const SEVERITY_COLOUR: Record<string, string> = {
  INFO: "text-blue-400/70",
  WARNING: "text-neon-amber",
  CRITICAL: "text-alert-red",
  EMERGENCY: "text-alert-red animate-pulse",
};

const ROW_BG: Record<string, string> = {
  INFO: "",
  WARNING: "",
  CRITICAL: "bg-alert-red/5",
  EMERGENCY: "bg-alert-red/10",
};

export function AlertsPanel() {
  const alerts = useAlertStore((s) => s.alerts);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [alerts.length]);

  const unackCount = alerts.filter((a) => !a.acknowledged).length;

  const badge =
    unackCount > 0 ? (
      <span className="rounded-full bg-alert-red/20 border border-alert-red/40 px-2 py-0.5 text-[10px] font-mono text-alert-red tabular-nums">
        {unackCount} unacknowledged
      </span>
    ) : null;

  return (
    <Panel title="Alert Log" headerAction={badge}>
      <div
        ref={scrollRef}
        className="max-h-[360px] overflow-y-auto -mx-4 -mb-4 px-4 pb-4"
      >
        {alerts.map((alert) => (
          <AlertRow key={alert.id} alert={alert} />
        ))}

        {alerts.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <div className="h-10 w-10 rounded-full border border-signal-green/30 flex items-center justify-center">
              <span className="text-signal-green text-sm">✓</span>
            </div>
            <p className="text-sm text-hud-muted">
              No alerts recorded.
            </p>
            <p className="text-[10px] text-hud-muted/60">
              Alerts will appear for squawk changes, emergency codes, and anomalies.
            </p>
          </div>
        )}
      </div>
    </Panel>
  );
}

function AlertRow({ alert }: { alert: AlertRecord }) {
  const isSquawkEmergency =
    alert.severity === AlertSeverity.EMERGENCY &&
    ["7700", "7600", "7500"].includes(
      (alert.data?.["squawk"] as string) ?? "",
    );

  return (
    <div
      className={clsx(
        "flex items-start gap-2.5 py-2 border-b border-panel-border last:border-b-0",
        ROW_BG[alert.severity] ?? "",
        isSquawkEmergency && "animate-pulse-slow -mx-4 px-4 bg-alert-red/15",
      )}
    >
      <span
        className={clsx(
          "flex-shrink-0 text-sm leading-none mt-0.5",
          SEVERITY_COLOUR[alert.severity] ?? "text-hud-muted",
        )}
        aria-label={alert.severity}
      >
        {SEVERITY_ICON[alert.severity] ?? "•"}
      </span>

      <span className="flex-shrink-0 font-mono text-[10px] text-hud-muted tabular-nums mt-0.5 w-[82px]">
        {fmtTimePrecise(
          alert.created_at instanceof Date
            ? alert.created_at.getTime()
            : new Date(alert.created_at).getTime(),
        )}
      </span>

      <span className="flex-shrink-0 rounded bg-deep-navy px-1.5 py-0.5 font-mono text-[10px] text-electric-cyan tabular-nums border border-panel-border">
        {alert.aircraft_icao.toUpperCase()}
      </span>

      <p
        className={clsx(
          "flex-1 text-[11px] leading-snug min-w-0",
          alert.severity === AlertSeverity.EMERGENCY
            ? "text-alert-red font-medium"
            : "text-white/80",
        )}
      >
        {alert.message}
      </p>
    </div>
  );
}
