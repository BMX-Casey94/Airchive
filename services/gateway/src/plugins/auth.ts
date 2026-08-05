import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createLogger } from "@airchive/logger";
import type { GatewayConfig } from "../config.js";

const log = createLogger({ service: "gateway:auth" });

/**
 * Secrets that are published in this repository or shipped as defaults. Signing
 * with any of them is equivalent to having no authentication, because anyone
 * can mint a token that verifies.
 */
const PUBLISHED_SECRETS = new Set([
  "",
  "CHANGE_ME_IN_PRODUCTION",
  "dev-secret-change-in-production",
  "changeme",
  "secret",
]);

/**
 * Password accepted by the local development login. It is a literal in a public
 * repository, so it is only ever honoured when the bypass is explicitly on.
 */
const DEV_PASSWORD = "airchive_dev";

/** Constant-time string compare via SHA-256 digests (equal length always). */
function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function registerAuth(app: FastifyInstance, config: GatewayConfig): Promise<void> {
  // Previously this was keyed off NODE_ENV, which meant an unset or inherited
  // "development" silently turned every protected route into an open one and
  // handed out operator tokens to anyone who knew a hard-coded password. The
  // switch is now explicit, defaults to off, and announces itself.
  if (config.devAuthBypass) {
    log.warn(
      "GATEWAY_DEV_AUTH_BYPASS is set: authentication is DISABLED and the "
        + "development login is active. Never set this on a reachable host.",
    );
  } else if (PUBLISHED_SECRETS.has(config.jwtSecret.trim())) {
    // Refuse to start rather than serve an API whose tokens anyone can forge.
    throw new Error(
      "JWT_SECRET is unset or still a published placeholder. Generate one with "
        + "`openssl rand -base64 48`, or set GATEWAY_DEV_AUTH_BYPASS=true for "
        + "local development.",
    );
  }

  if (!config.devAuthBypass && (!config.operatorUsername || !config.operatorPassword)) {
    log.warn(
      "OPERATOR_USERNAME / OPERATOR_PASSWORD unset: protected mutations "
        + "(e.g. alert test) cannot mint tokens until they are configured.",
    );
  }

  await app.register(import("@fastify/jwt"), {
    secret: config.jwtSecret,
    sign: { expiresIn: config.jwtExpiry },
  });

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    if (config.devAuthBypass) return;
    try {
      await request.jwtVerify();
    } catch {
      reply.status(401).send({ success: false, error: "Unauthorised" });
    }
  });

  app.post("/api/auth/token", async (request, reply) => {
    const { username, password } = request.body as { username?: string; password?: string };
    if (!username || !password) {
      return reply.status(400).send({ success: false, error: "Username and password required" });
    }

    const devOk = config.devAuthBypass && secretsMatch(password, DEV_PASSWORD);
    const operatorConfigured =
      Boolean(config.operatorUsername) && Boolean(config.operatorPassword);
    const operatorOk =
      operatorConfigured
      && secretsMatch(username, config.operatorUsername)
      && secretsMatch(password, config.operatorPassword);

    if (!devOk && !operatorOk) {
      return reply.status(401).send({ success: false, error: "Invalid credentials" });
    }

    const token = app.jwt.sign({ sub: username, role: "operator" });
    return reply.send({ success: true, data: { token } });
  });
}
