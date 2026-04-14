import {
  FlightPhase,
  type PhaseTransition,
  type TelemetryRecord,
} from "@airchive/types";

export interface AircraftPhaseState {
  currentPhase: FlightPhase;
  previousPhase: FlightPhase | null;
  phaseEnteredAt: number;
  stableVrateStartedAt: number | null;
  descentStartedAt: number | null;
  lastOnGround: boolean;
  lastRecord: TelemetryRecord | null;
}

const PARKED_SLOW_MS = 60_000;
const STABLE_VRATE_MS = 60_000;
const DESCENT_SUSTAIN_MS = 30_000;
const CLIMB_ALT_FT = 3_000;
const APPROACH_ALT_FT = 10_000;
const VSI_LEVEL_LOW = -300;
const VSI_LEVEL_HIGH = 300;
const VSI_CLIMB_THRESHOLD = 300;
const VSI_DESCENT_THRESHOLD = -300;
const TAXI_GS_KTS = 5;
/** Airborne initial phase: treat at or above this baro altitude as likely cruise. */
const CRUISE_INITIAL_ALT_FT = 25_000;

function normaliseIcao(icao: string): string {
  return icao.trim().toUpperCase();
}

function telemetryTimeMs(record: TelemetryRecord): number {
  const t = record.ts;
  return Number.isFinite(t) ? t : Date.now();
}

function sanitizeGs(record: TelemetryRecord): number {
  const g = record.gs;
  if (g == null || !Number.isFinite(g)) return 0;
  return Math.max(0, g);
}

function sanitizeBaroRate(record: TelemetryRecord): number {
  const r = record.baro_rate;
  if (r == null || !Number.isFinite(r)) return 0;
  return r;
}

function sanitizeAltBaro(record: TelemetryRecord): number {
  const a = record.alt_baro;
  if (a == null || !Number.isFinite(a)) return 0;
  return a;
}

function inferInitialPhase(record: TelemetryRecord): FlightPhase {
  if (record.on_ground) return FlightPhase.PARKED;
  const alt = sanitizeAltBaro(record);
  if (alt >= CRUISE_INITIAL_ALT_FT) return FlightPhase.CRUISE;
  return FlightPhase.CLIMB;
}

function freshParkedState(ts: number): AircraftPhaseState {
  return {
    currentPhase: FlightPhase.PARKED,
    previousPhase: null,
    phaseEnteredAt: ts,
    stableVrateStartedAt: null,
    descentStartedAt: null,
    lastOnGround: true,
    lastRecord: null,
  };
}

function createStateFromFirstRecord(record: TelemetryRecord): AircraftPhaseState {
  const ts = telemetryTimeMs(record);
  return {
    currentPhase: inferInitialPhase(record),
    previousPhase: null,
    phaseEnteredAt: ts,
    stableVrateStartedAt: null,
    descentStartedAt: null,
    lastOnGround: !!record.on_ground,
    lastRecord: record,
  };
}

export class FlightPhaseDetector {
  private readonly states = new Map<string, AircraftPhaseState>();
  private readonly listeners: Array<(transition: PhaseTransition) => void> = [];

  update(record: TelemetryRecord): FlightPhase {
    return this.updateWithTransitions(record).phase;
  }

  updateWithTransitions(
    record: TelemetryRecord,
  ): { phase: FlightPhase; transitions: PhaseTransition[] } {
    const transitions: PhaseTransition[] = [];
    const icao = normaliseIcao(record.icao);
    let state = this.states.get(icao);
    if (!state) {
      state = createStateFromFirstRecord(record);
      this.states.set(icao, state);
      return { phase: state.currentPhase, transitions };
    }

    const ts = telemetryTimeMs(record);
    const onGround = !!record.on_ground;
    const wasOnGround = state.lastOnGround;
    const gs = sanitizeGs(record);
    const baro = sanitizeBaroRate(record);
    const alt = sanitizeAltBaro(record);

    const fromPhase = state.currentPhase;
    let phase = fromPhase;

    if (!wasOnGround && onGround) {
      phase = FlightPhase.LANDING;
      state.stableVrateStartedAt = null;
      state.descentStartedAt = null;
      if (gs < TAXI_GS_KTS) state.stableVrateStartedAt = ts;
      else state.stableVrateStartedAt = null;
    } else if (wasOnGround && !onGround) {
      phase = FlightPhase.TAKEOFF;
      state.stableVrateStartedAt = null;
      state.descentStartedAt = null;
    } else if (onGround) {
      state.descentStartedAt = null;
      if (gs < TAXI_GS_KTS) {
        if (state.stableVrateStartedAt == null) state.stableVrateStartedAt = ts;
      } else {
        state.stableVrateStartedAt = null;
      }

      if (gs < TAXI_GS_KTS && state.stableVrateStartedAt != null) {
        if (ts - state.stableVrateStartedAt >= PARKED_SLOW_MS) {
          phase = FlightPhase.PARKED;
        }
      }

      if (gs >= TAXI_GS_KTS) {
        if (
          phase === FlightPhase.LANDING ||
          phase === FlightPhase.PARKED ||
          phase === FlightPhase.TAXI_IN
        ) {
          if (phase === FlightPhase.LANDING) phase = FlightPhase.TAXI_IN;
          else phase = FlightPhase.TAXI;
        }
      }
    } else {
      for (let step = 0; step < 16; step++) {
        const next = this.stepAirbornePhase(phase, state, alt, baro, ts);
        if (next === phase) break;
        phase = next;
      }
    }

    if (phase !== fromPhase) {
      state.previousPhase = fromPhase;
      state.currentPhase = phase;
      state.phaseEnteredAt = ts;
      state.stableVrateStartedAt = null;
      state.descentStartedAt = null;
      if (onGround && gs < TAXI_GS_KTS) state.stableVrateStartedAt = ts;
      else if (onGround) state.stableVrateStartedAt = null;

      const transition: PhaseTransition = {
        aircraft_icao: icao,
        from_phase: fromPhase,
        to_phase: phase,
        timestamp: ts,
        telemetry: record,
      };
      transitions.push(transition);
      for (const fn of this.listeners) {
        try {
          fn(transition);
        } catch {
          /* isolate listener failures */
        }
      }
    }

    state.lastOnGround = onGround;
    state.lastRecord = record;
    return { phase: state.currentPhase, transitions };
  }

  private stepAirbornePhase(
    phase: FlightPhase,
    state: AircraftPhaseState,
    alt: number,
    baro: number,
    ts: number,
  ): FlightPhase {
    if (phase === FlightPhase.CLIMB || phase === FlightPhase.CRUISE) {
      if (baro < VSI_DESCENT_THRESHOLD) {
        if (state.descentStartedAt == null) state.descentStartedAt = ts;
      } else {
        state.descentStartedAt = null;
      }
    } else {
      state.descentStartedAt = null;
    }

    if (phase === FlightPhase.CLIMB) {
      if (baro >= VSI_LEVEL_LOW && baro <= VSI_LEVEL_HIGH) {
        if (state.stableVrateStartedAt == null) state.stableVrateStartedAt = ts;
      } else {
        state.stableVrateStartedAt = null;
      }
    } else {
      state.stableVrateStartedAt = null;
    }

    if (phase === FlightPhase.TAKEOFF && alt > CLIMB_ALT_FT && baro > VSI_CLIMB_THRESHOLD) {
      return FlightPhase.CLIMB;
    }

    if (
      phase === FlightPhase.CLIMB &&
      baro < VSI_DESCENT_THRESHOLD &&
      state.descentStartedAt != null &&
      ts - state.descentStartedAt >= DESCENT_SUSTAIN_MS
    ) {
      return FlightPhase.DESCENT;
    }

    if (
      phase === FlightPhase.CLIMB &&
      baro >= VSI_LEVEL_LOW &&
      baro <= VSI_LEVEL_HIGH &&
      state.stableVrateStartedAt != null &&
      ts - state.stableVrateStartedAt >= STABLE_VRATE_MS
    ) {
      return FlightPhase.CRUISE;
    }

    if (phase === FlightPhase.CRUISE && baro > VSI_CLIMB_THRESHOLD) {
      return FlightPhase.CLIMB;
    }

    if (
      phase === FlightPhase.CRUISE &&
      baro < VSI_DESCENT_THRESHOLD &&
      state.descentStartedAt != null &&
      ts - state.descentStartedAt >= DESCENT_SUSTAIN_MS
    ) {
      return FlightPhase.DESCENT;
    }

    if (phase === FlightPhase.DESCENT && alt < APPROACH_ALT_FT) {
      return FlightPhase.APPROACH;
    }

    return phase;
  }

  getPhase(icao: string): FlightPhase {
    return this.states.get(normaliseIcao(icao))?.currentPhase ?? FlightPhase.PARKED;
  }

  getState(icao: string): AircraftPhaseState | undefined {
    const s = this.states.get(normaliseIcao(icao));
    return s ? { ...s, lastRecord: s.lastRecord } : undefined;
  }

  onTransition(listener: (transition: PhaseTransition) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  reset(icao: string): void {
    this.states.set(normaliseIcao(icao), freshParkedState(Date.now()));
  }
}
