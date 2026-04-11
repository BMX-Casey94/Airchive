import { PROTOCOL_ID_BYTES } from "@airchive/telemetry-codec";

const TOPIC = "tm_airchive";

export interface BsvTxOutput {
  script?: Buffer | Uint8Array | string;
  lockingScript?: Buffer | Uint8Array | string;
}

export interface BsvTransactionLike {
  outputs: BsvTxOutput[];
}

export interface AdmissibleOutput {
  outputIndex: number;
  airchivePayload: Buffer;
}

function toBuffer(script: Buffer | Uint8Array | string): Buffer {
  if (typeof script === "string") {
    return Buffer.from(script, "hex");
  }
  if (Buffer.isBuffer(script)) {
    return script;
  }
  return Buffer.from(script);
}

function readPush(script: Buffer, offset: number): { data: Buffer; next: number } | null {
  if (offset >= script.length) {
    return null;
  }
  const op = script[offset]!;
  if (op === 0x00) {
    return { data: Buffer.alloc(0), next: offset + 1 };
  }
  if (op >= 0x01 && op <= 0x4b) {
    const n = op;
    const end = offset + 1 + n;
    if (end > script.length) {
      return null;
    }
    return { data: script.subarray(offset + 1, end), next: end };
  }
  if (op === 0x4c) {
    if (offset + 2 > script.length) {
      return null;
    }
    const n = script[offset + 1]!;
    const end = offset + 2 + n;
    if (end > script.length) {
      return null;
    }
    return { data: script.subarray(offset + 2, end), next: end };
  }
  if (op === 0x4d) {
    if (offset + 3 > script.length) {
      return null;
    }
    const n = script.readUInt16LE(offset + 1);
    const end = offset + 3 + n;
    if (end > script.length) {
      return null;
    }
    return { data: script.subarray(offset + 3, end), next: end };
  }
  if (op === 0x4e) {
    if (offset + 5 > script.length) {
      return null;
    }
    const n = script.readUInt32LE(offset + 1);
    const end = offset + 5 + n;
    if (end > script.length || n < 0) {
      return null;
    }
    return { data: script.subarray(offset + 5, end), next: end };
  }
  return null;
}

function findOpReturnPayload(script: Buffer): Buffer | null {
  const idx = script.indexOf(0x6a);
  if (idx < 0) {
    return null;
  }
  let pos = idx + 1;
  const chunks: Buffer[] = [];
  while (pos < script.length) {
    const push = readPush(script, pos);
    if (push === null) {
      break;
    }
    if (push.data.length > 0) {
      chunks.push(push.data);
    }
    pos = push.next;
  }
  if (chunks.length === 0) {
    return null;
  }
  return Buffer.concat(chunks);
}

function hasSkycMagic(payload: Buffer): boolean {
  if (payload.length < PROTOCOL_ID_BYTES.length) {
    return false;
  }
  for (let i = 0; i < PROTOCOL_ID_BYTES.length; i++) {
    if (payload[i] !== PROTOCOL_ID_BYTES[i]) {
      return false;
    }
  }
  return true;
}

export class AirchiveTopicManager {
  readonly topicName = TOPIC;

  identifyAdmissibleOutputs(tx: BsvTransactionLike): AdmissibleOutput[] {
    const out: AdmissibleOutput[] = [];
    for (let i = 0; i < tx.outputs.length; i++) {
      const o = tx.outputs[i]!;
      const raw = o.script ?? o.lockingScript;
      if (raw === undefined) {
        continue;
      }
      const script = toBuffer(raw);
      const payload = findOpReturnPayload(script);
      if (payload !== null && hasSkycMagic(payload)) {
        out.push({ outputIndex: i, airchivePayload: payload });
      }
    }
    return out;
  }

  getDocumentation(): string {
    return [
      `Topic ${TOPIC} indexes Airchive on-chain telemetry and flight events.`,
      "Admissible outputs carry an OP_RETURN script whose concatenated push data begins with the SKYC protocol magic (0x53 0x4b 0x59 0x43).",
      "Payload layout: protocol id (4), version (1), ICAO (3), timestamp uint64 LE (8), record type (1), MessagePack body.",
      "Record types: telemetry (0x01), flight event (0x02), telemetry delta (0x03).",
    ].join(" ");
  }

  getMetaData(): Record<string, unknown> {
    return {
      topic: TOPIC,
      protocol_magic: "SKYC",
      protocol_magic_hex: "534b5943",
      description: "Airchive aircraft telemetry and flight lifecycle records on BSV",
    };
  }
}
