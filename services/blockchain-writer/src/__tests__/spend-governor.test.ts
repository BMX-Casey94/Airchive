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
    haltCooldownMaxMs: 3_600_000,
    probeBudget: 5,
    probeSettleMs: 10_000,
    maxUnconfirmedChainDepth: 5,
    cautiousUnconfirmedChainDepth: 2,
    maxRejectRequeues: 3,
    ...overrides,
  };
}

/** Spends a trial's allowance the way the broadcast gate would. */
function dispatch(governor: SpendGovernor, count: number): void {
  for (let i = 0; i < count; i++) governor.noteBroadcastDispatched();
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

  it("holds the halt for the cooldown, then reopens as a capped trial", () => {
    const governor = new SpendGovernor(config({ haltCooldownMs: 60_000 }));
    observe(governor, 6, 6);
    expect(governor.getPosture()).toBe("HALTED");

    vi.advanceTimersByTime(59_000);
    expect(governor.getPosture()).toBe("HALTED");

    vi.advanceTimersByTime(2_000);
    // Reopening at full rate would spend through the blind spot before the
    // first rejection is reported, so recovery buys evidence a little at a time.
    expect(governor.getPosture()).toBe("PROBING");
    expect(governor.allowsBroadcast()).toBe(true);
    expect(governor.maxRejectRequeues()).toBe(0);
  });

  it("ignores rejections that arrive after spending has already stopped", () => {
    const governor = new SpendGovernor(config({ haltCooldownMs: 60_000 }));
    observe(governor, 6, 6);
    expect(governor.getPosture()).toBe("HALTED");

    // Verdicts on transactions broadcast before the halt keep streaming in for
    // minutes. They say nothing about the present, and counting them would hold
    // the window at a 100% reject rate with nothing accepted to offset it, so
    // the cooldown would expire straight back into a halt for ever.
    observe(governor, 0, 200);

    const snapshot = governor.getSnapshot();
    expect(snapshot.rejected).toBe(0);
    expect(snapshot.staleRejectsWhileHalted).toBe(200);

    vi.advanceTimersByTime(61_000);
    expect(governor.getPosture()).toBe("PROBING");
  });

  it("stops the trial once its allowance is spent and waits for the verdict", () => {
    const governor = new SpendGovernor(
      config({ haltCooldownMs: 60_000, probeBudget: 5, probeSettleMs: 10_000 }),
    );
    observe(governor, 6, 6);
    expect(governor.getPosture()).toBe("HALTED");
    vi.advanceTimersByTime(61_000);
    expect(governor.getPosture()).toBe("PROBING");

    dispatch(governor, 5);
    // Acceptance is reported immediately and rejection is not, so the trial must
    // stop spending and listen rather than read the silence as success.
    expect(governor.allowsBroadcast()).toBe(false);
    expect(governor.allowsTreasurySpend()).toBe(false);
    expect(governor.getSnapshot().probe).toMatchObject({ spent: 5, budget: 5, settling: true });

    vi.advanceTimersByTime(11_000);
    expect(governor.getPosture()).toBe("NORMAL");
    expect(governor.getSnapshot().consecutiveHalts).toBe(0);
  });

  it("re-halts on a single rejection during a trial and doubles the wait", () => {
    const governor = new SpendGovernor(
      config({ haltCooldownMs: 60_000, haltCooldownMaxMs: 1_000_000 }),
    );
    observe(governor, 6, 6);
    expect(governor.getSnapshot().lastHaltCooldownMs).toBe(60_000);

    vi.advanceTimersByTime(61_000);
    expect(governor.getPosture()).toBe("PROBING");

    // The trial exists to find one rejection cheaply, so one is decisive.
    governor.noteTerminalRejection();
    expect(governor.getPosture()).toBe("HALTED");
    expect(governor.getSnapshot().lastHaltCooldownMs).toBe(120_000);

    vi.advanceTimersByTime(61_000);
    expect(governor.getPosture()).toBe("HALTED");
    vi.advanceTimersByTime(61_000);
    expect(governor.getPosture()).toBe("PROBING");
  });

  it("caps the escalating cooldown so a broken upstream is retried eventually", () => {
    const governor = new SpendGovernor(
      config({ haltCooldownMs: 60_000, haltCooldownMaxMs: 200_000 }),
    );
    observe(governor, 6, 6);
    expect(governor.getPosture()).toBe("HALTED");

    for (let round = 0; round < 6; round++) {
      vi.advanceTimersByTime(300_000);
      expect(governor.getPosture()).toBe("PROBING");
      governor.noteTerminalRejection();
      expect(governor.getPosture()).toBe("HALTED");
    }

    expect(governor.getSnapshot().lastHaltCooldownMs).toBe(200_000);
  });

  it("concludes a trial the fleet was too quiet to spend", () => {
    const governor = new SpendGovernor(
      config({ haltCooldownMs: 60_000, probeBudget: 50, probeSettleMs: 10_000 }),
    );
    observe(governor, 6, 6);
    expect(governor.getPosture()).toBe("HALTED");
    vi.advanceTimersByTime(61_000);
    expect(governor.getPosture()).toBe("PROBING");

    // Nothing to broadcast, so the allowance is never spent. The trial must
    // still finish rather than leaving the writer parked in PROBING for ever.
    vi.advanceTimersByTime(31_000);
    expect(governor.getPosture()).toBe("PROBING");
    vi.advanceTimersByTime(11_000);
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

  it("does not re-halt a trial on a rejection broadcast before the trial started", () => {
    const governor = new SpendGovernor(
      config({ haltCooldownMs: 60_000, haltCooldownMaxMs: 1_000_000 }),
    );
    observe(governor, 6, 6);
    expect(governor.getPosture()).toBe("HALTED");

    vi.advanceTimersByTime(61_000);
    expect(governor.getPosture()).toBe("PROBING");
    const startedAt = Date.now();

    // A terminal status for a transaction paid for before this trial says
    // nothing about whether the network is accepting the trial's broadcasts.
    governor.noteTerminalRejection(startedAt - 1);

    expect(governor.getPosture()).toBe("PROBING");
    expect(governor.allowsBroadcast()).toBe(true);
    const snapshot = governor.getSnapshot();
    expect(snapshot.probe).toMatchObject({ rejected: 0 });
    expect(snapshot.rejected).toBe(0);
    expect(snapshot.lastHaltReason).toBe("reject_ratio");
    expect(snapshot.lastHaltCooldownMs).toBe(60_000);
    expect(snapshot.staleRejectsWhileHalted).toBe(1);
  });

  it("re-halts a trial when a transaction broadcast during the trial is rejected", () => {
    const governor = new SpendGovernor(
      config({ haltCooldownMs: 60_000, haltCooldownMaxMs: 1_000_000 }),
    );
    observe(governor, 6, 6);
    expect(governor.getPosture()).toBe("HALTED");

    vi.advanceTimersByTime(61_000);
    expect(governor.getPosture()).toBe("PROBING");
    const startedAt = Date.now();

    // Broadcast at the opening instant of the trial still belongs to it.
    governor.noteTerminalRejection(startedAt);

    expect(governor.getPosture()).toBe("HALTED");
    expect(governor.getSnapshot().lastHaltReason).toBe("probe_rejected");
    expect(governor.getSnapshot().lastHaltCooldownMs).toBe(120_000);
  });

  it("excludes a rejection broadcast before the evidence window from the ratio", () => {
    const windowMs = 120_000;
    const governor = new SpendGovernor(config({ windowMs, minSamples: 10 }));
    observe(governor, 10, 0);

    // Ten old rejections would be half the window if they were counted, which
    // is enough to halt. They describe broadcasts from before this window.
    for (let i = 0; i < 10; i++) {
      governor.noteTerminalRejection(Date.now() - windowMs - 1);
    }

    const snapshot = governor.getSnapshot();
    expect(snapshot.posture).toBe("NORMAL");
    expect(snapshot.accepted).toBe(10);
    expect(snapshot.rejected).toBe(0);
    expect(snapshot.rejectRatio).toBe(0);
    expect(snapshot.staleRejectsWhileHalted).toBe(10);
    expect(governor.allowsBroadcast()).toBe(true);
    expect(governor.maxRejectRequeues()).toBe(3);
  });

  it("counts a rejection broadcast inside the evidence window", () => {
    const windowMs = 120_000;
    const governor = new SpendGovernor(config({ windowMs, minSamples: 10 }));
    observe(governor, 18, 0);

    // The opening instant of the window is still inside it. One millisecond
    // earlier is the case excluded above. Two counted rejections are exactly
    // the cautious share; a halt would wipe the window and hide the count.
    governor.noteTerminalRejection(Date.now() - windowMs);
    governor.noteTerminalRejection(Date.now() - 1_000);

    const snapshot = governor.getSnapshot();
    expect(snapshot.rejected).toBe(2);
    expect(snapshot.accepted).toBe(18);
    expect(snapshot.rejectRatio).toBeCloseTo(0.1);
    expect(snapshot.posture).toBe("CAUTIOUS");
    expect(snapshot.staleRejectsWhileHalted).toBe(0);
    expect(governor.maxRejectRequeues()).toBe(1);
  });

  it("counts a rejection with an unknown broadcast time as current", () => {
    const governor = new SpendGovernor(
      config({ haltCooldownMs: 60_000, windowMs: 120_000, minSamples: 10 }),
    );
    observe(governor, 10, 0);

    for (let i = 0; i < 10; i++) governor.noteTerminalRejection(null);
    expect(governor.getSnapshot().staleRejectsWhileHalted).toBe(0);
    expect(governor.getPosture()).toBe("HALTED");

    vi.advanceTimersByTime(61_000);
    expect(governor.getPosture()).toBe("PROBING");

    governor.noteTerminalRejection(null);

    expect(governor.getPosture()).toBe("HALTED");
  });
});
