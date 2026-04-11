import { Redis } from "ioredis";
import { createLogger } from "@airchive/logger";

const log = createLogger({ service: "agent-activity" });

export interface AgentEvent {
  type: "discovery" | "transaction" | "analysis" | "status" | "message";
  agent: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export class AgentActivityPublisher {
  private readonly redis: Redis;
  private readonly channel = "agent:activity";

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async publish(event: AgentEvent): Promise<void> {
    try {
      await this.redis.publish(this.channel, JSON.stringify(event));
    } catch (err) {
      log.debug({ err }, "Failed to publish agent activity");
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
