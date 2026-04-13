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

interface BlockchainState {
  /** Recent transaction feed entries (newest last). */
  entries: BlockchainEntry[];
  /** Aggregated daily summary counters. */
  dailySummary: DailySummary;

  /** Push a new entry or update an existing entry's status (e.g. SEEN_ON_NETWORK → MINED). */
  pushEntry: (entry: BlockchainEntry) => void;
  /** Bulk-replace entries (e.g. on initial load). */
  setEntries: (entries: BlockchainEntry[]) => void;
  /** Update the daily summary. */
  setDailySummary: (summary: Partial<DailySummary>) => void;
  /** Increment daily counters from a new entry. */
  incrementDaily: (bytes: number, sats: number) => void;
}

const MAX_FEED_ENTRIES = 200;

export const useBlockchainStore = create<BlockchainState>((set) => ({
  entries: [],
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

        return { entries: updated, dailySummary: summaryPatch };
      }

      return {
        entries: [...prev.entries, entry].slice(-MAX_FEED_ENTRIES),
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
    set({ entries: entries.slice(-MAX_FEED_ENTRIES) }),

  setDailySummary: (summary) =>
    set((prev) => ({ dailySummary: { ...prev.dailySummary, ...summary } })),

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
