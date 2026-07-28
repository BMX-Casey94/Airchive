import type { Knex } from "knex";
import { Hash } from "@bsv/sdk";
import { createLogger } from "@airchive/logger";
import { headerFetchTotal, headersStoredGauge, spvVerificationsTotal } from "./metrics.js";
import type { ChainLookup } from "./chain-lookup.js";

const log = createLogger({ service: "blockchain-writer:headers" });

const HEADER_FETCH_TIMEOUT_MS = 10_000;

export interface BlockHeader {
  height: number;
  hash: string;
  prev_hash: string;
  merkle_root: string;
  time: number;
  bits: number;
  nonce: number;
  version: number;
}

interface WocHeader {
  hash: string;
  height: number;
  version: number;
  merkleroot: string;
  time: number;
  nonce: number;
  bits: string;
  previousblockhash: string;
}

/**
 * Postgres-backed block header store that also satisfies the SDK's ChainTracker
 * contract, so `MerklePath.verify()` checks proofs against headers we hold.
 *
 * Headers are never trusted on the word of the API that served them: each one
 * is reserialised into its canonical 80 bytes, hashed, and checked to both
 * match the advertised hash and satisfy its own difficulty target. That reduces
 * the trust placed in the header source to the same assumption SPV already
 * makes — that forging a header requires doing the proof of work.
 */
export class HeaderStore {
  private readonly memo = new Map<number, BlockHeader>();

  constructor(
    private readonly db: Knex,
    private readonly woc: ChainLookup,
  ) {}

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    const header = await this.getHeader(height);
    if (!header) return false;
    return header.merkle_root.toLowerCase() === root.toLowerCase();
  }

  async currentHeight(): Promise<number> {
    const row = await this.db("block_headers").max<{ max: number | null }>("height as max").first();
    return Number(row?.max ?? 0);
  }

  async getHeader(height: number): Promise<BlockHeader | null> {
    const cached = this.memo.get(height);
    if (cached) return cached;

    const row = await this.db<BlockHeader>("block_headers").where({ height }).first();
    if (row) {
      const header = normaliseRow(row);
      this.memo.set(height, header);
      return header;
    }

    const fetched = await this.fetchHeader(height);
    if (!fetched) return null;

    await this.store(fetched);
    return fetched;
  }

  /**
   * Pulls the recent tip window. Keeping a contiguous, linked run of recent
   * headers means a reorg shows up as a hash mismatch on an existing height
   * rather than passing unnoticed.
   */
  async syncTip(): Promise<number> {
    let stored = 0;
    try {
      const payload = await this.woc.getJson<WocHeader[]>("/block/headers", {
        label: "block_headers",
        timeoutMs: HEADER_FETCH_TIMEOUT_MS,
      });
      if (!payload) {
        headerFetchTotal.inc({ outcome: "error" });
        return 0;
      }

      // Ascending, so each header can be linked to the one before it.
      const headers = payload
        .map(toHeader)
        .filter((header): header is BlockHeader => header !== null)
        .sort((a, b) => a.height - b.height);

      for (const header of headers) {
        if (!verifyProofOfWork(header)) {
          log.error(
            { height: header.height, hash: header.hash },
            "Rejected block header failing proof-of-work validation",
          );
          headerFetchTotal.inc({ outcome: "invalid" });
          continue;
        }
        if (await this.detectReorg(header)) continue;
        await this.store(header);
        stored++;
      }

      headerFetchTotal.inc({ outcome: "ok" }, stored);
      const total = await this.db("block_headers").count<{ count: string }>("* as count").first();
      headersStoredGauge.set(Number(total?.count ?? 0));
    } catch (err) {
      headerFetchTotal.inc({ outcome: "error" });
      log.warn({ err }, "Block header tip sync failed");
    }
    return stored;
  }

  /**
   * A differing hash at a height we already hold means the chain reorganised.
   * The new header wins, and any proof verified against the old one is no
   * longer sound, so those transactions are returned for re-verification.
   */
  private async detectReorg(header: BlockHeader): Promise<boolean> {
    const existing = await this.db<BlockHeader>("block_headers")
      .where({ height: header.height })
      .first();
    if (!existing || existing.hash === header.hash) return false;

    log.error(
      { height: header.height, previousHash: existing.hash, newHash: header.hash },
      "Block reorganisation detected — invalidating proofs at this height",
    );

    await this.db("block_headers").where({ height: header.height }).delete();
    this.memo.delete(header.height);
    await this.db("tx_results")
      .where({ block_height: header.height, spv_verified: true })
      .update({ spv_verified: false, status: "SEEN_ON_NETWORK" });
    spvVerificationsTotal.inc({ outcome: "reorg_invalidated" });
    return false;
  }

  private async fetchHeader(height: number): Promise<BlockHeader | null> {
    try {
      const payload = await this.woc.getJson<WocHeader>(`/block/${height}/header`, {
        label: "block_header",
        timeoutMs: HEADER_FETCH_TIMEOUT_MS,
        allowNotFound: true,
      });
      if (!payload) {
        headerFetchTotal.inc({ outcome: "missing" });
        return null;
      }

      const header = toHeader(payload);
      if (!header) {
        headerFetchTotal.inc({ outcome: "invalid" });
        return null;
      }
      if (!verifyProofOfWork(header)) {
        log.error(
          { height, hash: header.hash },
          "Rejected block header failing proof-of-work validation",
        );
        headerFetchTotal.inc({ outcome: "invalid" });
        return null;
      }

      headerFetchTotal.inc({ outcome: "ok" });
      return header;
    } catch (err) {
      headerFetchTotal.inc({ outcome: "error" });
      log.warn({ err, height }, "Block header fetch failed");
      return null;
    }
  }

  private async store(header: BlockHeader): Promise<void> {
    await this.db("block_headers").insert(header).onConflict("height").merge();
    this.memo.set(header.height, header);
  }
}

function normaliseRow(row: BlockHeader): BlockHeader {
  return {
    height: Number(row.height),
    hash: row.hash,
    prev_hash: row.prev_hash,
    merkle_root: row.merkle_root,
    time: Number(row.time),
    bits: Number(row.bits),
    nonce: Number(row.nonce),
    version: Number(row.version),
  };
}

function toHeader(raw: WocHeader): BlockHeader | null {
  if (
    typeof raw?.hash !== "string"
    || typeof raw.merkleroot !== "string"
    || typeof raw.bits !== "string"
    || !Number.isFinite(raw.height)
  ) {
    return null;
  }
  return {
    height: raw.height,
    hash: raw.hash,
    // The genesis block has no parent; represent it as the zero hash.
    prev_hash: raw.previousblockhash ?? "0".repeat(64),
    merkle_root: raw.merkleroot,
    time: raw.time,
    bits: Number.parseInt(raw.bits, 16),
    nonce: raw.nonce,
    version: raw.version,
  };
}

function writeUInt32LE(out: number[], value: number): void {
  out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

/** Hashes are displayed big-endian but serialised little-endian. */
function hexToLeBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = hex.length - 2; i >= 0; i -= 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

export function serialiseHeader(header: BlockHeader): number[] {
  const out: number[] = [];
  writeUInt32LE(out, header.version >>> 0);
  out.push(...hexToLeBytes(header.prev_hash));
  out.push(...hexToLeBytes(header.merkle_root));
  writeUInt32LE(out, header.time >>> 0);
  writeUInt32LE(out, header.bits >>> 0);
  writeUInt32LE(out, header.nonce >>> 0);
  return out;
}

/** Expands compact nBits into the full 256-bit target. */
export function targetFromBits(bits: number): bigint {
  const exponent = bits >>> 24;
  const mantissa = BigInt(bits & 0x00ff_ffff);
  if (exponent <= 3) {
    return mantissa >> BigInt(8 * (3 - exponent));
  }
  return mantissa << BigInt(8 * (exponent - 3));
}

/**
 * Confirms the header hashes to the hash it claims and that the hash clears its
 * own difficulty target. Together these make a forged header as expensive as
 * mining one.
 */
export function verifyProofOfWork(header: BlockHeader): boolean {
  const serialised = serialiseHeader(header);
  if (serialised.length !== 80) return false;

  const digest = Hash.hash256(serialised) as number[];
  const hash = digest
    .slice()
    .reverse()
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (hash !== header.hash.toLowerCase()) return false;

  const target = targetFromBits(header.bits);
  if (target <= 0n) return false;
  return BigInt(`0x${hash}`) <= target;
}
