import type { Transaction } from "@bsv/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isLocalBackpressureBroadcastFailure,
  isUnsentBroadcastError,
  type BroadcastOutcome,
  type Broadcaster,
} from "../broadcaster.js";
import { GovernedBroadcaster } from "../governed-broadcaster.js";
import { SpendGovernor, type SpendGuardConfig } from "../spend-governor.js";

function config(overrides: Partial<SpendGuardConfig> = {}): SpendGuardConfig {
  return {
    paused: false,
    windowMs: 60_000,
    minSamples: 10,
    cautiousRatio: 0.1,
    haltRatio: 0.25,
    haltCooldownMs: 60_000,
    haltCooldownMaxMs: 600_000,
    probeBudget: 2,
    probeSettleMs: 10_000,
    maxUnconfirmedChainDepth: 5,
    cautiousUnconfirmedChainDepth: 2,
    maxRejectRequeues: 3,
    ...overrides,
  };
}

function fakeUpstream(): Broadcaster & { calls: number } {
  const upstream = {
    calls: 0,
    async broadcast(): Promise<BroadcastOutcome> {
      upstream.calls++;
      return { txid: "a".repeat(64), status: "SEEN_ON_NETWORK" };
    },
    getState: () => ({
      inFlight: 0,
      queueDepth: 0,
      circuitOpen: false,
      circuitOpenRemainingMs: 0,
    }),
    getLimits: () => ({ maxConcurrentBroadcasts: 4, maxQueueDepth: 100 }),
    isDegraded: () => false,
    setupCallbackReceiver: () => {},
    closeCallbackReceiver: async () => {},
    on() {
      return upstream;
    },
  } as unknown as Broadcaster & { calls: number };
  return upstream;
}

const TX = {} as Transaction;

describe("GovernedBroadcaster", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends nothing upstream while spending is halted", async () => {
    const upstream = fakeUpstream();
    const governor = new SpendGovernor(config({ paused: true }));
    const gate = new GovernedBroadcaster(upstream, governor);

    const result = await gate.broadcast(TX, "ABC123", { kind: "telemetry" });

    expect(upstream.calls).toBe(0);
    expect(result.status).toBe("FAILED");
    expect(result.code).toBe("SPEND_HALTED");
  });

  it("reports a refusal as local backpressure so the input is not purged", async () => {
    const upstream = fakeUpstream();
    const governor = new SpendGovernor(config({ paused: true }));
    const gate = new GovernedBroadcaster(upstream, governor);

    const result = await gate.broadcast(TX, "ABC123", { kind: "telemetry" });

    // A refusal is the writer declining to send, not the network refusing the
    // transaction. Classifying it as a network failure would delete a perfectly
    // good UTXO and burn the sample as an archive gap.
    expect(isLocalBackpressureBroadcastFailure(result)).toBe(true);
    expect(
      isUnsentBroadcastError(new Error(`Broadcast local backpressure: ${result.code}`)),
    ).toBe(true);
  });

  it("closes the paths that never asked the governor themselves", async () => {
    const upstream = fakeUpstream();
    const governor = new SpendGovernor(config({ paused: true }));
    const gate = new GovernedBroadcaster(upstream, governor);

    // Consolidation and treasury reshaping are not archive writes, so they had
    // no spend check of their own and kept paying fees straight through a halt.
    for (const kind of ["consolidation", "refill", "retry", "tx"] as const) {
      const result = await gate.broadcast(TX, undefined, { kind });
      expect(result.code).toBe("SPEND_HALTED");
    }
    expect(upstream.calls).toBe(0);
  });

  it("spends a trial's allowance and then stops, whatever the transaction is for", async () => {
    const upstream = fakeUpstream();
    const governor = new SpendGovernor(config({ probeBudget: 2 }));
    const gate = new GovernedBroadcaster(upstream, governor);

    for (let i = 0; i < 6; i++) governor.noteBroadcastAccepted();
    for (let i = 0; i < 6; i++) governor.noteTerminalRejection();
    expect(governor.getPosture()).toBe("HALTED");

    vi.advanceTimersByTime(61_000);
    expect(governor.getPosture()).toBe("PROBING");

    // A refill counts against the allowance exactly like a telemetry write, so a
    // recovery cannot spend the treasury on pool maintenance while it is meant
    // to be testing the water with a couple of transactions.
    expect((await gate.broadcast(TX, undefined, { kind: "refill" })).status)
      .toBe("SEEN_ON_NETWORK");
    expect((await gate.broadcast(TX, "ABC123", { kind: "telemetry" })).status)
      .toBe("SEEN_ON_NETWORK");
    expect(upstream.calls).toBe(2);

    const third = await gate.broadcast(TX, "ABC123", { kind: "telemetry" });
    expect(third.code).toBe("SPEND_HALTED");
    expect(upstream.calls).toBe(2);
  });

  it("delegates state and callback wiring to the upstream", () => {
    const upstream = fakeUpstream();
    const governor = new SpendGovernor(config({ paused: true }));
    const gate = new GovernedBroadcaster(upstream, governor);

    expect(gate.getLimits()).toEqual({ maxConcurrentBroadcasts: 4, maxQueueDepth: 100 });
    expect(gate.isDegraded()).toBe(false);
    expect(gate.getState().circuitOpen).toBe(false);
    expect(gate.on("status-update", () => {})).toBe(gate);
  });
});
