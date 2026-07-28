import { EventEmitter } from "node:events";
import { createLogger } from "@airchive/logger";
import { arcadeSseConnected, arcadeStatusEventsTotal } from "./metrics.js";
import type { ArcCallbackPayload } from "./broadcaster.js";

const log = createLogger({ service: "blockchain-writer:arcade-sse" });

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** Arcade sends periodic comments; silence well beyond that means a dead socket. */
const IDLE_TIMEOUT_MS = 90_000;
/** Response headers should arrive immediately; anything slower is a stuck proxy. */
const CONNECT_TIMEOUT_MS = 15_000;

export interface ArcadeStatusEvent {
  txid: string;
  status?: string;
  txStatus?: string;
  blockHeight?: number;
  blockHash?: string;
  merklePath?: string;
  timestamp?: string;
  extraInfo?: string;
  competingTxs?: string[];
}

/**
 * Consumes Arcade's `GET /events` SSE stream.
 *
 * This replaces the inbound ARC callback receiver, which never worked: ARC has
 * to reach the writer, and behind NAT or an ephemeral tunnel it cannot. SSE is
 * an outbound connection, so it needs no inbound reachability at all — which is
 * why transaction confirmation tracking was previously dead.
 */
export class ArcadeSseClient extends EventEmitter {
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private lastEventId: string | null = null;
  private stopped = false;

  constructor(
    private readonly baseUrl: string,
    private readonly callbackToken: string,
    private readonly apiKey?: string,
  ) {
    super();
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.abortController?.abort();
    this.abortController = null;
    arcadeSseConnected.set(0);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(this.consecutiveFailures, 5),
    );
    const jitter = Math.floor(Math.random() * RECONNECT_BASE_MS);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay + jitter);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    const url = `${this.baseUrl}/events?callbackToken=${encodeURIComponent(this.callbackToken)}`;
    const controller = new AbortController();
    this.abortController = controller;

    // Guards against a half-open socket that never errors and never delivers,
    // covering both the connect phase and subsequent silence on the stream.
    let idleTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
    const resetIdleTimer = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
    };

    try {
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      // Arcade replays everything missed since this id, so a dropped connection
      // does not lose confirmations.
      if (this.lastEventId) headers["Last-Event-ID"] = this.lastEventId;
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok || !res.body) {
        throw new Error(`Arcade SSE ${res.status} ${res.statusText}`);
      }

      resetIdleTimer();
      this.consecutiveFailures = 0;
      arcadeSseConnected.set(1);
      log.info({ endpoint: this.baseUrl }, "Arcade SSE status stream connected");

      await this.readStream(res.body, resetIdleTimer);
      throw new Error("Arcade SSE stream ended");
    } catch (err) {
      arcadeSseConnected.set(0);
      if (!this.stopped) {
        this.consecutiveFailures++;
        log.warn(
          { err: (err as Error).message, attempt: this.consecutiveFailures },
          "Arcade SSE stream disconnected — reconnecting",
        );
        this.scheduleReconnect();
      }
    } finally {
      clearTimeout(idleTimer);
      if (this.abortController === controller) this.abortController = null;
    }
  }

  private async readStream(
    body: ReadableStream<Uint8Array>,
    onActivity: () => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!this.stopped) {
      const { done, value } = await reader.read();
      if (done) return;

      onActivity();
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; tolerate CRLF.
      let separator = findFrameSeparator(buffer);
      while (separator) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        this.handleFrame(frame);
        separator = findFrameSeparator(buffer);
      }
    }
  }

  private handleFrame(frame: string): void {
    let eventName = "message";
    let eventId: string | null = null;
    const dataLines: string[] = [];

    for (const rawLine of frame.split(/\r?\n/)) {
      // A leading colon is a keep-alive comment.
      if (rawLine === "" || rawLine.startsWith(":")) continue;
      const colon = rawLine.indexOf(":");
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
      const valueRaw = colon === -1 ? "" : rawLine.slice(colon + 1);
      const value = valueRaw.startsWith(" ") ? valueRaw.slice(1) : valueRaw;

      if (field === "event") eventName = value;
      else if (field === "data") dataLines.push(value);
      else if (field === "id") eventId = value;
    }

    if (eventId) this.lastEventId = eventId;
    if (dataLines.length === 0) return;
    if (eventName !== "status" && eventName !== "message") return;

    let event: ArcadeStatusEvent;
    try {
      event = JSON.parse(dataLines.join("\n")) as ArcadeStatusEvent;
    } catch {
      log.warn({ frame: frame.slice(0, 200) }, "Discarding unparseable Arcade SSE frame");
      return;
    }

    const status = (event.txStatus ?? event.status ?? "").trim().toUpperCase();
    if (!event.txid || status === "") return;

    arcadeStatusEventsTotal.inc({ status });
    this.emit("status-update", {
      txid: event.txid,
      txStatus: status,
      blockHeight: event.blockHeight,
      blockHash: event.blockHash,
      merklePath: event.merklePath,
      extraInfo: event.extraInfo,
      competingTxs: event.competingTxs,
    } satisfies ArcCallbackPayload);
  }
}

function findFrameSeparator(
  buffer: string,
): { index: number; length: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  if (lf !== -1) return { index: lf, length: 2 };
  return null;
}
