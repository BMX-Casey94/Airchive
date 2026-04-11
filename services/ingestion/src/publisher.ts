import { Redis } from "ioredis";
import type { TelemetryRecord } from "@airchive/types";

export class TelemetryPublisher {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async publish(record: TelemetryRecord): Promise<void> {
    const payload = JSON.stringify(record);
    const channel = `telemetry:${record.icao}`;
    await this.redis.publish(channel, payload);
  }

  async publishBatch(records: TelemetryRecord[]): Promise<void> {
    if (records.length === 0) return;

    const pipeline = this.redis.pipeline();

    for (const record of records) {
      const payload = JSON.stringify(record);
      const channel = `telemetry:${record.icao}`;
      pipeline.publish(channel, payload);
    }

    await pipeline.exec();
  }
}
