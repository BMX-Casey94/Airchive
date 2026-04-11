/* ──────────────────────────────────────────────────────────────
 *  Airchive Dashboard — domain types
 *
 *  Mirror the canonical @airchive/types shapes that the
 *  gateway API delivers, keeping the dashboard independent
 *  of the server-side monorepo packages at build time.
 * ────────────────────────────────────────────────────────────── */

export type FlightPhase =
  | "PARKED"
  | "TAXI"
  | "TAKEOFF"
  | "CLIMB"
  | "CRUISE"
  | "DESCENT"
  | "APPROACH"
  | "LANDING"
  | "TAXI_IN"
  | "UNKNOWN";

export type EmergencyString =
  | "none"
  | "general"
  | "lifeguard"
  | "minfuel"
  | "nordo"
  | "unlawful"
  | "downed";

export type RecordType = 0x01 | 0x02 | 0x03;

export type TxStatus = "SEEN_ON_NETWORK" | "MINED" | "FAILED";

export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL" | "EMERGENCY";

/* ── Live aircraft state (from WebSocket / REST polling) ───── */
export interface AircraftState {
  icao: string;
  callsign: string;
  reg: string;
  aircraftType: string;
  squawk: string;
  lat: number;
  lon: number;
  altBaro: number;
  altGeom: number;
  onGround: boolean;
  gs: number;
  ias: number;
  tas: number;
  track: number;
  trueHeading: number;
  baroRate: number;
  emergency: EmergencyString;
  phase: FlightPhase;
  flightId?: string;
  lastSeen: number;
}

/* ── Positional snapshot for trail buffer ────────────────── */
export interface PositionSnapshot {
  lat: number;
  lon: number;
  alt: number;
  ts: number;
}

/* ── Flight session ──────────────────────────────────────── */
export interface FlightSession {
  id: string;
  aircraftIcao: string;
  callsign: string;
  originIcao?: string;
  originName?: string;
  destIcao?: string;
  destName?: string;
  phase: FlightPhase;
  startedAt: string;
  endedAt?: string;
  totalTxCount: number;
  totalSatsSpent: number;
}

/* ── Phase transition (used by FlightTimeline) ───────────── */
export interface PhaseSegment {
  phase: FlightPhase;
  startTs: number;
  endTs?: number;
  durationMs: number;
}

/* ── Transaction result (from API) ──────────────────────── */
export interface TxResultDTO {
  txid: string;
  aircraftIcao: string;
  recordType: RecordType;
  status: TxStatus;
  blockHeight?: number;
  merklePath?: string;
  timestamp: number;
  feeSats: number;
  sizeBytes: number;
  flightId?: string;
  createdAt: string;
}

/* ── Decoded OP_RETURN fields shown on tx explorer page ─── */
export interface DecodedPayload {
  protocolId: string;
  version: number;
  icaoHex: string;
  timestamp: number;
  recordType: RecordType;
  fields: Record<string, unknown>;
  rawHex: string;
}

/* ── UTXO summary per aircraft ──────────────────────────── */
export interface UtxoSummary {
  icao: string;
  balanceSats: number;
  count: number;
}

/* ── System health snapshot ──────────────────────────────── */
export interface SystemHealth {
  dbConnected: boolean;
  redisConnected: boolean;
  uptimeMs: number;
  pendingWriteCount: number;
  aircraftWriteRates: Record<string, { actual: number; expected: number }>;
  utxoSummaries: UtxoSummary[];
}

/* ── Blockchain statistics ───────────────────────────────── */
export interface BlockchainStats {
  totalTxToday: number;
  totalBytesOnChain: number;
  costTodaySats: number;
  costTodayGbp: number;
  activeAircraftCount: number;
  adaptiveRateSavingsPercent: number;
}

/* ── Completed flight card (flights page) ────────────────── */
export interface CompletedFlight {
  id: string;
  aircraftIcao: string;
  callsign: string;
  originIcao?: string;
  originName?: string;
  destIcao?: string;
  destName?: string;
  startedAt: string;
  endedAt: string;
  durationMin: number;
  totalTxCount: number;
  totalSatsSpent: number;
  phases: PhaseSegment[];
}
