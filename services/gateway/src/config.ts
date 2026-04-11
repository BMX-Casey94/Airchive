export interface GatewayConfig {
  port: number;
  wsPort: number;
  jwtSecret: string;
  jwtExpiry: string;
  corsOrigin: string;
  redis: { host: string; port: number };
  nodeEnv: string;
}

export function loadConfig(): GatewayConfig {
  return {
    port: parseInt(process.env.GATEWAY_PORT ?? "4000", 10),
    wsPort: parseInt(process.env.GATEWAY_WS_PORT ?? "4001", 10),
    jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-in-production",
    jwtExpiry: process.env.JWT_EXPIRY ?? "24h",
    corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
    redis: {
      host: process.env.REDIS_HOST ?? "127.0.0.1",
      port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
    },
    nodeEnv: process.env.NODE_ENV ?? "development",
  };
}
