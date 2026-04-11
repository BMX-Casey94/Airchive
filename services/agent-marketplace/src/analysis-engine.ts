import type { TelemetryRecord } from "@airchive/types";

export interface FleetAnalysis {
  timestamp: number;
  totalAircraft: number;
  airborne: number;
  grounded: number;
  avgAltitudeFt: number;
  avgGroundSpeedKts: number;
  maxAltitudeFt: number;
  maxSpeedKts: number;
  phaseDistribution: Record<string, number>;
  anomalies: Anomaly[];
  staleAircraft: string[];
  totalDistanceMiles: number;
}

export interface Anomaly {
  icao: string;
  type: "altitude" | "speed" | "vertical_rate" | "squawk" | "position";
  severity: "info" | "warning" | "critical";
  message: string;
  value: number;
  threshold: number;
}

const STALE_THRESHOLD_MS = 120_000;
const ALT_ANOMALY_FT = 43_000;
const SPEED_ANOMALY_KTS = 600;
const VERT_RATE_ANOMALY_FPM = 6_000;
const EMERGENCY_SQUAWKS = new Set(["7500", "7600", "7700"]);

export function analyseFleet(
  records: TelemetryRecord[],
  now: number = Date.now(),
): FleetAnalysis {
  const anomalies: Anomaly[] = [];
  const staleAircraft: string[] = [];
  const phaseDistribution: Record<string, number> = {};

  let airborne = 0;
  let grounded = 0;
  let altSum = 0;
  let gsSum = 0;
  let altCount = 0;
  let gsCount = 0;
  let maxAlt = 0;
  let maxSpeed = 0;

  for (const r of records) {
    if (now - r.ts > STALE_THRESHOLD_MS) {
      staleAircraft.push(r.icao);
    }

    if (r.on_ground) {
      grounded++;
    } else {
      airborne++;
    }

    if (r.alt_baro > 0) {
      altSum += r.alt_baro;
      altCount++;
      if (r.alt_baro > maxAlt) maxAlt = r.alt_baro;
    }

    if (r.gs > 0) {
      gsSum += r.gs;
      gsCount++;
      if (r.gs > maxSpeed) maxSpeed = r.gs;
    }

    const phase = (r as TelemetryRecord & { flight_phase?: string }).flight_phase ?? "UNKNOWN";
    phaseDistribution[phase] = (phaseDistribution[phase] ?? 0) + 1;

    if (r.alt_baro > ALT_ANOMALY_FT) {
      anomalies.push({
        icao: r.icao,
        type: "altitude",
        severity: "warning",
        message: `Altitude ${r.alt_baro} ft exceeds ${ALT_ANOMALY_FT} ft threshold`,
        value: r.alt_baro,
        threshold: ALT_ANOMALY_FT,
      });
    }

    if (r.gs > SPEED_ANOMALY_KTS) {
      anomalies.push({
        icao: r.icao,
        type: "speed",
        severity: "warning",
        message: `Ground speed ${r.gs} kts exceeds ${SPEED_ANOMALY_KTS} kts threshold`,
        value: r.gs,
        threshold: SPEED_ANOMALY_KTS,
      });
    }

    if (Math.abs(r.baro_rate) > VERT_RATE_ANOMALY_FPM) {
      anomalies.push({
        icao: r.icao,
        type: "vertical_rate",
        severity: "warning",
        message: `Vertical rate ${r.baro_rate} fpm exceeds ±${VERT_RATE_ANOMALY_FPM} fpm`,
        value: r.baro_rate,
        threshold: VERT_RATE_ANOMALY_FPM,
      });
    }

    if (EMERGENCY_SQUAWKS.has(r.squawk)) {
      anomalies.push({
        icao: r.icao,
        type: "squawk",
        severity: "critical",
        message: `Emergency squawk ${r.squawk} detected`,
        value: parseInt(r.squawk, 10),
        threshold: 0,
      });
    }
  }

  return {
    timestamp: now,
    totalAircraft: records.length,
    airborne,
    grounded,
    avgAltitudeFt: altCount > 0 ? Math.round(altSum / altCount) : 0,
    avgGroundSpeedKts: gsCount > 0 ? Math.round(gsSum / gsCount) : 0,
    maxAltitudeFt: maxAlt,
    maxSpeedKts: maxSpeed,
    phaseDistribution,
    anomalies,
    staleAircraft,
    totalDistanceMiles: 0,
  };
}

export function summariseAnalysis(analysis: FleetAnalysis): string {
  const parts = [
    `Fleet: ${analysis.totalAircraft} aircraft`,
    `Airborne: ${analysis.airborne}`,
    `Grounded: ${analysis.grounded}`,
    `Avg ALT: ${analysis.avgAltitudeFt} ft`,
    `Avg GS: ${analysis.avgGroundSpeedKts} kts`,
    `Max ALT: ${analysis.maxAltitudeFt} ft`,
    `Anomalies: ${analysis.anomalies.length}`,
    `Stale: ${analysis.staleAircraft.length}`,
  ];
  return parts.join(" | ");
}
