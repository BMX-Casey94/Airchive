import { create } from "zustand";
import type { AircraftState, TelemetryDataPoint } from "@/types/airchive";

interface FleetState {
  /** Map of ICAO hex → latest aircraft state. */
  aircraft: Map<string, AircraftState>;
  /** Currently selected aircraft ICAO hex (null = none). */
  selectedIcao: string | null;
  /** Rolling telemetry time-series for the selected aircraft. */
  telemetryHistory: TelemetryDataPoint[];

  /** Replace or insert an aircraft state snapshot. */
  upsertAircraft: (state: AircraftState) => void;
  /** Bulk replace the full fleet map (e.g. on initial load). */
  setFleet: (fleet: AircraftState[]) => void;
  /** Select an aircraft by ICAO hex. */
  selectAircraft: (icao: string | null) => void;
  /** Push a telemetry data point (auto-trims to 60 s window). */
  pushTelemetry: (point: TelemetryDataPoint) => void;
  /** Clear the telemetry history (e.g. on aircraft change). */
  clearTelemetryHistory: () => void;
}

const TELEMETRY_WINDOW_MS = 60_000;

export const useFleetStore = create<FleetState>((set, get) => ({
  aircraft: new Map(),
  selectedIcao: null,
  telemetryHistory: [],

  upsertAircraft: (state) =>
    set((prev) => {
      const next = new Map(prev.aircraft);
      next.set(state.icao, state);
      return { aircraft: next };
    }),

  setFleet: (fleet) =>
    set(() => {
      const map = new Map<string, AircraftState>();
      for (const a of fleet) map.set(a.icao, a);
      return { aircraft: map };
    }),

  selectAircraft: (icao) =>
    set(() => ({ selectedIcao: icao, telemetryHistory: [] })),

  pushTelemetry: (point) =>
    set((prev) => {
      const cutoff = Date.now() - TELEMETRY_WINDOW_MS;
      const trimmed = prev.telemetryHistory.filter((p) => p.ts >= cutoff);
      return { telemetryHistory: [...trimmed, point] };
    }),

  clearTelemetryHistory: () => set({ telemetryHistory: [] }),
}));

/** Convenience selector: fleet as a sorted array. */
export function useFleetArray(): AircraftState[] {
  return useFleetStore((s) => {
    const arr = Array.from(s.aircraft.values());
    arr.sort((a, b) => a.callsign.localeCompare(b.callsign));
    return arr;
  });
}

/** Convenience selector: selected aircraft state or null. */
export function useSelectedAircraft(): AircraftState | null {
  return useFleetStore((s) =>
    s.selectedIcao ? (s.aircraft.get(s.selectedIcao) ?? null) : null,
  );
}
