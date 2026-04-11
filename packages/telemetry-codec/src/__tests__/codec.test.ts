import { describe, expect, it } from "vitest";
import type { FlightEventRecord, TelemetryRecord } from "@airchive/types";

import {
  buildOpReturnPayload,
  encodeFlightEventPayload,
  encodeIcaoHex,
  encodeTelemetryPayload,
  encodeTimestamp,
  RecordType,
} from "../encoder.js";
import {
  decodeFlightEventPayload,
  decodeIcaoHex,
  decodeTelemetryPayload,
  decodeTimestamp,
  parseOpReturnPayload,
} from "../decoder.js";
import { PROTOCOL_ID_BYTES, PROTOCOL_VERSION } from "../constants.js";

function mockTelemetry(overrides: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return {
    icao: "A1B2C3",
    callsign: "TEST01",
    reg: "G-TEST",
    squawk: "1234",
    aircraft_type: "B738",
    category: "",
    ts: 1_704_067_200_000,
    ts_pos: 1_704_067_200_000,
    lat: 51.47,
    lon: -0.46,
    alt_baro: 32_000,
    alt_geom: 32_000,
    on_ground: false,
    gs: 450,
    ias: 280,
    tas: 470,
    mach: 0.78,
    track: 90,
    true_heading: 92,
    mag_heading: 90,
    baro_rate: 0,
    geom_rate: 0,
    roll: 0,
    wind_dir: 270,
    wind_speed: 40,
    oat: -45,
    tat: -12,
    nav_qnh: 1013,
    nav_alt_mcp: 32_000,
    nav_alt_fms: 32_000,
    nav_heading: 90,
    nav_modes: ["LNAV", "VNAV"],
    nic: 8,
    rc: 0,
    adsb_version: 2,
    position_source: 1,
    num_receivers: 3,
    emergency: "none",
    data_sources: ["adsbfi"],
    seq: 1,
    ...overrides,
  };
}

describe("telemetry codec", () => {
  describe("ICAO hex", () => {
    it("round-trips encodeIcaoHex and decodeIcaoHex", () => {
      const samples = ["a1b2c3", "00FFAA", "abcdef"];
      for (const icao of samples) {
        const bytes = encodeIcaoHex(icao);
        expect(decodeIcaoHex(bytes)).toBe(icao.toUpperCase());
      }
    });

    it("throws for invalid ICAO hex strings", () => {
      expect(() => encodeIcaoHex("")).toThrow(RangeError);
      expect(() => encodeIcaoHex("GGGGGG")).toThrow(RangeError);
      expect(() => encodeIcaoHex("12345")).toThrow(RangeError);
      expect(() => encodeIcaoHex("1234567")).toThrow(RangeError);
    });
  });

  describe("timestamp", () => {
    it("round-trips encodeTimestamp and decodeTimestamp", () => {
      const values = [0, 1, 1_704_067_200_000, Number.MAX_SAFE_INTEGER];
      for (const ms of values) {
        expect(decodeTimestamp(encodeTimestamp(ms))).toBe(ms);
      }
    });

    it("rejects non-finite or negative timestamps when encoding", () => {
      expect(() => encodeTimestamp(-1)).toThrow(RangeError);
      expect(() => encodeTimestamp(Number.NaN)).toThrow(RangeError);
    });
  });

  describe("OP_RETURN envelope", () => {
    it("round-trips buildOpReturnPayload and parseOpReturnPayload for telemetry", () => {
      const record = mockTelemetry();
      const payload = encodeTelemetryPayload(record);
      const raw = buildOpReturnPayload(record.icao, record.ts, RecordType.TELEMETRY, payload);
      const parsed = parseOpReturnPayload(raw);
      expect(parsed.icao).toBe(record.icao.toUpperCase());
      expect(parsed.timestamp).toBe(record.ts);
      expect(parsed.recordType).toBe(RecordType.TELEMETRY);
      expect(decodeTelemetryPayload(parsed.payload)).toEqual(record);
    });

    it("throws when the protocol identifier does not match", () => {
      const record = mockTelemetry();
      const payload = encodeTelemetryPayload(record);
      const raw = buildOpReturnPayload(record.icao, record.ts, RecordType.TELEMETRY, payload);
      raw[0] = 0xff;
      expect(() => parseOpReturnPayload(raw)).toThrow(/protocol/i);
    });

    it("throws when the protocol version is unsupported", () => {
      const record = mockTelemetry();
      const payload = encodeTelemetryPayload(record);
      const raw = buildOpReturnPayload(record.icao, record.ts, RecordType.TELEMETRY, payload);
      raw[4] = 0x99;
      expect(() => parseOpReturnPayload(raw)).toThrow(/version/i);
    });

    it("throws for an unknown record type byte", () => {
      const record = mockTelemetry();
      const payload = encodeTelemetryPayload(record);
      const raw = buildOpReturnPayload(record.icao, record.ts, RecordType.TELEMETRY, payload);
      raw[16] = 0xff;
      expect(() => parseOpReturnPayload(raw)).toThrow(/record type/i);
    });

    it("rejects payloads shorter than the fixed header", () => {
      expect(() => parseOpReturnPayload(new Uint8Array(10))).toThrow(/short/i);
    });
  });

  describe("flight event records", () => {
    it("round-trips FlightEventRecord encoding via the OP_RETURN envelope", () => {
      const event: FlightEventRecord = {
        type: "FLIGHT_EVENT",
        event: "TAKEOFF",
        flight_id: "fl-001",
        icao: "4d1234",
        callsign: "BAW123",
        reg: "G-ABCD",
        summary: "Departed runway 27L",
        airport_icao: "EGLL",
        airport_name: "London Heathrow",
        lat: 51.47,
        lon: -0.46,
        alt_baro: 1500,
        gs: 180,
        track: 270,
      };
      const body = encodeFlightEventPayload(event);
      const raw = buildOpReturnPayload(event.icao, 1_704_067_200_000, RecordType.FLIGHT_EVENT, body);
      const parsed = parseOpReturnPayload(raw);
      expect(parsed.recordType).toBe(RecordType.FLIGHT_EVENT);
      expect(decodeFlightEventPayload(parsed.payload)).toEqual(event);
    });
  });

  describe("constants alignment", () => {
    it("uses the expected on-wire protocol marker", () => {
      expect(PROTOCOL_ID_BYTES).toEqual(new Uint8Array([0x41, 0x49, 0x52, 0x43, 0x48, 0x49, 0x56, 0x45]));
      expect(PROTOCOL_VERSION).toBe(0x01);
    });
  });
});
