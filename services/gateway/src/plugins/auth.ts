import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { GatewayConfig } from "../config.js";

export async function registerAuth(app: FastifyInstance, config: GatewayConfig): Promise<void> {
  await app.register(import("@fastify/jwt"), {
    secret: config.jwtSecret,
    sign: { expiresIn: config.jwtExpiry },
  });

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    if (config.nodeEnv === "development") return;
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
    if (config.nodeEnv !== "development" || password !== "airchive_dev") {
      return reply.status(401).send({ success: false, error: "Invalid credentials" });
    }
    const token = app.jwt.sign({ sub: username, role: "operator" });
    return reply.send({ success: true, data: { token } });
  });
}
