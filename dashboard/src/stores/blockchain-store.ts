import { create } from "zustand";
import type { BlockchainEntry } from "@/types/airchive";

interface DailySummary {
  txCount: number;
  totalBytes: number;
  totalSats: number;
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
  setDailySummary: (summary: DailySummary) => void;
  /** Increment daily counters from a new entry. */
  incrementDaily: (bytes: number, sats: number) => void;
}

const MAX_FEED_ENTRIES = 200;

export const useBlockchainStore = create<BlockchainState>((set) => ({
  entries: [],
  dailySummary: { txCount: 0, totalBytes: 0, totalSats: 0 },

  pushEntry: (entry) =>
    set((prev) => ({
      entries: [...prev.entries, entry].slice(-MAX_FEED_ENTRIES),
      dailySummary: {
        txCount: prev.dailySummary.txCount + 1,
        totalBytes: prev.dailySummary.totalBytes + entry.size_bytes,
        totalSats: prev.dailySummary.totalSats + entry.fee_sats,
      },
    })),

  setEntries: (entries) =>
    set({ entries: entries.slice(-MAX_FEED_ENTRIES) }),

  setDailySummary: (summary) => set({ dailySummary: summary }),

  incrementDaily: (bytes, sats) =>
    set((prev) => ({
      dailySummary: {
        txCount: prev.dailySummary.txCount + 1,
        totalBytes: prev.dailySummary.totalBytes + bytes,
        totalSats: prev.dailySummary.totalSats + sats,
      },
    })),
}));
