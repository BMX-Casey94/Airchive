import type { TelemetryRecord } from "@airchive/types";
import { errorsTotal, pollDuration, pollsTotal } from "../metrics.js";

const TIMEOUT_MS = 5_000;
const MPS_TO_KNOTS = 1.94384;
const METRES_TO_FEET = 3.28084;
const MPS_TO_FTMIN = 196.85;

interface OpenSkyResponse {
  time: number;
  states: (string | number | boolean | number[] | null)[][] | null;
}

export async function fetchOpenSky(
  icaoList: string[],
  auth?: { username: string; password: string },
  apiUrl = "https://opensky-network.org/api",
): Promise<Partial<TelemetryRecord>[]> {
  if (icaoList.length === 0) return [];

  const endTimer = pollDuration.startTimer({ source: "opensky" });

  try {
    const hexParam = icaoList.map((h) => h.toLowerCase()).join(",");
    const url = `${apiUrl}/states/all?icao24=${hexParam}`;

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (auth?.username && auth?.password) {
      const creds = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
      headers["Authorization"] = `Basic ${creds}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 429) {
      errorsTotal.inc({ source: "opensky" });
      return [];
    }

    if (!res.ok) {
      errorsTotal.inc({ source: "opensky" });
      return [];
    }

    const body = (await res.json()) as OpenSkyResponse;
    if (!body.states || !Array.isArray(body.states)) return [];

    pollsTotal.inc({ source: "opensky" });
    return body.states.map(mapOpenSkyState).filter(Boolean) as Partial<TelemetryRecord>[];
  } catch {
    errorsTotal.inc({ source: "opensky" });
    return [];
  } finally {
    endTimer();
  }
}

function mapOpenSkyState(
  s: (string | number | boolean | number[] | null)[],
): Partial<TelemetryRecord> | null {
  if (!s || s.length < 17) return null;

  const icao = s[0] as string | null;
  if (!icao) return null;

  const callsign = typeof s[1] === "string" ? s[1].trim() : "";
  const timePosition = s[3] as number | null;
  const lon = s[5] as number | null;
  const lat = s[6] as number | null;
  const baroAltM = s[7] as number | null;
  const onGround = s[8] as boolean | null;
  const velocityMps = s[9] as number | null;
  const trueTrack = s[10] as number | null;
  const verticalRateMps = s[11] as number | null;
  const geoAltM = s[13] as number | null;
  const squawk = s[14] as string | null;
  const positionSource = s[16] as number | null;

  return {
    icao: icao.toUpperCase(),
    callsign: callsign || "",
    ts_pos: timePosition != null ? timePosition * 1000 : 0,
    lat: lat ?? 0,
    lon: lon ?? 0,
    alt_baro: baroAltM != null ? baroAltM * METRES_TO_FEET : 0,
    alt_geom: geoAltM != null ? geoAltM * METRES_TO_FEET : 0,
    on_ground: onGround ?? false,
    gs: velocityMps != null ? velocityMps * MPS_TO_KNOTS : 0,
    track: trueTrack ?? 0,
    baro_rate: verticalRateMps != null ? verticalRateMps * MPS_TO_FTMIN : 0,
    squawk: squawk ?? "",
    position_source: positionSource ?? 0,
    data_sources: ["opensky"],
  };
}
