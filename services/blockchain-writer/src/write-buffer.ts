import type { Knex } from "knex";
import type { Redis } from "ioredis";
import type { RecordType } from "@airchive/types";
import type { WalletVault } from "@airchive/crypto";
import {
  deletePendingWrite,
  getPendingWrites,
  insertPendingWrite,
  markWriteRetried,
} from "@airchive/db";
import { createLogger } from "@airchive/logger";
import type { ArcBroadcaster } from "./broadcaster.js";
import type { UtxoManager } from "./utxo-manager.js";
import { buildRawOpReturnTx } from "./tx-builder.js";
import { insertTxResult } from "@airchive/db";
import { pendingWritesGauge } from "./metrics.js";

const log = createLogger({ service: "blockchain-writer:write-buffer" });

const RETRY_INTERVAL_MS = 30_000;
const RETRY_BATCH_SIZE = 50;

export class WriteBuffer {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private retrying = false;
  private redisPublisher: Redis | null = null;

  constructor(
    private readonly db: Knex,
    private readonly broadcaster: ArcBroadcaster,
    private readonly utxoManager: UtxoManager,
    private readonly vault: WalletVault,
  ) {}

  setRedisPublisher(redis: Redis): void {
    this.redisPublisher = redis;
  }

  async buffer(
    icao: string,
    recordType: RecordType,
    payload: Uint8Array,
    flightId?: string,
  ): Promise<void> {
    await insertPendingWrite(this.db, {
      aircraft_icao: icao,
      record_type: recordType,
      payload: Buffer.from(payload),
      flight_id: flightId,
    });

    pendingWritesGauge.inc();
    log.debug({ icao, recordType }, "Write buffered for retry");
  }

  startRetryLoop(): void {
    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      void this.retry();
    }, RETRY_INTERVAL_MS);

    log.info({ intervalMs: RETRY_INTERVAL_MS }, "Write-buffer retry loop started");
  }

  stopRetryLoop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async retry(): Promise<number> {
    if (this.retrying) return 0;
    this.retrying = true;
    let successCount = 0;

    try {
      const pending = await getPendingWrites(this.db, RETRY_BATCH_SIZE);
      if (pending.length === 0) return 0;

      log.debug({ count: pending.length }, "Processing pending writes");

      for (const write of pending) {
        const icao = write.aircraft_icao;
        let utxoAcquired = false;
        let utxoTxid = "";
        let utxoVout = 0;

        try {
          const privateKey = this.vault.getAircraftPrivateKey(icao);
          const utxo = await this.utxoManager.acquireUtxo(icao);
          utxoAcquired = true;
          utxoTxid = utxo.txid;
          utxoVout = utxo.vout;

          const payload =
            write.payload instanceof Buffer
              ? new Uint8Array(write.payload)
              : write.payload;

          const { tx, changeOutput } = await buildRawOpReturnTx({
            utxo,
            privateKey,
            icao,
            timestamp: Date.now(),
            recordType: write.record_type,
            payload,
          });

          const result = await this.broadcaster.broadcast(tx, icao);

          if (result.status === "FAILED") {
            await this.utxoManager.deleteStaleUtxo(utxo.txid, utxo.vout).catch(() => {});
            utxoAcquired = false;
            throw new Error("Broadcast returned FAILED status");
          }

          const txid = result.txid;

          await this.utxoManager.recordSpend(
            utxo.txid,
            utxo.vout,
            txid,
            1,
            changeOutput.satoshis,
            changeOutput.lockingScript,
            icao,
          );

          const retryResultRow = {
            txid,
            aircraft_icao: icao,
            record_type: write.record_type,
            status: "SEEN_ON_NETWORK" as const,
            timestamp: Date.now(),
            fee_sats: Number(utxo.satoshis) - changeOutput.satoshis,
            size_bytes: tx.toBinary().length,
            flight_id: write.flight_id ?? undefined,
          };
          await insertTxResult(this.db, retryResultRow);
          await this.redisPublisher?.publish("txresult", JSON.stringify(retryResultRow)).catch(() => {});

          await deletePendingWrite(this.db, write.id);
          pendingWritesGauge.dec();
          successCount++;
        } catch (err) {
          if (utxoAcquired) {
            await this.utxoManager
              .releaseUtxo(utxoTxid, utxoVout)
              .catch(() => {});
          }

          await markWriteRetried(
            this.db,
            write.id,
            (err as Error).message,
          ).catch(() => {});

          log.warn(
            { err, icao, writeId: write.id },
            "Pending write retry failed",
          );
        }
      }

      if (successCount > 0) {
        log.info({ successCount }, "Pending writes retried");
      }
    } catch (err) {
      log.error({ err }, "Write-buffer retry cycle error");
    } finally {
      this.retrying = false;
    }

    return successCount;
  }
}
