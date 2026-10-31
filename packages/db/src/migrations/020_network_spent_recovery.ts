import type { Knex } from "knex";

/**
 * Recovery state for a quarantined outpoint whose spender was accepted by one
 * Teranode node and then never propagated.
 *
 * The writer rebroadcasts that already-signed transaction and records the
 * result here. Rows already in the table stay quarantined. The new columns
 * have constant defaults, so this migration does not update or delete any
 * existing data.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("network_spent_outpoints", (table) => {
    table.string("recovery_status", 20).notNullable().defaultTo("pending");
    table.integer("recovery_attempts").notNullable().defaultTo(0);
    table.timestamp("last_attempt_at", { useTz: true }).nullable();
    table.text("recovery_detail").nullable();
    table.index(["recovery_status"], "network_spent_outpoints_recovery_status_idx");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("network_spent_outpoints", (table) => {
    table.dropIndex(["recovery_status"], "network_spent_outpoints_recovery_status_idx");
    table.dropColumn("recovery_status");
    table.dropColumn("recovery_attempts");
    table.dropColumn("last_attempt_at");
    table.dropColumn("recovery_detail");
  });
}
