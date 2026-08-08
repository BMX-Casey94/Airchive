import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";

vi.mock("@airchive/db", () => ({
  getUtxoCount: vi.fn(async () => 0),
  getUtxoPoolBalance: vi.fn(async () => 0n),
  insertUtxo: vi.fn(async () => undefined),
  markUtxosConfirmed: vi.fn(async () => 0),
  resetConfirmedUtxoDepths: vi.fn(async () => 0),
}));

import {
  ChainDepthExhaustedError,
  UtxoManager,
} from "../utxo-manager.js";

interface PoolRow {
  aircraft_icao: string;
  txid: string;
  vout: number;
  satoshis: number;
  locking_script: string;
  is_locked: boolean;
  locked_at: Date | null;
  unconfirmed_depth: number;
}

function row(overrides: Partial<PoolRow> = {}): PoolRow {
  return {
    aircraft_icao: "ABCDEF",
    txid: "aa".repeat(32),
    vout: 0,
    satoshis: 1_600,
    locking_script: "76a914",
    is_locked: false,
    locked_at: null,
    unconfirmed_depth: 0,
    ...overrides,
  };
}

type Comparison = (candidate: PoolRow) => boolean;

/**
 * Minimal stand-in for the Knex builder shapes the pool actually uses. A real
 * Postgres would be a better test of the SQL, but this covers the selection
 * policy — which output the writer picks, and when it refuses to pick one — that
 * the chain-depth ceiling exists to enforce.
 */
function createFakeDb(rows: PoolRow[]) {
  const store = rows;

  function builder() {
    const filters: Comparison[] = [];
    let order: Array<{ column: keyof PoolRow; order: "asc" | "desc" }> = [];
    let counting = false;

    const matched = (): PoolRow[] => {
      const result = store.filter((candidate) =>
        filters.every((filter) => filter(candidate)),
      );
      for (const spec of [...order].reverse()) {
        result.sort((a, b) => {
          const left = a[spec.column];
          const right = b[spec.column];
          const cmp = left === right ? 0 : (left as number) < (right as number) ? -1 : 1;
          return spec.order === "desc" ? -cmp : cmp;
        });
      }
      return result;
    };

    const api = {
      where(arg: unknown, op?: string, value?: unknown) {
        if (typeof arg === "object" && arg !== null) {
          const clause = arg as Partial<PoolRow>;
          filters.push((candidate) =>
            Object.entries(clause).every(
              ([key, expected]) => candidate[key as keyof PoolRow] === expected,
            ),
          );
        } else {
          const column = arg as keyof PoolRow;
          filters.push((candidate) => {
            const actual = candidate[column] as number;
            const expected = value as number;
            switch (op) {
              case ">=":
                return actual >= expected;
              case ">":
                return actual > expected;
              case "<":
                return actual < expected;
              case "<=":
                return actual <= expected;
              default:
                return actual === expected;
            }
          });
        }
        return api;
      },
      orderBy(
        spec: Array<{ column: keyof PoolRow; order: "asc" | "desc" }> | keyof PoolRow,
        direction?: "asc" | "desc",
      ) {
        order = Array.isArray(spec)
          ? spec
          : [{ column: spec, order: direction ?? "asc" }];
        return api;
      },
      select() {
        return api;
      },
      count() {
        counting = true;
        return api;
      },
      async first(...columns: string[]) {
        if (counting) return { count: String(matched().length) };
        const found = matched()[0];
        if (!found) return undefined;
        if (columns.length === 0) return found;
        return Object.fromEntries(
          columns.map((column) => [column, found[column as keyof PoolRow]]),
        );
      },
      async update(patch: Partial<PoolRow>) {
        const targets = matched();
        for (const target of targets) Object.assign(target, patch);
        return targets.length;
      },
      async delete() {
        const targets = new Set(matched());
        for (let i = store.length - 1; i >= 0; i--) {
          if (targets.has(store[i]!)) store.splice(i, 1);
        }
        return targets.size;
      },
      async insert(record: Partial<PoolRow>) {
        store.push(row(record));
        return [1];
      },
      then(
        resolve: (value: PoolRow[]) => unknown,
        reject?: (reason: unknown) => unknown,
      ) {
        try {
          return Promise.resolve(resolve(matched()));
        } catch (err) {
          return reject ? Promise.resolve(reject(err)) : Promise.reject(err);
        }
      },
    };

    return api;
  }

  const db = (() => builder()) as unknown as Knex & { rows: PoolRow[] };
  Object.assign(db, {
    fn: { now: () => new Date("2026-01-01T00:00:00Z") },
    transaction: async <T>(handler: (trx: Knex.Transaction) => Promise<T>) =>
      handler((() => builder()) as unknown as Knex.Transaction),
    rows: store,
  });
  return db;
}

const woc = {} as never;

describe("UtxoManager unconfirmed chain depth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers the shallowest output over the largest one", async () => {
    const db = createFakeDb([
      row({ txid: "11".repeat(32), satoshis: 5_000, unconfirmed_depth: 3 }),
      row({ txid: "22".repeat(32), satoshis: 1_600, unconfirmed_depth: 0 }),
      row({ txid: "33".repeat(32), satoshis: 4_000, unconfirmed_depth: 1 }),
    ]);
    const manager = new UtxoManager(db, woc);
    manager.setMaxUnconfirmedChainDepth(() => 5);

    const acquired = await manager.acquireUtxo("ABCDEF");

    // Settled funds first: repeatedly taking the biggest output is what kept
    // extending one fragile lineage instead of spreading writes across the pool.
    expect(acquired.txid).toBe("22".repeat(32));
    expect(db.rows.find((r) => r.txid === "22".repeat(32))?.is_locked).toBe(true);
  });

  it("breaks ties at the same depth by taking the largest output", async () => {
    const db = createFakeDb([
      row({ txid: "11".repeat(32), satoshis: 1_600, unconfirmed_depth: 1 }),
      row({ txid: "22".repeat(32), satoshis: 9_000, unconfirmed_depth: 1 }),
    ]);
    const manager = new UtxoManager(db, woc);
    manager.setMaxUnconfirmedChainDepth(() => 5);

    const acquired = await manager.acquireUtxo("ABCDEF");
    expect(acquired.txid).toBe("22".repeat(32));
  });

  it("refuses to extend a chain past the ceiling instead of spending anyway", async () => {
    const db = createFakeDb([
      row({ txid: "11".repeat(32), satoshis: 50_000, unconfirmed_depth: 5 }),
      row({ txid: "22".repeat(32), satoshis: 50_000, unconfirmed_depth: 9 }),
    ]);
    const manager = new UtxoManager(db, woc);
    manager.setMaxUnconfirmedChainDepth(() => 5);

    await expect(manager.acquireUtxo("ABCDEF")).rejects.toBeInstanceOf(
      ChainDepthExhaustedError,
    );
    // Funds are real, so nothing may be locked, purged or treated as stale.
    expect(db.rows.every((r) => !r.is_locked)).toBe(true);
  });

  it("tightens with the governor's ceiling without the pool being rebuilt", async () => {
    const db = createFakeDb([
      row({ txid: "11".repeat(32), satoshis: 1_600, unconfirmed_depth: 3 }),
    ]);
    const manager = new UtxoManager(db, woc);
    let ceiling = 5;
    manager.setMaxUnconfirmedChainDepth(() => ceiling);

    await expect(manager.acquireUtxo("ABCDEF")).resolves.toMatchObject({
      txid: "11".repeat(32),
    });

    await manager.releaseUtxo("11".repeat(32), 0);
    ceiling = 2;

    await expect(manager.acquireUtxo("ABCDEF")).rejects.toBeInstanceOf(
      ChainDepthExhaustedError,
    );
  });

  it("records change one level deeper than the input it spent", async () => {
    const db = createFakeDb([
      row({ txid: "11".repeat(32), satoshis: 1_600, unconfirmed_depth: 2 }),
    ]);
    const manager = new UtxoManager(db, woc);

    await manager.recordSpend(
      "11".repeat(32),
      0,
      "99".repeat(32),
      1,
      1_500,
      "76a914",
      "ABCDEF",
    );

    expect(db.rows.some((r) => r.txid === "11".repeat(32))).toBe(false);
    const change = db.rows.find((r) => r.txid === "99".repeat(32));
    expect(change?.unconfirmed_depth).toBe(3);
  });

  it("excludes outputs beyond the ceiling from the spendable balance", async () => {
    const db = createFakeDb([
      row({ txid: "11".repeat(32), unconfirmed_depth: 0 }),
      row({ txid: "22".repeat(32), unconfirmed_depth: 4 }),
      row({ txid: "33".repeat(32), unconfirmed_depth: 6 }),
    ]);
    const manager = new UtxoManager(db, woc);
    manager.setMaxUnconfirmedChainDepth(() => 4);

    const state = await manager.checkBalance("ABCDEF");

    // Counting unspendable rows as available would hide the need for a refill.
    expect(state.unlockedUtxoCount).toBe(1);
    expect(state.readyUtxoCount).toBe(1);
    expect(state.deepUtxoCount).toBe(2);
  });
});
