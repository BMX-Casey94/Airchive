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
    expect(c.shouldWrite("ABC123", FlightPhase.PARKED, rec)).toBe(true);
    c.recordWrite("ABC123", FlightPhase.PARKED, rec);
    vi.advanceTimersByTime(30_000);
    expect(c.shouldWrite("ABC123", FlightPhase.PARKED, rec)).toBe(false);
  });

  it("returns true from shouldWrite once the phase interval has elapsed", () => {
    const c = new WriteRateController();
    const rec = mockTelemetry({ icao: "ABC123" });
    c.recordWrite("ABC123", FlightPhase.PARKED, rec);
    vi.advanceTimersByTime(60_000);
    expect(c.shouldWrite("ABC123", FlightPhase.PARKED, rec)).toBe(true);
  });

  it("samples every airborne phase at the 1 Hz source polling floor", () => {
    const c = new WriteRateController();
    const rec = mockTelemetry();
    for (const phase of [
      FlightPhase.TAKEOFF,
      FlightPhase.CLIMB,
      FlightPhase.CRUISE,
      FlightPhase.DESCENT,
      FlightPhase.APPROACH,
      FlightPhase.LANDING,
    ]) {
      expect(c.getIntervalMs("X", phase, rec)).toBe(1000);
    }
  });

  it("samples ground movement often and parked aircraft as a heartbeat", () => {
    const c = new WriteRateController();
    const rec = mockTelemetry();
    expect(c.getIntervalMs("X", FlightPhase.TAXI, rec)).toBe(2000);
    expect(c.getIntervalMs("X", FlightPhase.TAXI_IN, rec)).toBe(2000);
    expect(c.getIntervalMs("X", FlightPhase.PARKED, rec)).toBe(60_000);
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
    c.recordWrite("RWTS01", FlightPhase.CRUISE, rec);
    vi.advanceTimersByTime(999);
    expect(c.shouldWrite("RWTS01", FlightPhase.CRUISE, rec)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(c.shouldWrite("RWTS01", FlightPhase.CRUISE, rec)).toBe(true);
  });

  it("clears per-aircraft state when reset is called", () => {
    const c = new WriteRateController();
    const rec = mockTelemetry({ icao: "RST001" });
    c.recordWrite("RST001", FlightPhase.PARKED, rec);
    c.setEmergencyOverride("RST001", true);
    c.reset("RST001");
    expect(c.getIntervalMs("RST001", FlightPhase.PARKED, rec)).toBe(60_000);
    expect(c.shouldWrite("RST001", FlightPhase.CRUISE, rec)).toBe(true);
  });

  describe("event-triggered writes", () => {
    /** Parks an aircraft on a 60s interval so only an event can emit a write. */
    function parkedController(initial: TelemetryRecord) {
      const c = new WriteRateController();
      c.recordWrite("EVT001", FlightPhase.PARKED, initial);
      vi.advanceTimersByTime(1000);
      return c;
    }

    it("emits immediately on a phase transition", () => {
      const rec = mockTelemetry({ icao: "EVT001" });
      const c = parkedController(rec);
      expect(c.shouldWrite("EVT001", FlightPhase.PARKED, rec)).toBe(false);
      expect(c.shouldWrite("EVT001", FlightPhase.TAXI, rec)).toBe(true);
    });

    it("emits immediately on a squawk change", () => {
      const rec = mockTelemetry({ icao: "EVT001", squawk: "1000" });
      const c = parkedController(rec);
      const squawked = mockTelemetry({ icao: "EVT001", squawk: "7700" });
      expect(c.shouldWrite("EVT001", FlightPhase.PARKED, squawked)).toBe(true);
    });

    it("emits immediately when the aircraft leaves the ground", () => {
      const rec = mockTelemetry({ icao: "EVT001", on_ground: true });
      const c = parkedController(rec);
      const airborne = mockTelemetry({ icao: "EVT001", on_ground: false });
      expect(c.shouldWrite("EVT001", FlightPhase.PARKED, airborne)).toBe(true);
    });

    it("emits when the vertical rate crosses the climb threshold", () => {
      const rec = mockTelemetry({ icao: "EVT001", baro_rate: 200 });
      const c = parkedController(rec);
      expect(
        c.shouldWrite("EVT001", FlightPhase.PARKED, mockTelemetry({ baro_rate: 900 })),
      ).toBe(false);
      expect(
        c.shouldWrite("EVT001", FlightPhase.PARKED, mockTelemetry({ baro_rate: 1200 })),
      ).toBe(true);
    });

    it("emits on a heading change beyond the threshold, using shortest arc", () => {
      const rec = mockTelemetry({ icao: "EVT001", true_heading: 355 });
      const c = parkedController(rec);
      // 355° -> 2° is a 7° turn across north, below the 10° threshold.
      expect(
        c.shouldWrite("EVT001", FlightPhase.PARKED, mockTelemetry({ true_heading: 2 })),
      ).toBe(false);
      expect(
        c.shouldWrite("EVT001", FlightPhase.PARKED, mockTelemetry({ true_heading: 20 })),
      ).toBe(true);
    });

    it("emits on an altitude change beyond the threshold", () => {
      const rec = mockTelemetry({ icao: "EVT001", alt_baro: 10_000 });
      const c = parkedController(rec);
      expect(
        c.shouldWrite("EVT001", FlightPhase.PARKED, mockTelemetry({ alt_baro: 10_300 })),
      ).toBe(false);
      expect(
        c.shouldWrite("EVT001", FlightPhase.PARKED, mockTelemetry({ alt_baro: 10_600 })),
      ).toBe(true);
    });

    it("reports why a write was emitted", () => {
      const rec = mockTelemetry({ icao: "TRG001", alt_baro: 10_000 });
      const c = new WriteRateController();
      expect(c.getWriteTrigger("TRG001", FlightPhase.PARKED, rec)).toBe("first");
      c.recordWrite("TRG001", FlightPhase.PARKED, rec);
      expect(c.getWriteTrigger("TRG001", FlightPhase.PARKED, rec)).toBeNull();
      expect(
        c.getWriteTrigger("TRG001", FlightPhase.PARKED, mockTelemetry({ alt_baro: 12_000 })),
      ).toBe("event");
      vi.advanceTimersByTime(60_000);
      expect(c.getWriteTrigger("TRG001", FlightPhase.PARKED, rec)).toBe("interval");
    });
  });
});
