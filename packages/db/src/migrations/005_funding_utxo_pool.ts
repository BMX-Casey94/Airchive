import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("funding_utxo_pool", (table) => {
    table.specificType("txid", "char(64)").notNullable();
    table.integer("vout").notNullable();
    table.bigInteger("satoshis").notNullable();
    table.text("locking_script").notNullable();
    table.boolean("is_locked").notNullable().defaultTo(false);
    table.timestamp("created_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());
    table.primary(["txid", "vout"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("funding_utxo_pool");
}
