import { createHash } from "node:crypto";

export interface RedisConfig {
  host: string;
  port: number;
  password: string | undefined;
  db: number;
}

export interface ArcEndpointConfig {
  name: string;
  url: string;
  apiKey?: string;
}

export interface ArcadeConfig {
  enabled: boolean;
  url: string;
  apiKey: string | undefined;
  batchWindowMs: number;
  maxBatchSize: number;
  /** Correlates submissions with the SSE status stream. */
  callbackToken: string;
  /** Enables SSE status consumption; disable to fall back to polling. */
  sseEnabled: boolean;
}

export interface Config {
  arcade: ArcadeConfig;
  arcEndpoints: ArcEndpointConfig[];
  arcCallbackPort: number;
  wocApiUrl: string;
  wocApiKey?: string;
  wocMaxRequestsPerSecond: number;
  walletMasterSeed: string;
  fundingWalletWif: string;
  trackedAircraft: string[];
  redis: RedisConfig;
  arcMaxConcurrentBroadcasts: number;
  arcMaxQueueDepth: number;
  arcTransientRetryAttempts: number;
  arcTransientRetryBaseMs: number;
  arcCircuitFailureThreshold: number;
  arcCircuitWindowMs: number;
  arcCircuitOpenMs: number;
  refillThresholdSats: number;
  refillAmountSats: number;
  activeAircraftUtxoTarget: number;
  activeAircraftReadyUtxoTarget: number;
  retryReadyUtxoReserve: number;
  retryPressureReadyUtxoBoost: number;
  retryPressureWindowMs: number;
  retryBackoffMs: number;
  retryBackoffJitterMs: number;
  refillMinOutputSats: number;
  consolidationThreshold: number;
  refillIdleWindowMs: number;
  refillCheckIntervalMs: number;
  refillMaxOutputsPerTx: number;
  /** Parallel refill broadcasts (treasury → aircraft). Higher = faster pool recovery under load. */
  maxConcurrentRefills: number;
  /** Minimum funding UTXO rows after startup split; more = less contention on concurrent refills. */
  fundingPoolSplitTarget: number;
  funding: FundingRecoveryConfig;
  agentRefill: AgentRefillConfig;
}

/**
 * Treasury top-ups for the marketplace agent wallets. The agents live in another
 * service but spend from the same treasury, so the writer — which is the only
 * component holding the funding key — keeps them solvent.
 */
export interface AgentRefillConfig {
  enabled: boolean;
  checkIntervalMs: number;
  /** Top up once the agent's total on-chain balance drops below this. */
  thresholdSats: number;
  /** Total value delivered per top-up. */
  amountSats: number;
  /** Split across this many outputs so agents never chain unconfirmed spends. */
  outputCount: number;
  /** An output smaller than this cannot cover a fee and leave non-dust change. */
  minOutputSats: number;
  /** Top up when fewer than this many usable outputs remain, whatever the balance. */
  minUsableOutputs: number;
}

/**
 * Governs the persisted funding state machine. Defaults are expressed as
 * multiples of a single refill so they stay correct if the refill size changes.
 */
export interface FundingRecoveryConfig {
  /** How often treasury health is evaluated while healthy. */
  checkIntervalMs: number;
  /** Below this many refills' worth of treasury, the state becomes LOW. */
  lowWatermarkRefills: number;
  /** First poll delay after entering DRY. */
  dryPollBaseMs: number;
  /** Ceiling on the dry poll backoff — recovery waits indefinitely, but calmly. */
  dryPollMaxMs: number;
  /** Minimum gap between repeat DRY alerts so an outage does not spam. */
  alertRepeatMs: number;
  /** Pending writes drained per retry cycle while recovering, to avoid a stampede. */
  recoveryDrainBatchSize: number;
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

function buildArcEndpoints(): ArcEndpointConfig[] {
  const endpoints: ArcEndpointConfig[] = [
    {
      name: "taal",
      url: optionalEnv("TAAL_ARC_URL", "https://arc.taal.com"),
      apiKey: requireEnv("TAAL_ARC_API_KEY"),
    },
  ];

  const gorillaUrl = process.env.GORILLAPOOL_ARC_URL?.trim();
  const gorillaApiKey = process.env.GORILLAPOOL_ARC_API_KEY?.trim();
  if (gorillaUrl) {
    endpoints.push({
      name: "gorillapool",
      url: gorillaUrl,
      apiKey: gorillaApiKey || undefined,
    });
  }

  return endpoints;
}

function buildArcadeConfig(masterSeed: string): ArcadeConfig {
  const url = (process.env.ARCADE_URL ?? "").trim().replace(/\/+$/, "");
  return {
    enabled: url !== "",
    url,
    apiKey: process.env.ARCADE_API_KEY?.trim() || undefined,
    batchWindowMs: Number(optionalEnv("ARCADE_BATCH_WINDOW_MS", "200")),
    maxBatchSize: Number(optionalEnv("ARCADE_MAX_BATCH_SIZE", "100")),
    // Derived from the master seed so the token is stable across restarts and
    // the SSE stream resumes against the same submissions. Never the seed itself.
    callbackToken:
      process.env.ARCADE_CALLBACK_TOKEN?.trim()
      || createHash("sha256").update(`airchive-arcade:${masterSeed}`).digest("hex").slice(0, 32),
    sseEnabled: optionalEnv("ARCADE_SSE_ENABLED", "true").toLowerCase() !== "false",
  };
}

export function loadConfig(): Config {
  const walletMasterSeed = requireEnv("WALLET_MASTER_SEED");
  return {
    arcade: buildArcadeConfig(walletMasterSeed),
    arcEndpoints: buildArcEndpoints(),
    arcCallbackPort: Number(optionalEnv("ARC_CALLBACK_PORT", "9090")),
    wocApiUrl: optionalEnv(
      "WOC_API_URL",
      "https://api.whatsonchain.com/v1/bsv/main",
    ),
    wocApiKey: process.env.WOC_API_KEY?.trim() || undefined,
    // The free tier allows roughly 3 requests/second per IP. Raise this only
    // alongside a paid WOC_API_KEY, or the writer earns itself a 429 cooldown.
    wocMaxRequestsPerSecond: Number(optionalEnv("WOC_MAX_RPS", "3")),
    walletMasterSeed,
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
    arcMaxConcurrentBroadcasts: Number(
      optionalEnv("ARC_MAX_CONCURRENT_BROADCASTS", "4"),
    ),
    arcMaxQueueDepth: Number(
      optionalEnv("ARC_MAX_QUEUE_DEPTH", "12"),
    ),
    arcTransientRetryAttempts: Number(
      optionalEnv("ARC_TRANSIENT_RETRY_ATTEMPTS", "2"),
    ),
    arcTransientRetryBaseMs: Number(
      optionalEnv("ARC_TRANSIENT_RETRY_BASE_MS", "250"),
    ),
    arcCircuitFailureThreshold: Number(
      optionalEnv("ARC_CIRCUIT_FAILURE_THRESHOLD", "8"),
    ),
    arcCircuitWindowMs: Number(
      optionalEnv("ARC_CIRCUIT_WINDOW_MS", "10000"),
    ),
    arcCircuitOpenMs: Number(
      optionalEnv("ARC_CIRCUIT_OPEN_MS", "8000"),
    ),
    refillThresholdSats: Number(
      optionalEnv("REFILL_THRESHOLD_SATS", "200000"),
    ),
    refillAmountSats: Number(optionalEnv("REFILL_AMOUNT_SATS", "320000")),
    activeAircraftUtxoTarget: Number(
      optionalEnv("ACTIVE_AIRCRAFT_UTXO_TARGET", "96"),
    ),
    activeAircraftReadyUtxoTarget: Number(
      optionalEnv("ACTIVE_AIRCRAFT_READY_UTXO_TARGET", "48"),
    ),
    retryReadyUtxoReserve: Number(
      optionalEnv("RETRY_READY_UTXO_RESERVE", "12"),
    ),
    retryPressureReadyUtxoBoost: Number(
      optionalEnv("RETRY_PRESSURE_READY_UTXO_BOOST", "12"),
    ),
    retryPressureWindowMs: Number(
      optionalEnv("RETRY_PRESSURE_WINDOW_MS", "30000"),
    ),
    retryBackoffMs: Number(
      optionalEnv("RETRY_BACKOFF_MS", "12000"),
    ),
    retryBackoffJitterMs: Number(
      optionalEnv("RETRY_BACKOFF_JITTER_MS", "3000"),
    ),
    refillMinOutputSats: Number(
      optionalEnv("REFILL_MIN_OUTPUT_SATS", "10000"),
    ),
    consolidationThreshold: Number(
      optionalEnv("CONSOLIDATION_THRESHOLD", "20"),
    ),
    refillIdleWindowMs: Number(
      optionalEnv("REFILL_IDLE_WINDOW_MS", "1800000"),
    ),
    refillCheckIntervalMs: Number(
      optionalEnv("REFILL_CHECK_INTERVAL_MS", "5000"),
    ),
    refillMaxOutputsPerTx: Number(
      optionalEnv("REFILL_MAX_OUTPUTS_PER_TX", "40"),
    ),
    maxConcurrentRefills: Number(
      optionalEnv("REFILL_MAX_CONCURRENT", "64"),
    ),
    fundingPoolSplitTarget: Number(
      optionalEnv("FUNDING_POOL_SPLIT_TARGET", "256"),
    ),
    funding: {
      checkIntervalMs: Number(optionalEnv("FUNDING_CHECK_INTERVAL_MS", "15000")),
      lowWatermarkRefills: Number(optionalEnv("FUNDING_LOW_WATERMARK_REFILLS", "20")),
      dryPollBaseMs: Number(optionalEnv("FUNDING_DRY_POLL_BASE_MS", "30000")),
      dryPollMaxMs: Number(optionalEnv("FUNDING_DRY_POLL_MAX_MS", "600000")),
      alertRepeatMs: Number(optionalEnv("FUNDING_ALERT_REPEAT_MS", "3600000")),
      recoveryDrainBatchSize: Number(
        optionalEnv("FUNDING_RECOVERY_DRAIN_BATCH", "25"),
      ),
    },
    agentRefill: {
      enabled: optionalEnv("AGENT_REFILL_ENABLED", "true").toLowerCase() !== "false",
      checkIntervalMs: Number(optionalEnv("AGENT_REFILL_CHECK_INTERVAL_MS", "60000")),
      thresholdSats: Number(optionalEnv("AGENT_REFILL_THRESHOLD_SATS", "20000")),
      amountSats: Number(optionalEnv("AGENT_REFILL_AMOUNT_SATS", "60000")),
      outputCount: Number(optionalEnv("AGENT_REFILL_OUTPUTS", "20")),
      minOutputSats: Number(optionalEnv("AGENT_REFILL_MIN_OUTPUT_SATS", "1200")),
      minUsableOutputs: Number(optionalEnv("AGENT_REFILL_MIN_USABLE_OUTPUTS", "6")),
    },
  };
}
