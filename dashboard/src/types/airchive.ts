/**
 * Dashboard-local type definitions mirroring @airchive/types.
 * Once the monorepo workspace wiring is complete these can be replaced
 * with direct re-exports from the shared package.
 */

export enum FlightPhase {
  PARKED = "PARKED",
  TAXI = "TAXI",
  TAKEOFF = "TAKEOFF",
  CLIMB = "CLIMB",
  CRUISE = "CRUISE",
  DESCENT = "DESCENT",
  APPROACH = "APPROACH",
  LANDING = "LANDING",
  TAXI_IN = "TAXI_IN",
}

export enum RecordType {
  TELEMETRY = 0x01,
  FLIGHT_EVENT = 0x02,
  TELEMETRY_DELTA = 0x03,
}

export type EmergencyString =
  | "none"
  | "general"
  | "lifeguard"
  | "minfuel"
  | "nordo"
  | "unlawful"
  | "downed";

export interface TelemetryRecord {
  icao: string;
  callsign: string;
  reg: string;
  squawk: string;
  aircraft_type: string;
  category: string;
  ts: number;
  ts_pos: number;
  lat: number;
  lon: number;
  alt_baro: number;
  alt_geom: number;
  on_ground: boolean;
  gs: number;
  ias: number;
  tas: number;
  mach: number;
  track: number;
  true_heading: number;
  mag_heading: number;
  baro_rate: number;
  geom_rate: number;
  roll: number;
  wind_dir: number;
  wind_speed: number;
  oat: number;
  tat: number;
  nav_qnh: number;
  nav_alt_mcp: number;
  nav_alt_fms: number;
  nav_heading: number;
  nav_modes: string[];
  nic: number;
  rc: number;
  adsb_version: number;
  position_source: number;
  num_receivers: number;
  emergency: EmergencyString;
  data_sources: string[];
  seq: number;
  flight_id?: string;
}

export type FlightEventType =
  | "PUSHBACK"
  | "TAXI_START"
  | "TAKEOFF"
  | "TOP_OF_CLIMB"
  | "CRUISE"
  | "TOP_OF_DESCENT"
  | "APPROACH"
  | "LANDING"
  | "TAXI_END"
  | "PARKED"
  | "EMERGENCY";

export interface FlightEventRecord {
  type: "FLIGHT_EVENT";
  event: FlightEventType;
  flight_id: string;
  icao: string;
  callsign: string;
  reg: string;
  summary: string;
  airport_icao?: string;
  airport_name?: string;
  destination_icao?: string;
  destination_name?: string;
  est_flight_time_min?: number;
  lat: number;
  lon: number;
  alt_baro: number;
  gs: number;
  track: number;
}

export interface TxResult {
  txid: string;
  aircraft_icao: string;
  record_type: RecordType;
  status: "SEEN_ON_NETWORK" | "MINED" | "FAILED";
  block_height?: number;
  merkle_path?: string;
  timestamp: number;
  created_at?: string | Date;
  fee_sats: number;
  size_bytes: number;
  chronicle_validated?: boolean;
}

export enum AlertSeverity {
  INFO = "INFO",
  WARNING = "WARNING",
  CRITICAL = "CRITICAL",
  EMERGENCY = "EMERGENCY",
}

export interface AlertRecord {
  id: string;
  aircraft_icao: string;
  flight_id?: string;
  severity: AlertSeverity;
  type: string;
  message: string;
  data: Record<string, unknown>;
  acknowledged: boolean;
  created_at: Date;
}

export type EmergencySquawk = "7700" | "7600" | "7500";

export function isEmergencySquawk(code: string): code is EmergencySquawk {
  return code === "7700" || code === "7600" || code === "7500";
}

/** Aircraft state as tracked by the dashboard fleet store. */
export interface AircraftState {
  icao: string;
  callsign: string;
  reg: string;
  aircraft_type: string;
  squawk: string;
  phase: FlightPhase;
  lat: number;
  lon: number;
  alt_baro: number;
  alt_geom: number;
  gs: number;
  ias: number;
  tas: number;
  mach: number;
  track: number;
  true_heading: number;
  mag_heading: number;
  baro_rate: number;
  geom_rate: number;
  wind_dir: number;
  wind_speed: number;
  nav_modes: string[];
  on_ground: boolean;
  emergency: EmergencyString;
  last_txid?: string;
  last_seen: number;
}

/** A blockchain feed entry combining TxResult with optional event data. */
export interface BlockchainEntry extends TxResult {
  flight_event?: FlightEventRecord;
}

/** Telemetry time-series data point for charts. */
export interface TelemetryDataPoint {
  ts: number;
  alt_baro: number;
  gs: number;
  ias: number;
  tas: number;
}
