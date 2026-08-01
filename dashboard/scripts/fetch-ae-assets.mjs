/**
 * Downloads the static assets for the /ae Azimuthal Equidistant map view.
 *
 * Everything here is public domain (NASA imagery) or public-domain-equivalent
 * (Natural Earth via world-atlas). Files are fetched once and kept under
 * public/ae/; the script is safe to run on every dev/build because it skips
 * anything already present, and it warns rather than fails when offline —
 * the AE view degrades gracefully to vector-only rendering without textures.
 *
 * Imagery credit (shown in the /ae HUD): NASA Earth Observatory
 * Blue Marble Next Generation (day) and Black Marble 2016 (night lights).
 */
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const ASSETS = [
  {
    url: "https://cdn.jsdelivr.net/npm/world-atlas@2/land-50m.json",
    dest: "public/ae/data/land-50m.json",
    label: "Natural Earth land (1:50m TopoJSON)",
  },
  {
    url: "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json",
    dest: "public/ae/data/countries-50m.json",
    label: "Natural Earth countries (1:50m TopoJSON)",
  },
  {
    url: "https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg",
    dest: "public/ae/textures/earth-day.jpg",
    label: "NASA Blue Marble NG day texture (5400x2700)",
  },
  {
    url: "https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_01deg.jpg",
    dest: "public/ae/textures/earth-night.jpg",
    label: "NASA Black Marble 2016 night lights (3600x1800)",
  },
];

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fetchAsset({ url, dest, label }) {
  const target = path.join(root, dest);
  if (await exists(target)) {
    return { label, status: "present" };
  }

  await mkdir(path.dirname(target), { recursive: true });
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  await writeFile(target, bytes);
  return { label, status: `downloaded (${(bytes.length / 1024 / 1024).toFixed(1)} MB)` };
}

let failures = 0;
for (const asset of ASSETS) {
  try {
    const { label, status } = await fetchAsset(asset);
    console.log(`[fetch-ae-assets] ${label}: ${status}`);
  } catch (err) {
    failures += 1;
    console.warn(
      `[fetch-ae-assets] WARN could not fetch ${asset.label}: ${err?.message ?? err}. `
        + "The AE view will fall back to vector-only rendering for this layer.",
    );
  }
}
console.log(failures === 0 ? "[fetch-ae-assets] Done" : `[fetch-ae-assets] Done with ${failures} warning(s)`);
