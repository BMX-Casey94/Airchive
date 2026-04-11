import type { FlightEventRecord, TelemetryRecord } from "@airchive/types";
import {
  decodeFlightEventPayload,
  decodeTelemetryPayload,
  parseOpReturnPayload,
  RecordType,
} from "@airchive/telemetry-codec";

export interface ParsedAirchiveTx {
  recordType: number;
  icao: string;
  timestamp: number;
  payload: TelemetryRecord | FlightEventRecord;
}

export function parseAirchiveTx(rawOpReturn: Buffer): ParsedAirchiveTx {
  const u8 = new Uint8Array(rawOpReturn);
  const parsed = parseOpReturnPayload(u8);
  let payload: TelemetryRecord | FlightEventRecord;
  if (parsed.recordType === RecordType.FLIGHT_EVENT) {
    payload = decodeFlightEventPayload(parsed.payload);
  } else {
    payload = decodeTelemetryPayload(parsed.payload);
  }
  return {
    recordType: parsed.recordType,
    icao: parsed.icao,
    timestamp: parsed.timestamp,
    payload,
  };
}
