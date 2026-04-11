import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src", "data", "demo-flights.json");
const destDir = path.join(root, "dist", "data");
const dest = path.join(destDir, "demo-flights.json");

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
