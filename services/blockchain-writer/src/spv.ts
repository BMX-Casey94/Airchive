import type { Knex } from "knex";
import { MerklePath } from "@bsv/sdk";
import { createLogger } from "@airchive/logger";
import { spvVerificationsTotal } from "./metrics.js";
import type { HeaderStore } from "./header-store.js";

const log = createLogger({ service: "blockchain-writer:spv" });

export interface ProofVerification {
  verified: boolean;
  blockHeight?: number;
  reason?: string;
}

/**
 * Verifies a BUMP against a locally held, proof-of-work-checked header.
 *
 * This is the step that was missing: proofs were stored and surfaced as "SPV
 * Verified" without ever being recomputed, so a malformed or fabricated path
 * was indistinguishable from a real one.
 */
export async function verifyBump(
  txid: string,
  bumpHex: string,
  headers: HeaderStore,
): Promise<ProofVerification> {
  let path: MerklePath;
  try {
    path = MerklePath.fromHex(bumpHex);
  } catch (err) {
    spvVerificationsTotal.inc({ outcome: "malformed" });
    return { verified: false, reason: `Malformed BUMP: ${(err as Error).message}` };
  }

  try {
    // computeRoot throws when the txid is absent from the path, which is itself
    // a rejection rather than an error condition.
    const root = path.computeRoot(txid);

    // "No header yet" and "the root is wrong" are opposite diagnoses — one is a
    // sync lag that resolves itself, the other says the proof is not evidence.
    // Reporting both as a mismatch makes a lagging sync look like a fraud
    // signal, so they are counted apart.
    const header = await headers.getHeader(path.blockHeight);
    if (!header) {
      spvVerificationsTotal.inc({ outcome: "header_unavailable" });
      return {
        verified: false,
        blockHeight: path.blockHeight,
        reason: `No header held for height ${path.blockHeight}`,
      };
    }

    const valid = header.merkle_root.toLowerCase() === root.toLowerCase();
    spvVerificationsTotal.inc({ outcome: valid ? "verified" : "root_mismatch" });
    return valid
      ? { verified: true, blockHeight: path.blockHeight }
      : {
          verified: false,
          blockHeight: path.blockHeight,
          reason: "Computed merkle root does not match the header for that height",
        };
  } catch (err) {
    spvVerificationsTotal.inc({ outcome: "not_in_path" });
    return { verified: false, reason: (err as Error).message };
  }
}

/**
 * Records a verified proof. Only a verified proof may move a transaction to
 * MINED, so the dashboard's confirmed count means "proved to be in a block"
 * rather than "an API said so".
 */
export async function recordVerifiedProof(
  db: Knex,
  txid: string,
  bumpHex: string,
  blockHeight: number,
): Promise<void> {
  await db("tx_results").where({ txid }).update({
    status: "MINED",
    block_height: blockHeight,
    bump: bumpHex,
    merkle_path: bumpHex,
    spv_verified: true,
  });
  log.debug({ txid, blockHeight }, "Merkle proof verified against a stored header");
}

/**
 * Persists many verified proofs in a few statements.
 *
 * Catch-up settles thousands of rows against one cached block; one UPDATE per
 * row would spend the whole cycle on round-trips and leave the backlog growing.
 */
export async function recordVerifiedProofsBatch(
  db: Knex,
  proofs: Array<{ txid: string; bumpHex: string; blockHeight: number }>,
): Promise<number> {
  if (proofs.length === 0) return 0;

  const CHUNK = 200;
  let updated = 0;

  for (let i = 0; i < proofs.length; i += CHUNK) {
    const chunk = proofs.slice(i, i + CHUNK);
    const bindings: Array<string | number> = [];
    const valuesSql = chunk
      .map((proof) => {
        bindings.push(proof.txid, proof.blockHeight, proof.bumpHex);
        return "(?::text, ?::int, ?::text)";
      })
      .join(", ");

    const result = await db.raw(
      `UPDATE tx_results AS t SET
         status = 'MINED',
         block_height = v.block_height,
         bump = v.bump,
         merkle_path = v.bump,
         spv_verified = true
       FROM (VALUES ${valuesSql}) AS v(txid, block_height, bump)
       WHERE t.txid = v.txid
         AND t.status = 'SEEN_ON_NETWORK'`,
      bindings,
    );
    updated += Number(result.rowCount ?? chunk.length);
  }

  return updated;
}

/**
 * Keeps an unverified proof for later re-checking without claiming it is sound.
 * A proof can legitimately arrive before its header does.
 */
export async function recordUnverifiedProof(
  db: Knex,
  txid: string,
  bumpHex: string,
  blockHeight: number | undefined,
  reason: string,
): Promise<void> {
  await db("tx_results").where({ txid }).update({
    bump: bumpHex,
    merkle_path: bumpHex,
    spv_verified: false,
    ...(blockHeight === undefined ? {} : { block_height: blockHeight }),
  });
  log.warn({ txid, blockHeight, reason }, "Merkle proof stored unverified");
}
