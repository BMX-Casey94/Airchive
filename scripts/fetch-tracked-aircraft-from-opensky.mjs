#!/usr/bin/env node
/**
 * Build a TRACKED_AIRCRAFT-style comma-separated ICAO24 hex list from live OpenSky
 * data (https://opensky-network.org/api/states/all). Qatar Airways entries are
 * listed first; remaining slots are filled with other wide-body / long-haul style
 * operators matched by callsign prefix or origin country.
 *
 * Usage:
 *   node scripts/fetch-tracked-aircraft-from-opensky.mjs [--max 200] [--out path]
 *
 * Respect OpenSky anonymous rate limits; do not run in a tight loop.
 */

const DEFAULT_MAX = 200;

function parseArgs() {
  const argv = process.argv.slice(2);
  let max = DEFAULT_MAX;
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max" && argv[i + 1]) max = parseInt(argv[++i], 10);
    else if (argv[i] === "--out" && argv[i + 1]) outPath = argv[++i];
  }
  if (!Number.isFinite(max) || max < 1) max = DEFAULT_MAX;
  return { max, outPath };
}

/** OpenSky returns icao24 as a lowercase hex string (or legacy integer). */
function normalizeHex(raw) {
  if (typeof raw === "number") return raw.toString(16).padStart(6, "0").toUpperCase();
  const s = String(raw).replace(/^0x/i, "").trim();
  if (/^[0-9a-fA-F]{1,6}$/.test(s)) return s.padStart(6, "0").toUpperCase();
  return s.toUpperCase();
}

function callsign(st) {
  return (st[1] ?? "").trim();
}

function originCountry(st) {
  return st[2] ?? "";
}

function isQatar(st) {
  return originCountry(st) === "Qatar" || callsign(st).startsWith("QTR");
}

/** Long-haul / major intercontinental-style operators (callsign-centric). */
function isOtherLongHaul(st) {
  const c = callsign(st);
  const oc = originCountry(st);
  if (!c) return false;

  if (oc === "United Arab Emirates" && /^(UAE|ETD|DHX|ABY|MSC|RKR)/.test(c)) return true;
  if (/^(BAW|SHT|CFE)/.test(c)) return true;
  if (oc === "Singapore" && /^SIA/.test(c)) return true;
  if (/^SIA/.test(c)) return true;
  if (/^(CPA|QFA|DLH|CFG|AFR|KLM|THY|DAL|UAL|AAL|EVA|ETH|IBE|VOZ|LAN|AMX)/.test(c)) return true;
  if (/^(ANA|JAL)/.test(c) && oc === "Japan") return true;
  if (/^(ACA|AIC)/.test(c)) return true;

  return false;
}

async function main() {
  const { max, outPath } = parseArgs();

  const res = await fetch("https://opensky-network.org/api/states/all", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`OpenSky HTTP ${res.status}`);

  const data = await res.json();
  const states = data.states ?? [];

  const qatar = [];
  const others = [];

  for (const st of states) {
    if (!st?.[0]) continue;
    const hex = normalizeHex(st[0]);
    if (isQatar(st)) qatar.push(hex);
    else if (isOtherLongHaul(st)) others.push(hex);
  }

  const qatarUnique = [...new Set(qatar)];
  const otherUnique = [...new Set(others)];

  const out = [];
  const seen = new Set();

  for (const h of qatarUnique) {
    if (out.length >= max) break;
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(h);
  }
  for (const h of otherUnique) {
    if (out.length >= max) break;
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(h);
  }

  const line = out.join(",");

  if (outPath) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(outPath, `${line}\n`, "utf8");
    console.error(`Wrote ${out.length} ICAO hex codes to ${outPath}`);
  }

  console.log(line);

  console.error(
    `# OpenSky snapshot: ${states.length} state vectors; Qatar ${qatarUnique.length}; ` +
      `other matched ${otherUnique.length}; emitted ${out.length} (max ${max}).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
