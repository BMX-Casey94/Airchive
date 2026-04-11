import type { TelemetryRecord, EmergencyString } from "@airchive/types";
import { errorsTotal, pollDuration, pollsTotal } from "../metrics.js";

const TIMEOUT_MS = 3_000;

interface Dump1090Aircraft {
  hex?: string;
  flight?: string;
  alt_baro?: number | "ground";
  alt_geom?: number;
  gs?: number;
  ias?: number;
  tas?: number;
  mach?: number;
  track?: number;
  true_heading?: number;
  mag_heading?: number;
  baro_rate?: number;
  geom_rate?: number;
  roll?: number;
  squawk?: string;
  emergency?: string;
  category?: string;
  lat?: number;
  lon?: number;
  nic?: number;
  rc?: number;
  version?: number;
  nav_qnh?: number;
  nav_altitude_mcp?: number;
  nav_altitude_fms?: number;
  nav_heading?: number;
  nav_modes?: string[];
  wd?: number;
  ws?: number;
  oat?: number;
  tat?: number;
  r?: string;
  t?: string;
}

interface Dump1090Response {
  now?: number;
  aircraft?: Dump1090Aircraft[];
}

export async function fetchRtlSdr(
  endpoint: string,
): Promise<Partial<TelemetryRecord>[]> {
  const endTimer = pollDuration.startTimer({ source: "rtlsdr" });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(endpoint, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      errorsTotal.inc({ source: "rtlsdr" });
      return [];
    }

    const body = (await res.json()) as Dump1090Response;
    if (!body.aircraft || !Array.isArray(body.aircraft)) return [];

    pollsTotal.inc({ source: "rtlsdr" });

    return body.aircraft
      .map(mapDump1090Aircraft)
      .filter(Boolean) as Partial<TelemetryRecord>[];
  } catch {
    errorsTotal.inc({ source: "rtlsdr" });
    return [];
  } finally {
    endTimer();
  }
}

function mapDump1090Aircraft(
  ac: Dump1090Aircraft,
): Partial<TelemetryRecord> | null {
  if (!ac.hex) return null;

  const altBaro =
    ac.alt_baro === "ground" ? 0 : (ac.alt_baro ?? 0);
  const onGround = ac.alt_baro === "ground";

  const emergency = normaliseEmergency(ac.emergency);

  return {
    icao: ac.hex.toUpperCase(),
    callsign: ac.flight?.trim() ?? "",
    reg: ac.r ?? "",
    aircraft_type: ac.t ?? "",
    category: ac.category ?? "",
    lat: ac.lat ?? 0,
    lon: ac.lon ?? 0,
    alt_baro: altBaro,
    alt_geom: ac.alt_geom ?? 0,
    on_ground: onGround,
    gs: ac.gs ?? 0,
    ias: ac.ias ?? 0,
    tas: ac.tas ?? 0,
    mach: ac.mach ?? 0,
    track: ac.track ?? 0,
    true_heading: ac.true_heading ?? 0,
    mag_heading: ac.mag_heading ?? 0,
    baro_rate: ac.baro_rate ?? 0,
    geom_rate: ac.geom_rate ?? 0,
    roll: ac.roll ?? 0,
    squawk: ac.squawk ?? "",
    emergency,
    nic: ac.nic ?? 0,
    rc: ac.rc ?? 0,
    adsb_version: ac.version ?? 0,
    wind_dir: ac.wd ?? 0,
    wind_speed: ac.ws ?? 0,
    oat: ac.oat ?? 0,
    tat: ac.tat ?? 0,
    nav_qnh: ac.nav_qnh ?? 0,
    nav_alt_mcp: ac.nav_altitude_mcp ?? 0,
    nav_alt_fms: ac.nav_altitude_fms ?? 0,
    nav_heading: ac.nav_heading ?? 0,
    nav_modes: ac.nav_modes ?? [],
    data_sources: ["rtlsdr"],
  };
}

const KNOWN_EMERGENCY: Set<string> = new Set([
  "none", "general", "lifeguard", "minfuel", "nordo", "unlawful", "downed",
]);

function normaliseEmergency(raw?: string): EmergencyString {
  if (!raw) return "none";
  const lower = raw.trim().toLowerCase();
  if (KNOWN_EMERGENCY.has(lower)) return lower as EmergencyString;
  return "none";
}
