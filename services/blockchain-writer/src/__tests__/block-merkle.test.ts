import { describe, expect, it } from "vitest";
import { MerklePath } from "@bsv/sdk";

import { branchToBumpHex, buildBlockMerkleTree } from "../block-merkle.js";
import { computeTscRoot } from "../confirmation-poller.js";
import { BLOCK_500000 } from "./block-500000.js";

// Its 150 transactions give odd levels above the leaves, which exercises the
// duplicated-node case that a power-of-two block would hide.
const TXIDS: string[] = [...BLOCK_500000.tx];
const EXPECTED_ROOT: string = BLOCK_500000.merkleroot;
const HEIGHT: number = BLOCK_500000.height;

describe("buildBlockMerkleTree", () => {
  it("reproduces the block's merkle root from its transaction list", () => {
    const tree = buildBlockMerkleTree(TXIDS);
    expect(tree?.root).toBe(EXPECTED_ROOT);
  });

  it("derives a branch for every transaction that recomputes the root", () => {
    const tree = buildBlockMerkleTree(TXIDS);
    expect(tree).not.toBeNull();

    for (const txid of TXIDS) {
      const index = tree!.indexOf.get(txid);
      expect(index).toBeTypeOf("number");
      expect(computeTscRoot(txid, index!, tree!.branchFor(index!))).toBe(EXPECTED_ROOT);
    }
  });

  it("rejects a tampered transaction list rather than trusting the provider", () => {
    const tampered = [...TXIDS];
    tampered[7] = "f".repeat(64);
    expect(buildBlockMerkleTree(tampered)?.root).not.toBe(EXPECTED_ROOT);
  });

  it("rejects a list whose order has been changed", () => {
    const reordered = [...TXIDS];
    [reordered[3], reordered[4]] = [reordered[4]!, reordered[3]!];
    expect(buildBlockMerkleTree(reordered)?.root).not.toBe(EXPECTED_ROOT);
  });

  it("refuses malformed input", () => {
    expect(buildBlockMerkleTree([])).toBeNull();
    expect(buildBlockMerkleTree(["not-a-txid"])).toBeNull();
  });

  it("handles a block containing only the coinbase", () => {
    const solo = buildBlockMerkleTree([TXIDS[0]!]);
    expect(solo?.root).toBe(TXIDS[0]);
    expect(solo?.branchFor(0)).toEqual([]);
  });
});

describe("branchToBumpHex", () => {
  it("emits a BUMP that independently recomputes the root", () => {
    const tree = buildBlockMerkleTree(TXIDS)!;

    for (const txid of TXIDS) {
      const index = tree.indexOf.get(txid)!;
      const hex = branchToBumpHex(HEIGHT, txid, index, tree.branchFor(index), EXPECTED_ROOT);

      expect(hex, `no BUMP produced for ${txid}`).not.toBeNull();

      // Round-trip through the serialised form: this is what a third party
      // reading the stored proof would do.
      const parsed = MerklePath.fromHex(hex!);
      expect(parsed.blockHeight).toBe(HEIGHT);
      expect(parsed.computeRoot(txid)).toBe(EXPECTED_ROOT);
    }
  });

  it("returns null when the branch does not lead to the expected root", () => {
    const tree = buildBlockMerkleTree(TXIDS)!;
    const txid = TXIDS[2]!;
    const index = tree.indexOf.get(txid)!;

    expect(
      branchToBumpHex(HEIGHT, txid, index, tree.branchFor(index), "0".repeat(64)),
    ).toBeNull();
  });
});
