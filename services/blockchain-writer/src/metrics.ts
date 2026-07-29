import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";
import { RecordType } from "@airchive/types";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const txBroadcastTotal = new Counter({
  name: "airchive_tx_broadcast_total",
  help: "Total transactions broadcast",
  labelNames: ["icao", "record_type", "status"] as const,
  registers: [registry],
});

export const txBroadcastLatency = new Histogram({
  name: "airchive_tx_broadcast_latency_seconds",
  help: "Broadcast latency in seconds",
  labelNames: ["icao"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const txBroadcastFailures = new Counter({
  name: "airchive_tx_broadcast_failures_total",
  help: "Total broadcast failures",
  labelNames: ["icao", "error_type"] as const,
  registers: [registry],
});

export const txBroadcastRetryTotal = new Counter({
  name: "airchive_tx_broadcast_retries_total",
  help: "Total transient broadcast retries attempted",
  labelNames: ["kind", "reason"] as const,
  registers: [registry],
});

export const txBroadcastQueueDepth = new Gauge({
  name: "airchive_tx_broadcast_queue_depth",
  help: "Current queued broadcast requests waiting for ARC slots",
  registers: [registry],
});

export const txBroadcastInFlight = new Gauge({
  name: "airchive_tx_broadcast_in_flight",
  help: "Current number of in-flight ARC broadcast requests",
  registers: [registry],
});

export const txBroadcastBreakerOpen = new Gauge({
  name: "airchive_tx_broadcast_breaker_open",
  help: "Whether the ARC transient failure breaker is currently open",
  registers: [registry],
});

export const writerWriteIngressTotal = new Counter({
  name: "airchive_writer_write_ingress_total",
  help: "Total write attempts entering the blockchain writer",
  labelNames: ["path", "record_type"] as const,
  registers: [registry],
});

export const writerWriteOutcomesTotal = new Counter({
  name: "airchive_writer_write_outcomes_total",
  help: "Total write outcomes inside the blockchain writer",
  labelNames: ["path", "record_type", "outcome"] as const,
  registers: [registry],
});

export const utxoPoolBalance = new Gauge({
  name: "airchive_utxo_pool_balance_sats",
  help: "UTXO pool balance per aircraft in satoshis",
  labelNames: ["icao"] as const,
  registers: [registry],
});

export const utxoPoolCount = new Gauge({
  name: "airchive_utxo_pool_count",
  help: "Number of UTXOs per aircraft",
  labelNames: ["icao"] as const,
  registers: [registry],
});

export const pendingWritesGauge = new Gauge({
  name: "airchive_pending_writes",
  help: "Pending writes awaiting broadcast",
  registers: [registry],
});

export const fundingPoolBalance = new Gauge({
  name: "airchive_funding_pool_balance_sats",
  help: "Treasury/funding UTXO pool balance in satoshis",
  registers: [registry],
});

export const fundingPoolCount = new Gauge({
  name: "airchive_funding_pool_count",
  help: "Number of UTXOs in the treasury/funding pool",
  registers: [registry],
});

export const refillOutcomesTotal = new Counter({
  name: "airchive_refill_outcomes_total",
  help: "Auto-refill attempt outcomes by distinct cause",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const treasuryDry = new Gauge({
  name: "airchive_treasury_dry",
  help: "1 when the treasury could not supply a funding UTXO on the last attempt",
  registers: [registry],
});

export const aircraftDryCount = new Gauge({
  name: "airchive_aircraft_dry_count",
  help: "Aircraft in the tracked fleet with no spendable UTXOs",
  registers: [registry],
});

export const agentWalletBalance = new Gauge({
  name: "airchive_agent_wallet_balance_sats",
  help: "On-chain balance of each marketplace agent wallet",
  labelNames: ["agent"] as const,
  registers: [registry],
});

export const agentRefillOutcomesTotal = new Counter({
  name: "airchive_agent_refill_outcomes_total",
  help: "Treasury top-up attempts for marketplace agent wallets",
  labelNames: ["agent", "outcome"] as const,
  registers: [registry],
});

export const arcadeSubmissionsTotal = new Counter({
  name: "airchive_arcade_submissions_total",
  help: "Transactions submitted to Arcade by outcome",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const arcadeFallbackTotal = new Counter({
  name: "airchive_arcade_fallback_total",
  help: "Transactions routed to the ARC fallback instead of Arcade",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const arcadeBatchSize = new Histogram({
  name: "airchive_arcade_batch_size",
  help: "Transactions coalesced into a single Arcade batch submission",
  buckets: [1, 2, 5, 10, 25, 50, 100],
  registers: [registry],
});

export const arcadeSseConnected = new Gauge({
  name: "airchive_arcade_sse_connected",
  help: "1 while the Arcade SSE status stream is connected",
  registers: [registry],
});

export const arcadeStatusEventsTotal = new Counter({
  name: "airchive_arcade_status_events_total",
  help: "Transaction status events received from the Arcade SSE stream",
  labelNames: ["status"] as const,
  registers: [registry],
});

export const statusEventsShedTotal = new Counter({
  name: "airchive_status_events_shed_total",
  help: "Status events dropped because the processing backlog was saturated",
  registers: [registry],
});

export const statusQueueDepth = new Gauge({
  name: "airchive_status_queue_depth",
  help: "Status events waiting to be processed",
  registers: [registry],
});

export const utxoLocksReclaimedTotal = new Counter({
  name: "airchive_utxo_locks_reclaimed_total",
  help: "UTXO locks reclaimed after exceeding the lock TTL",
  labelNames: ["pool"] as const,
  registers: [registry],
});

export const headerFetchTotal = new Counter({
  name: "airchive_spv_header_fetch_total",
  help: "Block header fetches by outcome",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const headersStoredGauge = new Gauge({
  name: "airchive_spv_headers_stored",
  help: "Block headers held locally for merkle proof verification",
  registers: [registry],
});

export const spvVerificationsTotal = new Counter({
  name: "airchive_spv_verifications_total",
  help: "Merkle proof verification attempts by outcome",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const wocRequestsTotal = new Counter({
  name: "airchive_woc_requests_total",
  help: "Chain-data requests by provider, call site and outcome",
  labelNames: ["label", "outcome", "provider"] as const,
  registers: [registry],
});

export const wocRateLimitedTotal = new Counter({
  name: "airchive_woc_rate_limited_total",
  help: "WhatsOnChain responses that rate limited the writer",
  registers: [registry],
});

export const wocQueueDepth = new Gauge({
  name: "airchive_woc_queue_depth",
  help: "Requests waiting for a slot in the shared WhatsOnChain budget",
  registers: [registry],
});

export const fundingStateGauge = new Gauge({
  name: "airchive_funding_state",
  help: "Funding state machine position (0 HEALTHY, 1 LOW, 2 DRY, 3 RECOVERING)",
  labelNames: ["scope"] as const,
  registers: [registry],
});

export const fundingRunwayHours = new Gauge({
  name: "airchive_funding_runway_hours",
  help: "Estimated hours of treasury runway at the observed burn rate",
  registers: [registry],
});

export const fundingRecoveriesTotal = new Counter({
  name: "airchive_funding_recoveries_total",
  help: "Completed treasury recoveries after a dry period",
  registers: [registry],
});

export function recordTypeMetricLabel(recordType: RecordType): string {
  switch (recordType) {
    case RecordType.FLIGHT_EVENT:
      return "flight_event";
    case RecordType.TELEMETRY_DELTA:
      return "telemetry_delta";
    case RecordType.TELEMETRY:
    default:
      return "telemetry";
  }
}
