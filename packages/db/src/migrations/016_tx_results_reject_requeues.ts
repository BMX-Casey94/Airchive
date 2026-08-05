import type { Knex } from "knex";

/**
 * Counts how many times a rejected broadcast has been re-queued for a fresh
 * attempt. The writer deletes the pending row as soon as Arcade accepts a
 * delivery; when the network later rejects that transaction the sample would
 * otherwise be lost even though the OP_RETURN bytes are still on this row.
 *
 * A small ceiling stops a permanently unmineable payload from looping forever.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tx_results", (table) => {
    table.integer("reject_requeues").notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tx_results", (table) => {
    table.dropColumn("reject_requeues");
  });
}
