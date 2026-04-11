import type { NextConfig } from "next";
import { createRequire } from "node:module";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

/** Workspace root (`Intelegentic/`) — Next does not load this by default. */
const workspaceRoot = path.join(__dirname, "..", "..");
dotenv.config({ path: path.join(workspaceRoot, ".env") });
dotenv.config({ path: path.join(workspaceRoot, ".env.local"), override: true });
/** Optional `airchive/.env` when developing from the monorepo folder only. */
dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", ".env.local"), override: true });

const cesiumPkg = path.dirname(require_.resolve("cesium/package.json"));
const cesiumBuildDir = path.join(cesiumPkg, "Build", "Cesium");

const nextConfig: NextConfig = {
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  outputFileTracingRoot: path.join(__dirname, ".."),
  reactStrictMode: true,
  experimental: {},
  env: {
    NEXT_PUBLIC_GATEWAY_URL: process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000",
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4001",
    NEXT_PUBLIC_CESIUM_ION_TOKEN: process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN ?? "",
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve = config.resolve ?? {};
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        url: false,
        http: false,
        https: false,
        zlib: false,
      };

      config.resolve.alias = {
        ...config.resolve.alias,
        cesium$: path.join(cesiumBuildDir, "Cesium.js"),
      };

      config.module = config.module ?? {};
      const cesiumNoParse = /cesium[\\/]Build[\\/]Cesium[\\/]Cesium\.js$/;
      const existing = config.module.noParse;
      if (Array.isArray(existing)) {
        existing.push(cesiumNoParse);
      } else if (existing) {
        config.module.noParse = [existing, cesiumNoParse] as any;
      } else {
        config.module.noParse = [cesiumNoParse];
      }
    }
    return config;
  },
};

export default nextConfig;
