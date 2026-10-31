import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateKey } from "@bsv/sdk";
import { RecordType, type TelemetryRecord } from "@airchive/types";
import {
  buildOpReturnPayload,
  encodeTelemetryPayload,
  RecordType as CodecRecordType,
} from "@airchive/telemetry-codec";
import { ChainLookup } from "../chain-lookup.js";
import { LostTxDetector, type LostTxDeps } from "../lost-tx-detector.js";
import type { TxProbe } from "../chain-lookup.js";
import { UtxoManager } from "../utxo-manager.js";
import { createMemoryDb, type MemoryRow } from "./memory-db.js";

const LOST = "ab".repeat(32);
const REAL = "cd".repeat(32);
const YOUNG = "ef".repeat(32);
const ICAO = "ABCDEF";
const RECHECK_MS = 5 * 60_000;
const MIN_AGE_MS = 20 * 60_000;

const aircraftKey = new PrivateKey(
  "0000000000000000000000000000000000000000000000000000000000000001",
  16,
);
const aircraftAddress = aircraftKey.toAddress();

function envelope(): Buffer {
  const telemetry: TelemetryRecord = {
    icao: ICAO,
    callsign: "TEST01",
    reg: "G-TEST",
    squawk: "1234",
    aircraft_type: "A35K",
    category: "",
    ts: 1_704_067_200_000,
    ts_pos: 1_704_067_200_000,
    lat: 51.47,
    lon: -0.46,
    alt_baro: 32_000,
    alt_geom: 32_000,
    on_ground: false,
    gs: 450,
    ias: 280,
    tas: 470,
    mach: 0.78,
    track: 90,
    true_heading: 92,
    mag_heading: 90,
    baro_rate: 0,
    geom_rate: 0,
    roll: 0,
    wind_dir: 270,
    wind_speed: 40,
    oat: -45,
    tat: -12,
    nav_qnh: 1013,
    nav_alt_mcp: 32_000,
    nav_alt_fms: 32_000,
    nav_heading: 90,
    nav_modes: ["LNAV", "VNAV"],
    nic: 8,
    rc: 0,
    adsb_version: 2,
    position_source: 1,
    num_receivers: 3,
    emergency: "none",
    data_sources: ["adsbfi"],
    seq: 1,
  };
  return Buffer.from(
    buildOpReturnPayload(
      telemetry.icao,
      telemetry.ts,
      CodecRecordType.TELEMETRY,
      encodeTelemetryPayload(telemetry),
    ),
  );
}

function txRow(txid: string, createdAt: Date): MemoryRow {
  return {
    txid,
    aircraft_icao: ICAO,
    record_type: RecordType.TELEMETRY,
    status: "SEEN_ON_NETWORK",
    timestamp: createdAt.getTime(),
    fee_sats: 1,
    size_bytes: 100,
    flight_id: null,
    op_return: txid === LOST ? envelope() : null,
    reject_requeues: 0,
    created_at: createdAt,
  };
}

function harness(probe: () => Promise<TxProbe> | TxProbe, now: () => number) {
  const start = now();
  const { db, table } = createMemoryDb({
    tx_results: [
      txRow(LOST, new Date(start - MIN_AGE_MS - 60_000)),
      txRow(YOUNG, new Date(start)),
    ],
    utxo_pool: [{
      aircraft_icao: ICAO,
      txid: LOST,
      vout: 1,
      satoshis: 4_000,
      locking_script: "76a91400",
      is_locked: false,
      unconfirmed_depth: 1,
      created_at: new Date(start - MIN_AGE_MS - 60_000),
    }],
  });
  const noteTerminalRejection = vi.fn();
  const funding = {
    reconcile: vi.fn(async () => ({ ok: true, added: 0, removed: 0 })),
    noteOutputsInvalidated: vi.fn(),
    isFundingOutputConfirmed: () => false,
  };
  const utxos = new UtxoManager(db, {
    getJson: async () => [{ tx_hash: REAL, tx_pos: 0, value: 5_000, height: 0 }],
  } as never);
  const deps: LostTxDeps = {
    db,
    probe: async (txid) => {
      expect(txid).not.toBe(YOUNG);
      return probe();
    },
    utxoManager: utxos,
    fundingUtxoManager: funding,
    fundingWif: "wif",
    addressFor: () => aircraftAddress,
    noteTerminalRejection,
    now,
    minAgeMs: MIN_AGE_MS,
    recheckMs: RECHECK_MS,
    batch: 50,
  };
  return { db, table, deps, noteTerminalRejection, funding, detector: new LostTxDetector(deps) };
}

describe("lost transaction detector", () => {
  it("requires two absences a recheck apart before marking the row lost", async () => {
    const start = Date.parse("2026-10-31T12:00:00Z");
    let now = start;
    let probes = 0;
    const { table, detector, noteTerminalRejection } = harness(
      () => {
        probes += 1;
        return { presence: "absent", providers: ["whatsonchain"] };
      },
      () => now,
    );

    await detector.runOnce();
    expect(table("tx_results").find((row) => row.txid === LOST)?.status).toBe("SEEN_ON_NETWORK");
    expect(table("pending_writes")).toHaveLength(0);
    expect(noteTerminalRejection).not.toHaveBeenCalled();

    now = start + RECHECK_MS - 1;
    await detector.runOnce();
    expect(probes).toBe(1);
    expect(table("tx_results").find((row) => row.txid === LOST)?.status).toBe("SEEN_ON_NETWORK");

    now = start + RECHECK_MS;
    const summary = await detector.runOnce();
    expect(probes).toBe(2);
    expect(summary.lost).toBe(1);
    const lost = table("tx_results").find((row) => row.txid === LOST);
    expect(lost?.status).toBe("FAILED");
    expect(lost?.reject_status).toBe("LOST");
    expect(String(lost?.reject_reason)).toContain("no record of this transaction");
    expect(table("tx_results").find((row) => row.txid === YOUNG)?.status).toBe("SEEN_ON_NETWORK");
    expect(table("pending_writes")).toHaveLength(1);
    expect(table("pending_writes")[0]?.preserved).toBe(true);
    expect(table("utxo_pool").map((row) => row.txid)).toEqual([REAL]);
    expect(noteTerminalRejection).not.toHaveBeenCalled();
  });

  it("treats an error or an unknown answer as not lost", async () => {
    const start = Date.parse("2026-10-31T12:00:00Z");
    let unknownCalls = 0;
    const unknown = harness(
      () => {
        unknownCalls += 1;
        return { presence: "unknown", providers: [] };
      },
      () => start,
    );
    await unknown.detector.runOnce();
    expect(unknownCalls).toBe(1);
    expect(unknown.table("tx_results").find((row) => row.txid === LOST)?.status).toBe("SEEN_ON_NETWORK");
    expect(unknown.table("pending_writes")).toHaveLength(0);
    expect(unknown.noteTerminalRejection).not.toHaveBeenCalled();

    let thrownCalls = 0;
    const thrown = harness(
      () => {
        thrownCalls += 1;
        throw new Error("429");
      },
      () => start,
    );
    await thrown.detector.runOnce();
    expect(thrownCalls).toBe(1);
    expect(thrown.table("tx_results").find((row) => row.txid === LOST)?.status).toBe("SEEN_ON_NETWORK");
    expect(thrown.noteTerminalRejection).not.toHaveBeenCalled();
  });

  it("confirms on one check when two providers both report the transaction missing", async () => {
    const start = Date.parse("2026-10-31T12:00:00Z");
    const { table, detector, noteTerminalRejection } = harness(
      () => ({ presence: "absent", providers: ["bananablocks", "whatsonchain"] }),
      () => start,
    );

    await detector.runOnce();

    expect(table("tx_results").find((row) => row.txid === LOST)?.status).toBe("FAILED");
    expect(table("pending_writes")).toHaveLength(1);
    expect(noteTerminalRejection).not.toHaveBeenCalled();
  });

  it("does not requeue the same txid twice", async () => {
    const start = Date.parse("2026-10-31T12:00:00Z");
    const { table, deps } = harness(
      () => ({ presence: "absent", providers: ["bananablocks", "whatsonchain"] }),
      () => start,
    );
    const first = new LostTxDetector(deps);
    await first.runOnce();
    expect(table("pending_writes")).toHaveLength(1);

    const row = table("tx_results").find((entry) => entry.txid === LOST);
    if (row) row.status = "SEEN_ON_NETWORK";
    const second = new LostTxDetector(deps);
    await second.runOnce();

    expect(table("pending_writes")).toHaveLength(1);
    expect(table("tx_results").find((entry) => entry.txid === LOST)?.reject_requeues).toBe(1);
  });

  it("forgets a first absence when a later check finds the transaction", async () => {
    const start = Date.parse("2026-10-31T12:00:00Z");
    let now = start;
    const answers: TxProbe[] = [
      { presence: "absent", providers: ["whatsonchain"] },
      { presence: "found", providers: ["whatsonchain"] },
      { presence: "absent", providers: ["whatsonchain"] },
    ];
    const { table, detector } = harness(() => answers.shift()!, () => now);

    await detector.runOnce();
    now = start + RECHECK_MS;
    await detector.runOnce();
    now = start + RECHECK_MS * 2;
    await detector.runOnce();

    expect(table("tx_results").find((row) => row.txid === LOST)?.status).toBe("SEEN_ON_NETWORK");
    expect(table("pending_writes")).toHaveLength(0);
  });
});

describe("chain probe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function lookup(): ChainLookup {
    return new ChainLookup([
      {
        name: "bananablocks",
        baseUrl: "https://banana.test",
        capabilities: ["tx"],
        txPathStyle: "hash",
        maxRequestsPerSecond: 100,
      },
      {
        name: "whatsonchain",
        baseUrl: "https://woc.test",
        capabilities: ["tx"],
        maxRequestsPerSecond: 100,
      },
    ]);
  }

  it("counts absent only when every healthy provider returns 404", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      if (String(url).includes("banana")) return new Response(null, { status: 404 });
      return new Response(JSON.stringify({ txid: LOST }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(lookup().probeTx(LOST)).resolves.toEqual({
      presence: "found",
      providers: ["whatsonchain"],
    });
    expect(urls.some((url) => url.includes("/tx/hash/"))).toBe(true);

    vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
    await expect(lookup().probeTx(LOST)).resolves.toEqual({
      presence: "absent",
      providers: ["bananablocks", "whatsonchain"],
    });
  });

  it("returns unknown on a provider error or rate limit", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 500 }));
    await expect(lookup().probeTx(LOST)).resolves.toEqual({
      presence: "unknown",
      providers: [],
    });

    vi.stubGlobal("fetch", async () => new Response("slow", { status: 429 }));
    await expect(lookup().probeTx(LOST)).resolves.toEqual({
      presence: "unknown",
      providers: [],
    });
  });
});
