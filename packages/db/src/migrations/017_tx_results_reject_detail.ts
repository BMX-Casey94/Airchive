import type { Knex } from "knex";

/**
 * Stores the upstream verdict for a terminal reject so operators can diagnose
 * FAILED rows without replaying the SSE/poller stream. The rebuffer path also
 * reads these columns when it was not given live context (e.g. restart).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tx_results", (table) => {
    table.string("reject_status", 40).nullable();
    table.text("reject_reason").nullable();
    table.jsonb("reject_competing_txs").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tx_results", (table) => {
    table.dropColumn("reject_status");
    table.dropColumn("reject_reason");
    table.dropColumn("reject_competing_txs");
  });
}
