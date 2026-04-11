/**
 * Copy Cesium static assets (Workers, Assets, ThirdParty, Widgets) into public/cesium
 * so the browser can load them at /cesium/... (see CESIUM_BASE_URL in GlobeViewInner).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardRoot = path.join(__dirname, "..");
const src = path.join(dashboardRoot, "node_modules", "cesium", "Build", "Cesium");
const dest = path.join(dashboardRoot, "public", "cesium");

if (!fs.existsSync(src)) {
  console.warn("[copy-cesium-assets] Cesium Build not found; skip:", src);
  process.exit(0);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log("[copy-cesium-assets] Copied Cesium assets to", dest);
