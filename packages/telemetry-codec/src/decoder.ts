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
    b === RecordType.TELEMETRY_DELTA ||
    b === RecordType.AGENT_ANALYSIS ||
    b === RecordType.AGENT_MONITOR
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

/**
 * Reassembles the flat envelope from an on-chain OP_RETURN locking script.
 *
 * On chain each field is a separate script push, whereas `parseOpReturnPayload`
 * reads the contiguous form stored alongside each transaction. This bridges the
 * two so a transaction fetched from the network decodes through the same path
 * as one read from the database.
 *
 * Returns null for any script that is not an AIRCHIVE OP_RETURN, since callers
 * routinely scan every output of a transaction.
 */
export function flattenOpReturnScript(script: Uint8Array): Uint8Array | null {
  let i = 0;
  // OP_FALSE OP_RETURN is the canonical prefix; a bare OP_RETURN is tolerated
  // because it remains valid and some tooling omits the leading zero.
  if (script[i] === 0x00) i += 1;
  if (script[i] !== 0x6a) return null;
  i += 1;

  const pushes: Uint8Array[] = [];
  while (i < script.length) {
    const opcode = script[i]!;
    i += 1;

    let length: number;
    if (opcode > 0 && opcode <= 75) {
      length = opcode;
    } else if (opcode === 0x4c) {
      if (i + 1 > script.length) return null;
      length = script[i]!;
      i += 1;
    } else if (opcode === 0x4d) {
      if (i + 2 > script.length) return null;
      length = script[i]! | (script[i + 1]! << 8);
      i += 2;
    } else if (opcode === 0x4e) {
      if (i + 4 > script.length) return null;
      length =
        script[i]!
        | (script[i + 1]! << 8)
        | (script[i + 2]! << 16)
        | (script[i + 3]! << 24);
      i += 4;
    } else {
      // A non-push opcode inside the data region means this is not our envelope.
      return null;
    }

    if (i + length > script.length) return null;
    pushes.push(script.subarray(i, i + length));
    i += length;
  }

  // Protocol id, version, ICAO, timestamp, record type, payload.
  if (pushes.length !== 6) return null;
  if (!bytesEqual(pushes[0]!, PROTOCOL_ID_BYTES)) return null;

  const total = pushes.reduce((sum, push) => sum + push.length, 0);
  const flat = new Uint8Array(total);
  let offset = 0;
  for (const push of pushes) {
    flat.set(push, offset);
    offset += push.length;
  }
  return flat;
}

export function decodeTelemetryPayload(payload: Uint8Array): TelemetryRecord {
  return decode(payload) as TelemetryRecord;
}

export function decodeFlightEventPayload(
  payload: Uint8Array,
): FlightEventRecord {
  return decode(payload) as FlightEventRecord;
}

export function decodeAgentPayload(payload: Uint8Array): Record<string, unknown> {
  return decode(payload) as Record<string, unknown>;
}
