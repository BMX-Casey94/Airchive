import type { TelemetryRecord, EmergencyString } from "@airchive/types";
import { errorsTotal, pollDuration, pollsTotal } from "../metrics.js";

const TIMEOUT_MS = 5_000;
const MAX_BATCH = 300;

interface AdsbFiAircraft {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  desc?: string;
  category?: string;
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
  lat?: number;
  lon?: number;
  nic?: number;
  rc?: number;
  seen_pos?: number;
  version?: number;
  wd?: number;
  ws?: number;
  oat?: number;
  tat?: number;
  nav_qnh?: number;
  nav_altitude_mcp?: number;
  nav_altitude_fms?: number;
  nav_heading?: number;
  nav_modes?: string[];
  on_ground?: boolean;
}

interface AdsbFiResponse {
  ac?: AdsbFiAircraft[];
  now?: number;
  msg?: string;
}

export async function fetchAdsbFi(
  icaoList: string[],
  apiUrl = "https://opendata.adsb.fi/api/v2",
): Promise<Partial<TelemetryRecord>[]> {
  if (icaoList.length === 0) return [];

  const endTimer = pollDuration.startTimer({ source: "adsbfi" });

  try {
    const results: Partial<TelemetryRecord>[] = [];

    for (let i = 0; i < icaoList.length; i += MAX_BATCH) {
      const batch = icaoList.slice(i, i + MAX_BATCH);
      const hexParam = batch.map((h) => h.toLowerCase()).join(",");
      const url = `${apiUrl}/hex/${hexParam}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      let res: Response;
      try {
        res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        errorsTotal.inc({ source: "adsbfi" });
        continue;
      }

      const body = (await res.json()) as AdsbFiResponse;
      if (!body.ac || !Array.isArray(body.ac)) continue;

      for (const ac of body.ac) {
        const record = mapAdsbFiAircraft(ac);
        if (record) results.push(record);
      }
    }

    pollsTotal.inc({ source: "adsbfi" });
    return results;
  } catch {
    errorsTotal.inc({ source: "adsbfi" });
    return [];
  } finally {
    endTimer();
  }
}

function mapAdsbFiAircraft(ac: AdsbFiAircraft): Partial<TelemetryRecord> | null {
  if (!ac.hex) return null;

  const altBaro =
    ac.alt_baro === "ground" ? 0 : (ac.alt_baro ?? 0);
  const onGround = ac.alt_baro === "ground" || ac.on_ground === true;

  const emergency = normaliseEmergency(ac.emergency);

  const hasPosition =
    ac.lat != null && ac.lon != null && !(ac.lat === 0 && ac.lon === 0);

  const record: Partial<TelemetryRecord> = {
    icao: ac.hex.toUpperCase(),
    callsign: ac.flight?.trim() ?? "",
    reg: ac.r ?? "",
    aircraft_type: ac.t ?? "",
    aircraft_desc: ac.desc ?? "",
    category: ac.category ?? "",
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
    data_sources: ["adsbfi"],
  };

  if (hasPosition) {
    record.lat = ac.lat!;
    record.lon = ac.lon!;
  }

  return record;
}

const KNOWN_EMERGENCY: Set<string> = new Set([
  "none",
  "general",
  "lifeguard",
  "minfuel",
  "nordo",
  "unlawful",
  "downed",
]);

function normaliseEmergency(raw?: string): EmergencyString {
  if (!raw) return "none";
  const lower = raw.trim().toLowerCase();
  if (KNOWN_EMERGENCY.has(lower)) return lower as EmergencyString;
  return "none";
}
