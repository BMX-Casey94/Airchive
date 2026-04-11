import { createServer } from "node:http";
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

const register = new Registry();
collectDefaultMetrics({ register });

export const pollsTotal = new Counter({
  name: "airchive_ingestion_polls_total",
  help: "Total number of poll cycles executed",
  labelNames: ["source"] as const,
  registers: [register],
});

export const recordsTotal = new Counter({
  name: "airchive_ingestion_records_total",
  help: "Total telemetry records ingested",
  labelNames: ["source", "icao"] as const,
  registers: [register],
});

export const errorsTotal = new Counter({
  name: "airchive_ingestion_errors_total",
  help: "Total ingestion errors",
  labelNames: ["source"] as const,
  registers: [register],
});

export const pollDuration = new Histogram({
  name: "airchive_ingestion_poll_duration_seconds",
  help: "Duration of poll requests in seconds",
  labelNames: ["source"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const trackedAircraftCount = new Gauge({
  name: "airchive_ingestion_tracked_aircraft_count",
  help: "Number of aircraft currently tracked",
  registers: [register],
});

const METRICS_PORT = 9090;

export function getMetricsServer(): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    if (req.url === "/metrics" && req.method === "GET") {
      try {
        const metrics = await register.metrics();
        res.writeHead(200, { "Content-Type": register.contentType });
        res.end(metrics);
      } catch {
        res.writeHead(500);
        res.end("Internal error collecting metrics");
      }
      return;
    }
    res.writeHead(404);
    res.end("Not Found");
  });

  server.listen(METRICS_PORT, "0.0.0.0", () => {
    /* metrics endpoint ready */
  });

  return server;
}
