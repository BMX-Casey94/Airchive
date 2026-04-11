export interface RedisConfig {
  host: string;
  port: number;
  password: string | undefined;
  db: number;
}

export interface Config {
  arcUrl: string;
  arcApiKey: string;
  arcCallbackPort: number;
  wocApiUrl: string;
  walletMasterSeed: string;
  fundingWalletWif: string;
  trackedAircraft: string[];
  redis: RedisConfig;
  refillThresholdSats: number;
  refillAmountSats: number;
  consolidationThreshold: number;
  refillIdleWindowMs: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : fallback;
}

export function loadConfig(): Config {
  return {
    arcUrl: optionalEnv("TAAL_ARC_URL", "https://arc.taal.com"),
    arcApiKey: requireEnv("TAAL_ARC_API_KEY"),
    arcCallbackPort: Number(optionalEnv("ARC_CALLBACK_PORT", "9090")),
    wocApiUrl: optionalEnv(
      "WOC_API_URL",
      "https://api.whatsonchain.com/v1/bsv/main",
    ),
    walletMasterSeed: requireEnv("WALLET_MASTER_SEED"),
    fundingWalletWif: requireEnv("FUNDING_WALLET_WIF"),
    trackedAircraft: requireEnv("TRACKED_AIRCRAFT")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    redis: {
      host: optionalEnv("REDIS_HOST", "127.0.0.1"),
      port: Number(optionalEnv("REDIS_PORT", "6379")),
      password: process.env.REDIS_PASSWORD || undefined,
      db: Number(optionalEnv("REDIS_DB", "0")),
    },
    refillThresholdSats: Number(
      optionalEnv("REFILL_THRESHOLD_SATS", "200000"),
    ),
    refillAmountSats: Number(optionalEnv("REFILL_AMOUNT_SATS", "1000000")),
    consolidationThreshold: Number(
      optionalEnv("CONSOLIDATION_THRESHOLD", "20"),
    ),
    refillIdleWindowMs: Number(
      optionalEnv("REFILL_IDLE_WINDOW_MS", "1800000"),
    ),
  };
}
