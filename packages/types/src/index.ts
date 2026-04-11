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

export interface FlightStats {
  duration_min: number;
  distance_miles: number;
  max_alt_ft: number;
  avg_gs_kts: number;
  total_tx_count: number;
  total_bsv_sats: number;
}

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
  flight_stats?: FlightStats;
}

export interface UTXORecord {
  aircraft_icao: string;
  txid: string;
  vout: number;
  satoshis: number;
  locking_script: string;
  is_locked: boolean;
  created_at: Date;
}

export interface AircraftConfig {
  icao: string;
  callsign: string;
  reg: string;
  aircraft_type: string;
  wallet_index: number;
  wallet_address: string;
  enabled: boolean;
}

export interface TxResult {
  txid: string;
  aircraft_icao: string;
  record_type: RecordType;
  status: "SEEN_ON_NETWORK" | "MINED" | "FAILED";
  block_height?: number;
  merkle_path?: string;
  timestamp: number;
  fee_sats: number;
  size_bytes: number;
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

export interface WriteRateConfig {
  phase: FlightPhase;
  interval_ms: number;
}

export const DEFAULT_WRITE_RATES: Record<FlightPhase, number> = {
  [FlightPhase.PARKED]: 300_000,
  [FlightPhase.TAXI]: 30_000,
  [FlightPhase.TAKEOFF]: 1_000,
  [FlightPhase.CLIMB]: 1_000,
  [FlightPhase.CRUISE]: 5_000,
  [FlightPhase.DESCENT]: 1_000,
  [FlightPhase.APPROACH]: 1_000,
  [FlightPhase.LANDING]: 1_000,
  [FlightPhase.TAXI_IN]: 30_000,
};

export interface FlightSession {
  id: string;
  aircraft_icao: string;
  callsign: string;
  origin_icao?: string;
  origin_name?: string;
  dest_icao?: string;
  dest_name?: string;
  phase: FlightPhase;
  started_at: Date;
  ended_at?: Date;
  total_tx_count: number;
  total_sats_spent: number;
}

export interface PendingWrite {
  id: number;
  aircraft_icao: string;
  record_type: RecordType;
  payload: Buffer | Uint8Array;
  flight_id?: string;
  created_at: Date;
  retry_count: number;
  last_error?: string;
}

export type AirportSizeType =
  | "large_airport"
  | "medium_airport"
  | "small_airport"
  | "heliport"
  | "closed";

export interface AirportInfo {
  icao_code: string;
  name: string;
  lat: number;
  lon: number;
  elevation_ft: number;
  iso_country: string;
  municipality: string;
  type: AirportSizeType;
}

export interface PhaseTransition {
  aircraft_icao: string;
  from_phase: FlightPhase;
  to_phase: FlightPhase;
  timestamp: number;
  telemetry: TelemetryRecord;
}

export const PROTOCOL_ID = "AIRCHIVE" as const;

export const PROTOCOL_VERSION = 0x01 as const;

export type EmergencySquawk = "7700" | "7600" | "7500";

/** ICAO emergency squawk (7700 / 7600 / 7500). */
export function isEmergencySquawk(code: string): code is EmergencySquawk {
  return code === "7700" || code === "7600" || code === "7500";
}
