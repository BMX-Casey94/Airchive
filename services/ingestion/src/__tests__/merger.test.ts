import { describe, expect, it } from "vitest";
import type { TelemetryRecord } from "@airchive/types";

import { mergeRecords } from "../merger.js";

describe("mergeRecords", () => {
  it("merges two sources for the same aircraft and prefers adsb.fi for speed-related fields", () => {
    const icao = `M1${Math.floor(Math.random() * 1e6)}`;
    const opensky: Partial<TelemetryRecord> = {
      icao,
      data_sources: ["opensky"],
      lat: 53.35,
      lon: -2.27,
      alt_baro: 32_000,
      gs: 410,
      ias: 999,
      tas: 888,
      baro_rate: 777,
    };
    const adsbfi: Partial<TelemetryRecord> = {
      icao,
      data_sources: ["adsbfi"],
      ias: 260,
      tas: 440,
      baro_rate: 50,
    };
    const [merged] = mergeRecords([[opensky], [adsbfi]]);
    expect(merged!.icao).toBe(icao.toUpperCase());
    expect(merged!.ias).toBe(260);
    expect(merged!.tas).toBe(440);
    expect(merged!.baro_rate).toBe(50);
    expect(merged!.lat).toBe(53.35);
    expect(merged!.data_sources.sort()).toEqual(["adsbfi", "opensky"].sort());
  });

  it("fills all fields when only a single source supplies usable values", () => {
    const icao = `M2${Math.floor(Math.random() * 1e6)}`;
    const single: Partial<TelemetryRecord> = {
      icao,
      data_sources: ["opensky"],
      callsign: "TEST99",
      lat: 50.0,
      lon: 1.0,
      alt_baro: 5000,
      gs: 220,
    };
    const [merged] = mergeRecords([[single]]);
    expect(merged!.callsign).toBe("TEST99");
    expect(merged!.lat).toBe(50);
    expect(merged!.lon).toBe(1);
    expect(merged!.alt_baro).toBe(5000);
    expect(merged!.gs).toBe(220);
    expect(merged!.mach).toBe(0);
  });

  it("leaves fields at defaults when sources omit them", () => {
    const icao = `M3${Math.floor(Math.random() * 1e6)}`;
    const [merged] = mergeRecords([
      [{ icao, data_sources: ["opensky"], lat: 48, lon: 2 }],
    ]);
    expect(merged!.reg).toBe("");
    expect(merged!.squawk).toBe("");
    expect(merged!.nav_modes).toEqual([]);
  });

  it("assigns monotonically increasing sequence numbers per aircraft ICAO", () => {
    const icao = `M4${Math.floor(Math.random() * 1e6)}`;
    const base = { icao, data_sources: ["opensky"] as string[], lat: 51, lon: 0 };
    const [first] = mergeRecords([[base]]);
    const [second] = mergeRecords([[base]]);
    expect(second!.seq).toBe(first!.seq + 1);
  });
});
