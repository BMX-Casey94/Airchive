import type { Knex } from "knex";

/**
 * Outpoints the network has refused to let us spend because another
 * transaction already spent them (Teranode UTXO_SPENT).
 *
 * The block explorers that reconcile and the startup sweep read can keep
 * listing such an outpoint as unspent when its spender was accepted by a node
 * but never mined. Without this record the pool re-imports it from them, the
 * next spend is rejected again, and the aircraft never writes. Rows are only
 * ever added from a network verdict naming the spender.
 */
function appRole(): string {
  return (process.env.POSTGRES_USER ?? "airchive").trim();
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("network_spent_outpoints", (table) => {
    table.string("txid", 64).notNullable();
    table.integer("vout").notNullable();
    table.string("spent_by_txid", 64).notNullable();
    table.string("rejected_txid", 64).nullable();
    table.timestamp("noted_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.primary(["txid", "vout"]);
  });
  await knex.raw(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.network_spent_outpoints TO ??",
    [appRole()],
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("network_spent_outpoints");
}
