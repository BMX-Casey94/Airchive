import { create } from "zustand";
import type { BlockchainEntry } from "@/types/airchive";

interface DailySummary {
  txCount: number;
  totalBytes: number;
  totalSats: number;
  minedCount: number;
  pendingCount: number;
  failedCount: number;
  trackedAircraftCount: number;
  txPerSecond: number;
}

/**
 * `gateway` means the counters are the database's own day totals. `session`
 * means the metrics endpoint is unreachable and everything shown has been
 * accumulated from the live socket since this page loaded — a very different
 * number, and one that resets on refresh, so the UI must say which it is.
 */
export type MetricsSource = "gateway" | "session";

interface BlockchainState {
  /** Recent transaction feed entries (newest last). */
  entries: BlockchainEntry[];
  /** Aggregated daily summary counters. */
  dailySummary: DailySummary;
  /** Where `dailySummary` came from. */
  metricsSource: MetricsSource;
  /** Arrival times of transactions seen this session, pruned to the last minute. */
  recentTxTimes: number[];

  /** Push a new entry or update an existing entry's status (e.g. SEEN_ON_NETWORK → MINED). */
  pushEntry: (entry: BlockchainEntry) => void;
  /** Bulk-replace entries (e.g. on initial load). */
  setEntries: (entries: BlockchainEntry[]) => void;
  /** Update the daily summary. */
  setDailySummary: (summary: Partial<DailySummary>) => void;
  /** Apply authoritative counters from the gateway's metrics endpoint. */
  applyGatewayMetrics: (summary: Partial<DailySummary>) => void;
  /** Record that the metrics endpoint could not be read. */
  markMetricsUnavailable: () => void;
  /** Increment daily counters from a new entry. */
  incrementDaily: (bytes: number, sats: number) => void;
}

const MAX_FEED_ENTRIES = 200;
const RATE_WINDOW_MS = 60_000;

function pruneWindow(times: number[], now: number): number[] {
  const cutoff = now - RATE_WINDOW_MS;
  return times.filter((t) => t >= cutoff);
}

function resolveEntryTime(entry: BlockchainEntry): number {
  const timestamp = Number(entry.timestamp);
  const createdAt = entry.created_at == null ? NaN : new Date(entry.created_at).getTime();

  if (Number.isFinite(createdAt)) {
    const now = Date.now();
    const timestampLooksFuture = Number.isFinite(timestamp) && timestamp > now + 60_000;
    const timestampLooksSkewed = Number.isFinite(timestamp) && Math.abs(timestamp - createdAt) > 10 * 60_000;
    if (timestampLooksFuture || timestampLooksSkewed) {
      return createdAt;
    }
  }

  return Number.isFinite(timestamp) ? timestamp : createdAt;
}

function normaliseEntries(entries: BlockchainEntry[]): BlockchainEntry[] {
  return [...entries]
    .sort((a, b) => {
      const timeDelta = resolveEntryTime(a) - resolveEntryTime(b);
      if (timeDelta !== 0) return timeDelta;
      return a.txid.localeCompare(b.txid);
    })
    .slice(-MAX_FEED_ENTRIES);
}

export const useBlockchainStore = create<BlockchainState>((set) => ({
  entries: [],
  metricsSource: "session",
  recentTxTimes: [],
  dailySummary: {
    txCount: 0,
    totalBytes: 0,
    totalSats: 0,
    minedCount: 0,
    pendingCount: 0,
    failedCount: 0,
    trackedAircraftCount: 0,
    txPerSecond: 0,
  },

  pushEntry: (entry) =>
    set((prev) => {
      const existingIdx = prev.entries.findIndex((e) => e.txid === entry.txid);

      if (existingIdx !== -1) {
        const existing = prev.entries[existingIdx];
        if (existing.status === entry.status) return prev;

        const updated = [...prev.entries];
        updated[existingIdx] = { ...existing, ...entry };

        const summaryPatch = { ...prev.dailySummary };
        if (existing.status === "SEEN_ON_NETWORK") summaryPatch.pendingCount = Math.max(0, summaryPatch.pendingCount - 1);
        else if (existing.status === "MINED") summaryPatch.minedCount = Math.max(0, summaryPatch.minedCount - 1);
        else if (existing.status === "FAILED") summaryPatch.failedCount = Math.max(0, summaryPatch.failedCount - 1);

        if (entry.status === "MINED") summaryPatch.minedCount++;
        else if (entry.status === "SEEN_ON_NETWORK") summaryPatch.pendingCount++;
        else if (entry.status === "FAILED") summaryPatch.failedCount++;

        return { entries: normaliseEntries(updated), dailySummary: summaryPatch };
      }

      const now = Date.now();
      return {
        entries: normaliseEntries([...prev.entries, entry]),
        recentTxTimes: [...pruneWindow(prev.recentTxTimes, now), now],
        dailySummary: {
          ...prev.dailySummary,
          txCount: prev.dailySummary.txCount + 1,
          totalBytes: prev.dailySummary.totalBytes + (entry.size_bytes ?? 0),
          totalSats: prev.dailySummary.totalSats + (entry.fee_sats ?? 0),
          minedCount: prev.dailySummary.minedCount + (entry.status === "MINED" ? 1 : 0),
          pendingCount: prev.dailySummary.pendingCount + (entry.status === "SEEN_ON_NETWORK" ? 1 : 0),
          failedCount: prev.dailySummary.failedCount + (entry.status === "FAILED" ? 1 : 0),
        },
      };
    }),

  setEntries: (entries) =>
    set((prev) => {
      const now = Date.now();
      // Backfilled history seeds the rate window so the tile is meaningful
      // immediately after a refresh rather than climbing from zero.
      const seeded = entries
        .map(resolveEntryTime)
        .filter((t) => Number.isFinite(t) && t <= now && t >= now - RATE_WINDOW_MS);
      return {
        entries: normaliseEntries(entries),
        recentTxTimes: pruneWindow([...prev.recentTxTimes, ...seeded], now).sort((a, b) => a - b),
      };
    }),

  setDailySummary: (summary) =>
    set((prev) => ({ dailySummary: { ...prev.dailySummary, ...summary } })),

  applyGatewayMetrics: (summary) =>
    set((prev) => ({
      dailySummary: { ...prev.dailySummary, ...summary },
      metricsSource: "gateway",
    })),

  markMetricsUnavailable: () => set({ metricsSource: "session" }),

  incrementDaily: (bytes, sats) =>
    set((prev) => ({
      dailySummary: {
        ...prev.dailySummary,
        txCount: prev.dailySummary.txCount + 1,
        totalBytes: prev.dailySummary.totalBytes + bytes,
        totalSats: prev.dailySummary.totalSats + sats,
        pendingCount: prev.dailySummary.pendingCount + 1,
      },
    })),
}));
