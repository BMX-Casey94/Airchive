export interface AgentMarketplaceConfig {
  redis: { host: string; port: number };
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  collectorKeyEnv: string;
  analystKeyEnv: string;
  monitorKeyEnv: string;
  analysisIntervalMs: number;
  monitorIntervalMs: number;
  trackedAircraft: string[];
  storageUrl: string;
  network: "main" | "testnet";
  metricsPort: number;
}

export function loadConfig(): AgentMarketplaceConfig {
  const tracked = (process.env.TRACKED_AIRCRAFT ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (tracked.length === 0) {
    throw new Error("TRACKED_AIRCRAFT env var is empty");
  }

  return {
    redis: {
      host: process.env.REDIS_HOST ?? "localhost",
      port: Number(process.env.REDIS_PORT ?? "6379"),
    },
    postgres: {
      host: process.env.POSTGRES_HOST ?? "localhost",
      port: Number(process.env.POSTGRES_PORT ?? "5432"),
      database: process.env.POSTGRES_DB ?? "airchive",
      user: process.env.POSTGRES_USER ?? "airchive",
      password: process.env.POSTGRES_PASSWORD ?? "",
    },
    collectorKeyEnv: "COLLECTOR_AGENT_KEY",
    analystKeyEnv: "ANALYST_AGENT_KEY",
    monitorKeyEnv: "MONITOR_AGENT_KEY",
    analysisIntervalMs: Number(process.env.AGENT_ANALYSIS_INTERVAL_MS ?? "30000"),
    monitorIntervalMs: Number(process.env.AGENT_MONITOR_INTERVAL_MS ?? "5000"),
    trackedAircraft: tracked,
    storageUrl: process.env.BSV_STORAGE_URL ?? "https://storage.babbage.systems",
    network: (process.env.BSV_NETWORK ?? "mainnet") === "mainnet" ? "main" : "testnet",
    metricsPort: Number(process.env.AGENT_METRICS_PORT ?? "9093"),
  };
}
