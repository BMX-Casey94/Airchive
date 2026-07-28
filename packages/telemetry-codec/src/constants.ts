export const PROTOCOL_ID = "AIRCHIVE";
export const PROTOCOL_ID_BYTES = new Uint8Array([0x41, 0x49, 0x52, 0x43, 0x48, 0x49, 0x56, 0x45]);
export const PROTOCOL_VERSION = 0x01;

export const enum RecordType {
  TELEMETRY = 0x01,
  FLIGHT_EVENT = 0x02,
  TELEMETRY_DELTA = 0x03,
  /** Fleet-wide analysis inscribed by the Analyst agent. */
  AGENT_ANALYSIS = 0x04,
  /** Coverage summary inscribed by the Monitor agent. */
  AGENT_MONITOR = 0x05,
}

/**
 * Agent records describe the fleet rather than one aircraft. 000000 is not an
 * allocatable ICAO 24-bit address, so it cannot collide with a real aircraft.
 */
export const FLEET_PSEUDO_ICAO = "000000";
