import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tx_results", (table) => {
    table.boolean("chronicle_validated").notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tx_results", (table) => {
    table.dropColumn("chronicle_validated");
  });
}
