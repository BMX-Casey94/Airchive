import { FlightPhase, AlertSeverity, type AlertRecord } from "@airchive/types";
import { randomUUID } from "node:crypto";

const VALID_NEXT: Record<FlightPhase, ReadonlySet<FlightPhase>> = {
  [FlightPhase.PARKED]: new Set([FlightPhase.PARKED, FlightPhase.TAXI]),
  [FlightPhase.TAXI]: new Set([
    FlightPhase.TAXI,
    FlightPhase.TAKEOFF,
    FlightPhase.PARKED,
    FlightPhase.TAXI_IN,
  ]),
  [FlightPhase.TAKEOFF]: new Set([
    FlightPhase.TAKEOFF,
    FlightPhase.CLIMB,
    FlightPhase.LANDING,
    FlightPhase.APPROACH,
  ]),
  [FlightPhase.CLIMB]: new Set([
    FlightPhase.CLIMB,
    FlightPhase.CRUISE,
    FlightPhase.DESCENT,
    FlightPhase.TAKEOFF,
  ]),
  [FlightPhase.CRUISE]: new Set([
    FlightPhase.CRUISE,
    FlightPhase.DESCENT,
    FlightPhase.CLIMB,
    FlightPhase.APPROACH,
  ]),
  [FlightPhase.DESCENT]: new Set([
    FlightPhase.DESCENT,
    FlightPhase.APPROACH,
    FlightPhase.CRUISE,
    FlightPhase.CLIMB,
  ]),
  [FlightPhase.APPROACH]: new Set([
    FlightPhase.APPROACH,
    FlightPhase.LANDING,
    FlightPhase.DESCENT,
    FlightPhase.CRUISE,
  ]),
  [FlightPhase.LANDING]: new Set([
    FlightPhase.LANDING,
    FlightPhase.TAXI_IN,
    FlightPhase.APPROACH,
  ]),
  [FlightPhase.TAXI_IN]: new Set([
    FlightPhase.TAXI_IN,
    FlightPhase.PARKED,
    FlightPhase.TAXI,
  ]),
};

export class PhaseAnomalyDetector {
  checkTransition(
    icao: string,
    from: FlightPhase,
    to: FlightPhase,
  ): AlertRecord | null {
    if (from === to) return null;
    const allowed = VALID_NEXT[from];
    if (allowed?.has(to) ?? false) return null;

    const id = randomUUID();
    const now = new Date();
    const severity = AlertSeverity.CRITICAL;

    return {
      id,
      aircraft_icao: icao.trim().toUpperCase(),
      severity,
      type: "UNEXPECTED_PHASE_TRANSITION",
      message: `Disallowed flight phase transition from ${from} to ${to}`,
      data: {
        from_phase: from,
        to_phase: to,
      },
      acknowledged: false,
      created_at: now,
    };
  }
}
