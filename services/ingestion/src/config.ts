export interface IngestionConfig {
  pollIntervalMs: number;
  trackedAircraft: string[];
  demoMode: boolean;
  /** Explicit path, or empty to use default next to compiled demo-replay module */
  demoReplayPath: string;
  demoSpeedMultiplier: number;
  opensky: {
    enabled: boolean;
    apiUrl: string;
    username?: string;
    password?: string;
  };
  adsbfi: {
    apiUrl: string;
  };
  rtlSdr: {
    endpoint: string;
    enabled: boolean;
  };
  redis: {
    host: string;
    port: number;
  };
}

export function getConfig(): IngestionConfig {
  const trackedRaw = process.env.TRACKED_AIRCRAFT ?? "";
  const trackedAircraft = trackedRaw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);

  return {
    pollIntervalMs: envInt("POLL_INTERVAL_MS", 1000),
    trackedAircraft,
    demoMode: process.env.DEMO_MODE === "true",
    demoReplayPath: (process.env.DEMO_REPLAY_PATH ?? "").trim(),
    demoSpeedMultiplier: envFloat("DEMO_SPEED_MULTIPLIER", 1),
    opensky: {
      enabled: process.env.OPENSKY_ENABLED === "true",
      apiUrl:
        process.env.OPENSKY_API_URL ??
        "https://opensky-network.org/api",
      username: process.env.OPENSKY_USERNAME || undefined,
      password: process.env.OPENSKY_PASSWORD || undefined,
    },
    adsbfi: {
      apiUrl:
        process.env.ADSBFI_API_URL ??
        "https://opendata.adsb.fi/api/v2",
    },
    rtlSdr: {
      endpoint:
        process.env.RTL_SDR_ENDPOINT ??
        "http://localhost:8080/data/aircraft.json",
      enabled: process.env.RTL_SDR_ENABLED === "true",
    },
    redis: {
      host: process.env.REDIS_HOST ?? "127.0.0.1",
      port: envInt("REDIS_PORT", 6379),
    },
  };
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
