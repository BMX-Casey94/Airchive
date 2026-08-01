import type { Knex } from "knex";

/**
 * Separates the two kinds of deferred telemetry, which until now shared one
 * table and one policy.
 *
 * A write deferred by a momentary broadcaster blip is genuinely superseded by
 * the next sample a second later, so collapsing those to the latest position
 * per aircraft is correct — replaying stale coordinates helps nobody. But the
 * same collapse was applied during a funding outage, where it silently
 * destroyed the archive: every arriving sample deleted the previously held one,
 * so a multi-day dry treasury preserved exactly one telemetry frame per
 * aircraft out of the millions that occurred, while the dashboard reported the
 * writes as "held, not discarded".
 *
 * Rows flagged `preserved` are exempt from coalescing and drain in
 * chronological order once funding returns. They are aged out on a retention
 * window instead, so an unattended outage cannot fill the disk.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pending_writes", (table) => {
    table.boolean("preserved").notNullable().defaultTo(false);
  });

  // Pruning and the coalescing scan both filter on this flag; partial because
  // preserved rows only exist during an outage and should not weigh on the
  // index in normal operation.
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS pending_writes_preserved_created_idx
       ON pending_writes (created_at)
      WHERE preserved = true`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("DROP INDEX IF EXISTS pending_writes_preserved_created_idx");
  await knex.schema.alterTable("pending_writes", (table) => {
    table.dropColumn("preserved");
  });
}
