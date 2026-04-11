"use client";

import useSWR, { type SWRConfiguration } from "swr";
import { apiBaseUrl, fetcher } from "@/lib/api";
import type { AircraftTelemetry } from "@/stores/aircraft-store";
import type { AlertRecord, AlertSeverity } from "@/types/airchive";

/* ── Shared SWR Defaults ──────────────────────────────────────── */

const defaultOpts: SWRConfiguration = {
  revalidateOnFocus: false,
  shouldRetryOnError: true,
  errorRetryCount: 3,
};

/* ── Fleet ────────────────────────────────────────────────────── */

export interface FleetResponse {
  aircraft: AircraftTelemetry[];
  count: number;
}

export function useFleet() {
  return useSWR<FleetResponse>(
    `${apiBaseUrl}/api/fleet`,
    fetcher,
    { ...defaultOpts, refreshInterval: 2_000 },
  );
}

/* ── Single Aircraft ──────────────────────────────────────────── */

export interface AircraftDetail extends AircraftTelemetry {
  registration: string | null;
  typeCode: string | null;
  operator: string | null;
}

export function useAircraft(icao: string | null) {
  return useSWR<AircraftDetail>(
    icao ? `${apiBaseUrl}/api/aircraft/${icao}` : null,
    fetcher,
    { ...defaultOpts, refreshInterval: 2_000 },
  );
}

/* ── Flight Sessions ──────────────────────────────────────────── */

export interface FlightSession {
  flightId: string;
  icao: string;
  callsign: string | null;
  departureAirport: string | null;
  arrivalAirport: string | null;
  startTime: number;
  endTime: number | null;
  txCount: number;
  phases: string[];
}

export function useFlightSessions(icao: string | null) {
  return useSWR<FlightSession[]>(
    icao ? `${apiBaseUrl}/api/aircraft/${icao}/flights` : null,
    fetcher,
    defaultOpts,
  );
}

/* ── Alerts ───────────────────────────────────────────────────── */

export interface AlertFilters {
  severity?: AlertSeverity;
  icao?: string;
  acknowledged?: boolean;
}

function buildAlertKey(filters?: AlertFilters): string {
  const params = new URLSearchParams();
  if (filters?.severity) params.set("severity", filters.severity);
  if (filters?.icao) params.set("icao", filters.icao);
  if (filters?.acknowledged !== undefined)
    params.set("acknowledged", String(filters.acknowledged));
  const qs = params.toString();
  return `${apiBaseUrl}/api/alerts${qs ? `?${qs}` : ""}`;
}

export function useAlerts(filters?: AlertFilters) {
  return useSWR<AlertRecord[]>(
    buildAlertKey(filters),
    fetcher,
    { ...defaultOpts, refreshInterval: 5_000 },
  );
}

/* ── Metrics ──────────────────────────────────────────────────── */

export interface Metrics {
  txCountToday: number;
  bytesOnChainToday: number;
  bsvCostToday: number;
  activeAircraft: number;
  avgLatencyMs: number;
}

export function useMetrics() {
  return useSWR<Metrics>(
    `${apiBaseUrl}/api/metrics`,
    fetcher,
    { ...defaultOpts, refreshInterval: 5_000 },
  );
}

/* ── System Health ────────────────────────────────────────────── */

export interface SystemHealth {
  status: "healthy" | "degraded" | "down";
  uptime: number;
  services: Record<
    string,
    { status: "ok" | "degraded" | "down"; latencyMs: number }
  >;
}

export function useSystemHealth() {
  return useSWR<SystemHealth>(
    `${apiBaseUrl}/api/system/health`,
    fetcher,
    { ...defaultOpts, refreshInterval: 10_000 },
  );
}
