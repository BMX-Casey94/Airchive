import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Redis } from "ioredis";
import type { TelemetryRecord } from "@airchive/types";
import { createLogger } from "@airchive/logger";
import { TelemetryPublisher } from "./publisher.js";
import { recordsTotal } from "./metrics.js";

const log = createLogger({ service: "ingestion" });

/**
 * Resolves the demo recording path. Relative env paths are resolved from `process.cwd()`.
 * When unset, uses `data/demo-flights.json` next to this module (`src/data` in dev, `dist/data` after build).
 */
export function resolveDemoReplayPath(explicit?: string): string {
  const trimmed = explicit?.trim() ?? "";
  if (trimmed.length > 0) {
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
  }
  return fileURLToPath(new URL("./data/demo-flights.json", import.meta.url));
}

export async function loadDemoRecordingIcaos(filePath: string): Promise<string[]> {
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Demo recording must be a JSON array");
  }
  const set = new Set<string>();
  for (const item of parsed) {
    if (item && typeof item === "object" && "icao" in item) {
      const icao = String((item as { icao: unknown }).icao).trim().toUpperCase();
      if (icao.length > 0) set.add(icao);
    }
  }
  return [...set];
}

function sortByTs(records: TelemetryRecord[]): TelemetryRecord[] {
  return [...records].sort((a, b) => a.ts - b.ts);
}

export class DemoReplayService {
  private readonly filePath: string;

  private publisher: TelemetryPublisher | null = null;

  private records: TelemetryRecord[] = [];

  private speedMultiplier = 1;

  private stopped = true;

  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? resolveDemoReplayPath();
  }

  get dataPath(): string {
    return this.filePath;
  }

  async load(): Promise<void> {
    const raw = await readFile(this.filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("Demo recording must be a JSON array of telemetry objects");
    }
    this.records = sortByTs(parsed as TelemetryRecord[]);
    if (this.records.length === 0) {
      throw new Error("Demo recording is empty");
    }
    log.info({ path: this.filePath, count: this.records.length }, "Demo recording loaded");
  }

  /**
   * Publishes to `telemetry:{icao}` using the same format as live ingestion.
   * Timing follows deltas between `ts` values; on loop, timestamps are shifted so the timeline stays coherent.
   */
  async start(redis: Redis, speedMultiplier = 1): Promise<void> {
    await this.load();
    this.stopped = false;
    this.speedMultiplier = Math.max(0.01, speedMultiplier);
    this.publisher = new TelemetryPublisher(redis);
    log.info({ speedMultiplier: this.speedMultiplier }, "Demo replay started");
    this.runStep(0, Date.now());
  }

  stop(): void {
    this.stopped = true;
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.publisher = null;
    log.info("Demo replay stopped");
  }

  private runStep(index: number, loopStart: number): void {
    if (this.stopped || !this.publisher) return;

    const recs = this.records;
    const first = recs[0]!;
    const record = recs[index]!;
    const outTs = loopStart + (record.ts - first.ts);
    const payload: TelemetryRecord = { ...record, ts: outTs, ts_pos: outTs };

    void this.publisher
      .publish(payload)
      .then(() => {
        recordsTotal.inc({ source: "demo", icao: payload.icao });
        if (this.stopped || !this.publisher) return;

        const nextIndex = index + 1;
        if (nextIndex >= recs.length) {
          this.timeoutHandle = setTimeout(() => {
            this.runStep(0, Date.now());
          }, 0);
          return;
        }

        const delta =
          Math.max(0, recs[nextIndex]!.ts - record.ts) / this.speedMultiplier;
        this.timeoutHandle = setTimeout(() => {
          this.runStep(nextIndex, loopStart);
        }, delta);
      })
      .catch((err: unknown) => {
        log.error({ err }, "Demo publish failed");
      });
  }
}
