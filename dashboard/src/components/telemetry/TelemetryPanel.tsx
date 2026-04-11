"use client";

import clsx from "clsx";
import { useSelectedAircraft } from "@/stores/fleet-store";
import {
  fmtAltitude,
  fmtSpeed,
  fmtMach,
  fmtHeading,
  fmtVerticalRate,
  fmtWind,
} from "@/lib/format";
import Panel from "@/components/ui/Panel";
import DataReadout from "@/components/ui/DataReadout";
import PhaseBadge from "@/components/ui/PhaseBadge";
import AltitudeChart from "@/components/telemetry/AltitudeChart";
import SpeedChart from "@/components/telemetry/SpeedChart";

function verticalRateColour(fpm: number): string {
  const abs = Math.abs(fpm);
  if (abs < 500) return "text-signal-green";
  if (abs < 1500) return "text-neon-amber";
  return "text-alert-red";
}

export default function TelemetryPanel() {
  const aircraft = useSelectedAircraft();

  if (!aircraft) {
    return (
      <Panel title="Telemetry">
        <div className="flex items-center justify-center py-16 text-hud-muted text-sm">
          Select an aircraft to view telemetry.
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Telemetry"
      headerAction={
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-white">
            {aircraft.callsign || aircraft.icao.toUpperCase()}
          </span>
          <PhaseBadge phase={aircraft.phase} />
        </div>
      }
    >
      <div className="space-y-5">
        {/* Primary readouts — 2-column grid */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <DataReadout
            label="Baro Altitude"
            value={fmtAltitude(aircraft.alt_baro)}
            unit="ft"
          />
          <DataReadout
            label="Geom Altitude"
            value={fmtAltitude(aircraft.alt_geom)}
            unit="ft"
          />
          <DataReadout
            label="Ground Speed"
            value={fmtSpeed(aircraft.gs)}
            unit="kts"
            colour="text-electric-cyan"
          />
          <DataReadout
            label="Indicated Airspeed"
            value={fmtSpeed(aircraft.ias)}
            unit="kts"
            colour="text-signal-green"
          />
          <DataReadout
            label="True Airspeed"
            value={fmtSpeed(aircraft.tas)}
            unit="kts"
            colour="text-neon-amber"
          />
          <DataReadout label="Mach" value={fmtMach(aircraft.mach)} />
          <DataReadout
            label="Heading"
            value={fmtHeading(aircraft.track)}
          />
          <DataReadout
            label="Mag Heading"
            value={fmtHeading(aircraft.mag_heading)}
          />
          <DataReadout
            label="Vertical Rate"
            value={fmtVerticalRate(aircraft.baro_rate)}
            unit="fpm"
            colour={verticalRateColour(aircraft.baro_rate)}
          />
          <DataReadout
            label="Wind"
            value={fmtWind(aircraft.wind_dir, aircraft.wind_speed)}
          />
        </div>

        {/* Nav modes */}
        {aircraft.nav_modes.length > 0 && (
          <div>
            <span className="hud-label">Nav Modes</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {aircraft.nav_modes.map((mode) => (
                <span
                  key={mode}
                  className="rounded border border-panel-border bg-deep-navy px-2 py-0.5 font-mono text-[10px] text-electric-cyan/80"
                >
                  {mode}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Charts */}
        <div className="space-y-4">
          <div>
            <span className="hud-label mb-2 block">Altitude Profile</span>
            <AltitudeChart />
          </div>
          <div>
            <span className="hud-label mb-2 block">Speed Profile</span>
            <SpeedChart />
          </div>
        </div>
      </div>
    </Panel>
  );
}
