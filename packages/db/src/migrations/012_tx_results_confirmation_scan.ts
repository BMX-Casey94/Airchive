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
 * Makes the confirmation poller's scan an index lookup and gives it somewhere
 * to record progress.
 *
 * The poller selects unconfirmed transactions and orders them, but the only
 * indexes on `tx_results` were `(aircraft_icao, timestamp)` and
 * `(status, spv_verified)`. Neither serves `where status = ? order by ...`, so
 * every cycle ran a parallel sequential scan over the whole table — around 1.6
 * seconds and 100k buffers, twice every ten seconds.
 *
 * `last_checked_at` fixes a separate defect. Ordering the backlog purely by
 * `timestamp` meant the oldest rows were re-examined on every cycle, so any
 * transaction that could not be confirmed permanently occupied the head of the
 * queue and nothing behind it was ever reached. Stamping each row as it is
 * examined turns the scan into a rotation.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn("tx_results", "last_checked_at"))) {
    await knex.schema.alterTable("tx_results", (table) => {
      table.timestamp("last_checked_at", { useTz: false }).nullable();
    });
  }

  await createIndexConcurrently(
    knex,
    "tx_results_status_ts_idx",
    `ON tx_results (status, "timestamp")`,
  );

  // NULLS FIRST matches the poller's ordering, so never-checked rows are
  // reached before rows already examined once. Without it the planner cannot
  // use this index for that sort.
  await createIndexConcurrently(
    knex,
    "tx_results_status_checked_idx",
    "ON tx_results (status, last_checked_at ASC NULLS FIRST)",
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("DROP INDEX CONCURRENTLY IF EXISTS tx_results_status_checked_idx");
  await knex.raw("DROP INDEX CONCURRENTLY IF EXISTS tx_results_status_ts_idx");
  await knex.schema.alterTable("tx_results", (table) => {
    table.dropColumn("last_checked_at");
  });
}
