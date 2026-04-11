import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("aircraft_config", (table) => {
    table.string("icao", 6).primary();
    table.string("callsign", 8);
    table.string("reg", 10);
    table.string("aircraft_type", 6);
    table.integer("wallet_index").notNullable().unique();
    table.boolean("enabled").notNullable().defaultTo(true);
    table.timestamp("created_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("utxo_pool", (table) => {
    table.string("aircraft_icao", 6).notNullable().references("icao").inTable("aircraft_config");
    table.specificType("txid", "char(64)").notNullable();
    table.integer("vout").notNullable();
    table.bigInteger("satoshis").notNullable();
    table.text("locking_script").notNullable();
    table.boolean("is_locked").notNullable().defaultTo(false);
    table.timestamp("created_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());
    table.primary(["txid", "vout"]);
    table.index(["aircraft_icao", "is_locked"], "utxo_pool_aircraft_locked_idx");
  });

  await knex.schema.createTable("flight_sessions", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("aircraft_icao", 6).notNullable().references("icao").inTable("aircraft_config");
    table.string("callsign", 8);
    table.string("origin_icao", 4);
    table.string("origin_name", 100);
    table.string("dest_icao", 4);
    table.string("dest_name", 100);
    table.string("phase", 20).notNullable().defaultTo("PARKED");
    table.timestamp("started_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("ended_at", { useTz: false });
    table.integer("total_tx_count").notNullable().defaultTo(0);
    table.bigInteger("total_sats_spent").notNullable().defaultTo(0);
    table.index(["aircraft_icao", "started_at"], "flight_sessions_aircraft_started_idx");
  });

  await knex.schema.createTable("pending_writes", (table) => {
    table.increments("id").primary();
    table.string("aircraft_icao", 6).notNullable();
    table.smallint("record_type").notNullable();
    table.binary("payload").notNullable();
    table.uuid("flight_id");
    table.timestamp("created_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());
    table.integer("retry_count").notNullable().defaultTo(0);
    table.text("last_error");
    table.index(["retry_count", "created_at"], "pending_writes_retry_created_idx");
  });

  await knex.schema.createTable("tx_results", (table) => {
    table.specificType("txid", "char(64)").primary();
    table.string("aircraft_icao", 6).notNullable();
    table.smallint("record_type").notNullable();
    table.string("status", 20).notNullable();
    table.integer("block_height");
    table.text("merkle_path");
    table.bigInteger("timestamp").notNullable();
    table.integer("fee_sats").notNullable();
    table.integer("size_bytes").notNullable();
    table.uuid("flight_id");
    table.timestamp("created_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());
    table.index(["aircraft_icao", "timestamp"], "tx_results_aircraft_ts_idx");
  });

  await knex.schema.createTable("alerts", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("aircraft_icao", 6).notNullable();
    table.uuid("flight_id");
    table.string("severity", 20).notNullable();
    table.string("type", 50).notNullable();
    table.text("message").notNullable();
    table.jsonb("data").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    table.boolean("acknowledged").notNullable().defaultTo(false);
    table.timestamp("created_at", { useTz: false }).notNullable().defaultTo(knex.fn.now());
    table.index(["aircraft_icao", "created_at"], "alerts_aircraft_created_idx");
    table.index(["severity", "acknowledged"], "alerts_severity_ack_idx");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("alerts");
  await knex.schema.dropTableIfExists("tx_results");
  await knex.schema.dropTableIfExists("pending_writes");
  await knex.schema.dropTableIfExists("flight_sessions");
  await knex.schema.dropTableIfExists("utxo_pool");
  await knex.schema.dropTableIfExists("aircraft_config");
}
