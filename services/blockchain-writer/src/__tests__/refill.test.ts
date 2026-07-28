import { describe, expect, it } from "vitest";
import { P2PKH, PrivateKey } from "@bsv/sdk";
import {
  buildFundingSplitTx,
  buildRefillTx,
  derivePubKeyHash,
  estimateRefillFee,
} from "../tx-builder.js";
import { treasuryOutputFloorSats } from "../auto-refill.js";

// Fixed scalars so the fixtures are deterministic. These are test keys with no
// funds and no relationship to any deployed wallet.
const fundingKey = new PrivateKey(
  "0000000000000000000000000000000000000000000000000000000000000001",
  16,
);
const recipientKey = new PrivateKey(
  "0000000000000000000000000000000000000000000000000000000000000002",
  16,
);

function fundingUtxo(index: number, satoshis: number) {
  return {
    txid: index.toString(16).padStart(64, "0"),
    vout: index,
    satoshis,
    lockingScript: new P2PKH().lock(derivePubKeyHash(fundingKey)).toHex(),
  };
}

describe("estimateRefillFee", () => {
  it("grows with the number of inputs", () => {
    const one = estimateRefillFee(4, true, 1);
    const five = estimateRefillFee(4, true, 5);
    expect(five).toBeGreaterThan(one);
  });

  it("treats a missing input count as a single input", () => {
    expect(estimateRefillFee(4, true)).toBe(estimateRefillFee(4, true, 1));
  });
});

describe("buildRefillTx", () => {
  const recipientPkh = derivePubKeyHash(recipientKey);

  it("funds a refill by combining several small treasury outputs", async () => {
    // No single output covers the refill; together they comfortably do. This is
    // the fragmented-treasury case that previously reported the treasury dry.
    const utxos = [
      fundingUtxo(1, 30_000),
      fundingUtxo(2, 30_000),
      fundingUtxo(3, 30_000),
    ];

    const result = await buildRefillTx({
      fundingUtxos: utxos,
      fundingKey,
      recipientPkh,
      amountSats: 63_000,
      recipientOutputCount: 3,
    });

    expect(result.tx.inputs).toHaveLength(3);
    expect(result.recipientOutputs).toHaveLength(3);

    const paidOut = result.recipientOutputs.reduce((sum, o) => sum + o.satoshis, 0);
    expect(paidOut).toBe(63_000);

    const inputTotal = utxos.reduce((sum, u) => sum + u.satoshis, 0);
    const fee = estimateRefillFee(3, true, 3);
    expect(result.changeSats).toBe(inputTotal - paidOut - fee);
  });

  it("still works from a single sufficient output", async () => {
    const result = await buildRefillTx({
      fundingUtxos: [fundingUtxo(4, 200_000)],
      fundingKey,
      recipientPkh,
      amountSats: 63_000,
      recipientOutputCount: 2,
    });

    expect(result.tx.inputs).toHaveLength(1);
    expect(result.recipientOutputs).toHaveLength(2);
  });

  it("rejects a selection that cannot cover the amount plus fee", async () => {
    await expect(
      buildRefillTx({
        fundingUtxos: [fundingUtxo(5, 10_000)],
        fundingKey,
        recipientPkh,
        amountSats: 63_000,
        recipientOutputCount: 1,
      }),
    ).rejects.toThrow(/insufficient/i);
  });

  it("rejects an empty input set rather than building an unfunded transaction", async () => {
    await expect(
      buildRefillTx({
        fundingUtxos: [],
        fundingKey,
        recipientPkh,
        amountSats: 1_000,
      }),
    ).rejects.toThrow(/at least one funding UTXO/i);
  });
});

describe("treasuryOutputFloorSats", () => {
  it("exceeds what a single refill spends, so one output funds one refill", () => {
    const amount = 320_000;
    const outputs = 4;
    const floor = treasuryOutputFloorSats(amount, outputs);
    expect(floor).toBeGreaterThan(amount + estimateRefillFee(outputs, true, 1));
  });
});

describe("buildFundingSplitTx", () => {
  it("consolidates many small outputs into one usable output", async () => {
    // The fragmented-treasury remedy: outputs individually below the refill
    // floor are swept into a single output that clears it.
    const utxos = Array.from({ length: 8 }, (_, i) => fundingUtxo(10 + i, 40_000));

    const { tx, outputs } = await buildFundingSplitTx({
      fundingUtxos: utxos,
      fundingKey,
      targetOutputCount: 1,
    });

    expect(tx.inputs).toHaveLength(8);
    expect(outputs).toHaveLength(1);

    const inputTotal = utxos.reduce((sum, u) => sum + u.satoshis, 0);
    expect(outputs[0]?.satoshis).toBe(inputTotal - estimateRefillFee(1, false, 8));
    expect(outputs[0]?.satoshis).toBeGreaterThan(40_000);
  });

  it("still splits one large output into many", async () => {
    const { tx, outputs } = await buildFundingSplitTx({
      fundingUtxos: [fundingUtxo(30, 4_000_000)],
      fundingKey,
      targetOutputCount: 10,
    });

    expect(tx.inputs).toHaveLength(1);
    expect(outputs).toHaveLength(10);
  });

  it("refuses to reshape when the inputs cannot cover the outputs", async () => {
    await expect(
      buildFundingSplitTx({
        fundingUtxos: [fundingUtxo(40, 800)],
        fundingKey,
        targetOutputCount: 10,
      }),
    ).rejects.toThrow(/too small/i);
  });
});
