import type { Knex } from "knex";

/**
 * SPV storage. Two gaps are closed here:
 *
 * 1. There was no header storage at all, so a merkle proof could never be
 *    checked against anything — "SPV Verified" in the dashboard only tested
 *    that `merkle_path` was non-null.
 * 2. `merkle_path` held whatever an upstream reported, unverified. `bump` now
 *    holds the BUMP as received and `spv_verified` records whether it was
 *    actually checked against a header whose proof of work we validated.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("block_headers", (table) => {
    table.integer("height").primary();
    table.specificType("hash", "char(64)").notNullable().unique();
    table.specificType("prev_hash", "char(64)").notNullable();
    table.specificType("merkle_root", "char(64)").notNullable();
    table.bigInteger("time").notNullable();
    table.bigInteger("bits").notNullable();
    table.bigInteger("nonce").notNullable();
    table.bigInteger("version").notNullable();
    table.timestamp("created_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());
    table.index(["merkle_root"], "block_headers_merkle_root_idx");
  });

  await knex.schema.alterTable("tx_results", (table) => {
    table.text("bump").nullable();
    table.boolean("spv_verified").notNullable().defaultTo(false);
  });

  // The proof poller scans for transactions still awaiting a verified proof.
  await knex.schema.alterTable("tx_results", (table) => {
    table.index(["status", "spv_verified"], "tx_results_status_spv_idx");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tx_results", (table) => {
    table.dropIndex(["status", "spv_verified"], "tx_results_status_spv_idx");
    table.dropColumn("spv_verified");
    table.dropColumn("bump");
  });
  await knex.schema.dropTableIfExists("block_headers");
}
