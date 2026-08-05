"use client";

import useSWR from "swr";
import { apiBaseUrl, fetcher } from "@/lib/api";
import { TRACKED_AIRCRAFT_MAP } from "@/lib/tracked-aircraft";
import { resolveAircraftDescription } from "@/lib/aircraft-types";
import { resolveOperator } from "@/lib/airline-operators";
import { normaliseCallsign } from "@/lib/callsign";

/** Beyond this the transponder is treated as quiet rather than live. */
const LIVE_WINDOW_MS = 120_000;

interface FleetRow {
  icao: string;
  callsign?: string | null;
  reg?: string | null;
  aircraft_type?: string | null;
  category?: string | null;
  flight_phase?: string | null;
  last_updated?: number | string | null;
  ts?: number | string | null;
  wallet_address?: string | null;
}

interface FleetResponse {
  success: boolean;
  data?: FleetRow[];
}

export interface AircraftIdentity {
  icao: string;
  registration: string | null;
  typeCode: string | null;
  description: string | null;
  operator: string | null;
  callsign: string | null;
  phase: string | null;
  walletAddress: string | null;
  live: boolean;
  loading: boolean;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Identity read from an aircraft's own on-chain records. Supplied by the
 * explorer pages, which already hold decoded envelopes carrying `aircraft_desc`
 * — the archive can name an aircraft the live fleet has never reported.
 */
export interface AircraftIdentityFallback {
  registration?: string | null;
  typeCode?: string | null;
  description?: string | null;
  callsign?: string | null;
}

/**
 * Resolves who an ICAO hex code actually belongs to.
 *
 * The explorer only ever receives a hex code in the URL, which tells a reader
 * nothing. Live fleet state is authoritative when the aircraft is transmitting;
 * the static registry and the aircraft's own on-chain envelopes fill in
 * registration, type and operator when it is not, so the page identifies the
 * aircraft even when it has been parked for days.
 */
export function useAircraftIdentity(
  icao: string,
  fallback?: AircraftIdentityFallback,
): AircraftIdentity {
  const upper = icao.trim().toUpperCase();
  const { data, isLoading } = useSWR<FleetResponse>(
    `${apiBaseUrl}/api/fleet`,
    fetcher,
    { refreshInterval: 15_000, dedupingInterval: 10_000, revalidateOnFocus: false },
  );

  const staticInfo = TRACKED_AIRCRAFT_MAP.get(upper);
  const row = data?.data?.find((entry) => entry.icao?.toUpperCase() === upper);

  const lastSeen = Number(row?.last_updated ?? row?.ts ?? 0);
  const live = Number.isFinite(lastSeen) && lastSeen > 0
    && Date.now() - lastSeen < LIVE_WINDOW_MS;

  const typeCode =
    clean(row?.aircraft_type)
    ?? clean(staticInfo?.type)
    ?? clean(fallback?.typeCode);

  const registration =
    clean(row?.reg) ?? clean(staticInfo?.reg) ?? clean(fallback?.registration);
  const callsign =
    normaliseCallsign(row?.callsign, upper)
    ?? normaliseCallsign(fallback?.callsign, upper);

  return {
    icao: upper,
    registration,
    typeCode,
    description: resolveAircraftDescription(
      clean(staticInfo?.desc),
      clean(fallback?.description),
      typeCode,
    ),
    operator: resolveOperator({
      curated: staticInfo?.operator,
      callsign,
      registration,
    }),
    callsign,
    phase: clean(row?.flight_phase),
    walletAddress: clean(row?.wallet_address),
    live,
    loading: isLoading,
  };
}
