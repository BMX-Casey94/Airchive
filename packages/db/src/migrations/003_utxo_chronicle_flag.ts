import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("utxo_pool", (table) => {
    table.boolean("is_chronicle").notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("utxo_pool", (table) => {
    table.dropColumn("is_chronicle");
  });
}
