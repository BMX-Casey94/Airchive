import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AirportInfo, AirportSizeType } from "@airchive/types";

const EARTH_RADIUS_MILES = 3958.7613;

const INCLUDED_TYPES = new Set<string>([
  "large_airport",
  "medium_airport",
  "small_airport",
]);

interface AirportEntry {
  ident: string;
  name: string;
  lat: number;
  lon: number;
  elevation_ft: number;
  iso_country: string;
  municipality: string;
  type: AirportSizeType;
}

function defaultCsvPath(): string {
  return join(__dirname, "..", "data", "airports.csv");
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const len = content.length;

  for (let i = 0; i < len; i++) {
    const c = content[i]!;

    if (inQuotes) {
      if (c === '"') {
        const next = content[i + 1];
        if (next === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\n") {
      row.push(field);
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      field = "";
      continue;
    }
    if (c === "\r") {
      const next = content[i + 1];
      if (next === "\n") {
        i++;
      }
      row.push(field);
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      field = "";
      continue;
    }

    field += c;
  }

  row.push(field);
  if (row.some((cell) => cell.length > 0)) {
    rows.push(row);
  }

  return rows;
}

function headerIndex(headerRow: string[]): Map<string, number> {
  const map = new Map<string, number>();
  headerRow.forEach((name, i) => {
    const key = name.replace(/^\uFEFF/, "").trim();
    map.set(key, i);
  });
  return map;
}

function cell(row: string[], col: Map<string, number>, key: string): string {
  const idx = col.get(key);
  if (idx === undefined) {
    return "";
  }
  return row[idx]?.trim() ?? "";
}

function gridKey(lat: number, lon: number): string {
  return `${Math.floor(lat)}_${Math.floor(lon)}`;
}

function buildGrid(airports: AirportEntry[]): Map<string, AirportEntry[]> {
  const grid = new Map<string, AirportEntry[]>();
  for (const a of airports) {
    const key = gridKey(a.lat, a.lon);
    const bucket = grid.get(key);
    if (bucket) {
      bucket.push(a);
    } else {
      grid.set(key, [a]);
    }
  }
  return grid;
}

function toAirportInfo(entry: AirportEntry): AirportInfo {
  return {
    icao_code: entry.ident,
    name: entry.name,
    lat: entry.lat,
    lon: entry.lon,
    elevation_ft: entry.elevation_ft,
    iso_country: entry.iso_country,
    municipality: entry.municipality,
    type: entry.type,
  };
}

function parseAirportRows(rows: string[][]): AirportEntry[] {
  if (rows.length === 0) {
    return [];
  }
  const col = headerIndex(rows[0]!);
  const entries: AirportEntry[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const type = cell(row, col, "type");
    if (!INCLUDED_TYPES.has(type)) {
      continue;
    }

    const ident = cell(row, col, "ident").toUpperCase();
    if (!ident) {
      continue;
    }

    const lat = Number.parseFloat(cell(row, col, "latitude_deg"));
    const lon = Number.parseFloat(cell(row, col, "longitude_deg"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }

    const elevRaw = cell(row, col, "elevation_ft");
    const elevation_ft = elevRaw === "" ? 0 : Number.parseFloat(elevRaw);
    const elevation = Number.isFinite(elevation_ft) ? elevation_ft : 0;

    entries.push({
      ident,
      name: cell(row, col, "name"),
      lat,
      lon,
      elevation_ft: elevation,
      iso_country: cell(row, col, "iso_country"),
      municipality: cell(row, col, "municipality"),
      type: type as AirportSizeType,
    });
  }

  return entries;
}

export function haversineDistanceMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const lat1R = toRad(lat1);
  const lat2R = toRad(lat2);
  const dLatR = toRad(lat2 - lat1);
  const dLonR = toRad(lon2 - lon1);

  const sinDLat = Math.sin(dLatR / 2);
  const sinDLon = Math.sin(dLonR / 2);
  const a =
    sinDLat * sinDLat +
    Math.cos(lat1R) * Math.cos(lat2R) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return EARTH_RADIUS_MILES * c;
}

export class AirportLookup {
  private readonly airports: readonly AirportEntry[];

  private readonly grid: Map<string, AirportEntry[]>;

  private readonly byIcao: Map<string, AirportEntry>;

  private constructor(airports: AirportEntry[]) {
    this.airports = airports;
    this.grid = buildGrid(airports);
    this.byIcao = new Map(airports.map((a) => [a.ident, a]));
  }

  static async load(csvPath?: string): Promise<AirportLookup> {
    const path = csvPath ?? defaultCsvPath();
    try {
      const raw = await readFile(path, "utf8");
      const text = raw.replace(/^\uFEFF/, "");
      const rows = parseCsv(text);
      const entries = parseAirportRows(rows);
      return new AirportLookup(entries);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return new AirportLookup([]);
      }
      throw err;
    }
  }

  get count(): number {
    return this.airports.length;
  }

  findByIcao(icao: string): AirportInfo | null {
    const key = icao.trim().toUpperCase();
    if (!key) {
      return null;
    }
    const entry = this.byIcao.get(key);
    return entry ? toAirportInfo(entry) : null;
  }

  findNearest(
    lat: number,
    lon: number,
    maxDistanceMiles: number = 10,
  ): AirportInfo | null {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(maxDistanceMiles)) {
      return null;
    }

    const baseLat = Math.floor(lat);
    const baseLon = Math.floor(lon);
    let best: AirportEntry | null = null;
    let bestDist = Infinity;

    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const key = `${baseLat + dLat}_${baseLon + dLon}`;
        const bucket = this.grid.get(key);
        if (!bucket) {
          continue;
        }
        for (const a of bucket) {
          const d = haversineDistanceMiles(lat, lon, a.lat, a.lon);
          if (d < bestDist) {
            bestDist = d;
            best = a;
          }
        }
      }
    }

    if (!best || bestDist > maxDistanceMiles) {
      return null;
    }
    return toAirportInfo(best);
  }
}

export async function loadAirports(csvPath?: string): Promise<AirportLookup> {
  return AirportLookup.load(csvPath);
}
