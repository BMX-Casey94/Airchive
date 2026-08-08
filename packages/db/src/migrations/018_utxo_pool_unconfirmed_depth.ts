import type { Knex } from "knex";

/**
 * How many unconfirmed ancestors an aircraft output has in its own spend chain.
 *
 * The writer records a spend and its change as soon as a broadcast is accepted
 * for delivery, and the next write a second later spends that change. Nothing
 * bounded how long that chain of unconfirmed transactions could grow, so a
 * single parent the network later refused invalidated every descendant behind
 * it — one rejection became hundreds of doomed writes, each paying a fee.
 *
 * Tracking the depth lets the pool prefer settled outputs and refuse to extend
 * a chain past a configured ceiling, which caps the blast radius of any one
 * rejection. Chain truth resets it: an output seen in a block is depth 0.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("utxo_pool", (table) => {
    table.integer("unconfirmed_depth").notNullable().defaultTo(0);
    // The acquire path filters on aircraft + lock state + depth on every write,
    // which at 1 Hz per aircraft is the hottest query the writer runs.
    table.index(
      ["aircraft_icao", "is_locked", "unconfirmed_depth"],
      "utxo_pool_aircraft_locked_depth_idx",
    );
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("utxo_pool", (table) => {
    table.dropIndex(
      ["aircraft_icao", "is_locked", "unconfirmed_depth"],
      "utxo_pool_aircraft_locked_depth_idx",
    );
    table.dropColumn("unconfirmed_depth");
  });
}
