import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Knex } from "knex";

const __dirname = dirname(fileURLToPath(import.meta.url));

const config: Knex.Config = {
  client: "pg",
  connection: {
    host: process.env.POSTGRES_HOST ?? "127.0.0.1",
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    database: process.env.POSTGRES_DB ?? "airchive",
    user: process.env.POSTGRES_USER ?? "postgres",
    password: process.env.POSTGRES_PASSWORD ?? "",
  },
  pool: { min: 2, max: 10 },
  migrations: {
    directory: join(__dirname, "migrations"),
    extension: "ts",
    loadExtensions: [".ts"],
  },
};

export default config;
