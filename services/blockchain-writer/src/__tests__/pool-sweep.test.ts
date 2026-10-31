import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrivateKey, type Transaction } from "@bsv/sdk";
import { RecordType } from "@airchive/types";
import type { Broadcaster } from "../broadcaster.js";
import { broadcastHold } from "../broadcast-hold.js";
import type { ChainLookup } from "../chain-lookup.js";
import { FundingUtxoManager } from "../funding-utxo-manager.js";
import { GovernedBroadcaster } from "../governed-broadcaster.js";
import { sweepPools } from "../pool-sweep.js";
import { SpendGovernor, type SpendGuardConfig } from "../spend-governor.js";
import { UtxoManager } from "../utxo-manager.js";
import { WriteBuffer } from "../write-buffer.js";
import { createMemoryDb, type MemoryRow } from "./memory-db.js";

const TX = {} as Transaction;
const PHANTOM = "aa".repeat(32);
const MEMPOOL = "bb".repeat(32);
const FRESH = "cc".repeat(32);
const FUNDING_PHANTOM = "dd".repeat(32);
const FUNDING_MEMPOOL = "ee".repeat(32);

const aircraftKey = new PrivateKey(
  "0000000000000000000000000000000000000000000000000000000000000001",
  16,
);
const fundingKey = new PrivateKey(
  "0000000000000000000000000000000000000000000000000000000000000002",
  16,
);
const aircraftAddress = aircraftKey.toAddress();
const fundingWif = fundingKey.toWif();
const fundingAddress = fundingKey.toAddress();

function guardConfig(): SpendGuardConfig {
  return {
    paused: false,
    windowMs: 60_000,
    minSamples: 40,
    cautiousRatio: 0.1,
    haltRatio: 0.25,
    haltCooldownMs: 60_000,
    haltCooldownMaxMs: 600_000,
    probeBudget: 2,
    probeSettleMs: 10_000,
    maxUnconfirmedChainDepth: 5,
    cautiousUnconfirmedChainDepth: 2,
    maxRejectRequeues: 3,
  };
}

function upstream(): Broadcaster & { calls: number } {
  const fake = {
    calls: 0,
    async broadcast() {
      fake.calls += 1;
      return { txid: "ff".repeat(32), status: "SEEN_ON_NETWORK" as const };
    },
  };
  return fake as unknown as Broadcaster & { calls: number };
}

beforeEach(() => {
  broadcastHold.reset();
});

afterEach(() => {
  broadcastHold.reset();
});

describe("startup pool sweep", () => {
  it("reconciles aircraft in order, then the treasury, and blocks broadcasts while it runs", async () => {
    const events: string[] = [];
    const refusals: string[] = [];
    const fakeUpstream = upstream();
    const gate = new GovernedBroadcaster(fakeUpstream, new SpendGovernor(guardConfig()));

    const summary = await sweepPools({
      hold: broadcastHold,
      delayMs: 5,
      aircraft: [
        { icao: "aaaaaa", address: "addr-a" },
        { icao: "bbbbbb", address: "addr-b" },
      ],
      utxoManager: {
        reconcile: async (icao) => {
          events.push(icao);
          expect(broadcastHold.isHeld()).toBe(true);
          return { applied: true, added: 1, removed: 2 };
        },
      },
      fundingUtxoManager: {
        reconcile: async () => {
          events.push("funding");
          expect(broadcastHold.isHeld()).toBe(true);
          return { ok: true, added: 3, removed: 4 };
        },
      },
      fundingWif: "wif",
      sleep: async (ms) => {
        events.push(`sleep:${ms}`);
        const refused = await gate.broadcast(TX, "aaaaaa", { kind: "telemetry" });
        refusals.push(refused.code ?? "");
      },
    });

    expect(events).toEqual([
      "aaaaaa",
      "sleep:5",
      "bbbbbb",
      "sleep:5",
      "funding",
    ]);
    expect(refusals).toEqual(["SPEND_HALTED", "SPEND_HALTED"]);
    expect(fakeUpstream.calls).toBe(0);
    expect(summary).toMatchObject({
      aircraftSwept: 2,
      rowsDeleted: 8,
      rowsInserted: 5,
      failures: 0,
      fundingSwept: true,
    });
    expect(broadcastHold.isHeld()).toBe(false);

    const allowed = await gate.broadcast(TX, "aaaaaa", { kind: "telemetry" });
    expect(allowed.status).toBe("SEEN_ON_NETWORK");
    expect(fakeUpstream.calls).toBe(1);
  });

  it("retries a provider failure with backoff, then keeps a failed aircraft blocked", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const summary = await sweepPools({
      hold: broadcastHold,
      delayMs: 10,
      aircraft: [
        { icao: "aaaaaa", address: "addr-a" },
        { icao: "bbbbbb", address: "addr-b" },
      ],
      utxoManager: {
        reconcile: async (icao) => {
          if (icao === "bbbbbb") return { applied: false, added: 0, removed: 0 };
          attempts += 1;
          if (attempts < 3) throw new Error("provider down");
          return { applied: true, added: 0, removed: 1 };
        },
      },
      fundingUtxoManager: {
        reconcile: async () => ({ ok: false, added: 0, removed: 0 }),
      },
      fundingWif: "wif",
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(attempts).toBe(3);
    expect(sleeps).toEqual([10, 20, 10, 10, 20, 10, 10, 20]);
    expect(summary.failedAircraft).toEqual(["BBBBBB"]);
    expect(summary.fundingSwept).toBe(false);
    expect(broadcastHold.isHeld()).toBe(false);
    expect(broadcastHold.blocksBroadcast("AAAAAA", "telemetry")).toBe(false);
    expect(broadcastHold.blocksBroadcast("BBBBBB", "telemetry")).toBe(true);
    expect(broadcastHold.blocksBroadcast("AAAAAA", "refill")).toBe(true);
    expect(broadcastHold.blocksBroadcast(undefined, "refill")).toBe(true);
  });

  it("forces past the cooldown and the recent-output guard, and keeps mempool outputs", async () => {
    const aircraftCalls: string[] = [];
    const chain = {
      getJson: async (path: string) => {
        if (path.includes(aircraftAddress)) {
          aircraftCalls.push(path);
          if (aircraftCalls.length < 3) throw new Error("provider down");
          return [
            { tx_hash: MEMPOOL, tx_pos: 0, value: 5_000, height: 0 },
            { tx_hash: FRESH, tx_pos: 1, value: 8_000, height: 0 },
          ];
        }
        if (path.includes(fundingAddress)) {
          return [{ tx_hash: FUNDING_MEMPOOL, tx_pos: 0, value: 500_000, height: 50 }];
        }
        throw new Error(path);
      },
    } as unknown as ChainLookup;

    const { db, table } = createMemoryDb({
      utxo_pool: [
        row(PHANTOM, "ABCDEF"),
        row(MEMPOOL, "ABCDEF"),
      ],
      funding_utxo_pool: [
        fundingRow(FUNDING_PHANTOM),
        fundingRow(FUNDING_MEMPOOL),
      ],
    });

    let heldDuringRead = false;
    const utxos = new UtxoManager(db, {
      getJson: async (path: string) => {
        heldDuringRead = heldDuringRead || broadcastHold.isHeld();
        return chain.getJson(path, { label: "address_unspent", timeoutMs: 15_000 });
      },
    } as unknown as ChainLookup);
    const funding = new FundingUtxoManager(db, chain);

    const summary = await sweepPools({
      hold: broadcastHold,
      delayMs: 0,
      aircraft: [{ icao: "abcdef", address: aircraftAddress }],
      utxoManager: utxos,
      fundingUtxoManager: funding,
      fundingWif,
    });

    expect(aircraftCalls).toHaveLength(3);
    expect(heldDuringRead).toBe(true);
    expect(broadcastHold.isHeld()).toBe(false);
    expect(summary.failures).toBe(0);
    expect(summary.aircraftSwept).toBe(1);
    expect(summary.fundingSwept).toBe(true);

    const aircraftTxids = table("utxo_pool").map((entry) => entry.txid).sort();
    expect(aircraftTxids).toEqual([FRESH, MEMPOOL].sort());
    const fundingTxids = table("funding_utxo_pool").map((entry) => entry.txid);
    expect(fundingTxids).toEqual([FUNDING_MEMPOOL]);
  });

  it("preserves live telemetry while the sweep hold is up", async () => {
    const { db, table } = createMemoryDb();
    const buffer = new WriteBuffer(
      db,
      {} as Broadcaster,
      {} as UtxoManager,
      {} as never,
    );
    broadcastHold.holdAll();

    await buffer.buffer("ABCDEF", RecordType.TELEMETRY, new Uint8Array([1, 2, 3]));

    expect(table("pending_writes")).toHaveLength(1);
    expect(table("pending_writes")[0]?.preserved).toBe(true);
  });
});

function row(txid: string, icao: string): MemoryRow {
  return {
    aircraft_icao: icao,
    txid,
    vout: 0,
    satoshis: 5_000,
    locking_script: "76a91400",
    is_locked: false,
    locked_at: null,
    unconfirmed_depth: 1,
    created_at: new Date(),
  };
}

function fundingRow(txid: string): MemoryRow {
  return {
    txid,
    vout: 0,
    satoshis: 500_000,
    locking_script: "76a91400",
    is_locked: false,
    locked_at: null,
    created_at: new Date(),
  };
}
