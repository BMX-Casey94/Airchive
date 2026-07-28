import type { Knex } from "knex";
import { Hash } from "@bsv/sdk";
import { updateTxStatus } from "@airchive/db";
import { createLogger } from "@airchive/logger";
import { spvVerificationsTotal } from "./metrics.js";
import type { HeaderStore } from "./header-store.js";
import { recordUnverifiedProof, recordVerifiedProof, verifyBump } from "./spv.js";
import type { ChainLookup } from "./chain-lookup.js";
import { isWocUnavailable } from "./woc-client.js";

const log = createLogger({ service: "blockchain-writer:confirmation-poller" });

const STEADY_INTERVAL_MS = 60_000;
const CATCHUP_INTERVAL_MS = 10_000;
const BATCH_SIZE = 200;
const RECENT_BATCH_SIZE = 160;
const BACKLOG_BATCH_SIZE = BATCH_SIZE - RECENT_BATCH_SIZE;
const POLL_CONCURRENCY = 12;
const BATCH_PAUSE_MS = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const STALE_TX_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

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
  nodes: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Backstop for the Arcade SSE status stream.
 *
 * Where this previously accepted an API's word that a transaction was mined,
 * it now insists on a merkle proof that verifies against a header whose proof
 * of work has been checked locally. A transaction only reaches MINED once that
 * succeeds; anything weaker is recorded as an unverified proof and retried.
 */
export class ConfirmationPoller {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private mode: PollMode = "catchup";
  private redisPublisher: { publish(channel: string, message: string): Promise<number> } | null = null;
  private onTerminalRejection: ((txid: string) => Promise<void>) | null = null;

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

  nudge(): void {
    if (!this.intervalId) return;
    this.switchToCatchupState();
    if (!this.running) {
      void this.poll();
    }
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
    if (!proof || !Array.isArray(proof.nodes)) return null;

    const header = await this.headers.getHeader(blockHeight);
    if (!header) return null;

    // The proof targets a block hash; it must be the block we verified.
    if (proof.target.toLowerCase() !== header.hash.toLowerCase()) {
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

  private async processPendingRow(
    row: PendingTxRow,
    wocBlockHeight: number | undefined,
  ): Promise<number> {
    const txid = row.txid;
    try {
      const arcade = await this.fetchArcadeProof(txid);
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
        // transaction is in a block — only that this proof cannot show it. The
        // TSC path below is checked against the same local header, so trying it
        // costs no trust, and returning here would strand a genuinely mined
        // transaction purely because the first proof it was handed was bad.
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

        // In a block but not yet provable — usually the header for that height
        // has not synced. Record the height so the row is not mistaken for one
        // the network never saw, and let the next cycle finish the proof.
        await this.db("tx_results")
          .where({ txid })
          .update({ block_height: wocBlockHeight });
        return 0;
      }

      // Nothing anywhere after a full day means it never propagated.
      const age = Date.now() - Number(row.timestamp);
      if (age > STALE_TX_MAX_AGE_MS && !arcade) {
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

  async poll(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let confirmed = 0;

    try {
      const baseQuery = () =>
        this.db("tx_results")
          .where("status", "SEEN_ON_NETWORK")
          .select(
            "txid",
            "aircraft_icao",
            "size_bytes",
            "fee_sats",
            "timestamp",
            "record_type",
            "chronicle_validated",
          );

      const [recentPending, backlogPending] = await Promise.all([
        baseQuery()
          .orderBy("timestamp", "desc")
          .limit(RECENT_BATCH_SIZE) as Promise<PendingTxRow[]>,
        baseQuery()
          .orderBy("timestamp", "asc")
          .limit(BACKLOG_BATCH_SIZE) as Promise<PendingTxRow[]>,
      ]);

      const pending = Array.from(
        new Map(
          [...recentPending, ...backlogPending].map((row) => [row.txid, row]),
        ).values(),
      );

      if (pending.length === 0) {
        this.switchToSteadyState();
        return 0;
      }

      this.switchToCatchupState();

      // One bulk lookup answers "is it in a block?" for the whole batch. The
      // previous per-row pair of requests meant a 200-row cycle asked
      // WhatsOnChain 400 times every ten seconds, which is well past the free
      // tier's budget — so it answered 429, nothing could be confirmed, the
      // backlog never drained, and the poller stayed in catch-up forever.
      const mined = await this.fetchWocBlockHeights(pending.map((row) => row.txid));

      for (let i = 0; i < pending.length; i += POLL_CONCURRENCY) {
        const slice = pending.slice(i, i + POLL_CONCURRENCY);
        const results = await Promise.all(
          slice.map((row) =>
            this.processPendingRow(row, mined.get(row.txid.toLowerCase())),
          ),
        );
        confirmed += results.reduce((sum, value) => sum + value, 0);

        if (i + POLL_CONCURRENCY < pending.length) {
          await sleep(BATCH_PAUSE_MS);
        }
      }

      if (confirmed > 0 || pending.length === BATCH_SIZE) {
        log.info(
          {
            confirmed,
            checked: pending.length,
            recentChecked: recentPending.length,
            backlogChecked: backlogPending.length,
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
