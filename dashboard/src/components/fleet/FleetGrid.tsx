"use client";

import { useFleetStore, useFleetArray } from "@/stores/fleet-store";
import AircraftCard from "@/components/fleet/AircraftCard";

export default function FleetGrid() {
  const aircraft = useFleetArray();
  const selectedIcao = useFleetStore((s) => s.selectedIcao);
  const selectAircraft = useFleetStore((s) => s.selectAircraft);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {aircraft.map((ac) => (
        <AircraftCard
          key={ac.icao}
          aircraft={ac}
          selected={ac.icao === selectedIcao}
          onClick={() =>
            selectAircraft(ac.icao === selectedIcao ? null : ac.icao)
          }
        />
      ))}

      {aircraft.length === 0 && (
        <div className="col-span-full flex items-center justify-center py-16 text-hud-muted text-sm">
          No aircraft in fleet — waiting for telemetry data…
        </div>
      )}
    </div>
  );
}
