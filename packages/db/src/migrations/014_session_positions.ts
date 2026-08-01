import type { Knex } from "knex";

function appRole(): string {
  return (process.env.POSTGRES_USER ?? "airchive").trim();
}

/**
 * Flight paths were until now reconstructed client-side from whichever
 * telemetry frames a browser happened to witness, so a dashboard opened
 * mid-flight could never show the route back to take-off. This table
 * persists a phase-aware, thinned position stream per flight session so any
 * client can fetch the complete path of an active (or completed) flight in
 * one query.
 *
 * Timestamps are epoch milliseconds (matching `agent_activity`) because the
 * consumers are browsers merging this stream with live WebSocket telemetry
 * that already speaks epoch-ms.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("session_positions", (table) => {
    table.bigIncrements("id").primary();
    table
      .uuid("flight_id")
      .notNullable()
      .references("id")
      .inTable("flight_sessions")
      .onDelete("CASCADE");
    table.string("aircraft_icao", 6).notNullable();
    table.bigInteger("ts").notNullable();
    table.double("lat").notNullable();
    table.double("lon").notNullable();
    table.integer("alt_baro");
    table.integer("gs");
    table.integer("track");
    table.string("phase", 20);

    table.index(["flight_id", "ts"], "session_positions_flight_ts_idx");
  });

  await knex.raw(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.session_positions TO ??",
    [appRole()],
  );
  await knex.raw(
    "GRANT USAGE, SELECT ON SEQUENCE public.session_positions_id_seq TO ??",
    [appRole()],
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("session_positions");
}
