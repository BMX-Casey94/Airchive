/**
 * Applies pending migrations and exits.
 *
 * This exists instead of a `knex migrate:latest` CLI invocation because the CLI
 * resolves its own TypeScript loader and chdirs into the knexfile's directory,
 * which behaves differently between a developer machine and a container. Doing
 * it programmatically means the deployed path runs plain compiled JavaScript
 * with no loader, no chdir and no argument parsing between the schema and the
 * database.
 *
 * A non-zero exit is meaningful: compose gates every service that touches
 * Postgres on this container completing successfully, so a failure here stops
 * the stack rather than letting services start against a half-built schema.
 */
import knex from "knex";
import config from "./knexfile.js";

const CONNECT_ATTEMPTS = 30;
const CONNECT_RETRY_MS = 2_000;
const LEDGER_TABLE = "knex_migrations";

const db = knex(config);

async function waitForDatabase(): Promise<void> {
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    try {
      await db.raw("select 1");
      return;
    } catch (err) {
      if (attempt === CONNECT_ATTEMPTS) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[migrate] database not ready (attempt ${attempt}/${CONNECT_ATTEMPTS}): ${reason}`,
      );
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
    }
  }
}

/**
 * Rewrites ledger entries left behind by the old extension-bearing naming.
 *
 * Databases migrated before the knexfile recorded bare names hold rows such as
 * "001_initial_schema.ts". The migration source now reports that same migration
 * as "001_initial_schema", so without this the migrator sees ten applied
 * migrations it cannot find on disk and aborts as corrupt — and were the check
 * bypassed it would re-run migrations against tables that already exist.
 *
 * This renames rather than deletes, so no record of what has been applied is
 * lost, and it is a no-op on a database that has never seen the old naming.
 */
async function normaliseLedgerNames(): Promise<void> {
  if (!(await db.schema.hasTable(LEDGER_TABLE))) return;

  const rows = await db<{ id: number; name: string }>(LEDGER_TABLE).select("id", "name");
  const bareNames = new Set(rows.map((row) => row.name).filter((name) => !/\.[jt]s$/.test(name)));
  const stale = rows.filter((row) => /\.[jt]s$/.test(row.name));
  if (stale.length === 0) return;

  await db.transaction(async (trx) => {
    for (const row of stale) {
      const bare = row.name.replace(/\.[jt]s$/, "");
      if (bareNames.has(bare)) {
        // Both namings recorded for one migration: the bare row is the one the
        // migrator will match, so the duplicate is redundant bookkeeping.
        await trx(LEDGER_TABLE).where({ id: row.id }).delete();
        console.log(`[migrate] removed duplicate ledger entry ${row.name}`);
        continue;
      }
      await trx(LEDGER_TABLE).where({ id: row.id }).update({ name: bare });
      bareNames.add(bare);
      console.log(`[migrate] renamed ledger entry ${row.name} -> ${bare}`);
    }
  });
}

try {
  await waitForDatabase();
  await normaliseLedgerNames();

  const [batch, applied] = (await db.migrate.latest()) as [number, string[]];

  if (applied.length === 0) {
    console.log("[migrate] schema already up to date");
  } else {
    console.log(`[migrate] batch ${batch}: applied ${applied.length} migration(s)`);
    for (const name of applied) console.log(`[migrate]   ${name}`);
  }

  const [completed, pending] = (await db.migrate.list()) as [unknown[], unknown[]];
  console.log(
    `[migrate] ${completed.length} migration(s) recorded, ${pending.length} pending`,
  );
} catch (err) {
  console.error("[migrate] failed:", err);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
