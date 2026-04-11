import { encode } from "@msgpack/msgpack";
import type { FlightEventRecord, TelemetryRecord } from "@airchive/types";

import {
  PROTOCOL_ID_BYTES,
  PROTOCOL_VERSION,
  RecordType,
} from "./constants.js";

export * from "./constants.js";

const ICAO_HEX_RE = /^[0-9a-fA-F]{6}$/;

export function encodeIcaoHex(icao: string): Uint8Array {
  if (!ICAO_HEX_RE.test(icao)) {
    throw new RangeError("ICAO hex must be exactly 6 hexadecimal characters");
  }
  const out = new Uint8Array(3);
  for (let i = 0; i < 3; i++) {
    out[i] = Number.parseInt(icao.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function encodeTimestamp(ms: number): Uint8Array {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError("Timestamp must be a finite non-negative number");
  }
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(Math.floor(ms)), true);
  return new Uint8Array(buf);
}

const RENAME_KEYS: Record<string, string> = {
  adsb_version: "transponder_ver",
};

const SOURCE_ALIASES: Record<string, string> = {
  adsbfi: "feed_1",
  opensky: "feed_2",
  rtlsdr: "feed_3",
};

export function encodeTelemetryPayload(record: TelemetryRecord): Uint8Array {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    const outKey = RENAME_KEYS[k] ?? k;
    if (outKey === "data_sources" && Array.isArray(v)) {
      cleaned[outKey] = v.map((s: string) => SOURCE_ALIASES[s] ?? s);
    } else {
      cleaned[outKey] = v;
    }
  }
  return encode(cleaned);
}

export function encodeFlightEventPayload(event: FlightEventRecord): Uint8Array {
  return encode(event);
}

export function buildOpReturnPayload(
  icao: string,
  timestamp: number,
  recordType: RecordType,
  payload: Uint8Array,
): Uint8Array {
  const headerLen = PROTOCOL_ID_BYTES.length + 1 + 3 + 8 + 1;
  const icaoBytes = encodeIcaoHex(icao);
  const tsBytes = encodeTimestamp(timestamp);
  const out = new Uint8Array(headerLen + payload.length);
  let o = 0;
  out.set(PROTOCOL_ID_BYTES, o);
  o += PROTOCOL_ID_BYTES.length;
  out[o] = PROTOCOL_VERSION;
  o += 1;
  out.set(icaoBytes, o);
  o += 3;
  out.set(tsBytes, o);
  o += 8;
  out[o] = recordType;
  o += 1;
  out.set(payload, o);
  return out;
}

function appendPush(script: number[], data: Uint8Array): void {
  const n = data.length;
  if (n <= 75) {
    script.push(n);
  } else if (n <= 255) {
    script.push(0x4c, n);
  } else if (n <= 65_535) {
    script.push(0x4d, n & 0xff, (n >> 8) & 0xff);
  } else if (n <= 0xffff_ffff) {
    script.push(
      0x4e,
      n & 0xff,
      (n >> 8) & 0xff,
      (n >> 16) & 0xff,
      (n >> 24) & 0xff,
    );
  } else {
    throw new RangeError("Push data exceeds maximum script push length");
  }
  for (let i = 0; i < n; i++) {
    script.push(data[i]!);
  }
}

export function buildOpReturnScript(
  icao: string,
  timestamp: number,
  recordType: RecordType,
  payload: Uint8Array,
): number[] {
  const script: number[] = [0x00, 0x6a];
  appendPush(script, PROTOCOL_ID_BYTES);
  appendPush(script, new Uint8Array([PROTOCOL_VERSION]));
  appendPush(script, encodeIcaoHex(icao));
  appendPush(script, encodeTimestamp(timestamp));
  appendPush(script, new Uint8Array([recordType]));
  appendPush(script, payload);
  return script;
}
