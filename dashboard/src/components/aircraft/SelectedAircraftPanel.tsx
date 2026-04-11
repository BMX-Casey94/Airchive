"use client";

import { useAircraftStore } from "@/stores/aircraft-store";
import type { AircraftTelemetry } from "@/stores/aircraft-store";
import { TRACKED_AIRCRAFT_MAP } from "@/lib/tracked-aircraft";
import { refinePhase } from "@/lib/refine-phase";
import Panel from "@/components/ui/Panel";
import DataReadout from "@/components/ui/DataReadout";
import PhaseBadge from "@/components/ui/PhaseBadge";
import { FlightPhase } from "@/types/airchive";
import {
  fmtAltitude,
  fmtSpeed,
  fmtHeading,
  fmtRelativeTime,
} from "@/lib/format";
import clsx from "clsx";

function phaseFromString(p: string): FlightPhase {
  return (FlightPhase as Record<string, FlightPhase>)[p] ?? FlightPhase.PARKED;
}

function verticalRateColour(fpm: number | null): string {
  if (fpm == null) return "text-hud-muted";
  const abs = Math.abs(fpm);
  if (abs < 500) return "text-signal-green";
  if (abs < 1500) return "text-neon-amber";
  return "text-alert-red";
}

function fmtVerticalRate(fpm: number | null | undefined): string {
  if (fpm == null) return "—";
  const sign = fpm >= 0 ? "+" : "";
  return `${sign}${Math.round(fpm).toLocaleString("en-GB")}`;
}

function fmtTemp(c: number | null | undefined): string {
  if (c == null || c === 0) return "—";
  return `${c > 0 ? "+" : ""}${c}°C`;
}

/**
 * Estimate pitch from vertical rate (fpm) and ground speed (kts).
 * pitch ≈ atan(vertical_speed / forward_speed) — both converted to ft/s.
 */
function estimatePitch(
  vRate: number | null | undefined,
  gs: number | null | undefined,
): number | null {
  if (vRate == null || gs == null || gs < 30) return null;
  const vFtPerSec = vRate / 60;
  const gsFtPerSec = gs * 1.68781;
  return (Math.atan2(vFtPerSec, gsFtPerSec) * 180) / Math.PI;
}

function AircraftDetail({ ac }: { ac: AircraftTelemetry }) {
  const info = TRACKED_AIRCRAFT_MAP.get(ac.icao);

  return (
    <div className="space-y-4">
      {/* Identity header */}
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-3">
            <span className="font-mono text-lg text-white">
              {ac.callsign || ac.icao.toUpperCase()}
            </span>
            <span className="font-mono text-[11px] text-hud-muted tabular-nums">
              {ac.icao.toUpperCase()}
            </span>
          </div>
          <span className="text-[11px] text-electric-cyan/70 font-mono">
            {ac.reg || info?.reg || "—"}
          </span>
        </div>
        <PhaseBadge phase={phaseFromString(refinePhase(ac))} />
      </div>

      {/* Aircraft identity */}
      <div className="rounded-lg border border-panel-border/20 bg-panel-bg/10 px-3 py-2 space-y-1">
        <p className="text-xs text-white">
          {ac.aircraftDesc || info?.desc || ac.aircraftType || info?.type || "Unknown type"}
        </p>
        {info?.operator && (
          <p className="text-[10px] text-hud-muted">{info.operator}</p>
        )}
        {ac.category && (
          <p className="text-[9px] text-hud-muted/60">
            ADS-B Category: {ac.category}
          </p>
        )}
      </div>

      {/* Squawk + ground status + emergency */}
      <div className="flex items-center gap-4 flex-wrap">
        {ac.squawk && (
          <div className="flex items-center gap-1.5">
            <span className="hud-label text-[9px]">Squawk</span>
            <span
              className={clsx(
                "font-mono text-sm tabular-nums",
                ac.squawk === "7700" || ac.squawk === "7600" || ac.squawk === "7500"
                  ? "text-alert-red font-bold animate-pulse"
                  : "text-electric-cyan",
              )}
            >
              {ac.squawk}
            </span>
          </div>
        )}
        {ac.emergency && ac.emergency !== "none" && (
          <span className="text-[10px] font-bold text-alert-red animate-pulse uppercase">
            {ac.emergency}
          </span>
        )}
        <div className="flex items-center gap-1.5">
          <span
            className={clsx(
              "inline-block h-2 w-2 rounded-full",
              ac.onGround ? "bg-neon-amber" : "bg-signal-green",
            )}
          />
          <span className="text-[10px] text-hud-muted">
            {ac.onGround ? "On Ground" : "Airborne"}
          </span>
        </div>
        <span className="text-[10px] font-mono text-hud-muted tabular-nums ml-auto">
          {fmtRelativeTime(ac.lastSeen)} ago
        </span>
      </div>

      {/* Primary readouts */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        <DataReadout label="Baro Altitude" value={fmtAltitude(ac.altitude)} unit="ft" />
        <DataReadout label="Geom Altitude" value={fmtAltitude(ac.altGeom)} unit="ft" />
        <DataReadout label="Ground Speed" value={fmtSpeed(ac.groundSpeed)} unit="kts" colour="text-electric-cyan" />
        <DataReadout label="Vertical Rate" value={fmtVerticalRate(ac.verticalRate)} unit="fpm" colour={verticalRateColour(ac.verticalRate)} />
        <DataReadout label="Track" value={fmtHeading(ac.heading)} />
        <DataReadout label="True Heading" value={fmtHeading(ac.trueHeading)} />
      </div>

      {/* Airspeed section */}
      <div className="border-t border-panel-border/30 pt-3">
        <span className="hud-label text-[9px] mb-2 block">Airspeed</span>
        <div className="grid grid-cols-3 gap-x-4 gap-y-2">
          <DataReadout label="IAS" value={ac.ias != null && ac.ias > 0 ? Math.round(ac.ias).toString() : "—"} unit="kts" />
          <DataReadout label="TAS" value={ac.tas != null && ac.tas > 0 ? Math.round(ac.tas).toString() : "—"} unit="kts" />
          <DataReadout label="Mach" value={ac.mach != null && ac.mach > 0 ? ac.mach.toFixed(3) : "—"} />
        </div>
      </div>

      {/* Attitude */}
      {(() => {
        const pitch = estimatePitch(ac.verticalRate, ac.groundSpeed);
        const hasRoll = ac.roll != null && ac.roll !== 0;
        const hasPitch = pitch != null;
        if (!hasRoll && !hasPitch) return null;
        return (
          <div className="border-t border-panel-border/30 pt-3">
            <span className="hud-label text-[9px] mb-2 block">Attitude</span>
            <div className="grid grid-cols-3 gap-x-4">
              <DataReadout
                label="Roll"
                value={hasRoll ? `${ac.roll! > 0 ? "+" : ""}${ac.roll!.toFixed(1)}°` : "—"}
              />
              <DataReadout
                label="Pitch (est.)"
                value={hasPitch ? `${pitch > 0 ? "+" : ""}${pitch.toFixed(1)}°` : "—"}
              />
              <DataReadout label="Mag Heading" value={fmtHeading(ac.magHeading)} />
            </div>
          </div>
        );
      })()}

      {/* Weather / atmosphere */}
      {((ac.windSpeed != null && ac.windSpeed > 0) || (ac.oat != null && ac.oat !== 0)) && (
        <div className="border-t border-panel-border/30 pt-3">
          <span className="hud-label text-[9px] mb-2 block">Atmosphere</span>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            {ac.windSpeed != null && ac.windSpeed > 0 && (
              <>
                <DataReadout label="Wind" value={`${Math.round(ac.windDir ?? 0)}° / ${Math.round(ac.windSpeed)} kts`} />
                <DataReadout label="QNH" value={ac.navQnh != null && ac.navQnh > 0 ? `${ac.navQnh.toFixed(1)} hPa` : "—"} />
              </>
            )}
            <DataReadout label="OAT" value={fmtTemp(ac.oat)} />
            <DataReadout label="TAT" value={fmtTemp(ac.tat)} />
          </div>
        </div>
      )}

      {/* Navigation */}
      {((ac.navAltMcp != null && ac.navAltMcp > 0) || (ac.navModes && ac.navModes.length > 0)) && (
        <div className="border-t border-panel-border/30 pt-3">
          <span className="hud-label text-[9px] mb-2 block">Navigation</span>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            <DataReadout label="Selected ALT (MCP)" value={ac.navAltMcp != null && ac.navAltMcp > 0 ? fmtAltitude(ac.navAltMcp) : "—"} unit="ft" />
            <DataReadout label="Selected ALT (FMS)" value={ac.navAltFms != null && ac.navAltFms > 0 ? fmtAltitude(ac.navAltFms) : "—"} unit="ft" />
            <DataReadout label="Nav Heading" value={ac.navHeading != null && ac.navHeading > 0 ? fmtHeading(ac.navHeading) : "—"} />
            {ac.navModes && ac.navModes.length > 0 && (
              <div className="flex flex-col">
                <span className="hud-label text-[8px]">Nav Modes</span>
                <span className="font-mono text-xs text-electric-cyan tabular-nums mt-0.5">
                  {ac.navModes.join(", ")}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Route */}
      {(ac.originIcao || ac.destIcao) && (
        <div className="border-t border-panel-border/30 pt-3">
          <span className="hud-label text-[9px] mb-2 block">Route</span>
          <div className="flex items-center gap-2 font-mono text-xs">
            <div className="flex flex-col items-center">
              <span className="text-electric-cyan font-semibold">
                {ac.originIcao ?? "—"}
              </span>
              {ac.originName && (
                <span className="text-[9px] text-hud-muted/70 max-w-[120px] truncate text-center">
                  {ac.originName}
                </span>
              )}
            </div>
            <span className="text-hud-muted/50 text-lg">→</span>
            <div className="flex flex-col items-center">
              <span className="text-electric-cyan font-semibold">
                {ac.destIcao ?? "—"}
              </span>
              {ac.destName && (
                <span className="text-[9px] text-hud-muted/70 max-w-[120px] truncate text-center">
                  {ac.destName}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Position */}
      <div className="border-t border-panel-border/30 pt-3">
        <span className="hud-label text-[9px]">Position</span>
        <p className="font-mono text-xs text-electric-cyan/80 tabular-nums mt-1">
          {ac.latitude != null && ac.longitude != null
            ? `${ac.latitude.toFixed(5)}°, ${ac.longitude.toFixed(5)}°`
            : "—"}
        </p>
      </div>

      {/* Flight ID */}
      {ac.flightId && (
        <div className="border-t border-panel-border/30 pt-3">
          <span className="hud-label text-[9px]">Flight Session</span>
          <p className="font-mono text-[10px] text-signal-green/80 tabular-nums mt-1">
            {ac.flightId}
          </p>
        </div>
      )}
    </div>
  );
}

export function SelectedAircraftPanel() {
  const fleet = useAircraftStore((s) => s.fleet);
  const selectedIcao = useAircraftStore((s) => s.selectedIcao);

  const ac = selectedIcao ? fleet.get(selectedIcao) ?? null : null;

  return (
    <Panel title="Selected Aircraft">
      {!ac ? (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <div className="h-10 w-10 rounded-full border border-muted-blue/30 flex items-center justify-center">
            <span className="text-hud-muted text-lg">✈</span>
          </div>
          <p className="text-sm text-hud-muted">
            Select an aircraft from the fleet grid to view telemetry.
          </p>
        </div>
      ) : (
        <AircraftDetail ac={ac} />
      )}
    </Panel>
  );
}
