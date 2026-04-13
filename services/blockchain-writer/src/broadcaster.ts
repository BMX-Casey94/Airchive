import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { ARC, type Transaction } from "@bsv/sdk";
import { createLogger } from "@airchive/logger";
import { txBroadcastFailures, txBroadcastLatency, txBroadcastTotal } from "./metrics.js";

function nodeFetchHttpClient() {
  return {
    async request<D>(url: string, options: { method?: string; headers?: Record<string, string>; data?: unknown }) {
      const res = await fetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.data != null ? JSON.stringify(options.data) : undefined,
      });
      const mediaType = res.headers.get("Content-Type");
      const data = mediaType?.startsWith("application/json")
        ? await res.json()
        : await res.text();
      return { ok: res.ok, status: res.status, statusText: res.statusText, data: data as D };
    },
  };
}

const log = createLogger({ service: "blockchain-writer:broadcaster" });

export interface BroadcastOutcome {
  txid: string;
  status: "SEEN_ON_NETWORK" | "FAILED";
  code?: string;
  description?: string;
}

export function isDependencyPendingBroadcastFailure(
  result: Pick<BroadcastOutcome, "status" | "code">,
): boolean {
  return result.status === "FAILED" && result.code === "SEEN_IN_ORPHAN_MEMPOOL";
}

export interface ArcCallbackPayload {
  txid: string;
  txStatus: string;
  blockHeight?: number;
  merklePath?: string;
}

export class ArcBroadcaster extends EventEmitter {
  private readonly arc: ARC;
  private callbackServer: Server | null = null;

  constructor(arcUrl: string, apiKey: string) {
    super();
    this.arc = new ARC(arcUrl, {
      apiKey,
      httpClient: nodeFetchHttpClient(),
    });
  }

  async broadcast(tx: Transaction, icao?: string): Promise<BroadcastOutcome> {
    const label = icao ?? "unknown";
    const start = performance.now();

    try {
      const response = await this.arc.broadcast(tx);
      const latency = (performance.now() - start) / 1_000;

      txBroadcastLatency.observe({ icao: label }, latency);

      if (response.status === "error" || !response.txid) {
        const failure = response as unknown as { code?: unknown; description?: unknown };
        const code = String(failure.code ?? "");
        const desc = String(failure.description ?? "");
        const dependencyPending = code === "SEEN_IN_ORPHAN_MEMPOOL";
        txBroadcastFailures.inc({
          icao: label,
          error_type: dependencyPending ? "DEPENDENCY_PENDING" : "ARC_REJECTED",
        });
        if (dependencyPending) {
          log.warn({ icao: label, response, latency }, `Broadcast dependency pending: ${desc}`);
        } else {
          log.error({ icao: label, response, latency }, `Broadcast rejected: ${desc}`);
        }
        return { txid: "", status: "FAILED", code: code || undefined, description: desc || undefined };
      }

      txBroadcastTotal.inc({
        icao: label,
        record_type: "tx",
        status: "SEEN_ON_NETWORK",
      });

      log.info({ txid: response.txid, latency }, "Broadcast accepted");

      return {
        txid: response.txid,
        status: "SEEN_ON_NETWORK",
      };
    } catch (err) {
      const latency = (performance.now() - start) / 1_000;
      txBroadcastLatency.observe({ icao: label }, latency);
      txBroadcastFailures.inc({
        icao: label,
        error_type: (err as Error).constructor.name,
      });

      log.error({ err, icao: label }, "Broadcast failed");

      return {
        txid: "",
        status: "FAILED",
        code: (err as Error).name,
        description: (err as Error).message,
      };
    }
  }

  setupCallbackReceiver(port: number): void {
    if (this.callbackServer) return;

    this.callbackServer = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === "POST" && req.url === "/arc/callback") {
          this.handleCallback(req, res);
          return;
        }

        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }

        res.writeHead(404);
        res.end();
      },
    );

    this.callbackServer.listen(port, () => {
      log.info({ port }, "ARC callback receiver listening");
    });
  }

  async closeCallbackReceiver(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.callbackServer) {
        resolve();
        return;
      }
      this.callbackServer.close(() => resolve());
    });
  }

  private handleCallback(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      if (chunks.reduce((s, c) => s + c.length, 0) > 1_048_576) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf-8"),
        ) as ArcCallbackPayload;

        if (!body.txid || !body.txStatus) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing txid or txStatus" }));
          return;
        }

        log.debug(
          { txid: body.txid, status: body.txStatus },
          "ARC callback received",
        );

        this.emit("status-update", {
          txid: body.txid,
          txStatus: body.txStatus,
          blockHeight: body.blockHeight,
          merklePath: body.merklePath,
        } satisfies ArcCallbackPayload);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });

    req.on("error", () => {
      res.writeHead(500);
      res.end();
    });
  }
}
