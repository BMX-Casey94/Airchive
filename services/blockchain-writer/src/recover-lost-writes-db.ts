import { createDb } from "@airchive/db";
import { rebufferRejectedTransaction } from "./rebuffer-rejected.js";
import { WocClient } from "./woc-client.js";
import {
  RECOVERY_MAX_REQUEUES,
  executeRecovery,
  exitCodeFor,
  probeBulkStatuses,
  probeTxid,
  recoveryProviderOptions,
  selectCandidatePage,
  txHashLookupPath,
  txLookupPath,
  type RecoverCli,
} from "./recover-lost-writes.js";

/**
 * Opens Postgres and the chain provider. Loaded only after main() has copied
 * Docker *_FILE secrets into the environment, because the knex config is read
 * once, at import time.
 *
 * rebufferRejectedTransaction needs a database handle only. It does not use
 * the spend governor and it does not broadcast. maxRequeues is 1 so the claim
 * is idempotent per txid.
 */
export async function runFromCli(options: RecoverCli): Promise<number> {
  const provider = recoveryProviderOptions(options.verifyProvider, process.env);
  const client = new WocClient({
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    apiKeyHeader: provider.apiKeyHeader,
    maxRequestsPerSecond: provider.maxRequestsPerSecond,
    maxConcurrent: provider.maxConcurrent,
  });
  const bulk = options.verifyProvider === "woc-bulk";
  const db = createDb();
  try {
    const summary = await executeRecovery(options, {
      loadPage: (cursor, pageSize) => selectCandidatePage(db, {
        from: options.from,
        to: options.to,
        statuses: options.statuses,
        cursor,
      }, pageSize),
      lookup: (txid) => probeTxid(client, txid, bulk ? txHashLookupPath : txLookupPath),
      lookupBulk: bulk ? (txids) => probeBulkStatuses(client, txids) : undefined,
      requeue: (txid) => rebufferRejectedTransaction(txid, {
        db,
        maxRequeues: RECOVERY_MAX_REQUEUES,
      }),
      sleep: (ms) => new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
      log: (line) => {
        console.error(line);
      },
      listLine: (line) => {
        console.log(line);
      },
    });
    return exitCodeFor(summary);
  } finally {
    await db.destroy();
  }
}
