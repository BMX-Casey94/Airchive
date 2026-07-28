import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Knex } from "knex";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The knex CLI chdirs into the knexfile's directory, so a bare `.env` lookup
// never finds the repo root. Load it explicitly; real environment variables
// still win, which keeps container and CI overrides authoritative.
try {
  process.loadEnvFile(join(__dirname, "..", "..", "..", ".env"));
} catch {
  // No root .env (containers inject env directly) — fall back to process.env.
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Six services share one Postgres, whose default max_connections is 100. A
// per-service ceiling of 32 oversubscribes that by a factor of two and the
// symptom — "remaining connection slots are reserved for roles with the
// SUPERUSER attribute" — surfaces as unrelated query failures across the whole
// system. Keep the default modest and raise it deliberately, per service, only
// alongside a matching max_connections increase on the server.
const poolMin = numberEnv("POSTGRES_POOL_MIN", 1);
const poolMax = Math.max(poolMin, numberEnv("POSTGRES_POOL_MAX", 10));

/**
 * Server-side guards applied to every session. A query that hangs and a
 * transaction that is opened and then abandoned both hold a connection
 * indefinitely, so the pool drains and never recovers; these turn either into a
 * loud, bounded failure instead.
 */
const sessionOptions = [
  `-c statement_timeout=${numberEnv("POSTGRES_STATEMENT_TIMEOUT_MS", 30_000)}`,
  "-c idle_in_transaction_session_timeout="
    + numberEnv("POSTGRES_IDLE_TX_TIMEOUT_MS", 60_000),
].join(" ");

const config: Knex.Config = {
  client: "pg",
  connection: {
    host: process.env.POSTGRES_HOST ?? "127.0.0.1",
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    database: process.env.POSTGRES_DB ?? "airchive",
    user: process.env.POSTGRES_USER ?? "postgres",
    password: process.env.POSTGRES_PASSWORD ?? "",
    // Every service reporting as "airchive" makes pg_stat_activity useless for
    // finding which one is holding connections. pnpm and npm both set
    // npm_package_name when running a script, so this needs no configuration.
    application_name:
      process.env.SERVICE_NAME ?? process.env.npm_package_name ?? "airchive",
    options: sessionOptions,
  },
  pool: {
    min: poolMin,
    max: poolMax,
    // Without reaping, every service holds its high-water mark of connections
    // for the life of the process even when idle overnight.
    idleTimeoutMillis: numberEnv("POSTGRES_POOL_IDLE_MS", 30_000),
    reapIntervalMillis: numberEnv("POSTGRES_POOL_REAP_MS", 5_000),
  },
  acquireConnectionTimeout: numberEnv("POSTGRES_ACQUIRE_TIMEOUT_MS", 60_000),
  migrations: {
    directory: join(__dirname, "migrations"),
    extension: "ts",
    loadExtensions: [".ts"],
  },
};

export default config;
