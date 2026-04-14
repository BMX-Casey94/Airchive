import { create } from "zustand";
import type { AircraftState, PositionSnapshot } from "@/types/dashboard";

const TRAIL_BUFFER_SIZE = 600;
const MIN_TRAIL_DISTANCE_DEG = 0.0002; // ~22m — capture fine-grained movement

interface FleetState {
  /** Live aircraft keyed by ICAO hex. */
  aircraft: Map<string, AircraftState>;

  /** Position trail buffer per ICAO (most recent last). */
  trails: Map<string, PositionSnapshot[]>;

  /** Currently selected aircraft ICAO (null = none). */
  selectedIcao: string | null;

  /** Active flight session for the selected aircraft. */
  selectedFlightId: string | null;

  /* ── Actions ──────────────────────────────────────────── */
  selectAircraft: (icao: string | null) => void;
  updateAircraft: (icao: string, patch: Partial<AircraftState>) => void;
  bulkUpdate: (updates: Array<[string, Partial<AircraftState>]>) => void;
  removeAircraft: (icao: string) => void;
  clearFleet: () => void;
  pruneStale: (maxAgeMs?: number) => number;
}

export const useFleetStore = create<FleetState>()((set, get) => ({
  aircraft: new Map(),
  trails: new Map(),
  selectedIcao: null,
  selectedFlightId: null,

  selectAircraft: (icao) =>
    set({
      selectedIcao: icao,
      selectedFlightId: icao
        ? get().aircraft.get(icao)?.flightId ?? null
        : null,
    }),

  updateAircraft: (icao, patch) =>
    set((state) => {
      const prev = state.aircraft.get(icao);
      const merged: AircraftState = prev
        ? { ...prev, ...patch }
        : ({
            icao,
            callsign: "",
            reg: "",
            aircraftType: "",
            squawk: "",
            lat: 0,
            lon: 0,
            altBaro: 0,
            altGeom: 0,
            onGround: false,
            gs: 0,
            ias: 0,
            tas: 0,
            track: 0,
            trueHeading: 0,
            baroRate: 0,
            emergency: "none",
            phase: "UNKNOWN",
            lastSeen: Date.now(),
            ...patch,
          } as AircraftState);

      const nextAircraft = new Map(state.aircraft);
      nextAircraft.set(icao, merged);

      const nextTrails = new Map(state.trails);
      if (merged.lat !== 0 || merged.lon !== 0) {
        const existing = nextTrails.get(icao) ?? [];
        const last = existing[existing.length - 1];
        const moved =
          !last ||
          Math.abs(merged.lat - last.lat) > MIN_TRAIL_DISTANCE_DEG ||
          Math.abs(merged.lon - last.lon) > MIN_TRAIL_DISTANCE_DEG;

        if (moved) {
          const snapshot: PositionSnapshot = {
            lat: merged.lat,
            lon: merged.lon,
            alt: merged.altBaro,
            ts: merged.lastSeen,
          };
          const updated = [...existing, snapshot].slice(-TRAIL_BUFFER_SIZE);
          nextTrails.set(icao, updated);
        }
      }

      return { aircraft: nextAircraft, trails: nextTrails };
    }),

  bulkUpdate: (updates) =>
    set((state) => {
      const nextAircraft = new Map(state.aircraft);
      const nextTrails = new Map(state.trails);

      for (const [icao, patch] of updates) {
        const prev = nextAircraft.get(icao);
        const merged: AircraftState = prev
          ? { ...prev, ...patch }
          : ({
              icao,
              callsign: "",
              reg: "",
              aircraftType: "",
              squawk: "",
              lat: 0,
              lon: 0,
              altBaro: 0,
              altGeom: 0,
              onGround: false,
              gs: 0,
              ias: 0,
              tas: 0,
              track: 0,
              trueHeading: 0,
              baroRate: 0,
              emergency: "none",
              phase: "UNKNOWN",
              lastSeen: Date.now(),
              ...patch,
            } as AircraftState);
        nextAircraft.set(icao, merged);

        if (merged.lat !== 0 || merged.lon !== 0) {
          const existing = nextTrails.get(icao) ?? [];
          const last = existing[existing.length - 1];
          const moved =
            !last ||
            Math.abs(merged.lat - last.lat) > MIN_TRAIL_DISTANCE_DEG ||
            Math.abs(merged.lon - last.lon) > MIN_TRAIL_DISTANCE_DEG;

          if (moved) {
            const snapshot: PositionSnapshot = {
              lat: merged.lat,
              lon: merged.lon,
              alt: merged.altBaro,
              ts: merged.lastSeen,
            };
            const updated = [...existing, snapshot].slice(-TRAIL_BUFFER_SIZE);
            nextTrails.set(icao, updated);
          }
        }
      }

      return { aircraft: nextAircraft, trails: nextTrails };
    }),

  removeAircraft: (icao) =>
    set((state) => {
      const nextAircraft = new Map(state.aircraft);
      const nextTrails = new Map(state.trails);
      nextAircraft.delete(icao);
      nextTrails.delete(icao);
      return {
        aircraft: nextAircraft,
        trails: nextTrails,
        selectedIcao: state.selectedIcao === icao ? null : state.selectedIcao,
        selectedFlightId:
          state.selectedIcao === icao ? null : state.selectedFlightId,
      };
    }),

  clearFleet: () =>
    set({
      aircraft: new Map(),
      trails: new Map(),
      selectedIcao: null,
      selectedFlightId: null,
    }),

  pruneStale: (maxAgeMs = 300_000) => {
    const now = Date.now();
    let pruned = 0;
    set((state) => {
      const nextAircraft = new Map<string, AircraftState>();
      const nextTrails = new Map<string, PositionSnapshot[]>();
      for (const [icao, ac] of state.aircraft) {
        if (now - ac.lastSeen < maxAgeMs || icao === state.selectedIcao) {
          nextAircraft.set(icao, ac);
          const t = state.trails.get(icao);
          if (t) nextTrails.set(icao, t);
        } else {
          pruned++;
        }
      }
      return pruned > 0
        ? { aircraft: nextAircraft, trails: nextTrails }
        : state;
    });
    return pruned;
  },
}));
