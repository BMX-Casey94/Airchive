import { describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";
import {
  NetworkSpentRegistry,
  parseNetworkSpentOutpoints,
} from "../network-spent-outpoints.js";

const PARENT = "c17eba1b642317b868a80daed87b9cf4cae16ae415ca46db6d70580e680c2cdc";
const SPENDER = "f065868fc39150e4652801be25635fac2475bd110452ae2b88d1f2ec6666f168";
const REJECTED = "96eb4b56a4b7eae1a81a1ac0d610c142f983df1972c6157dc4520490313f136e";

const TERANODE_LINE =
  `UTXO_SPENT (70): [ProcessTransaction][${REJECTED}] UTXO_SPENT (70): `
  + `${PARENT}:1 utxo already spent by tx ${SPENDER}[0]`;

interface FakeDb {
  db: Knex;
  inserted: Array<Record<string, unknown>>;
  deleted: Array<{ table: string; where: Record<string, unknown> }>;
}

function fakeDb(existing: Array<{ txid: string; vout: number }> = [], failInsert = false): FakeDb {
  const inserted: Array<Record<string, unknown>> = [];
  const deleted: Array<{ table: string; where: Record<string, unknown> }> = [];
  const db = vi.fn((table: string) => ({
    select: async () => existing,
    insert: (rows: Array<Record<string, unknown>>) => ({
      onConflict: () => ({
        ignore: async () => {
          if (failInsert) throw new Error("relation does not exist");
          inserted.push(...rows);
        },
      }),
    }),
    where: (where: Record<string, unknown>) => ({
      delete: async () => {
        deleted.push({ table, where });
        return 1;
      },
    }),
  }));
  return { db: db as unknown as Knex, inserted, deleted };
}

describe("parseNetworkSpentOutpoints", () => {
  it("extracts the spent outpoint and its spender from Teranode's UTXO_SPENT line", () => {
    expect(parseNetworkSpentOutpoints(TERANODE_LINE)).toEqual([
      { txid: PARENT, vout: 1, spentBy: SPENDER },
    ]);
  });

  it("ignores reasons that do not name a spender", () => {
    expect(parseNetworkSpentOutpoints("TX_INVALID (31): GoBDK fail to ValidateTransaction")).toEqual([]);
    expect(parseNetworkSpentOutpoints(`TX_LOCKED (37): [Spend] utxo is not spendable for ${PARENT}:1`)).toEqual([]);
    expect(parseNetworkSpentOutpoints(null)).toEqual([]);
  });

  it("de-duplicates repeated outpoints", () => {
    expect(parseNetworkSpentOutpoints(`${TERANODE_LINE}; ${TERANODE_LINE}`)).toHaveLength(1);
  });
});

describe("NetworkSpentRegistry", () => {
  it("filters loaded outpoints out of an explorer's unspent list", async () => {
    const { db } = fakeDb([{ txid: PARENT, vout: 1 }]);
    const registry = new NetworkSpentRegistry(db);
    await registry.load();

    const listed = [
      { tx_hash: PARENT, tx_pos: 1, value: 64_000, height: 973465 },
      { tx_hash: PARENT, tx_pos: 0, value: 64_000, height: 973465 },
    ];
    expect(registry.filter(listed)).toEqual([listed[1]]);
  });

  it("persists a quarantine and removes the outpoint from both pools", async () => {
    const fake = fakeDb();
    const registry = new NetworkSpentRegistry(fake.db);

    const added = await registry.quarantine(parseNetworkSpentOutpoints(TERANODE_LINE), REJECTED);

    expect(added).toBe(1);
    expect(registry.has(PARENT, 1)).toBe(true);
    expect(fake.inserted).toEqual([
      { txid: PARENT, vout: 1, spent_by_txid: SPENDER, rejected_txid: REJECTED },
    ]);
    expect(fake.deleted.map((d) => d.table).sort()).toEqual(["funding_utxo_pool", "utxo_pool"]);
  });

  it("keeps the outpoint quarantined in memory when the table write fails", async () => {
    const registry = new NetworkSpentRegistry(fakeDb([], true).db);
    await registry.quarantine(parseNetworkSpentOutpoints(TERANODE_LINE), REJECTED);
    expect(registry.filter([{ tx_hash: PARENT, tx_pos: 1 }])).toEqual([]);
  });

  it("starts empty rather than failing when the table cannot be read", async () => {
    const db = vi.fn(() => ({
      select: async () => {
        throw new Error("relation does not exist");
      },
    })) as unknown as Knex;
    const registry = new NetworkSpentRegistry(db);
    await expect(registry.load()).resolves.toBe(0);
  });
});
