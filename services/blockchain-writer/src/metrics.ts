import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

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
