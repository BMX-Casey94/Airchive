import { decode } from "@msgpack/msgpack";
import type { FlightEventRecord, TelemetryRecord } from "@airchive/types";

import {
  PROTOCOL_ID,
  PROTOCOL_ID_BYTES,
  PROTOCOL_VERSION,
  RecordType,
} from "./constants.js";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function isRecordTypeByte(b: number): b is RecordType {
  return (
    b === RecordType.TELEMETRY ||
    b === RecordType.FLIGHT_EVENT ||
    b === RecordType.TELEMETRY_DELTA
  );
}

export function decodeIcaoHex(bytes: Uint8Array): string {
  if (bytes.length !== 3) {
    throw new RangeError("ICAO hex encoding requires exactly 3 bytes");
  }
  let s = "";
  for (let i = 0; i < 3; i++) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  return s.toUpperCase();
}

export function decodeTimestamp(bytes: Uint8Array): number {
  if (bytes.length !== 8) {
    throw new RangeError("Timestamp encoding requires exactly 8 bytes");
  }
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const n = view.getBigUint64(0, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Timestamp exceeds safe integer range");
  }
  return Number(n);
}

export function parseOpReturnPayload(data: Uint8Array): {
  protocolId: string;
  version: number;
  icao: string;
  timestamp: number;
  recordType: RecordType;
  payload: Uint8Array;
} {
  const pidLen = PROTOCOL_ID_BYTES.length;
  const minLen = pidLen + 1 + 3 + 8 + 1;
  if (data.length < minLen) {
    throw new RangeError("OP_RETURN payload too short");
  }
  const pid = data.subarray(0, pidLen);
  if (!bytesEqual(pid, PROTOCOL_ID_BYTES)) {
    throw new RangeError("Invalid protocol identifier");
  }
  let o = pidLen;
  const version = data[o]!;
  if (version !== PROTOCOL_VERSION) {
    throw new RangeError(`Unsupported protocol version: ${version}`);
  }
  o += 1;
  const icao = decodeIcaoHex(data.subarray(o, o + 3));
  o += 3;
  const timestamp = decodeTimestamp(data.subarray(o, o + 8));
  o += 8;
  const rt = data[o]!;
  if (!isRecordTypeByte(rt)) {
    throw new RangeError(`Unknown record type: 0x${rt.toString(16)}`);
  }
  o += 1;
  return {
    protocolId: PROTOCOL_ID,
    version,
    icao,
    timestamp,
    recordType: rt,
    payload: data.subarray(o),
  };
}

export function decodeTelemetryPayload(payload: Uint8Array): TelemetryRecord {
  return decode(payload) as TelemetryRecord;
}

export function decodeFlightEventPayload(
  payload: Uint8Array,
): FlightEventRecord {
  return decode(payload) as FlightEventRecord;
}
