import type { Knex } from "knex";

/**
 * Funding health has to survive a restart. An in-memory flag means a writer
 * that crashes while the treasury is empty comes back believing everything is
 * fine, re-enters the same failure, and re-alerts from scratch. Persisting the
 * state machine lets recovery span an outage of any length — including one that
 * lasts days while somebody gets round to sending coins.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("funding_state", (table) => {
    // "TREASURY" for the funding wallet, otherwise the aircraft ICAO.
    table.string("scope", 16).primary();
    table.string("state", 16).notNullable().defaultTo("HEALTHY");
    table.bigInteger("balance_sats").notNullable().defaultTo(0);
    table.integer("utxo_count").notNullable().defaultTo(0);
    /** When the current state was entered, so runway and outage length are derivable. */
    table.timestamp("state_since", { useTz: false }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("last_checked_at", { useTz: false }).nullable();
    table.timestamp("last_alert_at", { useTz: false }).nullable();
    /** Next permitted on-chain poll while dry; backoff is persisted, not in memory. */
    table.timestamp("next_poll_at", { useTz: false }).nullable();
    table.integer("consecutive_dry_polls").notNullable().defaultTo(0);
    /** Rolling estimate used to present runway in hours on the dashboard. */
    table.bigInteger("burn_sats_per_hour").notNullable().defaultTo(0);
    table.jsonb("details").notNullable().defaultTo("{}");
    table.timestamp("updated_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());

    table.index(["state"], "funding_state_state_idx");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("funding_state");
}
