import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrivateKey } from "@bsv/sdk";
import type { Knex } from "knex";
import type { FundingStateName, FundingStateRow, FundingStateUpdate } from "@airchive/db";
import type { Config } from "../config.js";
import type { Broadcaster } from "../broadcaster.js";
import type { AutoRefillMonitor } from "../auto-refill.js";
import { estimateRefillFee } from "../tx-builder.js";

const mocks = vi.hoisted(() => ({
  getFundingState: vi.fn(),
  upsertFundingState: vi.fn(),
  insertAlert: vi.fn(),
  getPreservedWriteCount: vi.fn(),
  getFundingUtxoBalance: vi.fn(),
  getFundingUtxoCount: vi.fn(),
}));

vi.mock("@airchive/db", () => ({
  TREASURY_SCOPE: "TREASURY",
  getFundingState: mocks.getFundingState,
  upsertFundingState: mocks.upsertFundingState,
  insertAlert: mocks.insertAlert,
  getPreservedWriteCount: mocks.getPreservedWriteCount,
  getFundingUtxoBalance: mocks.getFundingUtxoBalance,
  getFundingUtxoCount: mocks.getFundingUtxoCount,
}));

import { FundingStateMachine } from "../funding-state.js";
import { FundingUtxoManager, splitFeeWithinBudget } from "../funding-utxo-manager.js";

// Fixed scalar. This key has no funds and no relationship to any deployed wallet.
const fundingKey = new PrivateKey(
  "0000000000000000000000000000000000000000000000000000000000000001",
  16,
);
const fundingWif = fundingKey.toWif();

const SPLIT_TARGET = 256;
const SPLIT_MAX_COST_SATS = 50_000;
const HEALTHY_BALANCE = 100_000_000;

function fundingRow(
  state: FundingStateName,
  details: Record<string, unknown> = {},
): FundingStateRow {
  return {
    scope: "TREASURY",
    state,
    balance_sats: HEALTHY_BALANCE,
    utxo_count: 3,
    state_since: new Date("2026-08-05T00:00:00Z"),
    last_checked_at: new Date("2026-08-05T00:00:00Z"),
    last_alert_at: null,
    next_poll_at: null,
    consecutive_dry_polls: 0,
    burn_sats_per_hour: 0,
    details,
    updated_at: new Date("2026-08-05T00:00:00Z"),
  };
}

function testConfig(overrides: Partial<Config["funding"]> = {}): Config {
  return {
    fundingWalletWif: fundingWif,
    refillAmountSats: 320_000,
    refillMaxOutputsPerTx: 40,
    fundingPoolSplitTarget: SPLIT_TARGET,
    funding: {
      checkIntervalMs: 60_000,
      lowWatermarkRefills: 20,
      dryPollBaseMs: 30_000,
      dryPollMaxMs: 600_000,
      alertRepeatMs: 3_600_000,
      recoveryDrainBatchSize: 25,
      recoveryStepAttempts: 3,
      recoveryStepTimeoutMs: 1_000,
      splitMaxCostSats: SPLIT_MAX_COST_SATS,
      ...overrides,
    },
  } as Config;
}

function pendingDb(pending: number): Knex {
  const api = {
    count() {
      return api;
    },
    async first() {
      return { count: pending };
    },
  };
  return ((table: string) => {
    if (table !== "pending_writes") throw new Error(`unexpected table ${table}`);
    return api;
  }) as unknown as Knex;
}

function persistedUpdates(): FundingStateUpdate[] {
  return mocks.upsertFundingState.mock.calls.map((call) => call[2] as FundingStateUpdate);
}

function lastState(): FundingStateName | undefined {
  return persistedUpdates().at(-1)?.state;
}

describe("FundingStateMachine recovery", () => {
  let machine: FundingStateMachine;
  let reconcile: ReturnType<typeof vi.fn>;
  let consolidate: ReturnType<typeof vi.fn>;
  let split: ReturnType<typeof vi.fn>;
  let checkAll: ReturnType<typeof vi.fn>;
  let retry: ReturnType<typeof vi.fn>;

  function build(preserved: number, pending = preserved): void {
    mocks.getFundingState.mockResolvedValue(fundingRow("RECOVERING"));
    mocks.getPreservedWriteCount.mockResolvedValue(preserved);
    mocks.upsertFundingState.mockResolvedValue(undefined);
    mocks.insertAlert.mockResolvedValue(undefined);

    reconcile = vi.fn(async () => true);
    consolidate = vi.fn(async () => 0);
    split = vi.fn(async () => 0);
    checkAll = vi.fn(async () => undefined);
    retry = vi.fn(() => new Promise<number>(() => {}));

    const fundingUtxos = {
      getBalance: vi.fn(async () => ({ balance: HEALTHY_BALANCE, count: 3 })),
      reconcile,
      consolidateIfFragmented: consolidate,
      splitIfNeeded: split,
    } as unknown as FundingUtxoManager;

    const autoRefill = {
      checkAll,
      resetTreasuryBackoff: vi.fn(),
      getDryAircraftCount: () => 0,
    } as unknown as AutoRefillMonitor;

    machine = new FundingStateMachine(
      pendingDb(pending),
      testConfig(),
      fundingUtxos,
      autoRefill,
      {} as Broadcaster,
      null,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    build(0);
  });

  afterEach(() => {
    machine?.stop();
  });

  it("resumes recovery when startup finds a persisted RECOVERING state", async () => {
    await machine.start();

    await vi.waitFor(() => {
      expect(split).toHaveBeenCalled();
      expect(lastState()).toBe("HEALTHY");
    });

    expect(machine.isRecovering()).toBe(false);
    expect(reconcile).toHaveBeenCalled();
    expect(consolidate).toHaveBeenCalled();
    expect(checkAll).toHaveBeenCalled();
    expect(split.mock.calls[0]?.[2]).toBe(SPLIT_TARGET);
    expect(split.mock.calls[0]?.[4]).toBe(SPLIT_MAX_COST_SATS);
    expect(retry).not.toHaveBeenCalled();
  });

  it("does not stay in RECOVERING when a recovery step keeps failing", async () => {
    reconcile.mockRejectedValue(new Error("chain unavailable"));

    await machine.start();

    await vi.waitFor(() => {
      expect(lastState()).toBe("HEALTHY");
    });

    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(split).toHaveBeenCalledTimes(1);
    expect(machine.isRecovering()).toBe(false);
  });

  it("abandons a hanging recovery step instead of pinning RECOVERING", async () => {
    split.mockImplementation(() => new Promise(() => {}));

    await machine.start();

    await vi.waitFor(() => {
      expect(lastState()).toBe("HEALTHY");
    }, { timeout: 3_000 });

    // A timed-out spend is still in flight, so it must not be launched again.
    expect(split).toHaveBeenCalledTimes(1);
    expect(checkAll).not.toHaveBeenCalled();
    expect(machine.isRecovering()).toBe(false);
  });

  it("leaves RECOVERING without draining a huge backlog and keeps prune protection", async () => {
    build(940_000);

    await machine.start();

    await vi.waitFor(() => {
      expect(lastState()).toBe("HEALTHY");
    });

    expect(retry).not.toHaveBeenCalled();
    expect(machine.isRecovering()).toBe(false);
    expect(machine.pausesBacklogMaintenance()).toBe(true);
    expect(machine.snapshot()?.backlogShield).toBe(true);
    expect(persistedUpdates().some((update) => update.details?.backlogShield === true)).toBe(true);
  });
});

describe("treasury split fee ceiling", () => {
  it("treats the ceiling as a hard stop on further split fees", () => {
    const oneSplitFee = estimateRefillFee(40, false, 1);
    expect(oneSplitFee).toBeGreaterThan(1);
    expect(splitFeeWithinBudget(0, oneSplitFee, 1)).toBe(false);
    expect(splitFeeWithinBudget(0, oneSplitFee * 20, SPLIT_MAX_COST_SATS)).toBe(true);
    expect(splitFeeWithinBudget(SPLIT_MAX_COST_SATS, oneSplitFee, SPLIT_MAX_COST_SATS)).toBe(false);
    expect(splitFeeWithinBudget(0, oneSplitFee, Number.POSITIVE_INFINITY)).toBe(true);
  });

  it("does not broadcast a split once the fee ceiling is exhausted", async () => {
    mocks.getFundingUtxoCount.mockResolvedValue(3);
    mocks.getFundingUtxoBalance.mockResolvedValue(HEALTHY_BALANCE);
    const broadcast = vi.fn();
    const transaction = vi.fn(async () => {
      throw new Error("split tried to lock a treasury output");
    });
    const manager = new FundingUtxoManager(
      { transaction } as unknown as Knex,
      {} as never,
    );

    const created = await manager.splitIfNeeded(
      fundingWif,
      { broadcast } as unknown as Broadcaster,
      SPLIT_TARGET,
      100_000,
      1,
    );

    expect(created).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
