/**
 * Chronicle-era telemetry transactions for Airchive.
 *
 * Transactions use version 2 to opt into Chronicle rules (activated
 * 7 Apr 2026, block 943,816). The OP_RETURN output embeds a
 * Chronicle validation proof — a script fragment using OP_SPLIT that
 * demonstrates on-chain ICAO and protocol ID extraction. This proof
 * is independently verifiable by any party parsing the transaction.
 *
 * Payload header layout (from buildOpReturnPayload):
 *   [0..7]  PROTOCOL_ID  "AIRCHIVE" (8 bytes)
 *   [8]     VERSION       0x01 (1 byte)
 *   [9..11] ICAO          3 bytes
 *   [12..19] TIMESTAMP    8 bytes (little-endian uint64)
 *   [20]    RECORD_TYPE   1 byte
 *   [21..]  PAYLOAD       msgpack data
 */

export const CHRONICLE_TX_VERSION = 2;
