import { readdir } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Knex } from "knex";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Locally the knex CLI loads this file as TypeScript from src/, but the
// container runs the compiled build, where the migrations next to it are .js.
// Deriving the extension from this file rather than hard-coding "ts" keeps one
// knexfile correct in both places; hard-coding it makes the compiled runner
// find zero migrations and report success against an empty database.
const selfExtension = extname(__filename) || ".ts";
const migrationDirectory = join(__dirname, "migrations");

/**
 * Records migrations under their bare name, with no file extension.
 *
 * Knex's default source names each applied migration after its filename, so the
 * same migration is "001_initial_schema.ts" when applied from source and
 * "001_initial_schema.js" when applied from the compiled build. The two ledgers
 * are mutually unreadable: whichever ran second reports the other's entries as
 * a corrupt migration directory and refuses to run. Dropping the extension
 * makes one repository produce one ledger however it is invoked.
 */
class MigrationSource implements Knex.MigrationSource<string> {
  async getMigrations(): Promise<string[]> {
    const entries = await readdir(migrationDirectory);
    return entries
      .filter(
        (file) =>
          file.endsWith(selfExtension) && !file.endsWith(`.d${selfExtension}`),
      )
      .sort();
  }

  getMigrationName(file: string): string {
    return basename(file, selfExtension);
  }

  async getMigration(file: string): Promise<Knex.Migration> {
    // A file URL rather than a bare path: on Windows, dynamic import of an
    // absolute path such as C:\... is rejected as an unknown protocol.
    return import(pathToFileURL(join(migrationDirectory, file)).href) as Promise<Knex.Migration>;
  }
}

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
    // No `directory` or `loadExtensions` here on purpose: knex treats any
    // filesystem option as a request for its built-in source and silently
    // discards migrationSource, with only a log line to say so. The directory
    // is baked into the source above instead. `extension` is not a filesystem
    // option in that sense and only tells `migrate:make` what to create.
    extension: selfExtension.slice(1),
    migrationSource: new MigrationSource(),
  },
};

export default config;
