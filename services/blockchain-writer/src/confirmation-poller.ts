import type { Knex } from "knex";
import { updateTxStatus } from "@airchive/db";
import { createLogger } from "@airchive/logger";

const log = createLogger({ service: "blockchain-writer:confirmation-poller" });

const STEADY_INTERVAL_MS = 60_000;
const CATCHUP_INTERVAL_MS = 10_000;
const BATCH_SIZE = 200;
const RECENT_BATCH_SIZE = 160;
const BACKLOG_BATCH_SIZE = BATCH_SIZE - RECENT_BATCH_SIZE;
const POLL_CONCURRENCY = 12;
const BATCH_PAUSE_MS = 100;

type PollMode = "catchup" | "steady";

interface WocTxStatus {
  txid: string;
  blockheight: number;
  blockhash: string;
  confirmations: number;
}

interface PendingTxRow {
  txid: string;
  aircraft_icao: string;
  size_bytes: number | string;
  fee_sats: number | string;
  timestamp: number | string;
  record_type: number | string;
  chronicle_validated?: boolean | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ConfirmationPoller {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private mode: PollMode = "catchup";
  private redisPublisher: { publish(channel: string, message: string): Promise<number> } | null = null;

  constructor(
    private readonly db: Knex,
    private readonly wocApiUrl: string,
  ) {}

  setRedisPublisher(pub: { publish(channel: string, message: string): Promise<number> }): void {
    this.redisPublisher = pub;
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

  private async processPendingRow(row: PendingTxRow): Promise<number> {
    try {
      const txid = row.txid;
      const res = await fetch(`${this.wocApiUrl}/tx/${txid}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        if (res.status === 404) {
          const age = Date.now() - Number(row.timestamp);
          if (age > 24 * 60 * 60 * 1_000) {
            await updateTxStatus(this.db, txid, "FAILED");
            log.debug({ txid }, "Marked stale tx as FAILED (>24h, not found on WoC)");
          }
        }
        return 0;
      }

      const data = (await res.json()) as WocTxStatus;
      if (!(data.confirmations > 0 && data.blockheight > 0)) {
        return 0;
      }

      await updateTxStatus(this.db, txid, "MINED", data.blockheight);

      if (this.redisPublisher) {
        const txResultMsg = JSON.stringify({
          txid,
          status: "MINED",
          aircraft_icao: row.aircraft_icao,
          record_type: Number(row.record_type),
          timestamp: Number(row.timestamp),
          size_bytes: Number(row.size_bytes),
          fee_sats: Number(row.fee_sats),
          block_height: data.blockheight,
          chronicle_validated: !!row.chronicle_validated,
        });
        await this.redisPublisher.publish("txresult", txResultMsg).catch(() => {});
      }

      return 1;
    } catch {
      return 0;
    }
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

      for (let i = 0; i < pending.length; i += POLL_CONCURRENCY) {
        const slice = pending.slice(i, i + POLL_CONCURRENCY);
        const results = await Promise.all(
          slice.map((row) => this.processPendingRow(row)),
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
