import { create } from "zustand";
import type { BlockchainEntry } from "@/types/airchive";

interface DailySummary {
  txCount: number;
  totalBytes: number;
  totalSats: number;
  minedCount: number;
  pendingCount: number;
  failedCount: number;
}

interface BlockchainState {
  /** Recent transaction feed entries (newest last). */
  entries: BlockchainEntry[];
  /** Aggregated daily summary counters. */
  dailySummary: DailySummary;

  /** Append a new blockchain entry. */
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
  dailySummary: { txCount: 0, totalBytes: 0, totalSats: 0, minedCount: 0, pendingCount: 0, failedCount: 0 },

  pushEntry: (entry) =>
    set((prev) => {
      const statusDelta = {
        minedCount: entry.status === "MINED" ? 1 : 0,
        failedCount: entry.status === "FAILED" ? 1 : 0,
        pendingCount: entry.status === "SEEN_ON_NETWORK" ? 1 : 0,
      };
      return {
        entries: [...prev.entries, entry].slice(-MAX_FEED_ENTRIES),
        dailySummary: {
          txCount: prev.dailySummary.txCount + 1,
          totalBytes: prev.dailySummary.totalBytes + entry.size_bytes,
          totalSats: prev.dailySummary.totalSats + entry.fee_sats,
          minedCount: prev.dailySummary.minedCount + statusDelta.minedCount,
          pendingCount: prev.dailySummary.pendingCount + statusDelta.pendingCount,
          failedCount: prev.dailySummary.failedCount + statusDelta.failedCount,
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
