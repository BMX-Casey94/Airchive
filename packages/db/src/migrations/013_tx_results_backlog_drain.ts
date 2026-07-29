import type { Knex } from "knex";

/**
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, and on a table
 * carrying a million rows of live write traffic a blocking build is not an
 * option.
 */
export const config = { transaction: false };

/**
 * A concurrent build that fails part-way leaves the index in place but marked
 * invalid. Postgres will not use it, and `IF NOT EXISTS` considers the name
 * taken, so a retry silently produces a database that looks migrated and still
 * sequentially scans. Clearing the carcass first makes the migration idempotent
 * in the way it actually needs to be.
 */
async function createIndexConcurrently(
  knex: Knex,
  name: string,
  definition: string,
): Promise<void> {
  const invalid = await knex.raw(
    `select 1
       from pg_class c
       join pg_index i on i.indexrelid = c.oid
      where c.relname = ? and i.indisvalid = false`,
    [name],
  );

  if (invalid.rows.length > 0) {
    await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS ??`, [name]);
  }

  await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ${definition}`);
}

/**
 * Supports draining the confirmation backlog by block rather than by row.
 *
 * Confirmations had become structurally impossible to catch up on. The poller
 * asked a provider which block each pending transaction was in, and could only
 * ask about a few hundred per cycle, so at the current write rate every cycle
 * was consumed by transactions that had only just become eligible — an age at
 * which a block has usually not arrived — and the million rows behind them
 * were never reached.
 *
 * Rows that an earlier pass already located carry `block_height`, and those
 * need no further questions: one block download proves every row sharing that
 * height. This index is what makes finding those heights cheap, both for the
 * grouped query that picks the busiest ones and for the paged reads that then
 * clear them.
 *
 * Partial, because only unconfirmed rows are ever drained. That keeps the index
 * small and, more importantly, keeps it shrinking as the backlog clears rather
 * than growing with every transaction ever written.
 */
export async function up(knex: Knex): Promise<void> {
  await createIndexConcurrently(
    knex,
    "tx_results_pending_height_idx",
    `ON tx_results (block_height)
      WHERE status = 'SEEN_ON_NETWORK' AND block_height IS NOT NULL`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("DROP INDEX CONCURRENTLY IF EXISTS tx_results_pending_height_idx");
}
