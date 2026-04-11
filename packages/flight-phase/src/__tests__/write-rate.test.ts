import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { FlightPhase, type TelemetryRecord } from "@airchive/types";

import { WriteRateController } from "../write-rate.js";

function mockTelemetry(overrides: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return {
    icao: "WRTEST",
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
    on_ground: true,
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
    ...overrides,
  };
}

describe("WriteRateController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true from shouldWrite on the first call for an aircraft", () => {
    const c = new WriteRateController();
    expect(c.shouldWrite("ABC123", FlightPhase.CRUISE, mockTelemetry())).toBe(true);
  });

  it("returns false from shouldWrite when the phase interval has not elapsed", () => {
    const c = new WriteRateController();
    const rec = mockTelemetry({ icao: "ABC123" });
    expect(c.shouldWrite("ABC123", FlightPhase.CRUISE, rec)).toBe(true);
    c.recordWrite("ABC123");
    vi.advanceTimersByTime(4000);
    expect(c.shouldWrite("ABC123", FlightPhase.CRUISE, rec)).toBe(false);
  });

  it("returns true from shouldWrite once the phase interval has elapsed", () => {
    const c = new WriteRateController();
    const rec = mockTelemetry({ icao: "ABC123" });
    c.recordWrite("ABC123");
    vi.advanceTimersByTime(5000);
    expect(c.shouldWrite("ABC123", FlightPhase.CRUISE, rec)).toBe(true);
  });

  it("uses distinct default intervals per phase (PARKED, CRUISE, TAKEOFF)", () => {
    const c = new WriteRateController();
    const rec = mockTelemetry();
    expect(c.getIntervalMs("X", FlightPhase.PARKED, rec)).toBe(300_000);
    expect(c.getIntervalMs("X", FlightPhase.CRUISE, rec)).toBe(5000);
    expect(c.getIntervalMs("X", FlightPhase.TAKEOFF, rec)).toBe(1000);
  });

  it("forces a 1,000 ms interval when an emergency override is active", () => {
    const c = new WriteRateController();
    const rec = mockTelemetry();
    c.setEmergencyOverride("EMRG01", true);
    expect(c.getIntervalMs("EMRG01", FlightPhase.PARKED, rec)).toBe(1000);
    expect(c.getIntervalMs("EMRG01", FlightPhase.CRUISE, rec)).toBe(1000);
  });

  it("updates the last-write timestamp when recordWrite is called", () => {
    const c = new WriteRateController();
    const rec = mockTelemetry({ icao: "RWTS01" });
    expect(c.shouldWrite("RWTS01", FlightPhase.CRUISE, rec)).toBe(true);
    c.recordWrite("RWTS01");
    vi.advanceTimersByTime(4999);
    expect(c.shouldWrite("RWTS01", FlightPhase.CRUISE, rec)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(c.shouldWrite("RWTS01", FlightPhase.CRUISE, rec)).toBe(true);
  });

  it("clears per-aircraft state when reset is called", () => {
    const c = new WriteRateController();
    const rec = mockTelemetry({ icao: "RST001" });
    c.recordWrite("RST001");
    c.setEmergencyOverride("RST001", true);
    c.reset("RST001");
    expect(c.getIntervalMs("RST001", FlightPhase.PARKED, rec)).toBe(300_000);
    expect(c.shouldWrite("RST001", FlightPhase.CRUISE, rec)).toBe(true);
  });
});
