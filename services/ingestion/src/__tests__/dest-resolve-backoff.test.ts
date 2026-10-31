import { describe, expect, it } from "vitest";

import { DEST_RESOLVE_BACKOFF_MS, DestResolveBackoff } from "../dest-resolve-backoff.js";

describe("DestResolveBackoff", () => {
  it("logs the first failure and skips retries until the backoff elapses", () => {
    let now = 1_000_000;
    const backoff = new DestResolveBackoff(DEST_RESOLVE_BACKOFF_MS, () => now);

    expect(backoff.shouldSkip("session-1")).toBe(false);
    expect(backoff.recordFailure("session-1")).toBe(true);
    expect(backoff.shouldSkip("session-1")).toBe(true);

    now += DEST_RESOLVE_BACKOFF_MS - 1;
    expect(backoff.shouldSkip("session-1")).toBe(true);

    now += 1;
    expect(backoff.shouldSkip("session-1")).toBe(false);
    expect(backoff.recordFailure("session-1")).toBe(false);
    expect(backoff.shouldSkip("session-1")).toBe(true);
  });

  it("tracks sessions independently and allows a new warning after clear", () => {
    let now = 5_000;
    const backoff = new DestResolveBackoff(DEST_RESOLVE_BACKOFF_MS, () => now);

    expect(backoff.recordFailure("session-1")).toBe(true);
    expect(backoff.shouldSkip("session-2")).toBe(false);
    expect(backoff.recordFailure("session-2")).toBe(true);

    backoff.clear("session-1");
    expect(backoff.shouldSkip("session-1")).toBe(false);
    expect(backoff.recordFailure("session-1")).toBe(true);
    expect(backoff.shouldSkip("session-2")).toBe(true);

    now += DEST_RESOLVE_BACKOFF_MS;
    expect(backoff.shouldSkip("session-2")).toBe(false);
  });
});
