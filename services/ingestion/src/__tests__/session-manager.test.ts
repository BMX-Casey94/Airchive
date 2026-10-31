import type { AirportInfo, AirportLookup } from "@airchive/airports";
import { FlightPhase } from "@airchive/types";
import type { Knex } from "knex";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { startSession, updateSessionDest } from "../session-manager.js";

const { warn, debug } = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn() }));

vi.mock("@airchive/logger", () => ({
  createLogger: () => ({
    warn,
    debug,
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

function capturingDb(): {
  db: Knex;
  inserts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
} {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const db = ((table: string) => {
    if (table !== "flight_sessions") {
      throw new Error(`unexpected table ${table}`);
    }
    return {
      insert(row: Record<string, unknown>) {
        inserts.push(row);
        return {
          returning: async () => [
            {
              id: "session-1",
              aircraft_icao: row.aircraft_icao,
              callsign: row.callsign,
              origin_icao: row.origin_icao ?? null,
              origin_name: row.origin_name ?? null,
              dest_icao: null,
              dest_name: null,
              phase: row.phase,
              started_at: new Date("2026-01-01T00:00:00.000Z"),
              ended_at: null,
              total_tx_count: 0,
              total_sats_spent: 0,
            },
          ],
        };
      },
      where() {
        return {
          update: async (row: Record<string, unknown>) => {
            updates.push(row);
            return 1;
          },
        };
      },
    };
  }) as unknown as Knex & { fn: { now: () => string } };
  db.fn = { now: () => "now" };
  return { db, inserts, updates };
}

function lookupReturning(info: AirportInfo | null): AirportLookup {
  return {
    findNearest: () => info,
  } as unknown as AirportLookup;
}

function airport(icaoCode: string | null, name = "Test Airport"): AirportInfo {
  return {
    icao_code: icaoCode,
    name,
    lat: 51.47,
    lon: -0.46,
    elevation_ft: 80,
    iso_country: "GB",
    municipality: "London",
    type: "large_airport",
  };
}

describe("startSession airport code", () => {
  beforeEach(() => {
    warn.mockClear();
    debug.mockClear();
  });

  it("stores a normalised 4-character origin", async () => {
    const { db, inserts } = capturingDb();
    await startSession(
      db,
      "400ABC",
      "BAW1",
      lookupReturning(airport(" egll ", "Heathrow")),
      51.47,
      -0.46,
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      origin_icao: "EGLL",
      origin_name: "Heathrow",
      phase: FlightPhase.TAXI,
    });
    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it("stores the origin name and omits a code that is absent or too long", async () => {
    const { db, inserts } = capturingDb();
    await startSession(
      db,
      "400ABC",
      "BAW1",
      lookupReturning(airport(null, "Skydive Dubai Airport")),
      25.09,
      55.13,
    );
    await startSession(
      db,
      "400ABC",
      "BAW1",
      lookupReturning(airport("AE-0001", "Batha Airport")),
      24.2,
      51.4,
    );
    expect(inserts[0]).toMatchObject({
      origin_name: "Skydive Dubai Airport",
    });
    expect(inserts[0]?.origin_icao).toBeUndefined();
    expect(inserts[1]?.origin_icao).toBeUndefined();
    expect(inserts[1]?.origin_name).toBe("Batha Airport");
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(2);
  });

  it("truncates an origin name to 100 characters without splitting a code point", async () => {
    const { db, inserts } = capturingDb();
    const name = `${"A".repeat(99)}\u{1F600}B`;
    await startSession(db, "400ABC", "BAW1", lookupReturning(airport("EGLL", name)), 51.47, -0.46);
    const stored = inserts[0]?.origin_name;
    expect(typeof stored).toBe("string");
    expect(Array.from(String(stored))).toHaveLength(100);
    expect(String(stored).endsWith("\u{1F600}")).toBe(true);
    expect(inserts[0]?.origin_icao).toBe("EGLL");
  });

  it("leaves origin empty when no airport is nearby", async () => {
    const { db, inserts } = capturingDb();
    await startSession(db, "400ABC", "BAW1", lookupReturning(null), 0, 0);
    expect(inserts[0]?.origin_icao).toBeUndefined();
    expect(inserts[0]?.origin_name).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("updateSessionDest airport code", () => {
  it("refuses an over-long code before writing", async () => {
    const { db, updates } = capturingDb();
    await expect(updateSessionDest(db, "session-1", "AE-0001", "Batha Airport")).rejects.toThrow(
      /varchar\(4\)/,
    );
    await expect(updateSessionDest(db, "session-1", "16A", "Nunapitchuk")).rejects.toThrow(
      /varchar\(4\)/,
    );
    expect(updates).toEqual([]);
  });

  it("stores the destination name and leaves the ICAO unset when the code is absent", async () => {
    const { db, updates } = capturingDb();
    await updateSessionDest(db, "session-1", null, "Skydive Dubai Airport");
    await updateSessionDest(db, "session-1", "", "Local Strip");
    expect(updates).toEqual([
      { dest_name: "Skydive Dubai Airport" },
      { dest_name: "Local Strip" },
    ]);
  });

  it("truncates a destination name to 100 characters", async () => {
    const { db, updates } = capturingDb();
    await updateSessionDest(db, "session-1", null, "N".repeat(120));
    expect(updates[0]?.dest_icao).toBeUndefined();
    expect(updates[0]?.dest_name).toHaveLength(100);
  });

  it("writes a normalised 4-character destination", async () => {
    const { db, updates } = capturingDb();
    await updateSessionDest(db, "session-1", " oebt ", "Batha Airport");
    expect(updates).toEqual([{ dest_icao: "OEBT", dest_name: "Batha Airport" }]);
  });
});
