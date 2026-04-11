"use client";

import { useAircraftStore } from "@/stores/aircraft-store";
import type { AircraftTelemetry } from "@/stores/aircraft-store";
import { TRACKED_AIRCRAFT, TRACKED_AIRCRAFT_MAP } from "@/lib/tracked-aircraft";
import { refinePhase } from "@/lib/refine-phase";
import PhaseBadge from "@/components/ui/PhaseBadge";
import { FlightPhase } from "@/types/airchive";
import { fmtAltitude, fmtSpeed, fmtHeading, fmtRelativeTime } from "@/lib/format";
import { motion } from "framer-motion";
import clsx from "clsx";
import Panel from "@/components/ui/Panel";

function phaseFromString(p: string): FlightPhase {
  return (FlightPhase as Record<string, FlightPhase>)[p] ?? FlightPhase.PARKED;
}

function isLive(ac: AircraftTelemetry): boolean {
  return ac.lastSeen > 0 && Date.now() - ac.lastSeen < 120_000;
}

function FleetCard({
  ac,
  selected,
  onClick,
}: {
  ac: AircraftTelemetry;
  selected: boolean;
  onClick: () => void;
}) {
  const live = isLive(ac);
  const info = TRACKED_AIRCRAFT_MAP.get(ac.icao);

  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
      className={clsx(
        "relative w-full rounded-xl border p-3 text-left transition-colors",
        "bg-panel-bg/25 backdrop-blur-xl",
        selected
          ? "border-electric-cyan/60 shadow-glow-cyan"
          : "border-panel-border hover:border-muted-blue/60",
        !live && "opacity-50",
      )}
    >
      {selected && (
        <div
          aria-hidden
          className="absolute inset-0 rounded-xl ring-1 ring-electric-cyan/30 pointer-events-none"
        />
      )}

      {/* Row 1: ICAO + Callsign + Phase */}
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[11px] text-hud-muted tabular-nums">
            {ac.icao.toUpperCase()}
          </span>
          <span className="font-mono text-sm text-white truncate">
            {ac.callsign || "—"}
          </span>
        </div>
        {live && <PhaseBadge phase={phaseFromString(refinePhase(ac))} />}
        {!live && (
          <span className="text-[9px] font-mono text-hud-muted/60 uppercase tracking-wider">
            Offline
          </span>
        )}
      </div>

      {/* Row 2: Registration + Type + Operator */}
      <div className="flex items-center gap-1.5 mb-2 text-[10px] text-hud-muted truncate">
        <span className="font-mono text-electric-cyan/70">
          {ac.reg || info?.reg || "—"}
        </span>
        <span className="text-hud-muted/40">·</span>
        <span className="truncate">
          {ac.aircraftDesc || info?.desc || ac.aircraftType || info?.type || "—"}
        </span>
      </div>

      {/* Row 3: Operator */}
      {info?.operator && (
        <p className="text-[9px] text-hud-muted/70 mb-2 truncate">
          {info.operator}
        </p>
      )}

      {/* Route (origin → destination) */}
      {live && (ac.originIcao || ac.destIcao) && (
        <div className="flex items-center gap-1.5 mb-2 font-mono text-[10px]">
          <span className="text-electric-cyan/80">{ac.originIcao ?? "—"}</span>
          <span className="text-hud-muted/40">→</span>
          <span className="text-electric-cyan/80">{ac.destIcao ?? "—"}</span>
        </div>
      )}

      {/* Row 4: Telemetry readouts (only when live) */}
      {live ? (
        <>
          <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
            <MiniReadout label="ALT" value={fmtAltitude(ac.altitude)} unit="ft" />
            <MiniReadout label="GS" value={fmtSpeed(ac.groundSpeed)} unit="kts" />
            <MiniReadout label="HDG" value={fmtHeading(ac.heading)} />
          </div>

          {/* Row 5: Extra metrics */}
          <div className="grid grid-cols-3 gap-x-3 gap-y-1.5 mt-1.5">
            {ac.mach != null && ac.mach > 0 && (
              <MiniReadout label="MACH" value={ac.mach.toFixed(3)} />
            )}
            {ac.ias != null && ac.ias > 0 && (
              <MiniReadout label="IAS" value={Math.round(ac.ias).toString()} unit="kts" />
            )}
            {ac.verticalRate != null && ac.verticalRate !== 0 && (
              <MiniReadout
                label="V/S"
                value={`${ac.verticalRate >= 0 ? "+" : ""}${Math.round(ac.verticalRate).toLocaleString("en-GB")}`}
                unit="fpm"
              />
            )}
          </div>

          <div className="mt-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span
                className={clsx(
                  "inline-block h-2 w-2 rounded-full",
                  ac.onGround ? "bg-neon-amber" : "bg-signal-green",
                )}
              />
              <span className="text-[9px] text-hud-muted">
                {ac.squawk ? `SQK ${ac.squawk}` : ""}
              </span>
            </div>
            <span className="text-[10px] font-mono text-hud-muted tabular-nums">
              {fmtRelativeTime(ac.lastSeen)} ago
            </span>
          </div>
        </>
      ) : (
        <p className="text-[10px] text-hud-muted/50 mt-1">
          Transponder inactive — no ADS-B signal
        </p>
      )}
    </motion.button>
  );
}

function MiniReadout({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-wider text-hud-muted">
        {label}
      </span>
      <span className="font-mono text-xs text-electric-cyan tabular-nums leading-tight">
        {value}
        {unit && (
          <span className="text-[8px] text-hud-muted ml-0.5">{unit}</span>
        )}
      </span>
    </div>
  );
}

export function FleetStatusGrid() {
  const fleet = useAircraftStore((s) => s.fleet);
  const selectedIcao = useAircraftStore((s) => s.selectedIcao);
  const selectAircraft = useAircraftStore((s) => s.selectAircraft);

  const merged: AircraftTelemetry[] = TRACKED_AIRCRAFT.map((info) => {
    const live = fleet.get(info.icao);
    if (live) return live;
    return {
      icao: info.icao,
      callsign: null,
      reg: info.reg,
      aircraftType: info.type,
      aircraftDesc: info.desc,
      category: null,
      latitude: null,
      longitude: null,
      altitude: null,
      altGeom: null,
      groundSpeed: null,
      ias: null,
      tas: null,
      mach: null,
      heading: null,
      trueHeading: null,
      magHeading: null,
      verticalRate: null,
      geomRate: null,
      roll: null,
      squawk: null,
      emergency: "none",
      onGround: false,
      phase: "UNKNOWN" as AircraftTelemetry["phase"],
      flightId: null,
      lastSeen: 0,
      windDir: null,
      windSpeed: null,
      oat: null,
      tat: null,
      navQnh: null,
      navAltMcp: null,
      navAltFms: null,
      navHeading: null,
      navModes: [],
      originIcao: null,
      originName: null,
      destIcao: null,
      destName: null,
    };
  });

  const liveFirst = merged.sort((a, b) => {
    const aLive = isLive(a);
    const bLive = isLive(b);
    if (aLive !== bLive) return aLive ? -1 : 1;
    return (a.callsign ?? a.icao).localeCompare(b.callsign ?? b.icao);
  });

  const liveCount = liveFirst.filter(isLive).length;

  const activeBadge = (
    <span className="font-mono text-[10px] text-electric-cyan tabular-nums">
      {liveCount} / {TRACKED_AIRCRAFT.length} live
    </span>
  );

  return (
    <Panel title="Fleet Status" headerAction={activeBadge}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 max-h-[500px] overflow-y-auto pr-1">
        {liveFirst.map((ac) => (
          <FleetCard
            key={ac.icao}
            ac={ac}
            selected={ac.icao === selectedIcao}
            onClick={() =>
              selectAircraft(ac.icao === selectedIcao ? null : ac.icao)
            }
          />
        ))}
      </div>
    </Panel>
  );
}
