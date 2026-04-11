import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { AirportLookup, haversineDistanceMiles } from "../airport-lookup.js";

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
});
