import { Redis } from "ioredis";
import { createLogger } from "@airchive/logger";
import { loadAirports } from "@airchive/airports";
import { createDb, getAllAircraftConfig, upsertAircraftConfig } from "@airchive/db";
import { getConfig } from "./config.js";
import { PhaseEngine } from "./phase-engine.js";
import { fetchOpenSky } from "./clients/opensky.js";
import { fetchAdsbFi } from "./clients/adsbfi.js";
import { fetchRtlSdr } from "./clients/rtlsdr.js";
import { mergeRecords } from "./merger.js";
import { DedupFilter } from "./dedup-filter.js";
import { TelemetryPublisher } from "./publisher.js";
import {
  DemoReplayService,
  loadDemoRecordingIcaos,
  resolveDemoReplayPath,
} from "./demo-replay.js";
import {
  getMetricsServer,
  recordsTotal,
  trackedAircraftCount,
} from "./metrics.js";

const log = createLogger({ service: "ingestion" });

let running = true;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let phaseEngine: PhaseEngine | null = null;
let demoReplay: DemoReplayService | null = null;

async function main(): Promise<void> {
  const config = getConfig();

  const demoPath = resolveDemoReplayPath(
    config.demoReplayPath.length > 0 ? config.demoReplayPath : undefined,
  );

  let trackedAircraft: string[];
  if (config.demoMode) {
    const fromFile = await loadDemoRecordingIcaos(demoPath);
    trackedAircraft = [
      ...new Set([
        ...config.trackedAircraft.map((i) => i.trim().toUpperCase()).filter(Boolean),
        ...fromFile,
      ]),
    ];
    if (trackedAircraft.length === 0) {
      log.fatal(
        "DEMO_MODE is enabled but the demo recording contains no ICAO addresses and TRACKED_AIRCRAFT is empty",
      );
      process.exit(1);
    }
    log.info(
      { path: demoPath, icaos: trackedAircraft, speed: config.demoSpeedMultiplier },
      "Demo replay mode — live ADS-B polling disabled",
    );
  } else if (config.trackedAircraft.length === 0) {
    log.fatal("TRACKED_AIRCRAFT env var is empty — nothing to poll");
    process.exit(1);
  } else {
    trackedAircraft = config.trackedAircraft;
  }

  log.info(
    { aircraft: trackedAircraft, pollMs: config.pollIntervalMs, demo: config.demoMode },
    `Starting ingestion for ${trackedAircraft.length} aircraft`,
  );

  const airports = await loadAirports();
  log.info({ count: airports.count }, "Airport database loaded");

  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 10) return null;
      return Math.min(times * 500, 5000);
    },
    lazyConnect: true,
  });

  redis.on("error", (err) => {
    log.error({ err: err.message }, "Redis connection error");
  });

  redis.on("connect", () => {
    log.info("Redis connected");
  });

  await redis.connect();

  const db = createDb();
  try {
    await db.raw("select 1");
  } catch (err) {
    log.fatal({ err }, "PostgreSQL unreachable — phase engine requires a database");
    await db.destroy().catch(() => {});
    await redis.quit().catch(() => redis.disconnect());
    process.exit(1);
  }

  const allDbAircraft = await getAllAircraftConfig(db);
  const fleetMap = new Map<string, { icao: string; wallet_index: number }>();
  const existingByIcao = new Map(allDbAircraft.map((ac) => [ac.icao, ac]));

  // Preserve existing wallet indexes so HD-derived aircraft addresses stay stable across restarts.
  for (const ac of allDbAircraft) {
    if (ac.enabled) {
      fleetMap.set(ac.icao, { icao: ac.icao, wallet_index: ac.wallet_index });
    }
  }

  let autoIndex = allDbAircraft.length > 0
    ? Math.max(...allDbAircraft.map((a) => a.wallet_index)) + 1
    : 0;

  for (const icao of trackedAircraft) {
    const existing = existingByIcao.get(icao);
    if (existing) {
      fleetMap.set(icao, { icao, wallet_index: existing.wallet_index });
      continue;
    }
    fleetMap.set(icao, { icao, wallet_index: autoIndex++ });
  }

  for (const aircraft of fleetMap.values()) {
    await upsertAircraftConfig(db, {
      icao: aircraft.icao,
      callsign: aircraft.icao,
      reg: "",
      aircraft_type: "",
      wallet_index: aircraft.wallet_index,
      enabled: true,
    });
  }
  log.info({ count: fleetMap.size }, "aircraft_config rows ensured");

  const publisher = new TelemetryPublisher(redis);
  const dedup = new DedupFilter();

  phaseEngine = new PhaseEngine({ redis, airportLookup: airports, db });
  try {
    await phaseEngine.start(trackedAircraft);
  } catch (err) {
    log.fatal({ err }, "Phase engine failed to start");
    await phaseEngine.stop().catch(() => {});
    phaseEngine = null;
    await db.destroy().catch(() => {});
    await redis.quit().catch(() => redis.disconnect());
    process.exit(1);
  }

  trackedAircraftCount.set(trackedAircraft.length);

  const metricsServer = getMetricsServer();
  log.info("Prometheus metrics server listening on :9090/metrics");

  async function pollCycle(): Promise<void> {
    if (!running || config.demoMode) return;

    try {
      const fetches: Promise<Partial<import("@airchive/types").TelemetryRecord>[]>[] = [
        fetchAdsbFi(trackedAircraft, config.adsbfi.apiUrl),
      ];

      if (config.opensky.enabled) {
        fetches.push(
          fetchOpenSky(
            trackedAircraft,
            config.opensky.username && config.opensky.password
              ? { username: config.opensky.username, password: config.opensky.password }
              : undefined,
            config.opensky.apiUrl,
          ),
        );
      }

      if (config.rtlSdr.enabled) {
        fetches.push(fetchRtlSdr(config.rtlSdr.endpoint));
      }

      const sources = await Promise.all(fetches);
      const merged = mergeRecords(sources);

      const toPublish = merged.filter((r) => dedup.shouldPublish(r));

      if (toPublish.length > 0) {
        await publisher.publishBatch(toPublish);

        for (const r of toPublish) {
          dedup.recordPublished(r);
          const src = r.data_sources.join(",") || "unknown";
          recordsTotal.inc({ source: src, icao: r.icao });
        }
      }

      if (merged.length > 0) {
        log.debug(
          { total: merged.length, published: toPublish.length },
          "Poll cycle complete",
        );
      }
    } catch (err) {
      log.error({ err }, "Poll cycle failed");
    }

    if (running) {
      pollTimer = setTimeout(pollCycle, config.pollIntervalMs);
    }
  }

  if (config.demoMode) {
    demoReplay = new DemoReplayService(demoPath);
    try {
      await demoReplay.start(redis, config.demoSpeedMultiplier);
    } catch (err) {
      log.fatal({ err }, "Demo replay failed to start");
      demoReplay.stop();
      demoReplay = null;
      await phaseEngine.stop().catch(() => {});
      phaseEngine = null;
      await db.destroy().catch(() => {});
      await redis.quit().catch(() => redis.disconnect());
      process.exit(1);
    }
  } else {
    pollCycle();
  }

  async function shutdown(signal: string): Promise<void> {
    if (!running) return;
    running = false;
    log.info({ signal }, "Shutting down gracefully");

    if (demoReplay) {
      demoReplay.stop();
      demoReplay = null;
    }

    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }

    metricsServer.close();

    try {
      if (phaseEngine) {
        await phaseEngine.stop();
        phaseEngine = null;
      }
    } catch (err) {
      log.warn({ err }, "Phase engine stop");
    }

    try {
      await db.destroy();
    } catch (err) {
      log.warn({ err }, "Database pool shutdown");
    }

    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }

    log.info("Shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
