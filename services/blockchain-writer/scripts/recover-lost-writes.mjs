/**
 * Recovers AIRCHIVE writes that Arcade accepted but that never reached the
 * network. Dry-run is the default. --apply --confirm requeues missing txids
 * as preserved pending writes. This process never broadcasts and never spends.
 *
 * Postgres is reached the same way as the writer: POSTGRES_* from the
 * environment, with Docker secrets read from any VAR_FILE path because
 * `docker exec` does not re-run the image entrypoint. The compiled module
 * applies those secrets before it opens a connection.
 *
 * Usage:
 *   node services/blockchain-writer/scripts/recover-lost-writes.mjs \
 *     --from 2026-10-31T13:00:00Z --to 2026-10-31T14:00:00Z
 *
 * The window is created_at >= --from and created_at < --to.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, "../dist/recover-lost-writes.js");

if (!existsSync(compiled)) {
  console.error(
    `Missing ${compiled}. Build @airchive/blockchain-writer first. `
    + "A running container only has this script after the image is rebuilt.",
  );
  process.exit(1);
}

const { main } = await import(pathToFileURL(compiled).href);
const code = await main(process.argv.slice(2));
process.exit(code ?? 1);
