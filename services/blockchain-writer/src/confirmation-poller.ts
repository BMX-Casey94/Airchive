import type { Knex } from "knex";
import { updateTxStatus } from "@airchive/db";
import { createLogger } from "@airchive/logger";

const log = createLogger({ service: "blockchain-writer:confirmation-poller" });

const STEADY_INTERVAL_MS = 2 * 60 * 1_000;
const CATCHUP_INTERVAL_MS = 15_000;
const BATCH_SIZE = 50;
const WOC_DELAY_MS = 250;

interface WocTxStatus {
  txid: string;
  blockheight: number;
  blockhash: string;
  confirmations: number;
}

export class ConfirmationPoller {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
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
    void this.poll();
    this.intervalId = setInterval(() => void this.poll(), CATCHUP_INTERVAL_MS);
    log.info({ intervalMs: CATCHUP_INTERVAL_MS, batchSize: BATCH_SIZE }, "Confirmation poller started (catch-up mode)");
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private switchToSteadyState(): void {
    if (!this.intervalId) return;
    clearInterval(this.intervalId);
    this.intervalId = setInterval(() => void this.poll(), STEADY_INTERVAL_MS);
    log.info({ intervalMs: STEADY_INTERVAL_MS }, "Confirmation poller switched to steady-state mode");
  }

  async poll(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let confirmed = 0;

    try {
      const pending = await this.db("tx_results")
        .where("status", "SEEN_ON_NETWORK")
        .orderBy("timestamp", "asc")
        .limit(BATCH_SIZE)
        .select("txid", "aircraft_icao", "size_bytes", "fee_sats", "timestamp");

      if (pending.length === 0) {
        this.switchToSteadyState();
        this.running = false;
        return 0;
      }

      for (const row of pending) {
        try {
          const txid = row.txid as string;
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
            await new Promise((r) => setTimeout(r, WOC_DELAY_MS));
            continue;
          }

          const data = (await res.json()) as WocTxStatus;
          if (data.confirmations > 0 && data.blockheight > 0) {
            await updateTxStatus(this.db, txid, "MINED", data.blockheight);
            confirmed++;

            if (this.redisPublisher) {
              const txResultMsg = JSON.stringify({
                txid,
                status: "MINED",
                aircraft_icao: row.aircraft_icao,
                size_bytes: row.size_bytes,
                fee_sats: row.fee_sats,
                block_height: data.blockheight,
              });
              await this.redisPublisher.publish("txresult", txResultMsg).catch(() => {});
            }
          }

          await new Promise((r) => setTimeout(r, WOC_DELAY_MS));
        } catch {
          await new Promise((r) => setTimeout(r, WOC_DELAY_MS));
        }
      }

      if (confirmed > 0) {
        log.info({ confirmed, checked: pending.length }, "Transactions confirmed as mined");
      }
    } catch (err) {
      log.error({ err }, "Confirmation poll cycle error");
    } finally {
      this.running = false;
    }

    return confirmed;
  }
}
