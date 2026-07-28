import { bufferFromColumn, tryDecodeEnvelope } from "./op-return.js";

export type PhaseName =
  | "PARKED"
  | "TAXI"
  | "TAKEOFF"
  | "CLIMB"
  | "CRUISE"
  | "DESCENT"
  | "APPROACH"
  | "LANDING"
  | "TAXI_IN"
  | "UNKNOWN";

/**
 * Flight events are recorded as milestones rather than phases, so the phase a
 * milestone puts the aircraft into is reconstructed here. EMERGENCY is
 * deliberately absent: it is raised alongside a phase, never instead of one.
 */
const EVENT_PHASE: Record<string, PhaseName> = {
  PUSHBACK: "TAXI",
  TAXI_START: "TAXI",
  TAKEOFF: "TAKEOFF",
  TOP_OF_CLIMB: "CRUISE",
  CRUISE: "CRUISE",
  TOP_OF_DESCENT: "DESCENT",
  APPROACH: "APPROACH",
  LANDING: "LANDING",
  TAXI_END: "TAXI_IN",
  PARKED: "PARKED",
};

export interface PhaseMarker {
  phase: PhaseName;
  timestamp: number;
}

export interface PhaseSegmentDTO {
  phase: PhaseName;
  startTs: number;
  endTs?: number;
  durationMs: number;
}

export interface FlightEventRow {
  timestamp: string | number;
  op_return?: unknown;
}

/**
 * Turns flight-event transaction rows into an ordered phase timeline. Rows that
 * cannot be decoded are skipped so a single corrupt record does not blank the
 * whole timeline.
 */
export function phaseMarkersFromEvents(rows: FlightEventRow[]): PhaseMarker[] {
  const markers: PhaseMarker[] = [];

  for (const row of rows) {
    const envelope = bufferFromColumn(row.op_return);
    if (envelope === null) continue;

    const decoded = tryDecodeEnvelope(envelope);
    if (decoded === null) continue;

    const event = decoded.fields.event;
    if (typeof event !== "string") continue;

    const phase = EVENT_PHASE[event];
    if (phase === undefined) continue;

    markers.push({ phase, timestamp: Number(row.timestamp) });
  }

  markers.sort((a, b) => a.timestamp - b.timestamp);
  return markers;
}

/** Collapses a marker timeline into contiguous segments up to `endTs`. */
export function buildPhaseSegments(
  markers: PhaseMarker[],
  endTs: number,
): PhaseSegmentDTO[] {
  const segments: PhaseSegmentDTO[] = [];

  for (const marker of markers) {
    const previous = segments[segments.length - 1];
    if (previous && previous.phase === marker.phase) continue;
    if (previous) {
      previous.endTs = marker.timestamp;
      previous.durationMs = Math.max(0, marker.timestamp - previous.startTs);
    }
    segments.push({
      phase: marker.phase,
      startTs: marker.timestamp,
      durationMs: 0,
    });
  }

  const last = segments[segments.length - 1];
  if (last && endTs > last.startTs) {
    last.endTs = endTs;
    last.durationMs = endTs - last.startTs;
  }

  return segments;
}

/** Phase in force at `ts`, or UNKNOWN when the timeline starts later. */
export function phaseAt(markers: PhaseMarker[], ts: number): PhaseName {
  let phase: PhaseName = "UNKNOWN";
  for (const marker of markers) {
    if (marker.timestamp > ts) break;
    phase = marker.phase;
  }
  return phase;
}
