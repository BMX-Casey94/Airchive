import type { Knex } from "knex";

/**
 * `is_locked` was previously only ever cleared at process start, so a crash
 * mid-broadcast stranded a UTXO until the next restart. Recording when the lock
 * was taken lets the writer reclaim locks that outlive a broadcast attempt.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("utxo_pool", (table) => {
    table.timestamp("locked_at", { useTz: false }).nullable();
  });

  await knex.schema.alterTable("funding_utxo_pool", (table) => {
    table.timestamp("locked_at", { useTz: false }).nullable();
  });

  // Reclaim sweeps scan locked rows by age; without these the sweep degrades to
  // a sequential scan of a pool that runs to tens of thousands of rows.
  await knex.schema.alterTable("utxo_pool", (table) => {
    table.index(["is_locked", "locked_at"], "utxo_pool_lock_age_idx");
  });

  await knex.schema.alterTable("funding_utxo_pool", (table) => {
    table.index(["is_locked", "locked_at"], "funding_utxo_pool_lock_age_idx");
  });

  // Existing locks predate the column. Stamp them so the first sweep can reclaim
  // them rather than treating a NULL as "locked forever".
  await knex("utxo_pool").where({ is_locked: true }).update({ locked_at: knex.fn.now() });
  await knex("funding_utxo_pool").where({ is_locked: true }).update({ locked_at: knex.fn.now() });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("utxo_pool", (table) => {
    table.dropIndex(["is_locked", "locked_at"], "utxo_pool_lock_age_idx");
    table.dropColumn("locked_at");
  });

  await knex.schema.alterTable("funding_utxo_pool", (table) => {
    table.dropIndex(["is_locked", "locked_at"], "funding_utxo_pool_lock_age_idx");
    table.dropColumn("locked_at");
  });
}
