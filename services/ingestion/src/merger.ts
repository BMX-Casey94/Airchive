import type { TelemetryRecord } from "@airchive/types";

const seqCounters = new Map<string, number>();

const ADSBFI_PREFERRED_FIELDS = new Set<keyof TelemetryRecord>([
  "ias",
  "tas",
  "mach",
  "roll",
  "baro_rate",
  "geom_rate",
  "true_heading",
  "mag_heading",
  "wind_dir",
  "wind_speed",
  "oat",
  "tat",
  "nav_qnh",
  "nav_alt_mcp",
  "nav_alt_fms",
  "nav_heading",
  "nav_modes",
  "reg",
  "aircraft_type",
  "category",
  "emergency",
]);

function emptyRecord(): TelemetryRecord {
  return {
    icao: "",
    callsign: "",
    reg: "",
    squawk: "",
    aircraft_type: "",
    category: "",
    ts: 0,
    ts_pos: 0,
    lat: 0,
    lon: 0,
    alt_baro: 0,
    alt_geom: 0,
    on_ground: false,
    gs: 0,
    ias: 0,
    tas: 0,
    mach: 0,
    track: 0,
    true_heading: 0,
    mag_heading: 0,
    baro_rate: 0,
    geom_rate: 0,
    roll: 0,
    wind_dir: 0,
    wind_speed: 0,
    oat: 0,
    tat: 0,
    nav_qnh: 0,
    nav_alt_mcp: 0,
    nav_alt_fms: 0,
    nav_heading: 0,
    nav_modes: [],
    nic: 0,
    rc: 0,
    adsb_version: 0,
    position_source: 0,
    num_receivers: 0,
    emergency: "none",
    data_sources: [],
    seq: 0,
  };
}

function isUsableValue(val: unknown): boolean {
  if (val === undefined || val === null) return false;
  if (typeof val === "number") return val !== 0 && Number.isFinite(val);
  if (typeof val === "string") return val.length > 0;
  if (Array.isArray(val)) return val.length > 0;
  return true;
}

export function mergeRecords(
  sources: Partial<TelemetryRecord>[][],
): TelemetryRecord[] {
  const grouped = new Map<string, Partial<TelemetryRecord>[]>();

  for (const sourceRecords of sources) {
    for (const rec of sourceRecords) {
      if (!rec.icao) continue;
      const key = rec.icao.toUpperCase();
      const list = grouped.get(key);
      if (list) list.push(rec);
      else grouped.set(key, [rec]);
    }
  }

  const results: TelemetryRecord[] = [];

  for (const [icao, partials] of grouped) {
    const merged = emptyRecord();
    merged.icao = icao;
    merged.ts = Date.now();

    const adsbfiPartial = partials.find((p) =>
      p.data_sources?.includes("adsbfi"),
    );
    const openskyPartial = partials.find((p) =>
      p.data_sources?.includes("opensky"),
    );

    const ordered = orderByPriority(partials, adsbfiPartial, openskyPartial);
    const allSources = new Set<string>();

    for (const partial of ordered) {
      if (partial.data_sources) {
        for (const ds of partial.data_sources) allSources.add(ds);
      }

      const keys = Object.keys(partial) as (keyof TelemetryRecord)[];
      for (const key of keys) {
        if (key === "data_sources" || key === "ts" || key === "seq") continue;

        const incoming = partial[key];
        if (!isUsableValue(incoming)) continue;

        const current = merged[key];
        if (isUsableValue(current)) {
          if (ADSBFI_PREFERRED_FIELDS.has(key) && adsbfiPartial && partial !== adsbfiPartial) {
            const adsbfiVal = (adsbfiPartial as Record<string, unknown>)[key];
            if (isUsableValue(adsbfiVal)) continue;
          }
        }

        (merged as unknown as Record<string, unknown>)[key] = incoming;
      }
    }

    merged.data_sources = Array.from(allSources);

    const prev = seqCounters.get(icao) ?? 0;
    const next = prev + 1;
    seqCounters.set(icao, next);
    merged.seq = next;

    results.push(merged);
  }

  return results;
}

function orderByPriority(
  partials: Partial<TelemetryRecord>[],
  adsbfi: Partial<TelemetryRecord> | undefined,
  opensky: Partial<TelemetryRecord> | undefined,
): Partial<TelemetryRecord>[] {
  const result: Partial<TelemetryRecord>[] = [];
  if (adsbfi) result.push(adsbfi);
  if (opensky) result.push(opensky);
  for (const p of partials) {
    if (p !== adsbfi && p !== opensky) result.push(p);
  }
  return result;
}
