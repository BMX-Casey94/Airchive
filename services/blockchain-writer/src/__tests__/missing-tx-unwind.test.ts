import { describe, expect, it } from "vitest";
import { settleTerminalRejectionMark } from "../missing-tx-unwind.js";
import { createMemoryDb } from "./memory-db.js";

const REJECTED = "bb".repeat(32);
const AIRCRAFT = "ABCDEF";

describe("settleTerminalRejectionMark", () => {
  it("deletes unconfirmed pool outputs when the tx_results row is missing", async () => {
    const { db, table } = createMemoryDb({
      utxo_pool: [
        {
          txid: REJECTED,
          vout: 0,
          aircraft_icao: AIRCRAFT,
          unconfirmed_depth: 1,
          satoshis: 2_000,
          is_locked: false,
        },
        {
          txid: REJECTED,
          vout: 1,
          aircraft_icao: AIRCRAFT,
          unconfirmed_depth: 0,
          satoshis: 50_000,
          is_locked: false,
        },
      ],
      funding_utxo_pool: [
        {
          txid: REJECTED,
          vout: 2,
          satoshis: 80_000,
          is_locked: false,
        },
        {
          txid: "cc".repeat(32),
          vout: 0,
          satoshis: 90_000,
          is_locked: false,
        },
      ],
    });

    const settled = await settleTerminalRejectionMark(db, REJECTED, {
      status: "REJECTED",
      reason: "TX_MISSING_PARENT",
    });

    expect(settled.kind).toBe("missing");
    if (settled.kind !== "missing") return;
    expect(settled.aircraftDeleted).toBe(1);
    expect(settled.aircraftIcaos).toEqual([AIRCRAFT]);
    expect(settled.aircraftConfirmedSkipped).toBe(1);
    expect(settled.fundingDeleted).toBe(1);
    expect(settled.fundingVouts).toEqual([2]);
    expect(table("utxo_pool").map((row) => row.vout)).toEqual([1]);
    expect(table("funding_utxo_pool").map((row) => row.txid)).toEqual(["cc".repeat(32)]);
  });

  it("does not touch outputs when the tx_results row is MINED", async () => {
    const { db, table } = createMemoryDb({
      tx_results: [{ txid: REJECTED, status: "MINED" }],
      utxo_pool: [{
        txid: REJECTED,
        vout: 0,
        aircraft_icao: AIRCRAFT,
        unconfirmed_depth: 1,
        satoshis: 2_000,
      }],
      funding_utxo_pool: [{ txid: REJECTED, vout: 1, satoshis: 10_000 }],
    });

    const settled = await settleTerminalRejectionMark(db, REJECTED, {
      status: "REJECTED",
    });

    expect(settled.kind).toBe("mined");
    expect(table("utxo_pool")).toHaveLength(1);
    expect(table("funding_utxo_pool")).toHaveLength(1);
    expect(table("tx_results")[0]?.status).toBe("MINED");
  });

  it("marks an existing unmined row and leaves the pools for the recorded unwind", async () => {
    const { db, table } = createMemoryDb({
      tx_results: [{ txid: REJECTED, status: "SEEN_ON_NETWORK" }],
      utxo_pool: [{
        txid: REJECTED,
        vout: 0,
        aircraft_icao: AIRCRAFT,
        unconfirmed_depth: 1,
      }],
    });

    const settled = await settleTerminalRejectionMark(db, REJECTED, {
      status: "DOUBLE_SPEND_ATTEMPTED",
      reason: "conflict",
    });

    expect(settled.kind).toBe("recorded");
    expect(table("tx_results")[0]?.status).toBe("FAILED");
    expect(table("utxo_pool")).toHaveLength(1);
  });

  it("leaves a funding output this process has already confirmed", async () => {
    const { db, table } = createMemoryDb({
      funding_utxo_pool: [
        { txid: REJECTED, vout: 0, satoshis: 10_000 },
        { txid: REJECTED, vout: 1, satoshis: 10_000 },
      ],
    });

    const settled = await settleTerminalRejectionMark(db, REJECTED, { status: "REJECTED" }, {
      isFundingConfirmed: (_txid, vout) => vout === 0,
    });

    expect(settled.kind).toBe("missing");
    if (settled.kind !== "missing") return;
    expect(settled.fundingDeleted).toBe(1);
    expect(settled.fundingConfirmedSkipped).toBe(1);
    expect(table("funding_utxo_pool").map((row) => row.vout)).toEqual([0]);
  });
});
