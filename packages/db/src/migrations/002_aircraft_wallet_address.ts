import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("aircraft_config", (table) => {
    table.string("wallet_address", 64).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("aircraft_config", (table) => {
    table.dropColumn("wallet_address");
  });
}
