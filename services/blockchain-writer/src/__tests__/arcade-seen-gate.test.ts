import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transaction } from "@bsv/sdk";
import { ArcadeBroadcaster } from "../arcade-broadcaster.js";
import {
  isDependencyPendingBroadcastFailure,
  isTransientBroadcastFailure,
  type Broadcaster,
} from "../broadcaster.js";

const TX_A = "aa".repeat(32);
const TX_B = "bb".repeat(32);

function fakeTx(id: string): Transaction {
  return {
    id: () => id,
    toEF: () => new Uint8Array([1]),
  } as unknown as Transaction;
}

function fallback(): Broadcaster {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    broadcast: vi.fn(async () => ({ txid: TX_A, status: "SEEN_ON_NETWORK" as const })),
    getState: () => ({
      inFlight: 0,
      queueDepth: 0,
      circuitOpen: false,
      circuitOpenRemainingMs: 0,
    }),
    getLimits: () => ({ maxConcurrentBroadcasts: 4, maxQueueDepth: 8 }),
    isDegraded: () => false,
    setupCallbackReceiver: () => undefined,
    closeCallbackReceiver: async () => undefined,
  }) as Broadcaster;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ARCADE_AWAIT_SEEN_BEFORE_SPEND;
});

describe("Arcade seen-before-spend gate", () => {
  it("keeps hasSeenOnNetworkGate true when the extra wait is off", () => {
    const broadcaster = new ArcadeBroadcaster(
      {
        url: "http://arcade.test",
        callbackToken: "tok",
        awaitSeenBeforeSpend: false,
        maxBatchSize: 1,
      },
      fallback(),
    );
    expect(broadcaster.hasSeenOnNetworkGate).toBe(true);
  });

  it("treats RECEIVED as success immediately when the flag is off", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      return json([{ txid: TX_A, txStatus: "RECEIVED" }]);
    }));
    const broadcaster = new ArcadeBroadcaster(
      {
        url: "http://arcade.test",
        callbackToken: "tok",
        awaitSeenBeforeSpend: false,
        maxBatchSize: 1,
        seenGateTimeoutMs: 30,
      },
      fallback(),
    );

    const result = await broadcaster.broadcast(fakeTx(TX_A), "ABCDEF");

    expect(result.status).toBe("SEEN_ON_NETWORK");
    expect(calls.some((url) => url.includes(`/tx/${TX_A}`))).toBe(false);
    await broadcaster.closeCallbackReceiver();
  });

  it("waits for SEEN_ON_NETWORK before resolving a RECEIVED 2xx when the flag is on", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes(`/tx/${TX_A}`)) return new Response("", { status: 404 });
      return json([{ txid: TX_A, txStatus: "RECEIVED" }]);
    }));
    const broadcaster = new ArcadeBroadcaster(
      {
        url: "http://arcade.test",
        callbackToken: "tok",
        awaitSeenBeforeSpend: true,
        maxBatchSize: 1,
        seenGateTimeoutMs: 2_000,
      },
      fallback(),
    );

    const pending = broadcaster.broadcast(fakeTx(TX_A), "ABCDEF", { kind: "refill" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    broadcaster.noteStatus(TX_A, "SEEN_ON_NETWORK");
    await expect(pending).resolves.toMatchObject({ status: "SEEN_ON_NETWORK", txid: TX_A });
    await broadcaster.closeCallbackReceiver();
  });

  it("accepts GorillaPool SEEN_MULTIPLE_NODES as the transaction being on the network", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes(`/tx/${TX_A}`)) {
        return json({ txid: TX_A, txStatus: "SEEN_MULTIPLE_NODES" });
      }
      return json([{ txid: TX_A, txStatus: "RECEIVED" }]);
    }));
    const broadcaster = new ArcadeBroadcaster(
      {
        url: "http://arcade.test",
        callbackToken: "tok",
        awaitSeenBeforeSpend: true,
        maxBatchSize: 1,
        seenGateTimeoutMs: 3_000,
      },
      fallback(),
    );

    const result = await broadcaster.broadcast(fakeTx(TX_A), "ABCDEF");
    expect(result).toMatchObject({ status: "SEEN_ON_NETWORK", txid: TX_A });
    await broadcaster.closeCallbackReceiver();
  });

  it("does not resolve success when the seen gate times out", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes(`/tx/${TX_A}`)) return new Response("", { status: 404 });
      return json([{ txid: TX_A, txStatus: "SENT_TO_NETWORK" }]);
    }));
    const broadcaster = new ArcadeBroadcaster(
      {
        url: "http://arcade.test",
        callbackToken: "tok",
        awaitSeenBeforeSpend: true,
        maxBatchSize: 1,
        seenGateTimeoutMs: 40,
      },
      fallback(),
    );

    const result = await broadcaster.broadcast(fakeTx(TX_A), "ABCDEF");
    expect(result).toMatchObject({ status: "FAILED", code: "NOT_SEEN_ON_NETWORK" });
    await broadcaster.closeCallbackReceiver();
  });

  it("reports a double spend seen during the gate as terminal, not as still propagating", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes(`/tx/${TX_A}`)) {
        return json({ txid: TX_A, txStatus: "DOUBLE_SPEND_ATTEMPTED" });
      }
      return json([{ txid: TX_A, txStatus: "RECEIVED" }]);
    }));
    const broadcaster = new ArcadeBroadcaster(
      {
        url: "http://arcade.test",
        callbackToken: "tok",
        awaitSeenBeforeSpend: true,
        maxBatchSize: 1,
        seenGateTimeoutMs: 3_000,
      },
      fallback(),
    );

    const result = await broadcaster.broadcast(fakeTx(TX_A), "ABCDEF");
    expect(result).toMatchObject({ status: "FAILED", code: "DOUBLE_SPEND_ATTEMPTED" });
    expect(isDependencyPendingBroadcastFailure(result)).toBe(false);
    expect(isTransientBroadcastFailure(result)).toBe(false);
    await broadcaster.closeCallbackReceiver();
  });

  it("reports a rejection delivered over SSE during an orphan-mempool wait as terminal", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes(`/tx/${TX_A}`)) return new Response("", { status: 404 });
      return json([{ txid: TX_A, txStatus: "SEEN_IN_ORPHAN_MEMPOOL" }]);
    }));
    const broadcaster = new ArcadeBroadcaster(
      {
        url: "http://arcade.test",
        callbackToken: "tok",
        awaitSeenBeforeSpend: true,
        maxBatchSize: 1,
        seenGateTimeoutMs: 2_000,
      },
      fallback(),
    );

    const pending = broadcaster.broadcast(fakeTx(TX_A), "ABCDEF");
    await new Promise((resolve) => setTimeout(resolve, 30));
    broadcaster.noteStatus(TX_A, "rejected");
    await expect(pending).resolves.toMatchObject({ status: "FAILED", code: "REJECTED" });
    await broadcaster.closeCallbackReceiver();
  });

  it("lets one transaction resolve while another in the same batch is still waiting", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const href = String(url);
      if (href.includes(`/tx/${TX_A}`) || href.includes(`/tx/${TX_B}`)) {
        return new Response("", { status: 404 });
      }
      return json([
        { txid: TX_A, txStatus: "RECEIVED" },
        { txid: TX_B, txStatus: "ACCEPTED_BY_NETWORK" },
      ]);
    }));
    const broadcaster = new ArcadeBroadcaster(
      {
        url: "http://arcade.test",
        callbackToken: "tok",
        awaitSeenBeforeSpend: true,
        maxBatchSize: 2,
        batchWindowMs: 20,
        seenGateTimeoutMs: 2_000,
      },
      fallback(),
    );

    const first = broadcaster.broadcast(fakeTx(TX_A), "ABCDEF");
    const second = broadcaster.broadcast(fakeTx(TX_B), "GHIJKL");
    await new Promise((resolve) => setTimeout(resolve, 50));
    broadcaster.noteStatus(TX_A, "SEEN_ON_NETWORK");
    await expect(first).resolves.toMatchObject({ status: "SEEN_ON_NETWORK" });

    let secondDone = false;
    const watching = second.then(() => {
      secondDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondDone).toBe(false);
    broadcaster.noteStatus(TX_B, "SEEN_ON_NETWORK");
    await watching;
    await broadcaster.closeCallbackReceiver();
  });

  it("still gates an orphan-mempool result when the extra wait is off", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes(`/tx/${TX_A}`)) return new Response("", { status: 404 });
      return json([{ txid: TX_A, txStatus: "SEEN_IN_ORPHAN_MEMPOOL" }]);
    }));
    const broadcaster = new ArcadeBroadcaster(
      {
        url: "http://arcade.test",
        callbackToken: "tok",
        awaitSeenBeforeSpend: false,
        maxBatchSize: 1,
        seenGateTimeoutMs: 40,
      },
      fallback(),
    );

    const result = await broadcaster.broadcast(fakeTx(TX_A), "ABCDEF");
    expect(result).toMatchObject({ status: "FAILED", code: "SEEN_IN_ORPHAN_MEMPOOL" });
    expect(broadcaster.hasSeenOnNetworkGate).toBe(true);
    await broadcaster.closeCallbackReceiver();
  });
});
