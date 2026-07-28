import type { FlightEventRecord, TelemetryRecord } from "@airchive/types";
import {
  decodeAgentPayload,
  decodeFlightEventPayload,
  decodeTelemetryPayload,
  parseOpReturnPayload,
  RecordType,
} from "@airchive/telemetry-codec";

export type AirchivePayload =
  | TelemetryRecord
  | FlightEventRecord
  | Record<string, unknown>;

export interface ParsedAirchiveTx {
  recordType: number;
  icao: string;
  timestamp: number;
  payload: AirchivePayload;
}

export function parseAirchiveTx(rawOpReturn: Buffer): ParsedAirchiveTx {
  const u8 = new Uint8Array(rawOpReturn);
  const parsed = parseOpReturnPayload(u8);
  let payload: AirchivePayload;
  if (parsed.recordType === RecordType.FLIGHT_EVENT) {
    payload = decodeFlightEventPayload(parsed.payload);
  } else if (
    parsed.recordType === RecordType.AGENT_ANALYSIS
    || parsed.recordType === RecordType.AGENT_MONITOR
  ) {
    payload = decodeAgentPayload(parsed.payload);
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
