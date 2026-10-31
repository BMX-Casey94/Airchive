import { afterEach, describe, expect, it } from "vitest";
import {
  FundingChainDepth,
  RecentSpendLedger,
  chainPropagationCooldownMs,
  fundingMaxUnconfirmedChainDepth,
  fundingPropagationCooldownMs,
  reconcileRecentGuardMs,
  refillPropagationCooldownMs,
  shouldAwaitSeenBeforeSpend,
  shouldRetainLocalDuringReconcile,
  shouldSuppressChainReinsert,
} from "../live-path-policy.js";

const ENV_KEYS = [
  "CHAIN_PROPAGATION_COOLDOWN_MS",
  "REFILL_PROPAGATION_COOLDOWN_MS",
  "FUNDING_PROPAGATION_COOLDOWN_MS",
  "RECONCILE_RECENT_OUTPUT_GUARD_MS",
  "FUNDING_MAX_UNCONFIRMED_CHAIN_DEPTH",
  "ARCADE_AWAIT_SEEN_BEFORE_SPEND",
];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("propagation cooldown defaults", () => {
  it("keeps today's defaults when the environment is unset", () => {
    expect(chainPropagationCooldownMs()).toBe(0);
    expect(refillPropagationCooldownMs()).toBe(500);
    expect(fundingPropagationCooldownMs()).toBe(500);
    expect(reconcileRecentGuardMs()).toBe(30_000);
    expect(fundingMaxUnconfirmedChainDepth()).toBe(4);
  });

  it("reads operator overrides and ignores garbage", () => {
    process.env.CHAIN_PROPAGATION_COOLDOWN_MS = "2000";
    process.env.REFILL_PROPAGATION_COOLDOWN_MS = "2000";
    process.env.FUNDING_PROPAGATION_COOLDOWN_MS = "2000";
    expect(chainPropagationCooldownMs()).toBe(2000);
    expect(refillPropagationCooldownMs()).toBe(2000);
    expect(fundingPropagationCooldownMs()).toBe(2000);

    process.env.CHAIN_PROPAGATION_COOLDOWN_MS = "nope";
    expect(chainPropagationCooldownMs()).toBe(0);
  });
});

describe("reconcile guard", () => {
  const now = 1_000_000;

  it("keeps a local output created inside the window", () => {
    expect(shouldRetainLocalDuringReconcile({
      nowMs: now,
      guardMs: 30_000,
      createdAtMs: now - 29_000,
      spentAtMs: null,
      creatingBroadcastAtMs: null,
    })).toBe(true);
  });

  it("keeps a local output whose spending transaction was broadcast inside the window", () => {
    expect(shouldRetainLocalDuringReconcile({
      nowMs: now,
      guardMs: 30_000,
      createdAtMs: now - 120_000,
      spentAtMs: now - 1_000,
      creatingBroadcastAtMs: null,
    })).toBe(true);
    expect(shouldRetainLocalDuringReconcile({
      nowMs: now,
      guardMs: 30_000,
      createdAtMs: now - 120_000,
      spentAtMs: null,
      creatingBroadcastAtMs: now - 1_000,
    })).toBe(true);
  });

  it("allows deletion once the window has passed", () => {
    expect(shouldRetainLocalDuringReconcile({
      nowMs: now,
      guardMs: 30_000,
      createdAtMs: now - 30_001,
      spentAtMs: now - 30_001,
      creatingBroadcastAtMs: now - 30_001,
    })).toBe(false);
  });

  it("does not resurrect an outpoint spent inside the window", () => {
    expect(shouldSuppressChainReinsert({
      nowMs: now,
      guardMs: 30_000,
      spentAtMs: now - 5_000,
    })).toBe(true);
    expect(shouldSuppressChainReinsert({
      nowMs: now,
      guardMs: 30_000,
      spentAtMs: now - 31_000,
    })).toBe(false);
  });

  it("drops the oldest ledger entries once the bound is reached", () => {
    const ledger = new RecentSpendLedger();
    for (let i = 0; i < 8_193; i++) {
      ledger.noteSpent(i.toString(16).padStart(64, "0"), 0, i);
    }
    expect(ledger.spentAtIfFresh("0".repeat(64), 0, 8_193, 1_000_000)).toBeNull();
    expect(ledger.spentAtIfFresh(
      (8192).toString(16).padStart(64, "0"),
      0,
      8_192,
      30_000,
    )).toBe(8192);
  });
});

describe("funding chain depth", () => {
  it("refuses a spend only once depth exceeds the cap and clears on confirmation", () => {
    const depth = new FundingChainDepth(() => 4);
    const txid = "aa".repeat(32);
    depth.noteUnconfirmed(txid, 0, 4);
    expect(depth.exceedsCap(txid, 0)).toBe(false);
    depth.noteUnconfirmed(txid, 0, 5);
    expect(depth.exceedsCap(txid, 0)).toBe(true);
    depth.confirm(txid, 0);
    expect(depth.exceedsCap(txid, 0)).toBe(false);
    expect(depth.isConfirmed(txid, 0)).toBe(true);
    expect(depth.depthOf(txid, 0)).toBe(0);
  });
});

describe("shouldAwaitSeenBeforeSpend", () => {
  it("is off unless the operator enables it", () => {
    expect(shouldAwaitSeenBeforeSpend({
      enabled: false,
      httpStatus: 200,
      txStatus: "RECEIVED",
    })).toBe(false);
  });

  it("waits for intermediate and silent 2xx statuses only", () => {
    for (const txStatus of ["RECEIVED", "SENT_TO_NETWORK", "ACCEPTED_BY_NETWORK", "", null]) {
      expect(shouldAwaitSeenBeforeSpend({ enabled: true, httpStatus: 200, txStatus })).toBe(true);
    }
    expect(shouldAwaitSeenBeforeSpend({
      enabled: true,
      httpStatus: 200,
      txStatus: "SEEN_ON_NETWORK",
    })).toBe(false);
    expect(shouldAwaitSeenBeforeSpend({
      enabled: true,
      httpStatus: 200,
      txStatus: "MINED",
    })).toBe(false);
    expect(shouldAwaitSeenBeforeSpend({
      enabled: true,
      httpStatus: 400,
      txStatus: "RECEIVED",
    })).toBe(false);
  });
});
