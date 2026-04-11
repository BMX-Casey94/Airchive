import type { Knex } from "knex";
import { updateTxStatus } from "@airchive/db";
import { createLogger } from "@airchive/logger";

const log = createLogger({ service: "blockchain-writer:confirmation-poller" });

const POLL_INTERVAL_MS = 2 * 60 * 1_000;
const BATCH_SIZE = 25;
const WOC_DELAY_MS = 300;

interface WocTxStatus {
  txid: string;
  blockheight: number;
  blockhash: string;
  confirmations: number;
}

export class ConfirmationPoller {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly db: Knex,
    private readonly wocApiUrl: string,
  ) {}

  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    log.info({ intervalMs: POLL_INTERVAL_MS }, "Confirmation poller started");
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
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
        .select("txid");

      if (pending.length === 0) {
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

          if (!res.ok) continue;

          const data = (await res.json()) as WocTxStatus;
          if (data.confirmations > 0 && data.blockheight > 0) {
            await updateTxStatus(this.db, txid, "MINED", data.blockheight);
            confirmed++;
          }

          await new Promise((r) => setTimeout(r, WOC_DELAY_MS));
        } catch {
          /* individual tx check failure is non-fatal */
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
