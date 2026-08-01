"use client";

import { useEffect, useMemo } from "react";
import useSWR from "swr";
import { apiBaseUrl, fetcher } from "@/lib/api";
import { useFleetStore } from "@/stores/fleet";
import type { PositionSnapshot } from "@/types/dashboard";

/**
 * Server-persisted flight paths for every active session. This is what makes
 * take-off-to-landing trails hold for a browser that opened mid-flight: the
 * gateway's stored baseline is stitched in front of whatever live telemetry
 * the fleet store has gathered, via the store's own timestamp-aware
 * `hydrateTrails` (the same mechanism used for IndexedDB restores, so
 * repeated refreshes self-deduplicate).
 */

/** `[ts, lat, lon, alt_baro, gs, track]` — mirrors the gateway wire format. */
export type WirePathPoint = [
  number,
  number,
  number,
  number | null,
  number | null,
  number | null,
];

export interface ActiveSessionDTO {
  id: string;
  aircraftIcao: string;
  callsign: string;
  originIcao: string | null;
  originName: string | null;
  destIcao: string | null;
  destName: string | null;
  phase: string;
  startedAt: string;
  totalTxCount: number;
  totalSatsSpent: number;
  path: WirePathPoint[];
}

interface ActiveSessionsResponse {
  success: boolean;
  data: ActiveSessionDTO[];
}

const REFRESH_INTERVAL_MS = 30_000;

export function useActiveSessions(): ActiveSessionDTO[] {
  const hydrateTrails = useFleetStore((s) => s.hydrateTrails);

  const { data } = useSWR<ActiveSessionsResponse>(
    `${apiBaseUrl}/api/sessions/active`,
    fetcher,
    {
      refreshInterval: REFRESH_INTERVAL_MS,
      revalidateOnFocus: false,
      // The AE view must keep rendering live client-side trails even when the
      // gateway is briefly unreachable; SWR retries quietly in the background.
      shouldRetryOnError: true,
    },
  );

  const sessions = useMemo(
    () => (data?.success ? data.data : []),
    [data],
  );

  useEffect(() => {
    if (sessions.length === 0) return;

    const restored = new Map<string, PositionSnapshot[]>();
    for (const session of sessions) {
      if (session.path.length === 0) continue;
      const icao = session.aircraftIcao.toUpperCase();
      const points: PositionSnapshot[] = session.path.map((p) => ({
        ts: p[0],
        lat: p[1],
        lon: p[2],
        alt: p[3] ?? 0,
      }));
      restored.set(icao, points);
    }
    if (restored.size > 0) hydrateTrails(restored);
  }, [sessions, hydrateTrails]);

  return sessions;
}
