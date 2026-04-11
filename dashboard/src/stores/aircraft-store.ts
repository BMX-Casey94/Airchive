import { create } from "zustand";
import type { FlightPhase } from "@/types/dashboard";

/* ── Types ────────────────────────────────────────────────────── */

export interface AircraftTelemetry {
  icao: string;
  callsign: string | null;
  reg: string | null;
  aircraftType: string | null;
  aircraftDesc: string | null;
  category: string | null;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  altGeom: number | null;
  groundSpeed: number | null;
  ias: number | null;
  tas: number | null;
  mach: number | null;
  heading: number | null;
  trueHeading: number | null;
  magHeading: number | null;
  verticalRate: number | null;
  geomRate: number | null;
  roll: number | null;
  squawk: string | null;
  emergency: string;
  onGround: boolean;
  phase: FlightPhase;
  flightId: string | null;
  lastSeen: number;
  windDir: number | null;
  windSpeed: number | null;
  oat: number | null;
  tat: number | null;
  navQnh: number | null;
  navAltMcp: number | null;
  navAltFms: number | null;
  navHeading: number | null;
  navModes: string[];
  originIcao: string | null;
  originName: string | null;
  destIcao: string | null;
  destName: string | null;
  walletAddress: string | null;
}

export interface AircraftState {
  fleet: Map<string, AircraftTelemetry>;
  selectedIcao: string | null;

  selectAircraft: (icao: string | null) => void;
  updateAircraft: (record: AircraftTelemetry) => void;
  updateFleet: (records: AircraftTelemetry[]) => void;
}

/**
 * Merge incoming telemetry with the previous record, keeping the
 * last-known-good value for any field the new update leaves null.
 */
function mergeTelemetry(
  prev: AircraftTelemetry,
  incoming: AircraftTelemetry,
): AircraftTelemetry {
  const merged = { ...incoming };
  const keys = Object.keys(prev) as (keyof AircraftTelemetry)[];
  for (const k of keys) {
    if (k === "icao" || k === "lastSeen") continue;
    if (merged[k] === null || merged[k] === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (merged as any)[k] = prev[k];
    }
  }

  if (
    (merged.latitude === 0 && merged.longitude === 0) &&
    prev.latitude != null && prev.latitude !== 0
  ) {
    merged.latitude = prev.latitude;
    merged.longitude = prev.longitude;
  }

  return merged;
}

/* ── Store ────────────────────────────────────────────────────── */

export const useAircraftStore = create<AircraftState>()((set) => ({
  fleet: new Map(),
  selectedIcao: null,

  selectAircraft: (icao) => set({ selectedIcao: icao }),

  updateAircraft: (record) =>
    set((state) => {
      const next = new Map(state.fleet);
      const prev = next.get(record.icao);
      next.set(record.icao, prev ? mergeTelemetry(prev, record) : record);
      return { fleet: next };
    }),

  updateFleet: (records) =>
    set((state) => {
      const next = new Map(state.fleet);
      for (const r of records) {
        const prev = next.get(r.icao);
        next.set(r.icao, prev ? mergeTelemetry(prev, r) : r);
      }
      return { fleet: next };
    }),
}));
