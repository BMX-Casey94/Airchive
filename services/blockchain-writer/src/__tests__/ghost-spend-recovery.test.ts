import type { Knex } from "knex";
import { Hash, P2PKH, PrivateKey, Transaction } from "@bsv/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  GhostSpendRecovery,
  type FetchLike,
  type MinedLookup,
  type OwnedWallets,
} from "../ghost-spend-recovery.js";
import { createMemoryDb, type MemoryRow } from "./memory-db.js";

const PARENT = "11".repeat(32);
const OTHER = "22".repeat(32);
const NOW = Date.parse("2026-10-31T12:00:00Z");
const INTERVAL_MS = 120_000;
const INPUT_SATS = 10_000;
const HUBS = ["https://hub-a.test/api/v1", "https://hub-b.test/api/v1"];
const ARCADE = "https://arcade.test";

function pubkeyHash(key: PrivateKey): number[] {
  return Hash.hash160(key.toPublicKey().encode(true) as number[]);
}

function lockScript(key: PrivateKey) {
  return new P2PKH().lock(pubkeyHash(key));
}

async function signedSpend(options: {
  inputs: Array<{ key: PrivateKey; sourceTxid: string; sourceVout?: number; sats?: number }>;
  outputs: Array<{ key: PrivateKey; sats: number }>;
}): Promise<{ txid: string; ef: string; raw: string }> {
  const tx = new Transaction();
  for (const input of options.inputs) {
    const sats = input.sats ?? INPUT_SATS;
    const vout = input.sourceVout ?? 0;
    const locking = lockScript(input.key);
    const source = new Transaction();
    for (let index = 0; index < vout; index += 1) {
      source.addOutput({ lockingScript: lockScript(input.key), satoshis: 1 });
    }
    source.addOutput({ lockingScript: locking, satoshis: sats });
    tx.addInput({
      sourceTransaction: source,
      sourceTXID: input.sourceTxid,
      sourceOutputIndex: vout,
      unlockingScriptTemplate: new P2PKH().unlock(input.key, "all", false, sats, locking),
      sequence: 0xffffffff,
    });
  }
  for (const output of options.outputs) {
    tx.addOutput({ lockingScript: lockScript(output.key), satoshis: output.sats });
  }
  await tx.sign();
  return { txid: tx.id("hex").toLowerCase(), ef: tx.toHexEF(), raw: tx.toHex() };
}

function quarantineRow(spendTxid: string, vout: number, patch: MemoryRow = {}): MemoryRow {
  return {
    txid: vout === 0 ? PARENT : OTHER,
    vout,
    spent_by_txid: spendTxid,
    rejected_txid: null,
    noted_at: new Date(NOW - 60_000),
    recovery_status: "pending",
    recovery_attempts: 0,
    last_attempt_at: null,
    recovery_detail: null,
    ...patch,
  };
}

function harness(options: {
  rows: MemoryRow[];
  owned: OwnedWallets;
  onFetch: (url: string, init?: RequestInit) => Response | Promise<Response>;
  lookup?: (txid: string) => Promise<MinedLookup>;
  now?: number;
  submitUrls?: string[];
}) {
  const { db, table } = createMemoryDb({ network_spent_outpoints: options.rows });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return options.onFetch(url, init);
  };
  const reconcileFunding = vi.fn(async () => ({ ok: true }));
  const reconcileAircraft = vi.fn(async () => ({ applied: true }));
  const job = new GhostSpendRecovery({
    db,
    fetch: fetchImpl,
    arcadeBaseUrl: ARCADE,
    callbackToken: "callback-token",
    datahubUrls: HUBS,
    submitUrls: options.submitUrls,
    resolveOwned: () => options.owned,
    reconcileFunding,
    reconcileAircraft,
    lookupMined: options.lookup ?? (async () => {
      throw new Error("chain lookup should not run");
    }),
    now: () => options.now ?? NOW,
    intervalMs: INTERVAL_MS,
    batch: 20,
    maxAttempts: 6,
  });
  return { table, calls, job, reconcileFunding, reconcileAircraft };
}

function posts(calls: Array<{ url: string; init?: RequestInit }>) {
  return calls.filter((call) => call.init?.method === "POST");
}

describe("ghost spend recovery", () => {
  it("rebroadcasts an owned spender and marks every row for that spender", async () => {
    const treasury = PrivateKey.fromRandom();
    const spend = await signedSpend({
      inputs: [{ key: treasury, sourceTxid: PARENT }],
      outputs: [{ key: treasury, sats: 9_000 }],
    });
    expect(spend.ef.startsWith("010000000000000000ef")).toBe(true);

    const { table, calls, job } = harness({
      rows: [
        quarantineRow(spend.txid, 0, { txid: PARENT }),
        quarantineRow(spend.txid, 1, { txid: PARENT }),
      ],
      owned: { treasuryAddress: treasury.toAddress(), aircraft: [] },
      onFetch: (url, init) => {
        if (init?.method === "POST") {
          return new Response(JSON.stringify({
            txid: spend.txid,
            status: 202,
            txStatus: "RECEIVED",
          }), { status: 202 });
        }
        if (url.startsWith("https://hub-a.test/")) return new Response("missing", { status: 404 });
        return new Response(spend.ef, { status: 200 });
      },
    });

    await job.runOnce();

    const posted = posts(calls);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe(`${ARCADE}/tx`);
    expect(Buffer.from(posted[0]?.init?.body as Uint8Array).toString("hex")).toBe(spend.ef);
    const headers = posted[0]?.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers.Accept).toBe("application/json");
    expect(headers["X-CallbackToken"]).toBe("callback-token");
    expect(calls.map((call) => call.url)).toEqual([
      `https://hub-a.test/api/v1/tx/${spend.txid}/hex`,
      `https://hub-b.test/api/v1/tx/${spend.txid}/hex`,
      `${ARCADE}/tx`,
    ]);

    const rows = table("network_spent_outpoints");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.recovery_status).toBe("rebroadcast");
      expect(row.recovery_attempts).toBe(1);
      expect(new Date(row.last_attempt_at as Date).getTime()).toBe(NOW);
      expect(String(row.recovery_detail)).toContain("RECEIVED");
    }
  });

  it("also sends the fetched bytes to each Teranode submit URL without changing the outcome", async () => {
    const treasury = PrivateKey.fromRandom();
    const spend = await signedSpend({
      inputs: [{ key: treasury, sourceTxid: PARENT }],
      outputs: [{ key: treasury, sats: 9_000 }],
    });
    const { table, calls, job } = harness({
      rows: [quarantineRow(spend.txid, 0, { txid: PARENT })],
      owned: { treasuryAddress: treasury.toAddress(), aircraft: [] },
      submitUrls: ["https://node-a.test/api/v1/", "ftp://ignored.test"],
      onFetch: (url, init) => {
        if (url.startsWith("https://node-a.test/")) throw new Error("connection refused");
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ txid: spend.txid, txStatus: "RECEIVED" }), { status: 202 });
        }
        return new Response(spend.ef, { status: 200 });
      },
    });

    await job.runOnce();

    const posted = posts(calls);
    expect(posted.map((call) => call.url)).toEqual([
      `${ARCADE}/tx`,
      "https://node-a.test/api/v1/tx",
    ]);
    expect(Buffer.from(posted[1]?.init?.body as Uint8Array).toString("hex")).toBe(spend.ef);
    expect(table("network_spent_outpoints")[0]?.recovery_status).toBe("rebroadcast");
  });

  it("rejects a datahub body whose txid is not the named spender and does not broadcast it", async () => {
    const treasury = PrivateKey.fromRandom();
    const named = await signedSpend({
      inputs: [{ key: treasury, sourceTxid: PARENT }],
      outputs: [{ key: treasury, sats: 9_000 }],
    });
    const substitute = await signedSpend({
      inputs: [{ key: treasury, sourceTxid: OTHER }],
      outputs: [{ key: treasury, sats: 9_000 }],
    });
    const { table, calls, job } = harness({
      rows: [quarantineRow(named.txid, 0)],
      owned: { treasuryAddress: treasury.toAddress(), aircraft: [] },
      onFetch: () => new Response(substitute.ef, { status: 200 }),
    });

    await job.runOnce();

    expect(posts(calls)).toHaveLength(0);
    const row = table("network_spent_outpoints")[0];
    expect(row?.recovery_status).toBe("rejected");
    expect(row?.recovery_attempts).toBe(1);
    expect(String(row?.recovery_detail)).toContain("does not match");
  });

  it("leaves a spender quarantined when any input pays an address we do not control", async () => {
    const treasury = PrivateKey.fromRandom();
    const stranger = PrivateKey.fromRandom();
    const spend = await signedSpend({
      inputs: [
        { key: treasury, sourceTxid: PARENT },
        { key: stranger, sourceTxid: OTHER },
      ],
      outputs: [{ key: treasury, sats: 19_000 }],
    });
    const { table, calls, job } = harness({
      rows: [quarantineRow(spend.txid, 0)],
      owned: { treasuryAddress: treasury.toAddress(), aircraft: [] },
      onFetch: () => new Response(spend.ef, { status: 200 }),
    });

    await job.runOnce();

    expect(posts(calls)).toHaveLength(0);
    const row = table("network_spent_outpoints")[0];
    expect(row?.recovery_status).toBe("not_ours");
    expect(String(row?.recovery_detail)).toContain("Input 1");
  });

  it("marks the row unavailable and counts an attempt when no datahub has the spender", async () => {
    const { table, calls, job } = harness({
      rows: [quarantineRow("ab".repeat(32), 0)],
      owned: { treasuryAddress: PrivateKey.fromRandom().toAddress(), aircraft: [] },
      onFetch: () => new Response("missing", { status: 404 }),
    });

    await job.runOnce();

    expect(posts(calls)).toHaveLength(0);
    const row = table("network_spent_outpoints")[0];
    expect(row?.recovery_status).toBe("unavailable");
    expect(row?.recovery_attempts).toBe(1);
    expect(String(row?.recovery_detail)).toContain("hub-a.test");
    expect(String(row?.recovery_detail)).toContain("hub-b.test");
  });

  it("records an Arcade REJECTED verdict and its reason", async () => {
    const treasury = PrivateKey.fromRandom();
    const spend = await signedSpend({
      inputs: [{ key: treasury, sourceTxid: PARENT }],
      outputs: [{ key: treasury, sats: 9_000 }],
    });
    const { table, job } = harness({
      rows: [quarantineRow(spend.txid, 0)],
      owned: { treasuryAddress: treasury.toAddress(), aircraft: [] },
      onFetch: (_url, init) => {
        if (init?.method === "POST") {
          return new Response(JSON.stringify({
            txid: spend.txid,
            txStatus: "REJECTED",
            extraInfo: "mandatory script verify failed",
          }), { status: 200 });
        }
        return new Response(spend.ef, { status: 200 });
      },
    });

    await job.runOnce();

    const row = table("network_spent_outpoints")[0];
    expect(row?.recovery_status).toBe("rejected");
    expect(row?.recovery_attempts).toBe(1);
    expect(String(row?.recovery_detail)).toContain("mandatory script verify failed");
  });

  it("marks a rebroadcast spender mined and reconciles only the wallets its outputs pay", async () => {
    const treasury = PrivateKey.fromRandom();
    const aircraftA = PrivateKey.fromRandom();
    const aircraftB = PrivateKey.fromRandom();
    const stranger = PrivateKey.fromRandom();
    const spend = await signedSpend({
      inputs: [{ key: treasury, sourceTxid: PARENT, sats: 20_000 }],
      outputs: [
        { key: treasury, sats: 6_000 },
        { key: aircraftA, sats: 6_000 },
        { key: stranger, sats: 6_000 },
      ],
    });
    const aircraftAddress = aircraftA.toAddress();
    let lookups = 0;
    const { table, calls, job, reconcileFunding, reconcileAircraft } = harness({
      rows: [quarantineRow(spend.txid, 0, {
        recovery_status: "rebroadcast",
        recovery_attempts: 1,
        last_attempt_at: new Date(NOW - 31 * 60_000),
      })],
      owned: {
        treasuryAddress: treasury.toAddress(),
        aircraft: [
          { icao: "abc123", address: aircraftAddress },
          { icao: "DEF456", address: aircraftB.toAddress() },
        ],
      },
      lookup: async (txid) => {
        lookups += 1;
        expect(txid).toBe(spend.txid);
        return { state: "mined", blockHeight: 900_000 };
      },
      onFetch: (_url, init) => {
        if (init?.method === "POST") return new Response("no", { status: 500 });
        return new Response(spend.ef, { status: 200 });
      },
    });

    await job.runOnce();

    expect(lookups).toBe(1);
    expect(posts(calls)).toHaveLength(0);
    expect(reconcileFunding).toHaveBeenCalledTimes(1);
    expect(reconcileAircraft).toHaveBeenCalledTimes(1);
    expect(reconcileAircraft).toHaveBeenCalledWith("ABC123", aircraftAddress);
    const row = table("network_spent_outpoints")[0];
    expect(row?.recovery_status).toBe("mined");
    expect(row?.recovery_attempts).toBe(1);
    expect(String(row?.recovery_detail)).toContain("900000");
  });

  it("skips a row whose last attempt is still inside the backoff window", async () => {
    // One previous attempt waits interval * 2, which is four minutes here.
    const { table, calls, job } = harness({
      rows: [quarantineRow("cd".repeat(32), 0, {
        recovery_attempts: 1,
        last_attempt_at: new Date(NOW - 1_000),
      })],
      owned: { treasuryAddress: PrivateKey.fromRandom().toAddress(), aircraft: [] },
      onFetch: () => {
        throw new Error("backoff row was fetched");
      },
    });

    await job.runOnce();

    expect(calls).toHaveLength(0);
    const row = table("network_spent_outpoints")[0];
    expect(row?.recovery_status).toBe("pending");
    expect(row?.recovery_attempts).toBe(1);
  });

  it("does not throw when the quarantine table is missing", async () => {
    const db = (() => {
      throw Object.assign(
        new Error('relation "network_spent_outpoints" does not exist'),
        { code: "42P01" },
      );
    }) as unknown as Knex;
    const job = new GhostSpendRecovery({
      db,
      fetch: async () => {
        throw new Error("fetch should not run");
      },
      arcadeBaseUrl: ARCADE,
      datahubUrls: HUBS,
      resolveOwned: () => ({ treasuryAddress: "1", aircraft: [] }),
      reconcileFunding: async () => undefined,
      reconcileAircraft: async () => undefined,
      lookupMined: async () => {
        throw new Error("lookup should not run");
      },
      now: () => NOW,
    });

    await expect(job.runOnce()).resolves.toEqual({
      rebroadcast: 0,
      mined: 0,
      not_ours: 0,
      unavailable: 0,
      rejected: 0,
      error: 0,
    });
  });

  it("rejects a raw transaction because source outputs are absent", async () => {
    const treasury = PrivateKey.fromRandom();
    const spend = await signedSpend({
      inputs: [{ key: treasury, sourceTxid: PARENT }],
      outputs: [{ key: treasury, sats: 9_000 }],
    });
    const { table, calls, job } = harness({
      rows: [quarantineRow(spend.txid, 0)],
      owned: { treasuryAddress: treasury.toAddress(), aircraft: [] },
      onFetch: () => new Response(spend.raw, { status: 200 }),
    });

    await job.runOnce();

    expect(posts(calls)).toHaveLength(0);
    const row = table("network_spent_outpoints")[0];
    expect(row?.recovery_status).toBe("rejected");
    expect(String(row?.recovery_detail).toLowerCase()).toMatch(/raw transaction|does not match/);
  });

  it("keeps the current status when Arcade returns a server error", async () => {
    const treasury = PrivateKey.fromRandom();
    const spend = await signedSpend({
      inputs: [{ key: treasury, sourceTxid: PARENT }],
      outputs: [{ key: treasury, sats: 9_000 }],
    });
    const { table, job } = harness({
      rows: [quarantineRow(spend.txid, 0)],
      owned: { treasuryAddress: treasury.toAddress(), aircraft: [] },
      onFetch: (_url, init) => {
        if (init?.method === "POST") return new Response("unavailable", { status: 503 });
        return new Response(spend.ef, { status: 200 });
      },
    });

    await job.runOnce();

    const row = table("network_spent_outpoints")[0];
    expect(row?.recovery_status).toBe("pending");
    expect(row?.recovery_attempts).toBe(1);
    expect(String(row?.recovery_detail)).toContain("503");
  });
});
