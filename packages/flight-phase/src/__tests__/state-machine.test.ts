import { describe, expect, it, vi } from "vitest";
import { FlightPhase, type TelemetryRecord } from "@airchive/types";

import { FlightPhaseDetector } from "../state-machine.js";
import { isEmergencyCondition } from "../emergency.js";

function mockTelemetry(overrides: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return {
    icao: "4DABCD",
    callsign: "TEST01",
    reg: "G-TEST",
    squawk: "",
    aircraft_type: "B738",
    category: "",
    ts: 1_700_000_000_000,
    ts_pos: 1_700_000_000_000,
    lat: 51.47,
    lon: -0.46,
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

describe("FlightPhaseDetector", () => {
  it("defaults initial phase to PARKED when on the ground", () => {
    const d = new FlightPhaseDetector();
    const phase = d.update(mockTelemetry({ on_ground: true, gs: 0 }));
    expect(phase).toBe(FlightPhase.PARKED);
  });

  it("defaults initial phase to CRUISE when airborne at high barometric altitude", () => {
    const d = new FlightPhaseDetector();
    const phase = d.update(
      mockTelemetry({
        on_ground: false,
        alt_baro: 35_000,
        gs: 450,
      }),
    );
    expect(phase).toBe(FlightPhase.CRUISE);
  });

  it("transitions PARKED → TAXI when ground speed rises above 5 knots on the ground", () => {
    const d = new FlightPhaseDetector();
    const icao = "PARKTX";
    d.update(mockTelemetry({ icao, on_ground: true, gs: 0 }));
    const phase = d.update(mockTelemetry({ icao, on_ground: true, gs: 8 }));
    expect(phase).toBe(FlightPhase.TAXI);
  });

  it("transitions TAXI → TAKEOFF when leaving the ground", () => {
    const d = new FlightPhaseDetector();
    const icao = "TAXITK";
    d.update(mockTelemetry({ icao, on_ground: true, gs: 0 }));
    d.update(mockTelemetry({ icao, on_ground: true, gs: 10 }));
    const phase = d.update(mockTelemetry({ icao, on_ground: false, gs: 80, alt_baro: 500 }));
    expect(phase).toBe(FlightPhase.TAKEOFF);
  });

  it("transitions TAKEOFF → CLIMB when altitude and vertical rate exceed thresholds", () => {
    const d = new FlightPhaseDetector();
    const icao = "TKCLMB";
    d.update(mockTelemetry({ icao, on_ground: true, gs: 0 }));
    d.update(mockTelemetry({ icao, on_ground: true, gs: 12 }));
    d.update(mockTelemetry({ icao, on_ground: false, gs: 160, alt_baro: 800 }));
    const phase = d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        gs: 220,
        alt_baro: 4500,
        baro_rate: 2500,
      }),
    );
    expect(phase).toBe(FlightPhase.CLIMB);
  });

  it("transitions CLIMB → CRUISE after vertical rate stays level for 60 seconds", () => {
    const d = new FlightPhaseDetector();
    const icao = "CLMCRS";
    const t0 = 1_710_000_000_000;
    d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 12_000,
        gs: 320,
        baro_rate: 800,
        ts: t0,
      }),
    );
    d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 14_000,
        gs: 340,
        baro_rate: 50,
        ts: t0 + 1000,
      }),
    );
    const phase = d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 14_500,
        gs: 345,
        baro_rate: 0,
        ts: t0 + 61_001,
      }),
    );
    expect(phase).toBe(FlightPhase.CRUISE);
  });

  it("transitions CRUISE → DESCENT after a sustained negative vertical rate (30 seconds)", () => {
    const d = new FlightPhaseDetector();
    const icao = "CRSDSC";
    const t0 = 1_720_000_000_000;
    d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 36_000,
        gs: 460,
        baro_rate: 0,
        ts: t0,
      }),
    );
    d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 35_500,
        gs: 455,
        baro_rate: -1200,
        ts: t0 + 1000,
      }),
    );
    const phase = d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 34_000,
        gs: 440,
        baro_rate: -1500,
        ts: t0 + 31_000,
      }),
    );
    expect(phase).toBe(FlightPhase.DESCENT);
  });

  it("transitions DESCENT → APPROACH when below 10,000 feet", () => {
    const d = new FlightPhaseDetector();
    const icao = "DSCAPR";
    const t0 = 1_730_000_000_000;
    d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 36_000,
        gs: 460,
        baro_rate: 0,
        ts: t0,
      }),
    );
    d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 35_000,
        gs: 450,
        baro_rate: -1200,
        ts: t0 + 1000,
      }),
    );
    d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 33_000,
        gs: 430,
        baro_rate: -1500,
        ts: t0 + 32_000,
      }),
    );
    const phase = d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 9500,
        gs: 280,
        baro_rate: -800,
        ts: t0 + 33_000,
      }),
    );
    expect(phase).toBe(FlightPhase.APPROACH);
  });

  it("transitions APPROACH → LANDING when returning to the ground", () => {
    const d = new FlightPhaseDetector();
    const icao = "APPLND";
    const t0 = 1_740_000_000_000;
    d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 36_000,
        gs: 460,
        baro_rate: 0,
        ts: t0,
      }),
    );
    d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 35_000,
        gs: 450,
        baro_rate: -1200,
        ts: t0 + 1000,
      }),
    );
    d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 33_000,
        gs: 430,
        baro_rate: -1500,
        ts: t0 + 32_000,
      }),
    );
    d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 9000,
        gs: 220,
        baro_rate: -600,
        ts: t0 + 33_000,
      }),
    );
    const phase = d.update(
      mockTelemetry({
        icao,
        on_ground: true,
        alt_baro: 0,
        gs: 95,
        baro_rate: 0,
        ts: t0 + 34_000,
      }),
    );
    expect(phase).toBe(FlightPhase.LANDING);
  });

  it("runs the LANDING → TAXI_IN → PARKED sequence using ground speed and dwell time", () => {
    const d = new FlightPhaseDetector();
    const icao = "LNDPRK";
    const t0 = 1_750_000_000_000;
    d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 36_000,
        gs: 460,
        baro_rate: 0,
        ts: t0,
      }),
    );
    d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 35_000,
        gs: 450,
        baro_rate: -1200,
        ts: t0 + 1000,
      }),
    );
    d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 33_000,
        gs: 430,
        baro_rate: -1500,
        ts: t0 + 32_000,
      }),
    );
    d.update(
      mockTelemetry({
        icao,
        on_ground: false,
        alt_baro: 9000,
        gs: 200,
        baro_rate: -500,
        ts: t0 + 33_000,
      }),
    );
    d.update(
      mockTelemetry({
        icao,
        on_ground: true,
        alt_baro: 0,
        gs: 45,
        baro_rate: 0,
        ts: t0 + 34_000,
      }),
    );
    expect(d.getPhase(icao)).toBe(FlightPhase.LANDING);

    d.update(
      mockTelemetry({
        icao,
        on_ground: true,
        alt_baro: 0,
        gs: 12,
        baro_rate: 0,
        ts: t0 + 35_000,
      }),
    );
    expect(d.getPhase(icao)).toBe(FlightPhase.TAXI_IN);

    d.update(
      mockTelemetry({
        icao,
        on_ground: true,
        alt_baro: 0,
        gs: 0,
        baro_rate: 0,
        ts: t0 + 36_000,
      }),
    );

    const phase = d.update(
      mockTelemetry({
        icao,
        on_ground: true,
        alt_baro: 0,
        gs: 0,
        baro_rate: 0,
        ts: t0 + 96_000,
      }),
    );
    expect(phase).toBe(FlightPhase.PARKED);
  });

  it("does not change phase solely because of an emergency, whilst still detecting the condition", () => {
    const d = new FlightPhaseDetector();
    const icao = "EMRG01";
    const cruise = mockTelemetry({
      icao,
      on_ground: false,
      alt_baro: 35_000,
      gs: 450,
      baro_rate: 0,
      squawk: "7700",
    });
    d.update(cruise);
    const before = d.getPhase(icao);
    expect(isEmergencyCondition(cruise)).toBe(true);
    const after = d.update({
      ...cruise,
      ts: cruise.ts + 5000,
      baro_rate: 0,
    });
    expect(after).toBe(before);
    expect(after).toBe(FlightPhase.CRUISE);
  });

  it("invokes the phase transition listener with the correct payload", () => {
    const d = new FlightPhaseDetector();
    const listener = vi.fn();
    d.onTransition(listener);
    const icao = "LSTNR1";
    d.update(mockTelemetry({ icao, on_ground: true, gs: 0 }));
    d.update(mockTelemetry({ icao, on_ground: true, gs: 10 }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]).toMatchObject({
      aircraft_icao: icao,
      from_phase: FlightPhase.PARKED,
      to_phase: FlightPhase.TAXI,
    });
  });

  it("tracks multiple aircraft independently", () => {
    const d = new FlightPhaseDetector();
    expect(d.update(mockTelemetry({ icao: "AAA111", on_ground: true, gs: 0 }))).toBe(
      FlightPhase.PARKED,
    );
    expect(
      d.update(
        mockTelemetry({
          icao: "BBB222",
          on_ground: false,
          alt_baro: 38_000,
          gs: 480,
        }),
      ),
    ).toBe(FlightPhase.CRUISE);
    expect(d.getPhase("AAA111")).toBe(FlightPhase.PARKED);
    expect(d.getPhase("BBB222")).toBe(FlightPhase.CRUISE);
  });
});
