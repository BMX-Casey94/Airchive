import type { Server } from "node:http";
import type { FlightEventRecord, TelemetryRecord } from "@airchive/types";
import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";

import type { ParsedAirchiveTx } from "./tx-parser.js";

export interface NewTxPushPayload {
  txid: string;
  icao: string;
  timestamp: number;
  recordType: number;
  payload: TelemetryRecord | FlightEventRecord;
}

export interface WsClientMessage {
  type?: string;
  icao?: string;
}

function normaliseIcao(raw: string): string {
  return raw.trim().toUpperCase();
}

export function attachWebSocketServer(
  httpServer: Server,
  options: { path: string },
): {
  wss: WebSocketServer;
  notifyNewTx: (parsed: ParsedAirchiveTx & { txid: string }) => void;
  close: () => Promise<void>;
} {
  const channels = new Map<string, Set<WebSocket>>();

  const wss = new WebSocketServer({ server: httpServer, path: options.path });

  function subscribe(ws: WebSocket, icao: string): void {
    const key = normaliseIcao(icao);
    let set = channels.get(key);
    if (set === undefined) {
      set = new Set();
      channels.set(key, set);
    }
    set.add(ws);
  }

  function unsubscribeAll(ws: WebSocket): void {
    for (const [, set] of channels) {
      set.delete(ws);
    }
  }

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (data: RawData) => {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(String(data)) as WsClientMessage;
      } catch {
        ws.send(JSON.stringify({ type: "error", data: { message: "Invalid JSON" } }));
        return;
      }
      if (msg.type === "subscribe" && typeof msg.icao === "string" && msg.icao.length > 0) {
        try {
          subscribe(ws, msg.icao);
          ws.send(
            JSON.stringify({
              type: "subscribed",
              data: { icao: normaliseIcao(msg.icao) },
            }),
          );
        } catch {
          ws.send(
            JSON.stringify({
              type: "error",
              data: { message: "Invalid ICAO" },
            }),
          );
        }
        return;
      }
      if (msg.type === "unsubscribe") {
        unsubscribeAll(ws);
        ws.send(JSON.stringify({ type: "unsubscribed", data: {} }));
        return;
      }
      ws.send(
        JSON.stringify({
          type: "error",
          data: { message: "Unknown message type" },
        }),
      );
    });

    ws.on("close", () => {
      unsubscribeAll(ws);
    });
  });

  function notifyNewTx(parsed: ParsedAirchiveTx & { txid: string }): void {
    const key = parsed.icao.toUpperCase();
    const set = channels.get(key);
    if (set === undefined || set.size === 0) {
      return;
    }
    const message = JSON.stringify({
      type: "new_tx",
      data: {
        txid: parsed.txid,
        icao: parsed.icao,
        timestamp: parsed.timestamp,
        recordType: parsed.recordType,
        payload: parsed.payload,
      } satisfies NewTxPushPayload,
    });
    for (const client of set) {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    }
  }

  async function close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => {
        if (err !== undefined) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
    channels.clear();
  }

  return { wss, notifyNewTx, close };
}
