import { WebSocketServer, WebSocket } from "ws";
import { Redis } from "ioredis";
import { createLogger } from "@airchive/logger";
import type { Server } from "node:http";

const log = createLogger({ service: "gateway-ws" });

interface WsClient {
  ws: WebSocket;
  subscriptions: Set<string>;
}

export class WsHub {
  private clients = new Set<WsClient>();
  private wss: WebSocketServer | null = null;
  private subscriber: Redis | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  async start(server: Server, redisConfig: { host: string; port: number }): Promise<void> {
    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", (ws) => {
      const client: WsClient = { ws, subscriptions: new Set() };
      this.clients.add(client);

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.subscribe && Array.isArray(msg.subscribe)) {
            for (const icao of msg.subscribe) {
              client.subscriptions.add(String(icao).toUpperCase());
            }
          }
          if (msg.unsubscribe && Array.isArray(msg.unsubscribe)) {
            for (const icao of msg.unsubscribe) {
              client.subscriptions.delete(String(icao).toUpperCase());
            }
          }
        } catch {
          /* ignore malformed messages */
        }
      });

      ws.on("close", () => this.clients.delete(client));
      ws.on("error", () => this.clients.delete(client));
    });

    this.subscriber = new Redis({ host: redisConfig.host, port: redisConfig.port, lazyConnect: true });
    await this.subscriber.connect();
    await this.subscriber.subscribe("broadcast", "txresult", "alerts", "phase", "agent:activity");

    this.subscriber.on("message", (_channel: string, message: string) => {
      try {
        const data = JSON.parse(message);
        const icao = (data.icao ?? data.aircraft_icao ?? "").toUpperCase();
        const type = _channel === "broadcast" ? "telemetry"
          : _channel === "txresult" ? "tx_result"
          : _channel === "alerts" ? "alert"
          : _channel === "agent:activity" ? "agent_activity"
          : "phase_change";

        const payload = JSON.stringify({ type, payload: data });
        const broadcastToAll = type === "agent_activity";

        for (const client of this.clients) {
          if (client.ws.readyState !== WebSocket.OPEN) continue;
          if (!broadcastToAll && client.subscriptions.size > 0 && !client.subscriptions.has(icao)) continue;
          client.ws.send(payload);
        }
      } catch {
        /* ignore parse errors */
      }
    });

    this.pingInterval = setInterval(() => {
      for (const client of this.clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.ping();
        }
      }
    }, 30_000);

    log.info("WebSocket hub started");
  }

  get connectedClients(): number {
    return this.clients.size;
  }

  async stop(): Promise<void> {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.subscriber) {
      this.subscriber.disconnect();
      this.subscriber = null;
    }
    if (this.wss) {
      for (const client of this.clients) {
        client.ws.close(1001, "Server shutting down");
      }
      this.wss.close();
      this.wss = null;
    }
  }
}
