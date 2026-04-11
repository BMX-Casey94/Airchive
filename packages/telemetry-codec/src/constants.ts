export const PROTOCOL_ID = "AIRCHIVE";
export const PROTOCOL_ID_BYTES = new Uint8Array([0x41, 0x49, 0x52, 0x43, 0x48, 0x49, 0x56, 0x45]);
export const PROTOCOL_VERSION = 0x01;

export const enum RecordType {
  TELEMETRY = 0x01,
  FLIGHT_EVENT = 0x02,
  TELEMETRY_DELTA = 0x03,
}
