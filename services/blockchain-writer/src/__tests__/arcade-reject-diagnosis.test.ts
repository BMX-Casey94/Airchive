import { describe, expect, it } from "vitest";
import {
  extractArcadeRejectDiagnosis,
  isArcadeTxNotFound,
} from "../arcade-reject-diagnosis.js";

describe("extractArcadeRejectDiagnosis", () => {
  it("reads camelCase ARC fields", () => {
    const diagnosis = extractArcadeRejectDiagnosis({
      txStatus: "REJECTED",
      extraInfo: "Missing inputs",
      competingTxs: ["aa".repeat(32)],
    });
    expect(diagnosis.status).toBe("REJECTED");
    expect(diagnosis.reason).toBe("Missing inputs");
    expect(diagnosis.competingTxs).toEqual(["aa".repeat(32)]);
    expect(diagnosis.upstreamSnippet).toBeUndefined();
  });

  it("flattens nested competingTxs arrays", () => {
    const diagnosis = extractArcadeRejectDiagnosis({
      txStatus: "DOUBLE_SPEND_ATTEMPTED",
      competingTxs: [["bb".repeat(32), "cc".repeat(32)]],
    });
    expect(diagnosis.competingTxs).toEqual(["bb".repeat(32), "cc".repeat(32)]);
  });

  it("falls back across title/detail/snake_case and captures a snippet when empty", () => {
    const withTitle = extractArcadeRejectDiagnosis({
      tx_status: "REJECTED",
      title: "Transaction is not valid",
      status: 200,
    });
    expect(withTitle.reason).toBe("Transaction is not valid");

    const empty = extractArcadeRejectDiagnosis(
      {
        txStatus: "REJECTED",
        timestamp: "2026-08-05T16:48:57Z",
      },
      "REJECTED",
    );
    expect(empty.reason).toBeUndefined();
    expect(empty.upstreamSnippet).toContain("REJECTED");
  });

  it("does not invent REJECTED from a not-found body", () => {
    const body = { error: "transaction not found" };
    expect(isArcadeTxNotFound(body)).toBe(true);
    const diagnosis = extractArcadeRejectDiagnosis(body);
    expect(diagnosis.status).toBe("");
    expect(diagnosis.notFound).toBe(true);
    expect(diagnosis.reason).toBe("transaction not found");
  });
});

