import type { PositionSnapshot } from "@/types/dashboard";

/**
 * Keeps flight trails across reloads.
 *
 * Trails were held only in memory, so every refresh threw away the accumulated
 * path and the globe restarted from a single point. IndexedDB is used rather
 * than localStorage because a few hundred aircraft at several hundred points
 * each is far past the ~5 MB string quota, and writing it synchronously would
 * stall the main thread on every save.
 */

const DB_NAME = "airchive-globe";
const DB_VERSION = 1;
const STORE = "trails";

/** Older than this and the path is history, not a flight in progress. */
const MAX_TRAIL_AGE_MS = 6 * 60 * 60 * 1_000;
/** Cap per aircraft on disk, mirroring the in-memory buffer. */
const MAX_POINTS_PER_TRAIL = 600;

interface StoredTrail {
  icao: string;
  points: PositionSnapshot[];
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Private browsing modes can refuse outright; trails simply stay
      // in-memory rather than the globe failing to load.
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "icao" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return dbPromise;
}

export async function loadPersistedTrails(): Promise<Map<string, PositionSnapshot[]>> {
  const trails = new Map<string, PositionSnapshot[]>();
  const db = await openDb();
  if (!db) return trails;

  const rows = await new Promise<StoredTrail[]>((resolve) => {
    try {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      request.onsuccess = () => resolve((request.result ?? []) as StoredTrail[]);
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });

  const cutoff = Date.now() - MAX_TRAIL_AGE_MS;
  const expired: string[] = [];

  for (const row of rows) {
    if (!row?.icao || !Array.isArray(row.points) || row.points.length === 0) continue;
    if (row.updatedAt < cutoff) {
      expired.push(row.icao);
      continue;
    }
    // Drop individual stale points too, so a flight resumed hours later does
    // not draw a straight line across the map from where it was last seen.
    const fresh = row.points.filter((p) => p && p.ts >= cutoff);
    if (fresh.length > 0) trails.set(row.icao, fresh.slice(-MAX_POINTS_PER_TRAIL));
  }

  if (expired.length > 0) void deleteTrails(expired);
  return trails;
}

export async function persistTrails(
  trails: Map<string, PositionSnapshot[]>,
): Promise<void> {
  const db = await openDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const updatedAt = Date.now();

      for (const [icao, points] of trails) {
        if (points.length === 0) continue;
        const record: StoredTrail = {
          icao,
          points: points.slice(-MAX_POINTS_PER_TRAIL),
          updatedAt,
        };
        store.put(record);
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function deleteTrails(icaos: string[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const icao of icaos) store.delete(icao);
  } catch {
    /* nothing to clean up */
  }
}
