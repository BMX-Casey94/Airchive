import type { Knex } from "knex";
import { createLogger } from "@airchive/logger";
import { outpointKey } from "./live-path-policy.js";
import { networkSpentOutpointsQuarantinedTotal } from "./metrics.js";

const log = createLogger({ service: "blockchain-writer:network-spent" });

const TABLE = "network_spent_outpoints";

export interface NetworkSpentOutpoint {
  txid: string;
  vout: number;
  spentBy: string;
}

/**
 * Teranode's double-spend line, as Arcade relays it:
 * `UTXO_SPENT (70): <parent>:<vout> utxo already spent by tx <spender>[0]`.
 */
const SPENT_BY_PATTERN = /([0-9a-f]{64}):(\d+) utxo already spent by tx ([0-9a-f]{64})/gi;

export function parseNetworkSpentOutpoints(
  reason: string | null | undefined,
): NetworkSpentOutpoint[] {
  if (!reason) return [];
  const found = new Map<string, NetworkSpentOutpoint>();
  for (const [, parent, voutText, spender] of reason.matchAll(SPENT_BY_PATTERN)) {
    if (!parent || !voutText || !spender) continue;
    const txid = parent.toLowerCase();
    const vout = Number(voutText);
    if (!Number.isSafeInteger(vout) || vout < 0) continue;
    found.set(outpointKey(txid, vout), { txid, vout, spentBy: spender.toLowerCase() });
  }
  return [...found.values()];
}

/**
 * Outpoints the network says are already spent. Explorers can keep listing
 * them as unspent when the spender was accepted by a node but never mined, so
 * every chain read used to rebuild the pools is filtered through this set.
 * Following the wallet-toolbox rule, a double-spent input is left spent rather
 * than offered for spending again.
 */
export class NetworkSpentRegistry {
  private readonly keys = new Set<string>();

  constructor(private readonly db: Knex) {}

  async load(): Promise<number> {
    try {
      const rows = await this.db(TABLE).select("txid", "vout") as Array<{ txid: string; vout: number }>;
      for (const row of rows) this.keys.add(outpointKey(String(row.txid).trim(), Number(row.vout)));
      log.info({ count: this.keys.size }, "Loaded outpoints the network reports as already spent");
    } catch (err) {
      log.error(
        { err },
        "Could not load network-spent outpoints — quarantine starts empty for this run",
      );
    }
    return this.keys.size;
  }

  has(txid: string, vout: number): boolean {
    return this.keys.has(outpointKey(txid.trim(), vout));
  }

  filter<T extends { tx_hash: string; tx_pos: number }>(utxos: T[]): T[] {
    if (this.keys.size === 0) return utxos;
    return utxos.filter((utxo) => !this.has(utxo.tx_hash, utxo.tx_pos));
  }

  /**
   * Records the outpoints and removes them from both pools. The in-memory set
   * is updated first so a reconcile that runs while the write is in flight
   * cannot re-import them.
   */
  async quarantine(outpoints: NetworkSpentOutpoint[], rejectedTxid: string): Promise<number> {
    const fresh = outpoints.filter((o) => !this.has(o.txid, o.vout));
    for (const o of fresh) this.keys.add(outpointKey(o.txid, o.vout));
    if (outpoints.length === 0) return 0;

    try {
      if (fresh.length > 0) {
        await this.db(TABLE)
          .insert(fresh.map((o) => ({
            txid: o.txid,
            vout: o.vout,
            spent_by_txid: o.spentBy,
            rejected_txid: rejectedTxid,
          })))
          .onConflict(["txid", "vout"])
          .ignore();
      }
      let removed = 0;
      for (const o of outpoints) {
        removed += await this.db("utxo_pool").where({ txid: o.txid, vout: o.vout }).delete();
        removed += await this.db("funding_utxo_pool").where({ txid: o.txid, vout: o.vout }).delete();
      }
      if (fresh.length > 0) {
        networkSpentOutpointsQuarantinedTotal.inc(fresh.length);
        log.warn(
          {
            rejectedTxid: rejectedTxid.slice(0, 12),
            outpoints: fresh.map((o) => `${o.txid.slice(0, 12)}:${o.vout}`),
            spentBy: fresh.map((o) => o.spentBy.slice(0, 12)),
            poolRowsRemoved: removed,
          },
          "Quarantined outpoints the network reports as already spent — they will not be re-imported from explorers",
        );
      }
    } catch (err) {
      log.error(
        { err, rejectedTxid: rejectedTxid.slice(0, 12) },
        "Could not persist network-spent outpoints — they stay quarantined until this process restarts",
      );
    }
    return fresh.length;
  }
}
