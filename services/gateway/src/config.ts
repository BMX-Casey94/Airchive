export interface GatewayConfig {
  port: number;
  wsPort: number;
  jwtSecret: string;
  jwtExpiry: string;
  corsOrigin: string | string[];
  devAuthBypass: boolean;
  redis: { host: string; port: number; password: string | undefined };
  nodeEnv: string;
}

/**
 * The dashboard is deployed separately from the API, so more than one origin
 * legitimately needs access — the custom domain and the hosting provider's own
 * URL, at least. A bare string cannot express that, which is how deployments
 * end up reaching for `*`.
 *
 * Browsers send Origin without a trailing slash. Values like
 * `https://www.airchive.uk/` must be normalised or the exact match fails and
 * the response goes out with `Vary: Origin` but no `Allow-Origin` header —
 * which Chrome reports as a CORS failure (often on a 200).
 */
export function parseCorsOrigin(raw: string | undefined): string | string[] {
  const value = (raw ?? "http://localhost:3000").trim();
  if (value === "*") return "*";
  const origins = value
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (origins.length === 0) return "http://localhost:3000";
  return origins.length === 1 ? origins[0]! : origins;
}

/** Normalise an Origin / allow-list entry for comparison. */
export function normaliseOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

/**
 * @fastify/cors `origin` option: reflect matching request origins, reject
 * others. Re-normalises both sides so a trailing slash left in `.env` cannot
 * break production again.
 */
export type CorsOriginCallback = (err: Error | null, allow: boolean | string) => void;
export type CorsOriginDelegate = (origin: string | undefined, cb: CorsOriginCallback) => void;

export function createCorsOriginDelegate(
  allowed: string | string[],
): boolean | CorsOriginDelegate {
  if (allowed === "*") return true;
  const list = (Array.isArray(allowed) ? allowed : [allowed]).map(normaliseOrigin);
  return (origin, cb) => {
    // Non-browser clients (curl, server-to-server) omit Origin.
    if (!origin) {
      cb(null, true);
      return;
    }
    const normalised = normaliseOrigin(origin);
    cb(null, list.includes(normalised) ? origin : false);
  };
}

export function loadConfig(): GatewayConfig {
  return {
    port: parseInt(process.env.GATEWAY_PORT ?? "4000", 10),
    wsPort: parseInt(process.env.GATEWAY_WS_PORT ?? "4001", 10),
    jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-in-production",
    jwtExpiry: process.env.JWT_EXPIRY ?? "24h",
    corsOrigin: parseCorsOrigin(process.env.CORS_ORIGIN),
    // Deliberately not derived from NODE_ENV. Disabling authentication is a
    // decision that should have to be written down, not something that happens
    // because a variable was left at its default.
    devAuthBypass: process.env.GATEWAY_DEV_AUTH_BYPASS === "true",
    redis: {
      host: process.env.REDIS_HOST ?? "127.0.0.1",
      port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
      password: process.env.REDIS_PASSWORD || undefined,
    },
    nodeEnv: process.env.NODE_ENV ?? "development",
  };
}
