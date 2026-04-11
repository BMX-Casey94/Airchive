export interface OverlayConfig {
  overlayPort: number;
  wsPath: string;
  topicName: string;
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
}

export function loadConfig(): OverlayConfig {
  const overlayPort = Number(process.env.OVERLAY_PORT ?? 4010);
  if (!Number.isFinite(overlayPort) || overlayPort < 1 || overlayPort > 65_535) {
    throw new RangeError("OVERLAY_PORT must be a valid TCP port");
  }

  return {
    overlayPort,
    wsPath: process.env.OVERLAY_WS_PATH ?? "/ws",
    topicName: process.env.OVERLAY_TOPIC ?? "tm_airchive",
    postgres: {
      host: process.env.POSTGRES_HOST ?? "127.0.0.1",
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      database: process.env.POSTGRES_DB ?? "airchive",
      user: process.env.POSTGRES_USER ?? "postgres",
      password: process.env.POSTGRES_PASSWORD ?? "",
    },
  };
}
