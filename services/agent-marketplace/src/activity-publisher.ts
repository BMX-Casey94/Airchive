import type { Knex } from "knex";
import { Redis } from "ioredis";
import { insertAgentActivity, type AgentActivityEventType } from "@airchive/db";
import { createLogger } from "@airchive/logger";

const log = createLogger({ service: "agent-activity" });

export interface AgentEvent {
  type: "discovery" | "transaction" | "analysis" | "status" | "message";
  agent: string;
  timestamp: number;
  data: Record<string, unknown>;
}

const PERSISTED_TYPES = new Set<AgentActivityEventType>([
  "discovery",
  "transaction",
  "analysis",
  "message",
]);

export class AgentActivityPublisher {
  private readonly redis: Redis;
  private readonly db: Knex;
  private readonly channel = "agent:activity";

  constructor(redis: Redis, db: Knex) {
    this.redis = redis;
    this.db = db;
  }

  async publish(event: AgentEvent): Promise<void> {
    try {
      await this.redis.publish(this.channel, JSON.stringify(event));
    } catch (err) {
      log.debug({ err }, "Failed to publish agent activity");
    }

    // Status heartbeats fire every few seconds and carry no day-total meaning;
    // everything else survives a reload so the marketplace tiles can be "today".
    if (PERSISTED_TYPES.has(event.type as AgentActivityEventType)) {
      void insertAgentActivity(this.db, {
        event_type: event.type as AgentActivityEventType,
        agent: event.agent,
        timestamp: event.timestamp,
        data: event.data,
      }).catch((err) => {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), type: event.type },
          "Failed to persist agent activity",
        );
      });
    }
  }

  async publishDiscovery(
    agent: string,
    identityKey: string,
    message: string,
  ): Promise<void> {
    await this.publish({
      type: "discovery",
      agent,
      timestamp: Date.now(),
      data: { identityKey, message },
    });
  }

  async publishTransaction(
    agent: string,
    action: string,
    amountSats: number,
    product: string,
    counterparty: string,
  ): Promise<void> {
    await this.publish({
      type: "transaction",
      agent,
      timestamp: Date.now(),
      data: { action, amountSats, product, counterparty },
    });
  }

  async publishAnalysis(
    agent: string,
    summary: string,
    txid: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.publish({
      type: "analysis",
      agent,
      timestamp: Date.now(),
      data: { summary, txid, ...details },
    });
  }

  async publishStatus(
    agent: string,
    status: string,
    balance?: number,
  ): Promise<void> {
    await this.publish({
      type: "status",
      agent,
      timestamp: Date.now(),
      data: { status, balance },
    });
  }

  async publishMessage(
    fromAgent: string,
    toAgent: string,
    messageType: string,
    content: string,
  ): Promise<void> {
    await this.publish({
      type: "message",
      agent: fromAgent,
      timestamp: Date.now(),
      data: { to: toAgent, messageType, content },
    });
  }
}
