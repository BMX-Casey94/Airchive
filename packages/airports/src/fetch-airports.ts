import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const SOURCE_URL =
  process.env.AIRPORTS_SOURCE_URL ??
  "https://davidmegginson.github.io/ourairports-data/airports.csv";

const OUTPUT_PATH = join(process.cwd(), "data", "airports.csv");

const REQUIRED_HEADERS = [
  "ident",
  "name",
  "type",
  "latitude_deg",
  "longitude_deg",
  "elevation_ft",
  "iso_country",
  "municipality",
];

async function main(): Promise<void> {
  const res = await fetch(SOURCE_URL, {
    headers: { Accept: "text/csv" },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`Airport CSV download failed: HTTP ${res.status}`);
  }

  const body = await res.text();
  const header = body.split(/\r?\n/, 1)[0] ?? "";

  for (const key of REQUIRED_HEADERS) {
    if (!header.includes(key)) {
      throw new Error(`Airport CSV missing required column: ${key}`);
    }
  }

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, body, "utf8");

  const rowCount = Math.max(0, body.split(/\r?\n/).length - 1);
  console.log(`Saved ${rowCount} airport rows to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
