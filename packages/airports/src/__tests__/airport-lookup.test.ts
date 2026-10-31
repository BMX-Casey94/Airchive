import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AirportLookup,
  haversineDistanceMiles,
  normaliseAirportIcao,
} from "../airport-lookup.js";

const CSV_HEADER = [
  "ident",
  "type",
  "name",
  "latitude_deg",
  "longitude_deg",
  "elevation_ft",
  "iso_country",
  "municipality",
  "icao_code",
].join(",");

async function loadRows(rows: string[]): Promise<AirportLookup> {
  const dir = mkdtempSync(join(tmpdir(), "airchive-airports-"));
  const csvPath = join(dir, "airports.csv");
  writeFileSync(csvPath, `${CSV_HEADER}\n${rows.join("\n")}\n`, "utf8");
  try {
    return await AirportLookup.load(csvPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("haversineDistanceMiles", () => {
  it("matches the known great-circle distance between London Heathrow and London Gatwick", () => {
    const lhrLat = 51.4706;
    const lhrLon = -0.461941;
    const lgwLat = 51.148077;
    const lgwLon = -0.190278;
    const miles = haversineDistanceMiles(lhrLat, lhrLon, lgwLat, lgwLon);
    expect(miles).toBeGreaterThan(22);
    expect(miles).toBeLessThan(28);
  });
});

describe("AirportLookup", () => {
  it("returns null from findNearest when no airports are loaded (missing CSV)", async () => {
    const missingPath = join(
      process.cwd(),
      "nonexistent-airports-data",
      "definitely-missing.csv",
    );
    const lookup = await AirportLookup.load(missingPath);
    expect(lookup.count).toBe(0);
    expect(lookup.findNearest(51.47, -0.46, 500)).toBeNull();
  });

  it("returns null from findByIcao for an unknown code", async () => {
    const missingPath = join(process.cwd(), "no-such-airports-file-xyz.csv");
    const lookup = await AirportLookup.load(missingPath);
    expect(lookup.findByIcao("XXXX")).toBeNull();
  });

  it("uses the icao_code column when ident is a longer local code", async () => {
    const lookup = await loadRows([
      `"AE-0001","small_airport","Batha, Airport",24.214693,51.44989,257,"SA","Batha","oebt"`,
    ]);
    expect(lookup.count).toBe(1);
    expect(lookup.findByIcao("AE-0001")).toBeNull();
    expect(lookup.findByIcao("oebt")).toMatchObject({
      icao_code: "OEBT",
      name: "Batha, Airport",
    });
    expect(lookup.findNearest(24.214693, 51.44989, 1)?.icao_code).toBe("OEBT");
  });

  it("falls back to ident only when it is exactly 4 alphanumeric characters", async () => {
    const lookup = await loadRows([
      "00AA,small_airport,Aero B Ranch Airport,38.704022,-101.473911,3435,US,Leoti,",
      "KLAX,large_airport,Los Angeles,33.9425,-118.408,125,US,Los Angeles,",
    ]);
    expect(lookup.count).toBe(2);
    expect(lookup.findByIcao("00aa")?.icao_code).toBe("00AA");
    expect(lookup.findByIcao("KLAX")?.name).toBe("Los Angeles");
  });

  it("prefers a different 4-character icao_code over ident", async () => {
    const lookup = await loadRows([
      "16A,small_airport,Nunapitchuk,60.905591,-162.44064,12,US,Nunapitchuk,PPIT",
      "ABCD,small_airport,Other,40, -100, 10, US, Test, WXYZ",
    ]);
    expect(lookup.findByIcao("16A")).toBeNull();
    expect(lookup.findByIcao("PPIT")?.icao_code).toBe("PPIT");
    expect(lookup.findByIcao("ABCD")).toBeNull();
    expect(lookup.findByIcao("WXYZ")?.icao_code).toBe("WXYZ");
  });

  it("keeps airports with no storable code in nearest matching", async () => {
    const lookup = await loadRows([
      "AE-0003,small_airport,Skydive Dubai Airport,51.47,-0.46,3,AE,Dubai,",
      "US-1234,small_airport,Local Strip,51.4701,-0.4601,10,US,Nowhere,",
      "HELIPAD,heliport,Pad,51.4702,-0.4602,0,GB,London,EGLW",
      "EGLL,large_airport,Heathrow,51.55,-0.46,83,GB,London,EGLL",
    ]);
    expect(lookup.count).toBe(3);
    expect(lookup.findByIcao("EGLW")).toBeNull();
    expect(lookup.findByIcao("AE-0003")).toBeNull();
    const nearest = lookup.findNearest(51.47, -0.46, 2);
    expect(nearest).toMatchObject({
      name: "Skydive Dubai Airport",
      icao_code: null,
    });
    expect(lookup.findByIcao("EGLL")?.icao_code).toBe("EGLL");
  });

  it("keeps a valid ident when the icao_code column is unusable", async () => {
    const lookup = await loadRows([
      "KLAX,large_airport,Los Angeles,33.94,-118.4,125,US,Los Angeles,TOO-LONG",
      ",small_airport,No Ident,51.47,-0.46,80,GB,London,EGKK",
    ]);
    expect(lookup.count).toBe(1);
    expect(lookup.findByIcao("KLAX")?.icao_code).toBe("KLAX");
    expect(lookup.findByIcao("EGKK")).toBeNull();
  });

  it("resolves the bundled OurAirports file by location even without a storable code", async () => {
    const csvPath = join(process.cwd(), "data", "airports.csv");
    const lookup = await AirportLookup.load(csvPath);
    expect(lookup.count).toBe(countLegacyIncludedAirports(csvPath));
    expect(lookup.findByIcao("AE-0001")).toBeNull();
    expect(lookup.findByIcao("AE-0003")).toBeNull();
    expect(lookup.findByIcao("OEBT")).toMatchObject({
      icao_code: "OEBT",
      name: "Batha Airport",
    });
    expect(lookup.findNearest(24.214693, 51.44989, 1)?.icao_code).toBe("OEBT");
    expect(lookup.findNearest(25.090037, 55.132345, 0.2)).toMatchObject({
      name: "Skydive Dubai Airport",
      icao_code: null,
    });
    expect(lookup.findByIcao("00AA")).toMatchObject({
      icao_code: "00AA",
      name: "Aero B Ranch Airport",
    });
  });
});

const LEGACY_INCLUDED_TYPES = new Set(["large_airport", "medium_airport", "small_airport"]);

/**
 * Count rows the loader kept before ICAO filtering: included type, non-empty
 * ident, finite coordinates. The lookup count must stay equal to this.
 */
function countLegacyIncludedAirports(csvPath: string): number {
  const text = readFileSync(csvPath, "utf8").replace(/^\uFEFF/, "");
  const rows = parseCsvRows(text);
  if (rows.length === 0) return 0;
  const header = rows[0]!;
  const col = new Map<string, number>();
  header.forEach((name, index) => {
    col.set(name.replace(/^\uFEFF/, "").trim(), index);
  });
  const cell = (row: string[], key: string): string => {
    const index = col.get(key);
    if (index === undefined) return "";
    return row[index]?.trim() ?? "";
  };
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (!LEGACY_INCLUDED_TYPES.has(cell(row, "type"))) continue;
    if (!cell(row, "ident")) continue;
    const lat = Number.parseFloat(cell(row, "latitude_deg"));
    const lon = Number.parseFloat(cell(row, "longitude_deg"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    count += 1;
  }
  return count;
}

function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') {
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
    if (c === "\n" || c === "\r") {
      if (c === "\r" && content[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}

describe("normaliseAirportIcao", () => {
  it("accepts only a 4-character alphanumeric code", () => {
    expect(normaliseAirportIcao("egll")).toBe("EGLL");
    expect(normaliseAirportIcao("  00aa  ")).toBe("00AA");
    expect(normaliseAirportIcao("A1B2")).toBe("A1B2");
    expect(normaliseAirportIcao(null)).toBeNull();
    expect(normaliseAirportIcao(undefined)).toBeNull();
    expect(normaliseAirportIcao("")).toBeNull();
    expect(normaliseAirportIcao("   ")).toBeNull();
    expect(normaliseAirportIcao("ABC")).toBeNull();
    expect(normaliseAirportIcao("16A")).toBeNull();
    expect(normaliseAirportIcao("ABCDE")).toBeNull();
    expect(normaliseAirportIcao("AE-0001")).toBeNull();
    expect(normaliseAirportIcao("A-BC")).toBeNull();
    expect(normaliseAirportIcao("AB CD")).toBeNull();
  });
});
