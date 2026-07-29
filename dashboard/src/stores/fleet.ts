import { create } from "zustand";
import type { AircraftState, PositionSnapshot } from "@/types/dashboard";

/**
 * Points held per aircraft. This is a ceiling on memory, not on how much of a
 * flight is kept: once reached, the older part of the path is thinned rather
 * than truncated, so the whole route from first contact survives at gradually
 * coarser resolution while the recent stretch stays exact.
 */
const TRAIL_BUFFER_SIZE = 1_500;
/** Newest points never thinned, so manoeuvring detail is not lost. */
const TRAIL_RECENT_KEEP = 500;
const MIN_TRAIL_DISTANCE_DEG = 0.0005; // ~55m — fine enough for taxi movement

/**
 * A trail kept only until the aircraft went quiet would restart from a single
 * point every time it came back. Holding the path well past the aircraft's own
 * staleness window is what lets a returning flight show where it came from.
 */
const TRAIL_RETENTION_MS = 6 * 60 * 60 * 1_000;

/**
 * Appends a point, halving the resolution of the older section when the buffer
 * is full. Dropping every other old point costs detail in proportion to age
 * and never loses the shape of the route, where slicing off the front would
 * discard the departure entirely.
 */
function appendTrailPoint(
  existing: PositionSnapshot[] | undefined,
  snapshot: PositionSnapshot,
): PositionSnapshot[] {
  const next = existing ? [...existing, snapshot] : [snapshot];
  if (next.length <= TRAIL_BUFFER_SIZE) return next;

  const split = next.length - TRAIL_RECENT_KEEP;
  const thinned = next.slice(0, split).filter((_, i) => i % 2 === 0);
  return [...thinned, ...next.slice(split)];
}

function trailLastSeen(points: PositionSnapshot[]): number {
  return points.length === 0 ? 0 : points[points.length - 1]!.ts;
}

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
  /** Seeds trails restored from storage without disturbing live ones. */
  hydrateTrails: (restored: Map<string, PositionSnapshot[]>) => void;
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
          nextTrails.set(
            icao,
            appendTrailPoint(existing, {
              lat: merged.lat,
              lon: merged.lon,
              alt: merged.altBaro,
              ts: merged.lastSeen,
            }),
          );
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
            nextTrails.set(
              icao,
              appendTrailPoint(existing, {
                lat: merged.lat,
                lon: merged.lon,
                alt: merged.altBaro,
                ts: merged.lastSeen,
              }),
            );
          }
        }
      }

      return { aircraft: nextAircraft, trails: nextTrails };
    }),

  removeAircraft: (icao) =>
    set((state) => {
      const nextAircraft = new Map(state.aircraft);
      nextAircraft.delete(icao);
      // The trail deliberately stays. Nothing draws it while the aircraft is
      // gone, and keeping it means a reappearance shows the full route flown
      // rather than starting again from a single point.
      return {
        aircraft: nextAircraft,
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

  hydrateTrails: (restored) =>
    set((state) => {
      if (restored.size === 0) return state;
      const nextTrails = new Map(state.trails);

      for (const [icao, points] of restored) {
        const live = nextTrails.get(icao);
        if (!live || live.length === 0) {
          nextTrails.set(icao, points.slice(-TRAIL_BUFFER_SIZE));
          continue;
        }
        // Points gathered since the page opened win; the restored history is
        // stitched on in front of them, dropping any overlap by timestamp.
        const earliestLive = live[0]!.ts;
        const history = points.filter((p) => p.ts < earliestLive);
        nextTrails.set(icao, [...history, ...live].slice(-TRAIL_BUFFER_SIZE));
      }

      return { trails: nextTrails };
    }),

  pruneStale: (maxAgeMs = 300_000) => {
    const now = Date.now();
    let pruned = 0;
    set((state) => {
      const nextAircraft = new Map<string, AircraftState>();
      for (const [icao, ac] of state.aircraft) {
        if (now - ac.lastSeen < maxAgeMs || icao === state.selectedIcao) {
          nextAircraft.set(icao, ac);
        } else {
          pruned++;
        }
      }

      // Trails outlive their aircraft, so they are aged out on their own much
      // longer clock instead of vanishing the moment a feed goes quiet.
      const nextTrails = new Map<string, PositionSnapshot[]>();
      let expired = 0;
      for (const [icao, points] of state.trails) {
        if (now - trailLastSeen(points) < TRAIL_RETENTION_MS) {
          nextTrails.set(icao, points);
        } else {
          expired++;
        }
      }

      if (pruned === 0 && expired === 0) return state;
      return { aircraft: nextAircraft, trails: nextTrails };
    });
    return pruned;
  },
}));
