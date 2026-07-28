import type { Knex } from "knex";

/**
 * Without the raw envelope, a stored transaction cannot be decoded from the
 * database at all: the overlay's row decoder had nothing to read and always
 * returned null, so the explorer could show that a write happened but never
 * what it contained. Storing the flat AIRCHIVE envelope written into the
 * OP_RETURN makes history self-describing without a round trip to a miner API.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tx_results", (table) => {
    table.binary("op_return").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tx_results", (table) => {
    table.dropColumn("op_return");
  });
}
