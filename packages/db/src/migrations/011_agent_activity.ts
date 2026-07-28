import type { Knex } from "knex";

function appRole(): string {
  return (process.env.POSTGRES_USER ?? "airchive").trim();
}

/**
 * Agent marketplace activity used to live only on a Redis pub/sub channel, so
 * the dashboard's "payments / earned / spent / discoveries" tiles reset on
 * every reload. Persisting the durable event types lets `/api/agents/metrics`
 * report true day totals the same way `/api/metrics` does for the blockchain.
 *
 * Status heartbeats are deliberately not stored — they fire every few seconds
 * and carry no history an analyst would query.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("agent_activity", (table) => {
    table.bigIncrements("id").primary();
    table.string("event_type", 32).notNullable();
    table.string("agent", 32).notNullable();
    table.bigInteger("timestamp").notNullable();
    table.jsonb("data").notNullable().defaultTo("{}");
    table.timestamp("created_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());

    table.index(["timestamp"], "agent_activity_timestamp_idx");
    table.index(["event_type", "timestamp"], "agent_activity_type_ts_idx");
  });

  await knex.raw(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_activity TO ??",
    [appRole()],
  );
  await knex.raw(
    "GRANT USAGE, SELECT ON SEQUENCE public.agent_activity_id_seq TO ??",
    [appRole()],
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("agent_activity");
}
