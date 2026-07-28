import {
  decodeAgentPayload,
  decodeFlightEventPayload,
  decodeTelemetryPayload,
  flattenOpReturnScript,
  parseOpReturnPayload,
} from "@airchive/telemetry-codec";
import { createLogger } from "@airchive/logger";

const log = createLogger({ service: "gateway" });

/**
 * Mirrors `parseAirchiveTx` in the overlay node. The gateway cannot import from
 * a sibling service, so the codec is used directly here rather than duplicating
 * any of the wire-format knowledge that lives in `@airchive/telemetry-codec`.
 */
const RECORD_TYPE_FLIGHT_EVENT = 0x02;
const RECORD_TYPE_AGENT_ANALYSIS = 0x04;
const RECORD_TYPE_AGENT_MONITOR = 0x05;

/** Miner APIs are a best-effort side path; a slow one must never stall a request. */
const NETWORK_TIMEOUT_MS = 2_500;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ENVELOPE_CACHE_LIMIT = 500;

/**
 * On-chain data is immutable, so a successful lookup can be reused for the life
 * of the process. Only successes are cached: caching misses would pin a
 * transient outage into every later request.
 */
const envelopeCache = new Map<string, Buffer>();

export interface DecodedEnvelope {
  protocolId: string;
  version: number;
  icaoHex: string;
  timestamp: number;
  recordType: number;
  fields: Record<string, unknown>;
  rawHex: string;
}

/** Postgres BYTEA arrives as a Buffer through Knex, but drivers vary. */
export function bufferFromColumn(raw: unknown): Buffer | null {
  if (raw === null || raw === undefined) return null;
  if (Buffer.isBuffer(raw)) return raw.length > 0 ? raw : null;
  if (raw instanceof Uint8Array) {
    return raw.length > 0 ? Buffer.from(raw) : null;
  }
  return null;
}

export function decodeEnvelope(flat: Buffer): DecodedEnvelope {
  const parsed = parseOpReturnPayload(new Uint8Array(flat));
  const recordType = Number(parsed.recordType);
  const fields =
    recordType === RECORD_TYPE_FLIGHT_EVENT
      ? decodeFlightEventPayload(parsed.payload)
      : recordType === RECORD_TYPE_AGENT_ANALYSIS
          || recordType === RECORD_TYPE_AGENT_MONITOR
        ? decodeAgentPayload(parsed.payload)
        : decodeTelemetryPayload(parsed.payload);

  return {
    protocolId: parsed.protocolId,
    version: parsed.version,
    icaoHex: parsed.icao,
    timestamp: parsed.timestamp,
    recordType,
    fields: fields as unknown as Record<string, unknown>,
    rawHex: flat.toString("hex"),
  };
}

/** Returns null rather than throwing so callers can degrade to an undecoded row. */
export function tryDecodeEnvelope(flat: Buffer): DecodedEnvelope | null {
  try {
    return decodeEnvelope(flat);
  } catch {
    return null;
  }
}

function normaliseBase(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  return trimmed === "" ? null : trimmed;
}

/**
 * Arcade first: it is the broadcaster we write through, so it holds our own
 * transactions soonest. WhatsOnChain backs it up once a transaction is mined.
 */
function candidateUrls(txid: string): string[] {
  const urls: string[] = [];
  const arcade = normaliseBase(process.env.ARCADE_URL);
  if (arcade) urls.push(`${arcade}/tx/${txid}`);
  const woc = normaliseBase(process.env.WOC_API_URL);
  if (woc) urls.push(`${woc}/tx/hash/${txid}`);
  return urls;
}

async function httpGetBody(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json, text/plain" },
    });
    if (!res.ok) return null;

    const declaredLength = Number(res.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_RESPONSE_BYTES) return null;

    const body = await res.text();
    return body.length > MAX_RESPONSE_BYTES ? null : body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readVarInt(
  buf: Buffer,
  offset: number,
): { value: number; next: number } | null {
  if (offset >= buf.length) return null;
  const first = buf[offset]!;
  if (first < 0xfd) return { value: first, next: offset + 1 };
  if (first === 0xfd) {
    if (offset + 3 > buf.length) return null;
    return { value: buf.readUInt16LE(offset + 1), next: offset + 3 };
  }
  if (first === 0xfe) {
    if (offset + 5 > buf.length) return null;
    return { value: buf.readUInt32LE(offset + 1), next: offset + 5 };
  }
  if (offset + 9 > buf.length) return null;
  const wide = buf.readBigUInt64LE(offset + 1);
  if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { value: Number(wide), next: offset + 9 };
}

/**
 * Extracts output locking scripts from a serialised transaction. Only the
 * output scripts are of interest, so inputs are skipped rather than parsed, and
 * any malformed length yields an empty result instead of a partial read.
 */
function outputScriptsFromRawTx(raw: Buffer): Buffer[] {
  let offset = 4;

  const inputCount = readVarInt(raw, offset);
  if (!inputCount) return [];
  offset = inputCount.next;

  for (let i = 0; i < inputCount.value; i++) {
    offset += 36;
    const scriptLen = readVarInt(raw, offset);
    if (!scriptLen) return [];
    offset = scriptLen.next + scriptLen.value + 4;
    if (offset > raw.length) return [];
  }

  const outputCount = readVarInt(raw, offset);
  if (!outputCount) return [];
  offset = outputCount.next;

  const scripts: Buffer[] = [];
  for (let i = 0; i < outputCount.value; i++) {
    offset += 8;
    const scriptLen = readVarInt(raw, offset);
    if (!scriptLen) return [];
    const start = scriptLen.next;
    const end = start + scriptLen.value;
    if (end > raw.length) return [];
    scripts.push(raw.subarray(start, end));
    offset = end;
  }

  return scripts;
}

const HEX_RE = /^[0-9a-fA-F]+$/;

function scriptsFromHexTx(hex: string): Buffer[] {
  const trimmed = hex.trim();
  if (trimmed.length < 20 || trimmed.length % 2 !== 0 || !HEX_RE.test(trimmed)) {
    return [];
  }
  return outputScriptsFromRawTx(Buffer.from(trimmed, "hex"));
}

/**
 * Accepts the shapes the two upstreams return: WhatsOnChain answers with a
 * decoded transaction carrying `vout[].scriptPubKey.hex`, whereas Arcade may
 * answer with the serialised transaction either as a bare hex body or wrapped
 * in a JSON field.
 */
function lockingScriptsFromBody(body: string): Buffer[] {
  const trimmed = body.trim();
  if (trimmed === "") return [];

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith('"')) {
    return scriptsFromHexTx(trimmed);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (typeof parsed === "string") return scriptsFromHexTx(parsed);
  if (parsed === null || typeof parsed !== "object") return [];

  const record = parsed as Record<string, unknown>;
  const container =
    record.data !== null && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : record;

  const vout = container.vout;
  if (Array.isArray(vout)) {
    const scripts: Buffer[] = [];
    for (const entry of vout) {
      if (entry === null || typeof entry !== "object") continue;
      const spk = (entry as Record<string, unknown>).scriptPubKey;
      const hex =
        spk !== null && typeof spk === "object"
          ? (spk as Record<string, unknown>).hex
          : undefined;
      if (typeof hex === "string" && hex !== "" && HEX_RE.test(hex)) {
        scripts.push(Buffer.from(hex, "hex"));
      }
    }
    if (scripts.length > 0) return scripts;
  }

  for (const key of ["hex", "rawTx", "rawtx", "txHex", "transaction"]) {
    const value = container[key];
    if (typeof value === "string") {
      const scripts = scriptsFromHexTx(value);
      if (scripts.length > 0) return scripts;
    }
  }

  return [];
}

/**
 * Recovers the flat AIRCHIVE envelope for a transaction written before the
 * `op_return` column existed. Returns null on any failure so the caller can
 * serve the row undecoded.
 */
export async function fetchEnvelopeFromNetwork(
  txid: string,
): Promise<Buffer | null> {
  const cached = envelopeCache.get(txid);
  if (cached) return cached;

  for (const url of candidateUrls(txid)) {
    const body = await httpGetBody(url);
    if (body === null) continue;

    for (const script of lockingScriptsFromBody(body)) {
      const flat = flattenOpReturnScript(new Uint8Array(script));
      if (flat === null) continue;

      const envelope = Buffer.from(flat);
      if (envelopeCache.size >= ENVELOPE_CACHE_LIMIT) {
        const oldest = envelopeCache.keys().next();
        if (!oldest.done) envelopeCache.delete(oldest.value);
      }
      envelopeCache.set(txid, envelope);
      return envelope;
    }
  }

  log.debug({ txid }, "No AIRCHIVE envelope recovered from upstream APIs");
  return null;
}
