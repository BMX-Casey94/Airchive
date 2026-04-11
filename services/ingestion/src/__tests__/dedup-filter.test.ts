import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { TelemetryRecord } from "@airchive/types";

import { DedupFilter } from "../dedup-filter.js";

function mockRecord(overrides: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return {
    icao: "DEDUP1",
    callsign: "",
    reg: "",
    squawk: "",
    aircraft_type: "",
    category: "",
    ts: 0,
    ts_pos: 0,
    lat: 51.47,
    lon: -0.12,
    alt_baro: 10_000,
    alt_geom: 10_000,
    on_ground: false,
    gs: 280,
    ias: 0,
    tas: 0,
    mach: 0,
    track: 90,
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
    ...overrides,
  };
}

describe("DedupFilter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("always allows the first record for an aircraft", () => {
    const f = new DedupFilter();
    const r = mockRecord();
    expect(f.shouldPublish(r)).toBe(true);
    f.recordPublished(r);
  });

  it("suppresses an identical subsequent record", () => {
    const f = new DedupFilter();
    const r = mockRecord();
    expect(f.shouldPublish(r)).toBe(true);
    f.recordPublished(r);
    expect(f.shouldPublish({ ...r })).toBe(false);
  });

  it("suppresses a record when position and motion deltas stay within the thresholds", () => {
    const f = new DedupFilter();
    const r = mockRecord();
    f.recordPublished(r);
    const smallMove = mockRecord({
      lat: r.lat + 0.00005,
      lon: r.lon + 0.00005,
      alt_baro: r.alt_baro + 10,
      gs: r.gs + 1,
    });
    expect(f.shouldPublish(smallMove)).toBe(false);
  });

  it("allows a record when the position change exceeds the threshold", () => {
    const f = new DedupFilter();
    const r = mockRecord();
    f.recordPublished(r);
    const bigMove = mockRecord({
      lat: r.lat + 0.001,
      lon: r.lon,
    });
    expect(f.shouldPublish(bigMove)).toBe(true);
  });

  it("always allows a record when on_ground changes", () => {
    const f = new DedupFilter();
    const r = mockRecord({ on_ground: false });
    f.recordPublished(r);
    expect(f.shouldPublish(mockRecord({ on_ground: true }))).toBe(true);
  });

  it("allows a record after 60 seconds of silence even when the payload is similar", () => {
    const f = new DedupFilter();
    const r = mockRecord();
    expect(f.shouldPublish(r)).toBe(true);
    f.recordPublished(r);
    expect(f.shouldPublish({ ...r })).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(f.shouldPublish({ ...r })).toBe(true);
  });
});
