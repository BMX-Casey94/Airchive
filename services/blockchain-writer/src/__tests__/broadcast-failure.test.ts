import { describe, expect, it } from "vitest";
import {
  isDependencyPendingBroadcastFailure,
  isTransientBroadcastFailure,
} from "../broadcaster.js";

describe("isTransientBroadcastFailure", () => {
  it("does not treat an explicit REJECTED code as transient when the reason mentions the network", () => {
    expect(isTransientBroadcastFailure({
      status: "FAILED",
      code: "REJECTED",
      description: "TX_MISSING_PARENT: parent not yet seen on the network",
    })).toBe(false);
  });

  it("does not treat DOUBLE_SPEND_ATTEMPTED as transient when the reason mentions a timeout", () => {
    expect(isTransientBroadcastFailure({
      status: "FAILED",
      code: "DOUBLE_SPEND_ATTEMPTED",
      description: "timeout waiting for the competing transaction",
    })).toBe(false);
  });

  it("does not treat a description that is itself the REJECTED status as transient", () => {
    expect(isTransientBroadcastFailure({
      status: "FAILED",
      code: "34",
      description: "REJECTED: missing parent on the network",
    })).toBe(false);
  });

  it("still treats transport failures as transient", () => {
    expect(isTransientBroadcastFailure({
      status: "FAILED",
      code: "503",
      description: "upstream unavailable",
    })).toBe(true);
    expect(isTransientBroadcastFailure({
      status: "FAILED",
      code: "429",
      description: "slow down",
    })).toBe(true);
    expect(isTransientBroadcastFailure({
      status: "FAILED",
      description: "fetch failed",
    })).toBe(true);
    expect(isTransientBroadcastFailure({
      status: "FAILED",
      description: "socket hang up",
    })).toBe(true);
    expect(isTransientBroadcastFailure({
      status: "FAILED",
      description: "connection reset by peer",
    })).toBe(true);
    expect(isTransientBroadcastFailure({
      status: "FAILED",
      description: "i/o timeout",
    })).toBe(true);
    expect(isTransientBroadcastFailure({
      status: "FAILED",
      description: "NetworkError when attempting to fetch resource",
    })).toBe(true);
  });

  it("does not treat a rejection reason that merely contains the word network as a transport failure", () => {
    expect(isTransientBroadcastFailure({
      status: "FAILED",
      code: "TX_MISSING_PARENT",
      description: "parent not yet seen on the network",
    })).toBe(false);
  });

  it("does not treat the seen-gate timeout as a transport failure", () => {
    expect(isTransientBroadcastFailure({
      status: "FAILED",
      code: "NOT_SEEN_ON_NETWORK",
      description: "Transaction was not seen on the network before the spend gate timed out",
    })).toBe(false);
    expect(isDependencyPendingBroadcastFailure({
      status: "FAILED",
      code: "NOT_SEEN_ON_NETWORK",
    })).toBe(true);
  });

  it("leaves orphan-mempool and successful outcomes non-transient", () => {
    expect(isTransientBroadcastFailure({
      status: "FAILED",
      code: "SEEN_IN_ORPHAN_MEMPOOL",
      description: "network",
    })).toBe(false);
    expect(isTransientBroadcastFailure({
      status: "SEEN_ON_NETWORK",
      description: "timeout",
    })).toBe(false);
  });
});
