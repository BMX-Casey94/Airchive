import type { AircraftTelemetry } from "@/stores/aircraft-store";

type Phase = AircraftTelemetry["phase"];

const VSI_CLIMB = 300;
const VSI_DESCENT = -300;

/**
 * Refine the backend-reported phase using live telemetry values.
 *
 * The backend phase engine may lag behind reality (polling interval,
 * sustained-duration thresholds, or stale initial classification).
 * This function applies simple, instantaneous overrides so the
 * dashboard badge reflects what the aircraft is visibly doing.
 */
export function refinePhase(ac: AircraftTelemetry): Phase {
  const phase = ac.phase;
  const vr = ac.verticalRate;

  if (vr == null || ac.onGround) return phase;

  if (phase === "CRUISE") {
    if (vr > VSI_CLIMB) return "CLIMB";
    if (vr < VSI_DESCENT) return "DESCENT";
  }

  if (phase === "CLIMB" && vr < VSI_DESCENT) return "DESCENT";
  if (phase === "DESCENT" && vr > VSI_CLIMB) return "CLIMB";

  return phase;
}
