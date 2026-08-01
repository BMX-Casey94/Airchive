/**
 * Canonical site origin for SEO surfaces (metadataBase, sitemap, robots,
 * Open Graph URLs).
 *
 * In production the deployed domain is baked into the bundle at build time:
 * `PUBLIC_ORIGIN` → `NEXT_PUBLIC_GATEWAY_URL` (the dashboard and gateway are
 * served from the same origin behind nginx). An explicit
 * `NEXT_PUBLIC_SITE_URL` wins if ever set. Anything non-HTTPS (local dev)
 * falls back to localhost so crawler artefacts never advertise a dev URL.
 */
function resolveSiteUrl(): string {
  const candidate =
    process.env.NEXT_PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_GATEWAY_URL ?? "";
  if (candidate.startsWith("https://")) {
    return candidate.replace(/\/+$/, "");
  }
  return "http://localhost:3000";
}

export const SITE_URL = resolveSiteUrl();

export const SITE_NAME = "Airchive";

export const SITE_DESCRIPTION =
  "Real-time aircraft telemetry with immutable, blockchain-backed flight "
  + "records on the BSV network — live 3D globe, flight sessions, and an "
  + "azimuthal equidistant polar flight map.";
