/**
 * Chronicle-validated locking/unlocking scripts for Airchive telemetry.
 *
 * Uses BSV Chronicle opcodes (activated 7 Apr 2026) to enforce that
 * the telemetry payload's ICAO field matches the expected aircraft
 * address — validated at the consensus layer by Bitcoin script itself.
 *
 * Locking script (on change output):
 *   <payload> is provided in the unlocking script alongside sig + pubkey.
 *   The script extracts the 3-byte ICAO from the payload header and
 *   verifies it matches the expected value before checking the P2PKH sig.
 *
 * Payload header layout (from buildOpReturnPayload):
 *   [0..7]  PROTOCOL_ID  "AIRCHIVE" (8 bytes)
 *   [8]     VERSION       0x01 or 0x02 (1 byte)
 *   [9..11] ICAO          3 bytes
 *   [12..19] TIMESTAMP    8 bytes (little-endian uint64)
 *   [20]    RECORD_TYPE   1 byte
 *   [21..]  PAYLOAD       msgpack data
 */

import { PROTOCOL_ID_BYTES } from "./constants.js";
import { encodeIcaoHex } from "./encoder.js";

const OP_DUP = 0x76;
const OP_HASH160 = 0xa9;
const OP_EQUALVERIFY = 0x88;
const OP_CHECKSIG = 0xac;
const OP_SPLIT = 0x7f;
const OP_NIP = 0x77;
const OP_DROP = 0x75;
const OP_VERIFY = 0x69;
const OP_SIZE = 0x82;
const OP_GREATERTHAN = 0xa0;
const OP_3 = 0x53;
const OP_9 = 0x59;

const MIN_HEADER_LEN = 21;

function pushData(script: number[], data: Uint8Array | number[]): void {
  const n = data.length;
  if (n <= 75) {
    script.push(n);
  } else if (n <= 255) {
    script.push(0x4c, n);
  } else {
    script.push(0x4d, n & 0xff, (n >> 8) & 0xff);
  }
  for (let i = 0; i < n; i++) {
    script.push(data[i]!);
  }
}

function pushSmallInt(script: number[], n: number): void {
  if (n === 0) {
    script.push(0x00);
  } else if (n >= 1 && n <= 16) {
    script.push(0x50 + n);
  } else {
    const bytes: number[] = [];
    let val = n;
    while (val > 0) {
      bytes.push(val & 0xff);
      val >>= 8;
    }
    if (bytes[bytes.length - 1]! & 0x80) bytes.push(0x00);
    pushData(script, bytes);
  }
}

/**
 * Build a Chronicle-validated P2PKH locking script.
 *
 * Unlocking script must provide: <sig> <pubkey> <airchive_payload>
 *
 * The locking script:
 *   1. Copies the payload and checks minimum size
 *   2. Splits at offset 9 to isolate the ICAO field
 *   3. Extracts 3-byte ICAO and verifies against expected value
 *   4. Splits at offset 0 to extract 8-byte protocol ID and verifies "AIRCHIVE"
 *   5. Drops validation temporaries
 *   6. Runs standard P2PKH (DUP HASH160 <pkh> EQUALVERIFY CHECKSIG)
 */
export function buildChronicleP2PKH(
  pubKeyHash: number[],
  icao: string,
): number[] {
  const expectedIcao = encodeIcaoHex(icao);
  const script: number[] = [];

  // Stack on entry: <sig> <pubkey> <payload>

  // -- Validate payload minimum length --
  script.push(OP_DUP);           // dup payload
  script.push(OP_SIZE);          // get length
  script.push(OP_NIP);           // drop the dup'd payload, keep length
  pushSmallInt(script, MIN_HEADER_LEN);
  script.push(OP_GREATERTHAN);   // length > MIN_HEADER_LEN
  script.push(OP_VERIFY);        // abort if too short

  // Stack: <sig> <pubkey> <payload>

  // -- Extract and verify ICAO (bytes 9..11) --
  script.push(OP_DUP);           // dup payload
  script.push(OP_9);             // push 9
  script.push(OP_SPLIT);         // split at 9 → <left_9> <right_from_9>
  script.push(OP_NIP);           // drop left_9, keep right_from_9
  script.push(OP_3);             // push 3
  script.push(OP_SPLIT);         // split at 3 → <icao_3bytes> <rest>
  script.push(OP_DROP);          // drop rest
  pushData(script, expectedIcao);
  script.push(OP_EQUALVERIFY);   // verify ICAO matches

  // Stack: <sig> <pubkey> <payload>

  // -- Extract and verify protocol ID (bytes 0..7 = "AIRCHIVE") --
  script.push(OP_DUP);           // dup payload
  pushSmallInt(script, 8);       // push 8
  script.push(OP_SPLIT);         // split at 8 → <proto_id_8> <rest>
  script.push(OP_DROP);          // drop rest
  pushData(script, PROTOCOL_ID_BYTES);
  script.push(OP_EQUALVERIFY);   // verify protocol ID = "AIRCHIVE"

  // Stack: <sig> <pubkey> <payload>

  // -- Drop payload, proceed to standard P2PKH --
  script.push(OP_DROP);

  // Stack: <sig> <pubkey>
  // Standard P2PKH
  script.push(OP_DUP);
  script.push(OP_HASH160);
  pushData(script, pubKeyHash);
  script.push(OP_EQUALVERIFY);
  script.push(OP_CHECKSIG);

  return script;
}

/**
 * Estimated size of the Chronicle-validated unlocking script.
 * Standard P2PKH unlock (sig + pubkey) = ~107 bytes
 * Plus the telemetry payload push (typically 100-400 bytes).
 */
export function estimateChronicleUnlockSize(payloadLen: number): number {
  const sigPush = 1 + 73;
  const pubkeyPush = 1 + 33;
  const payloadPush = payloadLen <= 75 ? 1 + payloadLen
    : payloadLen <= 255 ? 2 + payloadLen
    : 3 + payloadLen;
  return sigPush + pubkeyPush + payloadPush;
}

export const CHRONICLE_TX_VERSION = 2;
