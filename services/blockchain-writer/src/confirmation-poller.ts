import type { Knex } from "knex";
import { Hash } from "@bsv/sdk";
import { updateTxStatus } from "@airchive/db";
import { createLogger } from "@airchive/logger";
import { spvVerificationsTotal } from "./metrics.js";
import type { HeaderStore } from "./header-store.js";
import {
  recordUnverifiedProof,
  recordVerifiedProof,
  recordVerifiedProofsBatch,
  verifyBump,
} from "./spv.js";
import {
  branchToBumpHex,
  buildBlockMerkleTree,
  type BlockMerkleTree,
} from "./block-merkle.js";
import type { ChainLookup } from "./chain-lookup.js";
import { isWocUnavailable } from "./woc-client.js";

const log = createLogger({ service: "blockchain-writer:confirmation-poller" });

const STEADY_INTERVAL_MS = 60_000;
const CATCHUP_INTERVAL_MS = 10_000;
/**
 * Kept modest on purpose: WhatsOnChain's bulk status endpoint accepts 20 ids
 * per request, so this is 20 metered calls. Throughput comes from sweeping a
 * cached block afterwards, not from enlarging this status batch.
 */
const BATCH_SIZE = 400;
const POLL_CONCURRENCY = 12;
const BATCH_PAUSE_MS = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const STALE_TX_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/**
 * Blocks arrive roughly every ten minutes, so a transaction broadcast seconds
 * ago is almost never in one. Checking it anyway spent most of every cycle's
 * budget re-asking about the newest rows while the backlog behind them went
 * untouched.
 */
const MIN_CONFIRMATION_AGE_MS = 300_000;
/**
 * A row checked once and never revisited is a row abandoned. Blocks arrive
 * about every ten minutes, so the first look at a young transaction usually
 * finds nothing; without a re-check it would stay pending forever behind the
 * endless supply of never-checked rows arriving at the current write rate.
 */
const RECHECK_AFTER_MS = 15 * 60_000;
/**
 * Share of each discovery batch spent on rows that have never been looked at.
 * The rest goes to the least recently checked, so new arrivals cannot starve
 * the backlog the way a pure NULLS-FIRST ordering did.
 */
const DISCOVERY_NEW_SHARE = 0.5;
/**
 * The SSE stream reports rejections in real time, so polling Arcade for a
 * verdict is a backstop for transactions it never reported on. Restricting it
 * to older rows keeps one Arcade request per genuine question rather than one
 * per pending row per cycle.
 */
const REJECTION_RECHECK_AGE_MS = 10 * 60_000;

/**
 * A block costs one summary request plus one per 50,000 transactions, so it
 * pays for itself once a handful of the batch share it. Cached trees skip the
 * gate entirely — proving against a tree we already hold costs no RPS.
 */
const MIN_ROWS_FOR_BLOCK_PROOF = 3;
/** New block downloads per cycle. Cache hits do not count against this. */
const MAX_BLOCKS_PER_CYCLE = 4;
/** Above this the tree costs more heap than a confirmation is worth. */
const MAX_BLOCK_TX_FOR_LOCAL_PROOFS = 150_000;
/** Block bodies are megabytes, so they need longer than an API call. */
const BLOCK_REQUEST_TIMEOUT_MS = 60_000;
/** Floor between nudge-driven cycles, so a burst cannot outpace the timer. */
const MIN_NUDGE_INTERVAL_MS = CATCHUP_INTERVAL_MS;
/**
 * How many pending rows to test against cached trees each cycle. Membership is
 * an in-memory Map lookup, so this settles thousands of confirmations with
 * zero additional provider requests — which is how catch-up outruns ~25 TPS
 * without touching the rate limit.
 */
const CACHE_SWEEP_CANDIDATES = 12_000;
/**
 * Heights considered when draining the backlog. Rows already known to be in a
 * block carry the height, so the busiest heights can be found with one grouped
 * query and settled without asking any provider whether they are mined.
 */
const BACKLOG_HEIGHT_SAMPLE = 12;
/**
 * Block transaction ids matched against the backlog per query. `txid` is the
 * primary key, so each chunk is an index lookup; the chunking exists only to
 * keep a large block well inside the bind-parameter limit.
 */
const DRAIN_MATCH_CHUNK = 5_000;
/** Verified trees kept warm. A 70k-tx block is tens of MB; four is a safe cap. */
const BLOCK_TREE_CACHE_MAX = 4;
/**
 * Hard ceiling on per-transaction TSC fetches per cycle. The block path is the
 * real confirmer; this is only a narrow escape hatch so a lonely mined row is
 * not stranded when it never shares a batch with enough siblings to justify a
 * download.
 */
const MAX_PER_TX_PROOFS_PER_CYCLE = 8;

type PollMode = "catchup" | "steady";

interface PendingTxRow {
  txid: string;
  aircraft_icao: string;
  size_bytes: number | string;
  fee_sats: number | string;
  timestamp: number | string;
  record_type: number | string;
  chronicle_validated?: boolean | null;
}

interface BlockSummary {
  hash?: string;
  txcount?: number;
  num_tx?: number;
  /** Present in full only for blocks small enough to avoid pagination. */
  tx?: string[];
  pages?: { uri?: string[]; size?: number };
}

interface ArcadeTxStatus {
  txStatus?: string;
  status?: string;
  blockHeight?: number;
  merklePath?: string;
}

interface TscProof {
  index: number;
  txOrId: string;
  target: string;
  /**
   * What `target` holds. The TSC default is the block hash, which is what
   * WhatsOnChain returns; BananaBlocks returns the merkle root and says so
   * here. Ignoring the field meant every BananaBlocks proof was discarded as
   * pointing at the wrong block.
   */
  targetType?: string;
  nodes: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks the proof is about the block we hold, under either TSC encoding.
 *
 * `targetType` is optional and defaults to the block hash. BananaBlocks sets
 * it to "merkleRoot" and returns the root instead, so a comparison hard-coded
 * to the hash rejected every proof it served.
 */
export function targetMatchesHeader(
  proof: Pick<TscProof, "target" | "targetType">,
  header: { hash: string; merkle_root: string },
): boolean {
  const target = proof.target?.toLowerCase();
  if (!target) return false;

  switch ((proof.targetType ?? "hash").toLowerCase()) {
    case "merkleroot":
      return target === header.merkle_root.toLowerCase();
    case "header": {
      // The 80-byte serialised header. Bytes 36..67 are the merkle root in
      // wire order, whereas the stored root is in display order.
      if (target.length !== 160) return false;
      return target.slice(72, 136) === toWireOrder(header.merkle_root.toLowerCase());
    }
    default:
      return target === header.hash.toLowerCase();
  }
}

/** Display-order hash hex to wire order, which is the same bytes reversed. */
function toWireOrder(hex: string): string {
  return (hex.match(/../g) ?? []).reverse().join("");
}

/**
 * Backstop for the Arcade SSE status stream.
 *
 * Where this previously accepted an API's word that a transaction was mined,
 * it now insists on a merkle proof that verifies against a header whose proof
 * of work has been checked locally. A transaction only reaches MINED once that
 * succeeds; anything weaker is recorded as an unverified proof and retried.
 */
interface CachedBlockTree {
  tree: BlockMerkleTree;
  blockTxCount: number;
  /** Header merkle root the tree was checked against. */
  merkleRoot: string;
  lastUsedAt: number;
}

export class ConfirmationPoller {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private mode: PollMode = "catchup";
  private lastNudgePollAt = 0;
  private redisPublisher: { publish(channel: string, message: string): Promise<number> } | null = null;
  private onTerminalRejection: ((txid: string) => Promise<void>) | null = null;
  /** Height → verified merkle tree. Avoids re-downloading the same hot block. */
  private readonly blockTrees = new Map<number, CachedBlockTree>();

  constructor(
    private readonly db: Knex,
    private readonly woc: ChainLookup,
    private readonly headers: HeaderStore,
    private readonly arcadeUrl?: string,
    private readonly arcadeApiKey?: string,
  ) {}

  setRedisPublisher(pub: { publish(channel: string, message: string): Promise<number> }): void {
    this.redisPublisher = pub;
  }

  /**
   * Called when polling — rather than the SSE stream — is what discovers a
   * rejection. Both routes must unwind the transaction's phantom outputs;
   * marking the row FAILED and stopping there leaves the pool holding outputs
   * that never existed, and the aircraft's next write spends one and is
   * rejected in turn, which is how a single rejection becomes a stuck chain.
   */
  setTerminalRejectionHandler(handler: (txid: string) => Promise<void>): void {
    this.onTerminalRejection = handler;
  }

  start(): void {
    if (this.intervalId) return;
    this.setMode("catchup", true);
    void this.poll();
  }

  /**
   * Asks for an out-of-band cycle when something suggests there is work.
   *
   * Rate limited on purpose. Every mined-without-proof report used to trigger
   * one, and a block landing produces thousands at once, so cycles ran
   * back-to-back and drove the providers straight into rate limiting — the
   * poller then spent its budget on 429s rather than confirmations.
   */
  nudge(): void {
    if (!this.intervalId) return;
    this.switchToCatchupState();

    const now = Date.now();
    if (this.running || now - this.lastNudgePollAt < MIN_NUDGE_INTERVAL_MS) return;

    this.lastNudgePollAt = now;
    void this.poll();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private setMode(mode: PollMode, forceLog = false): void {
    const intervalMs = mode === "catchup" ? CATCHUP_INTERVAL_MS : STEADY_INTERVAL_MS;

    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    this.intervalId = setInterval(() => void this.poll(), intervalMs);
    const changed = this.mode !== mode;
    this.mode = mode;

    if (changed || forceLog) {
      log.info(
        {
          intervalMs,
          batchSize: BATCH_SIZE,
          concurrency: POLL_CONCURRENCY,
          proofSource: this.arcadeUrl ? "arcade+woc" : "woc",
        },
        mode === "catchup"
          ? "Confirmation poller switched to catch-up mode"
          : "Confirmation poller switched to steady-state mode",
      );
    }
  }

  private switchToCatchupState(): void {
    if (this.mode !== "catchup") {
      this.setMode("catchup");
    }
  }

  private switchToSteadyState(): void {
    if (this.mode !== "steady") {
      this.setMode("steady");
    }
  }

  private async fetchArcadeProof(txid: string): Promise<ArcadeTxStatus | null> {
    if (!this.arcadeUrl) return null;
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.arcadeApiKey) headers.Authorization = `Bearer ${this.arcadeApiKey}`;

      const res = await fetch(`${this.arcadeUrl}/tx/${txid}`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return (await res.json()) as ArcadeTxStatus;
    } catch {
      return null;
    }
  }

  /**
   * WhatsOnChain remains a proof source only. Its answer is never taken at face
   * value: the branch is recomputed and matched against a locally verified
   * header, so a wrong or hostile response fails closed.
   *
   * Only called for transactions the bulk status pass has already placed in a
   * block, so one proof request is spent per genuine confirmation rather than
   * two per pending row per cycle.
   */
  private async verifyViaWoc(
    txid: string,
    blockHeight: number,
  ): Promise<{ blockHeight: number } | null> {
    const proofs = await this.woc.getJson<TscProof[]>(`/tx/${txid}/proof/tsc`, {
      label: "tsc_proof",
      timeoutMs: REQUEST_TIMEOUT_MS,
      allowNotFound: true,
    });

    const proof = proofs?.[0];
    if (!proof || !Array.isArray(proof.nodes)) {
      // Counted because it is otherwise invisible: a request was spent and no
      // verification was attempted, and at scale that consumes most of the
      // provider budget without producing a single confirmation.
      spvVerificationsTotal.inc({ outcome: "no_proof_available" });
      return null;
    }

    const header = await this.headers.getHeader(blockHeight);
    if (!header) {
      spvVerificationsTotal.inc({ outcome: "header_unavailable" });
      return null;
    }

    // `target` identifies which block the proof claims; the recomputation
    // below is the part that actually proves inclusion, so accepting either
    // encoding weakens nothing.
    if (!targetMatchesHeader(proof, header)) {
      spvVerificationsTotal.inc({ outcome: "target_mismatch" });
      return null;
    }

    const root = computeTscRoot(txid, proof.index, proof.nodes);
    if (root === null || root !== header.merkle_root.toLowerCase()) {
      spvVerificationsTotal.inc({ outcome: "root_mismatch" });
      return null;
    }

    spvVerificationsTotal.inc({ outcome: "verified_tsc" });
    return { blockHeight };
  }

  private rememberBlockTree(
    height: number,
    tree: BlockMerkleTree,
    blockTxCount: number,
    merkleRoot: string,
  ): void {
    this.blockTrees.set(height, {
      tree,
      blockTxCount,
      merkleRoot,
      lastUsedAt: Date.now(),
    });

    while (this.blockTrees.size > BLOCK_TREE_CACHE_MAX) {
      let oldestHeight: number | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [candidateHeight, entry] of this.blockTrees) {
        if (entry.lastUsedAt < oldestAt) {
          oldestAt = entry.lastUsedAt;
          oldestHeight = candidateHeight;
        }
      }
      if (oldestHeight === null) break;
      this.blockTrees.delete(oldestHeight);
    }
  }

  private getCachedBlockTree(height: number): CachedBlockTree | null {
    const entry = this.blockTrees.get(height);
    if (!entry) return null;
    entry.lastUsedAt = Date.now();
    return entry;
  }

  /**
   * Downloads whole blocks (or reuses cached trees) and proves every one of
   * our transactions in them.
   *
   * Cached heights are always used, even for a single row — the download was
   * already paid for. Fresh downloads are reserved for heights that carry
   * enough of the batch to beat the per-transaction cost.
   */
  private async verifyBlockBatches(
    pending: PendingTxRow[],
    mined: Map<string, number>,
  ): Promise<{ confirmed: number; done: Set<string> }> {
    const done = new Set<string>();
    let confirmed = 0;

    const byHeight = new Map<number, PendingTxRow[]>();
    for (const row of pending) {
      const height = mined.get(row.txid.toLowerCase());
      if (height === undefined) continue;
      const group = byHeight.get(height);
      if (group) group.push(row);
      else byHeight.set(height, [row]);
    }

    // Cache hits first: no RPS, no MIN_ROWS gate.
    for (const [height, rows] of byHeight) {
      if (!this.blockTrees.has(height)) continue;
      try {
        confirmed += await this.verifyOneBlock(height, rows, done);
      } catch (err) {
        log.warn({ err, height, rows: rows.length }, "Cached block proofs failed");
      }
    }

    const downloadCandidates = [...byHeight.entries()]
      .filter(([height, rows]) => {
        if (this.blockTrees.has(height)) return false;
        // Skip heights whose rows were already settled via another path.
        return rows.some((row) => !done.has(row.txid))
          && rows.length >= MIN_ROWS_FOR_BLOCK_PROOF;
      })
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, MAX_BLOCKS_PER_CYCLE);

    for (const [height, rows] of downloadCandidates) {
      try {
        confirmed += await this.verifyOneBlock(
          height,
          rows.filter((row) => !done.has(row.txid)),
          done,
        );
      } catch (err) {
        // Leaves the rows untouched so the narrow per-transaction escape hatch
        // can still try a few of them.
        log.warn({ err, height, rows: rows.length }, "Block-derived proofs failed for a block");
      }
    }

    return { confirmed, done };
  }

  private static readonly PENDING_COLUMNS = [
    "txid",
    "aircraft_icao",
    "size_bytes",
    "fee_sats",
    "timestamp",
    "record_type",
    "chronicle_validated",
  ];

  /**
   * Clears every pending row that already knows which block it is in.
   *
   * This is the catch-up engine, and it is deliberately independent of the
   * status lookup. A row reaches this state once any earlier pass recorded its
   * height, so proving it needs nothing from a provider beyond the block
   * itself — and one block download settles every row that shares that height.
   *
   * Driving from the backlog's own height distribution is what makes catch-up
   * possible. Selecting blocks from the small status batch instead meant that
   * when the batch happened to contain nothing mined, no block was cached and
   * nothing could be confirmed, however large the backlog behind it.
   */
  private async drainKnownMinedBacklog(done: Set<string>): Promise<number> {
    const [hot, oldest] = await Promise.all([
      this.db("tx_results")
        .where("status", "SEEN_ON_NETWORK")
        .whereNotNull("block_height")
        .select("block_height")
        .count("* as rows")
        .groupBy("block_height")
        .orderBy("rows", "desc")
        .limit(BACKLOG_HEIGHT_SAMPLE) as unknown as Promise<
        Array<{ block_height: number | string; rows: number | string }>
      >,
      this.db("tx_results")
        .where("status", "SEEN_ON_NETWORK")
        .whereNotNull("block_height")
        .min("block_height as height")
        .first() as Promise<{ height: number | string | null } | undefined>,
    ]);

    // Ordering purely by row count would leave the sparse tail of old blocks
    // permanently behind busier ones, so the oldest is always taken as well.
    const heights: number[] = [];
    const seenHeight = new Set<number>();
    const push = (value: number | string | null | undefined) => {
      const height = Number(value);
      if (!Number.isFinite(height) || height <= 0 || seenHeight.has(height)) return;
      seenHeight.add(height);
      heights.push(height);
    };

    push(oldest?.height);
    for (const entry of hot) push(entry.block_height);

    if (heights.length === 0) return 0;

    let confirmed = 0;
    let downloads = 0;
    const drained: Array<{ height: number; confirmed: number }> = [];

    for (const height of heights) {
      // Cached heights are free; fresh downloads stay rationed.
      if (!this.blockTrees.has(height)) {
        if (downloads >= MAX_BLOCKS_PER_CYCLE) continue;
        downloads++;
      }

      const settled = await this.drainHeight(height, done);
      if (settled > 0) drained.push({ height, confirmed: settled });
      confirmed += settled;
    }

    if (confirmed > 0) {
      log.info(
        { confirmed, blocks: drained, downloads, cachedBlocks: this.blockTrees.size },
        "Drained known-mined backlog from block trees",
      );
    }

    return confirmed;
  }

  /**
   * Proves every transaction of ours that the block contains.
   *
   * The question is asked from the block's side rather than the backlog's: the
   * verified tree already lists every transaction id in the block, so matching
   * that list against pending rows finds all of them at once. Selecting rows by
   * `block_height` instead only ever found the few that some earlier pass had
   * happened to stamp — a small fraction of the roughly seventeen thousand
   * writes a block carries at the current rate — and left the rest to be
   * discovered one at a time through the very lookups the rate limit caps.
   *
   * The download is the expensive part and it has already been paid for, so
   * this extracts everything it is worth.
   */
  private async drainHeight(height: number, done: Set<string>): Promise<number> {
    const cached = await this.ensureBlockTree(height);
    if (!cached) return 0;

    const blockTxids = [...cached.tree.indexOf.keys()];
    let confirmed = 0;
    let ours = 0;

    for (let i = 0; i < blockTxids.length; i += DRAIN_MATCH_CHUNK) {
      const chunk = blockTxids.slice(i, i + DRAIN_MATCH_CHUNK);
      const rows = (await this.db("tx_results")
        .where("status", "SEEN_ON_NETWORK")
        .whereIn("txid", chunk)
        .select(ConfirmationPoller.PENDING_COLUMNS)) as PendingTxRow[];

      if (rows.length === 0) continue;
      ours += rows.length;
      confirmed += await this.confirmRowsFromTree(height, rows, done);
    }

    if (ours > 0) {
      log.info(
        { height, blockTxCount: cached.blockTxCount, ours, confirmed },
        "Matched a verified block against the pending backlog",
      );
    }

    return confirmed;
  }

  /**
   * Settles pending rows that sit inside a tree we already hold, without any
   * further provider calls. Catches rows whose height was never recorded, so
   * they are proved without ever being asked about individually.
   */
  private async sweepAgainstCachedTrees(
    alreadyDone: Set<string>,
  ): Promise<number> {
    if (this.blockTrees.size === 0) return 0;

    const candidates = (await this.db("tx_results")
      .where("status", "SEEN_ON_NETWORK")
      .where("timestamp", "<=", Date.now() - MIN_CONFIRMATION_AGE_MS)
      .select(ConfirmationPoller.PENDING_COLUMNS)
      .orderByRaw("last_checked_at ASC NULLS FIRST")
      .limit(CACHE_SWEEP_CANDIDATES)) as PendingTxRow[];

    if (candidates.length === 0) return 0;

    const byHeight = new Map<number, PendingTxRow[]>();
    for (const row of candidates) {
      if (alreadyDone.has(row.txid)) continue;
      const txid = row.txid.toLowerCase();
      for (const [height, entry] of this.blockTrees) {
        if (!entry.tree.indexOf.has(txid)) continue;
        const group = byHeight.get(height);
        if (group) group.push(row);
        else byHeight.set(height, [row]);
        break;
      }
    }

    let confirmed = 0;
    for (const [height, rows] of byHeight) {
      confirmed += await this.confirmRowsFromTree(height, rows, alreadyDone);
    }

    if (confirmed > 0) {
      log.info(
        {
          confirmed,
          scanned: candidates.length,
          cachedBlocks: this.blockTrees.size,
          heights: [...byHeight.keys()],
        },
        "Swept pending transactions against cached block trees",
      );
    }

    return confirmed;
  }

  /**
   * Returns a merkle tree for the height whose root has been checked against a
   * header we verified the proof of work on, downloading the block if it is not
   * already cached.
   */
  private async ensureBlockTree(height: number): Promise<CachedBlockTree | null> {
    const header = await this.headers.getHeader(height);
    if (!header) {
      spvVerificationsTotal.inc({ outcome: "header_unavailable" });
      return null;
    }
    const expectedRoot = header.merkle_root.toLowerCase();

    const cached = this.getCachedBlockTree(height);
    if (cached) {
      if (cached.merkleRoot === expectedRoot) return cached;
      // Header changed under us (reorg). Drop the stale tree and retry next cycle.
      this.blockTrees.delete(height);
      spvVerificationsTotal.inc({ outcome: "block_root_mismatch" });
      log.warn({ height }, "Cached block tree no longer matches header — discarded");
      return null;
    }

    const txids = await this.fetchBlockTxids(height);
    if (!txids) return null;

    const tree = buildBlockMerkleTree(txids);
    if (!tree) {
      spvVerificationsTotal.inc({ outcome: "block_list_malformed" });
      return null;
    }

    // The whole basis of trusting this list. It came from an unauthenticated
    // API, but only the real transaction set in the real order hashes to the
    // root of a header we have already checked the proof of work on. Anything
    // altered fails here and the block is discarded entirely.
    if (tree.root !== expectedRoot) {
      spvVerificationsTotal.inc({ outcome: "block_root_mismatch" });
      log.warn(
        { height, computed: tree.root, expected: header.merkle_root },
        "Block transaction list did not hash to the verified header root — discarded",
      );
      return null;
    }

    this.rememberBlockTree(height, tree, txids.length, expectedRoot);
    const stored = this.getCachedBlockTree(height);
    if (stored) {
      log.info(
        { height, blockTxCount: txids.length, cacheSize: this.blockTrees.size },
        "Cached verified block merkle tree",
      );
    }
    return stored;
  }

  private async verifyOneBlock(
    height: number,
    rows: PendingTxRow[],
    done: Set<string>,
  ): Promise<number> {
    if (rows.length === 0) return 0;

    const cacheHit = this.blockTrees.has(height);
    const cached = await this.ensureBlockTree(height);
    if (!cached) return 0;

    const confirmed = await this.confirmRowsFromTree(height, rows, done);
    log.info(
      {
        height,
        blockTxCount: cached.blockTxCount,
        ours: rows.length,
        confirmed,
        cacheHit,
      },
      "Derived merkle proofs locally from a block",
    );
    return confirmed;
  }

  private async confirmRowsFromTree(
    height: number,
    rows: PendingTxRow[],
    done: Set<string>,
  ): Promise<number> {
    const cached = this.getCachedBlockTree(height);
    if (!cached) return 0;

    const { tree } = cached;
    const proofs: Array<{ txid: string; bumpHex: string; blockHeight: number }> = [];
    const minedWithoutBump: string[] = [];
    const publishRows: PendingTxRow[] = [];
    const absent: string[] = [];

    for (const row of rows) {
      if (done.has(row.txid)) continue;
      const txid = row.txid.toLowerCase();
      const index = tree.indexOf.get(txid);
      if (index === undefined) {
        // Something recorded this height, but a proof-of-work-verified tree for
        // it does not contain the transaction, so the height is simply wrong.
        spvVerificationsTotal.inc({ outcome: "absent_from_block" });
        absent.push(row.txid);
        continue;
      }

      const bump = branchToBumpHex(height, txid, index, tree.branchFor(index), tree.root);
      if (bump) {
        proofs.push({ txid: row.txid, bumpHex: bump, blockHeight: height });
      } else {
        // Inclusion is already proven by the root match above, so the row is
        // still confirmed; only the portable proof could not be assembled.
        spvVerificationsTotal.inc({ outcome: "bump_encode_failed" });
        minedWithoutBump.push(row.txid);
      }
      publishRows.push(row);
      done.add(row.txid);
    }

    if (proofs.length > 0) {
      await recordVerifiedProofsBatch(this.db, proofs);
      spvVerificationsTotal.inc({ outcome: "verified_block" }, proofs.length);
    }

    if (minedWithoutBump.length > 0) {
      await this.db("tx_results").whereIn("txid", minedWithoutBump).update({
        status: "MINED",
        block_height: height,
        spv_verified: true,
      });
      spvVerificationsTotal.inc({ outcome: "verified_block" }, minedWithoutBump.length);
    }

    if (absent.length > 0) {
      // Clearing the stale height is what stops the drain fetching these same
      // rows every cycle, and lets the status pass rediscover the real block.
      await this.db("tx_results")
        .whereIn("txid", absent)
        .where("status", "SEEN_ON_NETWORK")
        .update({ block_height: null, last_checked_at: this.db.fn.now() });
      log.warn(
        { height, absent: absent.length },
        "Rows recorded at a height the verified block does not contain — height cleared",
      );
    }

    // Live subscribers; catch-up must not serialise thousands of awaits.
    for (const row of publishRows) {
      void this.publishMined(row, height);
    }

    return publishRows.length;
  }

  /**
   * The block's full transaction id list, in order.
   *
   * Large blocks are paginated at 50,000 ids, so even a busy block is two or
   * three requests. Returns null unless the complete list arrives — a partial
   * list would hash to the wrong root anyway, and bailing early saves the work.
   */
  private async fetchBlockTxids(height: number): Promise<string[] | null> {
    const summary = await this.woc.getJson<BlockSummary>(`/block/height/${height}`, {
      label: "block_summary",
      timeoutMs: BLOCK_REQUEST_TIMEOUT_MS,
      allowNotFound: true,
    });
    if (!summary?.hash) return null;

    const total = Number(summary.txcount ?? summary.num_tx ?? 0);
    if (!Number.isFinite(total) || total <= 0) return null;

    // Guards the heap: the tree for a block this size is already tens of
    // megabytes, and the per-transaction path remains available above it.
    if (total > MAX_BLOCK_TX_FOR_LOCAL_PROOFS) {
      log.debug({ height, total }, "Block too large for local proof derivation");
      return null;
    }

    const pageSize = Number(summary.pages?.size ?? 0);
    if (!summary.pages?.uri?.length || pageSize <= 0) {
      // Small blocks are returned inline with no pagination.
      return Array.isArray(summary.tx) && summary.tx.length === total ? summary.tx : null;
    }

    const txids: string[] = [];
    const pageCount = Math.ceil(total / pageSize);

    for (let page = 1; page <= pageCount; page++) {
      const rows = await this.woc.getJson<string[]>(
        `/block/hash/${summary.hash}/page/${page}`,
        { label: "block_page", timeoutMs: BLOCK_REQUEST_TIMEOUT_MS, allowNotFound: true },
      );
      if (!Array.isArray(rows) || rows.length === 0) return null;
      // Appended one at a time; spreading 50,000 arguments overflows the stack.
      for (const txid of rows) txids.push(txid);
    }

    return txids.length === total ? txids : null;
  }

  private async processPendingRow(
    row: PendingTxRow,
    wocBlockHeight: number | undefined,
    allowPerTxProof: boolean,
  ): Promise<number> {
    const txid = row.txid;
    const age = Date.now() - Number(row.timestamp);
    try {
      // Arcade is asked only when it can answer something worth having: a BUMP
      // for a transaction already known to be in a block, or a rejection
      // verdict for one old enough that its absence from the chain is
      // suspicious. Asking for every pending row was one request per row per
      // cycle for an answer that was almost always "still pending".
      const shouldAskArcade =
        (allowPerTxProof && wocBlockHeight !== undefined)
        || age > REJECTION_RECHECK_AGE_MS;
      const arcade = shouldAskArcade ? await this.fetchArcadeProof(txid) : null;
      const arcadeStatus = (arcade?.txStatus ?? arcade?.status ?? "").toUpperCase();

      if (arcade?.merklePath) {
        const result = await verifyBump(txid, arcade.merklePath, this.headers);
        if (result.verified && result.blockHeight !== undefined) {
          await recordVerifiedProof(this.db, txid, arcade.merklePath, result.blockHeight);
          await this.publishMined(row, result.blockHeight);
          return 1;
        }
        await recordUnverifiedProof(
          this.db,
          txid,
          arcade.merklePath,
          result.blockHeight ?? arcade.blockHeight,
          result.reason ?? "verification failed",
        );
        // Deliberately fall through rather than returning. One source offering
        // a proof that does not recompute says nothing about whether the
        // transaction is in a block — only that this proof cannot show it.
      }

      if (arcadeStatus === "REJECTED" || arcadeStatus === "DOUBLE_SPEND_ATTEMPTED") {
        await updateTxStatus(this.db, txid, "FAILED");
        log.error({ txid, status: arcadeStatus }, "Transaction terminally rejected by the network");
        if (this.onTerminalRejection) {
          await this.onTerminalRejection(txid).catch((err: unknown) => {
            log.error({ err, txid }, "Failed to unwind a rejection found by polling");
          });
        }
        return 0;
      }

      if (wocBlockHeight !== undefined) {
        if (allowPerTxProof) {
          const woc = await this.verifyViaWoc(txid, wocBlockHeight);
          if (woc) {
            await this.db("tx_results").where({ txid }).update({
              status: "MINED",
              block_height: woc.blockHeight,
              spv_verified: true,
            });
            await this.publishMined(row, woc.blockHeight);
            return 1;
          }
        }

        // In a block but not proved this cycle — record the height so the row
        // is not mistaken for one the network never saw. The block/sweep path
        // will finish it once that height is cached; buying a TSC proof here
        // for every leftover is what used to burn the rate budget.
        await this.db("tx_results")
          .where({ txid })
          .update({ block_height: wocBlockHeight });
        return 0;
      }

      // Nothing anywhere after a full day means it never propagated.
      if (age > STALE_TX_MAX_AGE_MS && shouldAskArcade && !arcade) {
        await updateTxStatus(this.db, txid, "FAILED");
        log.debug({ txid }, "Marked stale tx as FAILED (>24h with no proof from any source)");
      }
      return 0;
    } catch (err) {
      log.debug({ err, txid }, "Proof check failed for transaction");
      return 0;
    }
  }

  /**
   * Block heights for every pending txid, keyed lower-case. An empty map means
   * "none are mined"; a WoC outage yields an empty map too, which costs a cycle
   * rather than risking a wrong terminal verdict.
   */
  private async fetchWocBlockHeights(txids: string[]): Promise<Map<string, number>> {
    const heights = new Map<string, number>();
    try {
      const statuses = await this.woc.fetchTxStatuses(txids);
      if (!statuses) return heights;
      for (const [txid, status] of statuses) {
        heights.set(txid, status.blockHeight);
      }
    } catch (err) {
      if (isWocUnavailable(err)) {
        log.warn(
          { pending: txids.length, reason: (err as Error).message },
          "Confirmation cycle could not reach WhatsOnChain — retrying next cycle",
        );
      } else {
        log.error({ err }, "Bulk confirmation status lookup failed");
      }
    }
    return heights;
  }

  private async publishMined(row: PendingTxRow, blockHeight: number): Promise<void> {
    if (!this.redisPublisher) return;
    const message = JSON.stringify({
      txid: row.txid,
      status: "MINED",
      aircraft_icao: row.aircraft_icao,
      record_type: Number(row.record_type),
      timestamp: Number(row.timestamp),
      size_bytes: Number(row.size_bytes),
      fee_sats: Number(row.fee_sats),
      block_height: blockHeight,
      chronicle_validated: !!row.chronicle_validated,
      spv_verified: true,
    });
    await this.redisPublisher.publish("txresult", message).catch(() => {});
  }

  /**
   * Rows for the discovery pass, whose only job is to learn which block a
   * transaction is in so the drain can prove it later.
   *
   * The batch is split deliberately. A pure never-checked-first ordering meant
   * the constant stream of new writes filled every cycle, so each transaction
   * got exactly one look — at an age when a block almost certainly had not
   * arrived yet — and was then never revisited. Half the budget now goes to
   * rows due a re-check, which is what lets the backlog make progress.
   */
  private async selectDiscoveryBatch(): Promise<PendingTxRow[]> {
    const eligibleBefore = Date.now() - MIN_CONFIRMATION_AGE_MS;
    const newShare = Math.floor(BATCH_SIZE * DISCOVERY_NEW_SHARE);

    const [fresh, stale] = await Promise.all([
      this.db("tx_results")
        .where("status", "SEEN_ON_NETWORK")
        .where("timestamp", "<=", eligibleBefore)
        .whereNull("last_checked_at")
        .select(ConfirmationPoller.PENDING_COLUMNS)
        .limit(newShare) as Promise<PendingTxRow[]>,
      this.db("tx_results")
        .where("status", "SEEN_ON_NETWORK")
        .where("timestamp", "<=", eligibleBefore)
        .whereNotNull("last_checked_at")
        .where("last_checked_at", "<=", new Date(Date.now() - RECHECK_AFTER_MS))
        .orderBy("last_checked_at", "asc")
        .select(ConfirmationPoller.PENDING_COLUMNS)
        .limit(BATCH_SIZE - newShare) as Promise<PendingTxRow[]>,
    ]);

    const seen = new Set<string>();
    const batch: PendingTxRow[] = [];
    for (const row of [...fresh, ...stale]) {
      if (seen.has(row.txid)) continue;
      seen.add(row.txid);
      batch.push(row);
    }
    return batch;
  }

  async poll(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let confirmed = 0;

    try {
      // Backlog first, and without spending a single status request. Rows that
      // already carry a height only need the block, so this runs whether or not
      // the discovery pass below finds anything.
      const drainDone = new Set<string>();
      confirmed += await this.drainKnownMinedBacklog(drainDone);

      const pending = await this.selectDiscoveryBatch();

      if (pending.length === 0) {
        if (confirmed === 0) this.switchToSteadyState();
        return confirmed;
      }

      this.switchToCatchupState();

      // One bulk lookup answers "is it in a block?" for the whole batch. The
      // previous per-row pair of requests meant a 200-row cycle asked
      // WhatsOnChain 400 times every ten seconds, which is well past the free
      // tier's budget — so it answered 429, nothing could be confirmed, the
      // backlog never drained, and the poller stayed in catch-up forever.
      const mined = await this.fetchWocBlockHeights(pending.map((row) => row.txid));

      // Where many rows share a block, download that block once (or reuse a
      // cached tree) and prove them locally. Buying a proof each would cost
      // one metered request per row; the block costs two or three however many
      // rows it settles, and a cache hit costs none.
      const settled = await this.verifyBlockBatches(pending, mined);
      confirmed += settled.confirmed;
      for (const txid of drainDone) settled.done.add(txid);

      // Zero-RPS catch-up: every pending row that sits inside a tree we already
      // hold can be proved without asking a provider again.
      confirmed += await this.sweepAgainstCachedTrees(settled.done);

      const remaining = pending.filter((row) => !settled.done.has(row.txid));
      let perTxProofBudget = MAX_PER_TX_PROOFS_PER_CYCLE;

      for (let i = 0; i < remaining.length; i += POLL_CONCURRENCY) {
        const slice = remaining.slice(i, i + POLL_CONCURRENCY);
        // Budget is assigned before the concurrent work so a parallel slice
        // cannot overshoot MAX_PER_TX_PROOFS_PER_CYCLE.
        const allowPerTx = slice.map((row) => {
          const height = mined.get(row.txid.toLowerCase());
          if (height === undefined || perTxProofBudget <= 0) return false;
          perTxProofBudget -= 1;
          return true;
        });
        const results = await Promise.all(
          slice.map((row, index) =>
            this.processPendingRow(
              row,
              mined.get(row.txid.toLowerCase()),
              allowPerTx[index]!,
            ),
          ),
        );
        confirmed += results.reduce((sum, value) => sum + value, 0);

        if (i + POLL_CONCURRENCY < remaining.length) {
          await sleep(BATCH_PAUSE_MS);
        }
      }

      // Stamp the whole batch, confirmed or not. This is what rotates the
      // queue: rows just examined go to the back, so the next cycle reaches
      // rows it has not seen instead of re-reading these.
      await this.db("tx_results")
        .whereIn("txid", pending.map((row) => row.txid))
        .update({ last_checked_at: this.db.fn.now() });

      if (confirmed > 0 || pending.length === BATCH_SIZE) {
        log.info(
          {
            confirmed,
            checked: pending.length,
            inBlock: mined.size,
            drained: drainDone.size,
            cachedBlocks: this.blockTrees.size,
            mode: this.mode,
          },
          "Confirmation poll cycle completed",
        );
      }
    } catch (err) {
      log.error({ err }, "Confirmation poll cycle error");
    } finally {
      this.running = false;
    }

    return confirmed;
  }
}

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

/**
 * Walks a TSC merkle branch to the root. A `*` node means the sibling is the
 * working hash itself, which is how an odd level is padded.
 */
export function computeTscRoot(
  txid: string,
  index: number,
  nodes: string[],
): string | null {
  if (!Number.isInteger(index) || index < 0) return null;

  let working = hexToLeBytes(txid.toLowerCase());
  let position = index;

  for (const node of nodes) {
    const sibling = node === "*" ? working : hexToLeBytes(node.toLowerCase());
    if (sibling.length !== 32 || working.length !== 32) return null;

    const concatenated = position % 2 === 0
      ? [...working, ...sibling]
      : [...sibling, ...working];
    working = Hash.hash256(concatenated) as number[];
    position = Math.floor(position / 2);
  }

  return leBytesToHex(working);
}
