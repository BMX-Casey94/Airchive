import { Hash, MerklePath } from "@bsv/sdk";

/**
 * Builds a block's merkle tree locally so one download proves every one of our
 * transactions in that block.
 *
 * Buying an inclusion proof per transaction is the wrong unit of work at this
 * write rate. A block carries thousands of our writes, and its full transaction
 * list costs a couple of requests, so deriving the branches ourselves replaces
 * thousands of metered calls with two or three.
 *
 * It is also the stronger position cryptographically. A served proof has to be
 * taken on trust that the branch is the real one; here the whole tree is
 * recomputed and its root checked against a header whose proof of work we have
 * verified. A wrong or tampered transaction list cannot produce the right root,
 * so the entire block is rejected rather than any single bad branch slipping
 * through.
 */

/** Hashes are displayed big-endian but hashed little-endian. */
function hexToLeBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = hex.length - 2; i >= 0; i -= 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

function leBytesToHex(bytes: number[]): string {
  return bytes
    .slice()
    .reverse()
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const TXID_PATTERN = /^[0-9a-f]{64}$/;

export interface BlockMerkleTree {
  /** Display-order merkle root computed from the supplied transaction list. */
  root: string;
  /** Position of each transaction id in the block, keyed lower-case. */
  indexOf: Map<string, number>;
  /** Branch for a transaction, in the node ordering `computeTscRoot` expects. */
  branchFor(index: number): string[];
}

/**
 * Computes every level of the tree. Levels are retained because the branches
 * are read out of them; a block of 65k transactions produces roughly 131k
 * nodes, which is a few tens of megabytes held only for as long as the block
 * is being processed.
 */
export function buildBlockMerkleTree(txids: string[]): BlockMerkleTree | null {
  if (txids.length === 0) return null;

  const indexOf = new Map<string, number>();
  const leaves: number[][] = [];

  for (let i = 0; i < txids.length; i++) {
    const txid = txids[i]!.trim().toLowerCase();
    if (!TXID_PATTERN.test(txid)) return null;
    // First occurrence wins. Duplicate ids in a block would be a consensus
    // violation, but a provider repeating one must not silently shift indices.
    if (!indexOf.has(txid)) indexOf.set(txid, i);
    leaves.push(hexToLeBytes(txid));
  }

  const levels: number[][][] = [leaves];
  let level = leaves;

  while (level.length > 1) {
    const next: number[][] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      // An odd level pairs the final node with itself.
      const right = level[i + 1] ?? left;
      next.push(Hash.hash256([...left, ...right]) as number[]);
    }
    levels.push(next);
    level = next;
  }

  return {
    root: leBytesToHex(level[0]!),
    indexOf,
    branchFor(index: number): string[] {
      const nodes: string[] = [];
      let position = index;

      for (let depth = 0; depth < levels.length - 1; depth++) {
        const current = levels[depth]!;
        const siblingIndex = position % 2 === 0 ? position + 1 : position - 1;
        // "*" is how TSC encodes "the sibling is the node itself", which is
        // what pairing the last node of an odd level with itself produces.
        nodes.push(
          siblingIndex >= current.length
            ? "*"
            : leBytesToHex(current[siblingIndex]!),
        );
        position = Math.floor(position / 2);
      }

      return nodes;
    },
  };
}

/**
 * Serialises a locally derived branch as a BUMP.
 *
 * Storing the proof rather than just a verified flag is what lets anyone else
 * re-check the record later without trusting us or re-downloading the block.
 *
 * Returns null if the assembled path does not reproduce the expected root, so
 * a mistake here can never persist a proof that does not verify.
 */
export function branchToBumpHex(
  blockHeight: number,
  txid: string,
  index: number,
  branch: string[],
  expectedRoot: string,
): string | null {
  const path: Array<Array<{ offset: number; hash?: string; txid?: boolean; duplicate?: boolean }>> =
    [];

  for (let depth = 0; depth < branch.length; depth++) {
    const node = branch[depth]!;
    const offsetAtDepth = Math.floor(index / 2 ** depth);
    const sibling =
      node === "*"
        ? { offset: offsetAtDepth ^ 1, duplicate: true }
        : { offset: offsetAtDepth ^ 1, hash: node };

    if (depth === 0) {
      const self = { offset: index, hash: txid.toLowerCase(), txid: true };
      // Every level must be ordered by increasing offset.
      path.push(index % 2 === 0 ? [self, sibling] : [sibling, self]);
    } else {
      path.push([sibling]);
    }
  }

  if (path.length === 0) {
    // A block containing only the coinbase has no branch to walk.
    return MerklePath.fromCoinbaseTxidAndHeight(txid.toLowerCase(), blockHeight).toHex();
  }

  try {
    const merklePath = new MerklePath(blockHeight, path);
    if (merklePath.computeRoot(txid.toLowerCase()) !== expectedRoot) return null;
    return merklePath.toHex();
  } catch {
    return null;
  }
}
