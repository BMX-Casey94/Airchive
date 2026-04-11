import { Registry, Counter, Gauge, Histogram } from "prom-client";

export const registry = new Registry();

export const agentPaymentsTotal = new Counter({
  name: "agent_payments_total",
  help: "Total micropayments between agents",
  labelNames: ["from_agent", "to_agent", "product"] as const,
  registers: [registry],
});

export const agentBalanceSats = new Gauge({
  name: "agent_balance_sats",
  help: "Current agent wallet balance in satoshis",
  labelNames: ["agent"] as const,
  registers: [registry],
});

export const agentMessagesTotal = new Counter({
  name: "agent_messages_total",
  help: "Total MessageBox messages sent/received",
  labelNames: ["agent", "direction"] as const,
  registers: [registry],
});

export const analysisPublishedTotal = new Counter({
  name: "analysis_published_total",
  help: "Total on-chain analysis publications",
  registers: [registry],
});

export const dataRequestLatency = new Histogram({
  name: "data_request_latency_seconds",
  help: "Latency of data request fulfilment",
  labelNames: ["product"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});
