import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateKey } from "@bsv/sdk";
import type { ChainLookup } from "../chain-lookup.js";
import { FundingUtxoManager } from "../funding-utxo-manager.js";
import { UtxoManager } from "../utxo-manager.js";
import { createMemoryDb, type MemoryRow } from "./memory-db.js";

const ENV_KEYS = [
  "CHAIN_PROPAGATION_COOLDOWN_MS",
  "REFILL_PROPAGATION_COOLDOWN_MS",
  "FUNDING_PROPAGATION_COOLDOWN_MS",
  "RECONCILE_RECENT_OUTPUT_GUARD_MS",
  "FUNDING_MAX_UNCONFIRMED_CHAIN_DEPTH",
];

const fundingKey = new PrivateKey(
  "0000000000000000000000000000000000000000000000000000000000000001",
  16,
);
const fundingWif = fundingKey.toWif();
const aircraftAddress = fundingKey.toAddress();
const PARENT = "11".repeat(32);
const CHANGE = "22".repeat(32);
const ICAO = "ABCDEF";

afterEach(() => {
  vi.useRealTimers();
  for (const key of ENV_KEYS) delete process.env[key];
});

function chainOf(rows: MemoryRow[] | Error): ChainLookup {
  return {
    getJson: async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
  } as unknown as ChainLookup;
}

function utxo(overrides: MemoryRow = {}): MemoryRow {
  return {
    aircraft_icao: ICAO,
    txid: PARENT,
    vout: 0,
    satoshis: 5_000,
    locking_script: "76a91400",
    is_locked: false,
    locked_at: null,
    unconfirmed_depth: 0,
    created_at: new Date(Date.now() - 120_000),
    ...overrides,
  };
}

function funding(overrides: MemoryRow = {}): MemoryRow {
  return {
    txid: PARENT,
    vout: 0,
    satoshis: 500_000,
    locking_script: "76a91400",
    is_locked: false,
    locked_at: null,
    created_at: new Date(Date.now() - 120_000),
    ...overrides,
  };
}

describe("aircraft reconcile guard", () => {
  it("does not delete a local output created inside the guard window", async () => {
    const { db, table } = createMemoryDb({
      utxo_pool: [utxo({ created_at: new Date() })],
    });
    const manager = new UtxoManager(db, chainOf([]));

    await manager.reconcile(ICAO, aircraftAddress);

    expect(table("utxo_pool")).toHaveLength(1);
  });

  it("deletes an old local output the chain no longer lists", async () => {
    const { db, table } = createMemoryDb({
      utxo_pool: [utxo()],
    });
    const manager = new UtxoManager(db, chainOf([]));

    await manager.reconcile(ICAO, aircraftAddress);

    expect(table("utxo_pool")).toHaveLength(0);
  });

  it("does not resurrect an outpoint this process just spent", async () => {
    const { db, table } = createMemoryDb({
      utxo_pool: [utxo({ satoshis: 5_000 })],
    });
    const manager = new UtxoManager(db, chainOf([{
      tx_hash: PARENT,
      tx_pos: 0,
      value: 5_000,
      height: 0,
    }]));

    await manager.recordSpend(PARENT, 0, CHANGE, 1, 4_000, "76a91400", ICAO);
    await manager.reconcile(ICAO, aircraftAddress);

    const txids = table("utxo_pool").map((row) => row.txid);
    expect(txids).not.toContain(PARENT);
    expect(txids).toContain(CHANGE);
  });
});

describe("aircraft propagation cooldown", () => {
  it("keeps telemetry change immediately spendable when the cooldown default is 0", async () => {
    const { db } = createMemoryDb({
      utxo_pool: [utxo({ satoshis: 5_000 })],
    });
    const manager = new UtxoManager(db, chainOf([]));
    await manager.recordSpend(PARENT, 0, CHANGE, 1, 4_000, "76a91400", ICAO);

    const acquired = await manager.acquireUtxo(ICAO);
    expect(acquired.txid).toBe(CHANGE);
  });

  it("holds telemetry change for the configured cooldown", async () => {
    process.env.CHAIN_PROPAGATION_COOLDOWN_MS = "60000";
    const { db } = createMemoryDb({
      utxo_pool: [utxo({ satoshis: 5_000 })],
    });
    const manager = new UtxoManager(db, chainOf([]));
    await manager.recordSpend(PARENT, 0, CHANGE, 1, 4_000, "76a91400", ICAO);

    await expect(manager.acquireUtxo(ICAO)).rejects.toThrow(/cooling down/);
  });
});

describe("aircraft startup unlock", () => {
  it("unlocks only locked outputs the chain still lists", async () => {
    const listed = "33".repeat(32);
    const { db, table } = createMemoryDb({
      utxo_pool: [
        utxo({ txid: listed, is_locked: true, locked_at: new Date(Date.now() - 600_000) }),
        utxo({ is_locked: true, locked_at: new Date(Date.now() - 600_000) }),
      ],
    });
    const manager = new UtxoManager(db, chainOf([{
      tx_hash: listed,
      tx_pos: 0,
      value: 5_000,
      height: 10,
    }]));

    const unlocked = await manager.unlockLocksListedUnspent(ICAO, aircraftAddress);

    expect(unlocked).toBe(1);
    const byTx = Object.fromEntries(table("utxo_pool").map((row) => [row.txid, row.is_locked]));
    expect(byTx[listed]).toBe(false);
    expect(byTx[PARENT]).toBeUndefined();
  });

  it("keeps locks when the chain lookup fails", async () => {
    const { db, table } = createMemoryDb({
      utxo_pool: [utxo({ is_locked: true, locked_at: new Date(Date.now() - 600_000) })],
    });
    const manager = new UtxoManager(db, chainOf(new Error("timeout")));

    const unlocked = await manager.unlockLocksListedUnspent(ICAO, aircraftAddress);

    expect(unlocked).toBe(0);
    expect(table("utxo_pool")[0]?.is_locked).toBe(true);
  });

  it("does not unlock a recent output the chain has not listed yet", async () => {
    const { db, table } = createMemoryDb({
      utxo_pool: [utxo({ is_locked: true, created_at: new Date(), locked_at: new Date() })],
    });
    const manager = new UtxoManager(db, chainOf([]));

    const unlocked = await manager.unlockLocksListedUnspent(ICAO, aircraftAddress);

    expect(unlocked).toBe(0);
    expect(table("utxo_pool")).toHaveLength(1);
    expect(table("utxo_pool")[0]?.is_locked).toBe(true);
  });

  it("does not reclaim a stale lock when the chain lookup fails", async () => {
    const { db, table } = createMemoryDb({
      utxo_pool: [utxo({ is_locked: true, locked_at: new Date(Date.now() - 600_000) })],
    });
    const manager = new UtxoManager(db, chainOf(new Error("timeout")));

    const reclaimed = await manager.reclaimStaleLocks(() => aircraftAddress);

    expect(reclaimed).toBe(0);
    expect(table("utxo_pool")[0]?.is_locked).toBe(true);
  });
});

describe("funding reconcile guard and depth", () => {
  it("does not delete a fresh funding output missing from the chain snapshot", async () => {
    const { db, table } = createMemoryDb({
      funding_utxo_pool: [funding({ created_at: new Date() })],
    });
    const manager = new FundingUtxoManager(db, chainOf([]));

    await manager.reconcile(fundingWif);

    expect(table("funding_utxo_pool")).toHaveLength(1);
  });

  it("does not resurrect a funding outpoint this process just spent", async () => {
    const { db, table } = createMemoryDb({
      funding_utxo_pool: [funding()],
    });
    const manager = new FundingUtxoManager(db, chainOf([{
      tx_hash: PARENT,
      tx_pos: 0,
      value: 500_000,
      height: 0,
    }]));

    await manager.recordSpend(PARENT, 0, CHANGE, 1, 490_000, "76a91400");
    await manager.reconcile(fundingWif);

    const txids = table("funding_utxo_pool").map((row) => row.txid);
    expect(txids).not.toContain(PARENT);
    expect(txids).toContain(CHANGE);
  });

  it("refuses to spend a funding output once its in-process depth exceeds the cap", async () => {
    vi.useFakeTimers();
    const { db } = createMemoryDb({
      funding_utxo_pool: [funding({ satoshis: 1_000_000 })],
    });
    const manager = new FundingUtxoManager(db, chainOf([]));
    let txid = PARENT;
    let sats = 1_000_000;
    for (let depth = 0; depth < 5; depth++) {
      const next = (depth + 3).toString(16).padStart(64, "a");
      await manager.recordSpend(txid, 0, next, 0, sats - 1_000, "76a91400");
      txid = next;
      sats -= 1_000;
    }
    await vi.advanceTimersByTimeAsync(600);

    expect(await manager.acquire(1_000)).toBeUndefined();

    await db("funding_utxo_pool").insert({
      txid: "ab".repeat(32),
      vout: 0,
      satoshis: 800_000,
      locking_script: "76a91400",
      is_locked: false,
    });

    const acquired = await manager.acquire(1_000);
    expect(acquired?.txid).toBe("ab".repeat(32));
  });

  it("allows the same output once reconcile sees a positive chain height", async () => {
    vi.useFakeTimers();
    const chainRows: MemoryRow[] = [];
    const { db } = createMemoryDb({
      funding_utxo_pool: [funding({ satoshis: 1_000_000 })],
    });
    const manager = new FundingUtxoManager(db, {
      getJson: async () => chainRows,
    } as unknown as ChainLookup);
    let txid = PARENT;
    let sats = 1_000_000;
    for (let depth = 0; depth < 5; depth++) {
      const next = (depth + 3).toString(16).padStart(64, "b");
      await manager.recordSpend(txid, 0, next, 0, sats - 1_000, "76a91400");
      txid = next;
      sats -= 1_000;
    }
    await vi.advanceTimersByTimeAsync(600);
    expect(await manager.acquire(1_000)).toBeUndefined();

    const rows = await db("funding_utxo_pool").select("txid", "vout", "satoshis");
    const deep = rows[0]!;
    chainRows.push({
      tx_hash: String(deep.txid),
      tx_pos: Number(deep.vout),
      value: Number(deep.satoshis),
      height: 800_000,
    });
    await manager.reconcile(fundingWif);

    expect((await manager.acquire(1_000))?.txid).toBe(String(deep.txid));
  });

  it("holds funding change for the default 500ms and releases it when set to 0", async () => {
    const { db } = createMemoryDb({
      funding_utxo_pool: [funding({ satoshis: 1_000_000 })],
    });
    const cooling = new FundingUtxoManager(db, chainOf([]));
    await cooling.recordSpend(PARENT, 0, CHANGE, 0, 900_000, "76a91400");
    expect(await cooling.acquire(1_000)).toBeUndefined();

    process.env.FUNDING_PROPAGATION_COOLDOWN_MS = "0";
    const { db: openDb } = createMemoryDb({
      funding_utxo_pool: [funding({ satoshis: 1_000_000 })],
    });
    const open = new FundingUtxoManager(openDb, chainOf([]));
    await open.recordSpend(PARENT, 0, CHANGE, 0, 900_000, "76a91400");
    expect((await open.acquire(1_000))?.txid).toBe(CHANGE);
  });
});

describe("funding startup unlock", () => {
  it("keeps stale locks when the chain lookup fails", async () => {
    const { db, table } = createMemoryDb({
      funding_utxo_pool: [funding({
        is_locked: true,
        locked_at: new Date(Date.now() - 600_000),
      })],
    });
    const manager = new FundingUtxoManager(db, chainOf(new Error("timeout")));

    const unlocked = await manager.unlockLocksListedUnspent(fundingWif);
    const reclaimed = await manager.reclaimStaleLocks();

    expect(unlocked).toBe(0);
    expect(reclaimed).toBe(0);
    expect(table("funding_utxo_pool")[0]?.is_locked).toBe(true);
  });

  it("unlocks a locked funding output the chain still lists and does not reclaim a fresh lock", async () => {
    const { db, table } = createMemoryDb({
      funding_utxo_pool: [funding({
        is_locked: true,
        locked_at: new Date(),
      })],
    });
    const manager = new FundingUtxoManager(db, chainOf([{
      tx_hash: PARENT,
      tx_pos: 0,
      value: 500_000,
      height: 4,
    }]));

    await manager.reconcile(fundingWif);
    expect(await manager.reclaimStaleLocks()).toBe(0);
    expect(table("funding_utxo_pool")[0]?.is_locked).toBe(true);

    const unlocked = await manager.unlockLocksListedUnspent(fundingWif);
    expect(unlocked).toBe(1);
    expect(table("funding_utxo_pool")[0]?.is_locked).toBe(false);
  });

  it("does not reclaim funding locks before the wallet is bound", async () => {
    const { db, table } = createMemoryDb({
      funding_utxo_pool: [funding({
        is_locked: true,
        locked_at: new Date(Date.now() - 600_000),
      })],
    });
    const manager = new FundingUtxoManager(db, chainOf([{
      tx_hash: PARENT,
      tx_pos: 0,
      value: 500_000,
      height: 4,
    }]));

    expect(await manager.reclaimStaleLocks()).toBe(0);
    expect(table("funding_utxo_pool")[0]?.is_locked).toBe(true);
  });
});
