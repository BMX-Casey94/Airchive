import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpendGovernor, type SpendGuardConfig } from "../spend-governor.js";

function config(overrides: Partial<SpendGuardConfig> = {}): SpendGuardConfig {
  return {
    paused: false,
    windowMs: 60_000,
    minSamples: 10,
    cautiousRatio: 0.1,
    haltRatio: 0.25,
    haltCooldownMs: 300_000,
    maxUnconfirmedChainDepth: 5,
    cautiousUnconfirmedChainDepth: 2,
    maxRejectRequeues: 3,
    ...overrides,
  };
}

function observe(
  governor: SpendGovernor,
  accepted: number,
  rejected: number,
): void {
  for (let i = 0; i < accepted; i++) governor.noteBroadcastAccepted();
  for (let i = 0; i < rejected; i++) governor.noteTerminalRejection();
}

describe("SpendGovernor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays normal while the sample is too small to be meaningful", () => {
    const governor = new SpendGovernor(config());
    // Every observation is a rejection, but there are too few to act on.
    observe(governor, 0, 5);

    expect(governor.getPosture()).toBe("NORMAL");
    expect(governor.allowsBroadcast()).toBe(true);
    expect(governor.maxRejectRequeues()).toBe(3);
    expect(governor.maxUnconfirmedChainDepth()).toBe(5);
  });

  it("becomes cautious once rejections pass the warning share", () => {
    const governor = new SpendGovernor(config());
    observe(governor, 17, 3);

    expect(governor.getPosture()).toBe("CAUTIOUS");
    expect(governor.allowsBroadcast()).toBe(true);
    // Conservative spending: shallow outputs only, one rebuild per payload.
    expect(governor.maxUnconfirmedChainDepth()).toBe(2);
    expect(governor.maxRejectRequeues()).toBe(1);
  });

  it("halts spending, including treasury movement, once rejections dominate", () => {
    const governor = new SpendGovernor(config());
    observe(governor, 6, 6);

    expect(governor.getPosture()).toBe("HALTED");
    expect(governor.allowsBroadcast()).toBe(false);
    expect(governor.allowsTreasurySpend()).toBe(false);
    // A halted writer must not pay to rebuild rejected payloads either.
    expect(governor.maxRejectRequeues()).toBe(0);
  });

  it("holds the halt for the cooldown, then reopens on fresh evidence", () => {
    const governor = new SpendGovernor(config({ haltCooldownMs: 60_000 }));
    observe(governor, 6, 6);
    expect(governor.getPosture()).toBe("HALTED");

    vi.advanceTimersByTime(59_000);
    expect(governor.getPosture()).toBe("HALTED");

    vi.advanceTimersByTime(2_000);
    // The window was cleared when the halt tripped, so the same burst cannot
    // re-trip it and the writer gets a genuine chance to prove itself.
    expect(governor.getPosture()).toBe("NORMAL");
  });

  it("forgets observations that fall outside the window", () => {
    const governor = new SpendGovernor(config({ windowMs: 10_000 }));
    observe(governor, 0, 6);

    vi.advanceTimersByTime(11_000);
    observe(governor, 12, 0);

    expect(governor.getPosture()).toBe("NORMAL");
    expect(governor.getSnapshot().rejected).toBe(0);
  });

  it("pins the posture to halted while the operator kill switch is set", () => {
    const governor = new SpendGovernor(config({ paused: true }));
    observe(governor, 500, 0);

    expect(governor.isPaused()).toBe(true);
    expect(governor.getPosture()).toBe("HALTED");
    expect(governor.allowsBroadcast()).toBe(false);

    // No amount of clean traffic or elapsed time clears a manual pause.
    vi.advanceTimersByTime(24 * 60 * 60 * 1_000);
    expect(governor.getPosture()).toBe("HALTED");
  });

  it("reports the evidence behind its verdict", () => {
    const governor = new SpendGovernor(config());
    observe(governor, 18, 2);

    const snapshot = governor.getSnapshot();
    expect(snapshot).toMatchObject({
      posture: "CAUTIOUS",
      accepted: 18,
      rejected: 2,
      paused: false,
      maxUnconfirmedChainDepth: 2,
      maxRejectRequeues: 1,
    });
    expect(snapshot.rejectRatio).toBeCloseTo(0.1);
  });
});
