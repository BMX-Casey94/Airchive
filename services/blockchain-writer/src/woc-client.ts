import { createLogger } from "@airchive/logger";
import { wocRequestsTotal, wocRateLimitedTotal, wocQueueDepth } from "./metrics.js";

const log = createLogger({ service: "blockchain-writer:woc" });

/**
 * WhatsOnChain's free tier allows roughly three requests per second per IP.
 * Every subsystem here used to call it with a bare `fetch`, so the confirmation
 * poller, UTXO reconciliation, funding reconciliation, agent refills and header
 * sync competed for that budget with no coordination between them.
 *
 * That is not merely wasteful, it is self-reinforcing: once WoC starts
 * answering 429, reconciliation is skipped, phantom outputs survive in the
 * pool, the next write spends one and is rejected, and each rejection triggers
 * another reconciliation attempt. The remedy is a single client that every
 * caller shares, so the budget is spent deliberately rather than raced for.
 */
const DEFAULT_MAX_RPS = 3;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Backoff applied after a 429, doubling up to the cap on repeats. */
const RATE_LIMIT_BASE_COOLDOWN_MS = 5_000;
const RATE_LIMIT_MAX_COOLDOWN_MS = 120_000;

/** Requests waiting longer than this are dropped rather than left to pile up. */
const MAX_QUEUE_WAIT_MS = 30_000;
const MAX_QUEUE_DEPTH = 500;

export class WocRateLimitedError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Chain lookup rate limited; retry in ${Math.round(retryAfterMs / 1_000)}s`);
    this.name = "WocRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class WocUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WocUnavailableError";
  }
}

export interface WocClientOptions {
  baseUrl: string;
  apiKey?: string;
  /**
   * Header that carries the API key. WhatsOnChain uses `Authorization`;
   * Bitails uses `apikey`. Defaults to Authorization.
   */
  apiKeyHeader?: string;
  /** Low-cardinality name for logs and metrics (e.g. whatsonchain, bananablocks). */
  name?: string;
  maxRequestsPerSecond?: number;
  maxConcurrent?: number;
}

interface QueuedRequest {
  run: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
}

export interface WocRequestOptions {
  timeoutMs?: number;
  /** Return null on 404 instead of throwing — normal for an unbroadcast txid. */
  allowNotFound?: boolean;
  /** Label used for metrics and logs; keep it low-cardinality. */
  label: string;
}

export interface WocTxStatus {
  txid: string;
  blockHeight: number;
  confirmations: number;
}

interface WocBulkStatusRow {
  txid?: string;
  hash?: string;
  blockhash?: string;
  blockHash?: string;
  blockheight?: number;
  blockHeight?: number;
  confirmations?: number;
  error?: string;
}

/** WhatsOnChain caps its bulk endpoints at 20 identifiers per request. */
export const WOC_BULK_LIMIT = 20;

export class WocClient {
  readonly baseUrl: string;
  readonly name: string;
  private readonly apiKey?: string;
  private readonly apiKeyHeader: string;
  private readonly maxRps: number;
  private readonly maxConcurrent: number;

  private queue: QueuedRequest[] = [];
  private inFlight = 0;
  private windowStart = 0;
  private windowCount = 0;
  private cooldownUntil = 0;
  private consecutiveRateLimits = 0;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WocClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.name = options.name?.trim() || "whatsonchain";
    this.apiKey = options.apiKey?.trim() || undefined;
    this.apiKeyHeader = options.apiKeyHeader?.trim() || "Authorization";
    this.maxRps = Math.max(1, options.maxRequestsPerSecond ?? DEFAULT_MAX_RPS);
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);

    log.info(
      {
        provider: this.name,
        endpoint: this.baseUrl,
        maxRequestsPerSecond: this.maxRps,
        maxConcurrent: this.maxConcurrent,
        authenticated: Boolean(this.apiKey),
      },
      this.apiKey
        ? `Chain provider ready (authenticated): ${this.name}`
        : `Chain provider ready on free-tier budget: ${this.name}`,
    );
  }

  /** True while a 429 cooldown is in force, so callers can defer work. */
  isRateLimited(): boolean {
    return Date.now() < this.cooldownUntil;
  }

  get rateLimitRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  async getJson<T>(path: string, options: WocRequestOptions): Promise<T | null> {
    return this.request<T>(path, options, undefined);
  }

  async postJson<T>(
    path: string,
    body: unknown,
    options: WocRequestOptions,
  ): Promise<T | null> {
    return this.request<T>(path, options, body);
  }

  /**
   * Confirmation status for many transactions in one call. Falls back to null
   * for the whole batch when WoC will not answer, so the caller retries the
   * batch rather than silently treating unknown transactions as unconfirmed.
   */
  async fetchTxStatuses(txids: string[]): Promise<Map<string, WocTxStatus> | null> {
    if (txids.length === 0) return new Map();

    const statuses = new Map<string, WocTxStatus>();

    for (let i = 0; i < txids.length; i += WOC_BULK_LIMIT) {
      const chunk = txids.slice(i, i + WOC_BULK_LIMIT);
      const rows = await this.postJson<WocBulkStatusRow[]>(
        "/txs/status",
        { txids: chunk },
        { label: "txs_status", allowNotFound: true },
      );
      if (!rows) return null;

      for (const row of rows) {
        const txid = (row.txid ?? row.hash ?? "").toLowerCase();
        if (!txid || row.error) continue;
        // WhatsOnChain uses `blockheight`; BananaBlocks uses `blockHeight`.
        const blockHeight = Number(row.blockheight ?? row.blockHeight ?? 0);
        if (!(blockHeight > 0)) continue;
        statuses.set(txid, {
          txid,
          blockHeight,
          confirmations: Number(row.confirmations ?? 0),
        });
      }
    }

    return statuses;
  }

  private async request<T>(
    path: string,
    options: WocRequestOptions,
    body: unknown,
  ): Promise<T | null> {
    await this.acquireSlot();

    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.apiKey) headers[this.apiKeyHeader] = this.apiKey;
      if (body !== undefined) headers["Content-Type"] = "application/json";

      const res = await fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });

      if (res.status === 429) {
        const cooldown = this.noteRateLimited(res.headers.get("retry-after"));
        wocRequestsTotal.inc({
          label: options.label,
          outcome: "rate_limited",
          provider: this.name,
        });
        throw new WocRateLimitedError(cooldown);
      }

      if (res.status === 404 && options.allowNotFound) {
        this.noteSuccess();
        wocRequestsTotal.inc({
          label: options.label,
          outcome: "not_found",
          provider: this.name,
        });
        return null;
      }

      if (!res.ok) {
        wocRequestsTotal.inc({
          label: options.label,
          outcome: "error",
          provider: this.name,
        });
        throw new WocUnavailableError(
          `${this.name} returned ${res.status} for ${options.label}`,
        );
      }

      this.noteSuccess();
      wocRequestsTotal.inc({
        label: options.label,
        outcome: "ok",
        provider: this.name,
      });
      return (await res.json()) as T;
    } finally {
      this.inFlight--;
      this.drain();
    }
  }

  private noteSuccess(): void {
    this.consecutiveRateLimits = 0;
  }

  private noteRateLimited(retryAfterHeader: string | null): number {
    this.consecutiveRateLimits++;
    wocRateLimitedTotal.inc();

    const retryAfterSeconds = Number(retryAfterHeader);
    const advised = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1_000
      : 0;

    const backoff = Math.min(
      RATE_LIMIT_MAX_COOLDOWN_MS,
      RATE_LIMIT_BASE_COOLDOWN_MS * 2 ** (this.consecutiveRateLimits - 1),
    );
    const cooldown = Math.max(advised, backoff);
    this.cooldownUntil = Date.now() + cooldown;

    log.warn(
      {
        provider: this.name,
        cooldownMs: cooldown,
        consecutive: this.consecutiveRateLimits,
      },
      "Chain provider rate limited — pausing traffic to this upstream",
    );
    return cooldown;
  }

  /**
   * Blocks until this request may proceed under both the concurrency cap and
   * the per-second budget. Rejects immediately during a 429 cooldown so a
   * backlog cannot form behind an endpoint that is refusing us anyway.
   */
  private acquireSlot(): Promise<void> {
    if (this.isRateLimited()) {
      return Promise.reject(new WocRateLimitedError(this.rateLimitRemainingMs));
    }
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      return Promise.reject(
        new WocUnavailableError("WhatsOnChain request queue is saturated"),
      );
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        run: () => resolve(),
        reject,
        enqueuedAt: Date.now(),
      });
      wocQueueDepth.set(this.queue.length);
      this.drain();
    });
  }

  private drain(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }

    while (this.queue.length > 0) {
      const now = Date.now();

      if (now < this.cooldownUntil) {
        this.failQueue(new WocRateLimitedError(this.cooldownUntil - now));
        return;
      }

      if (this.inFlight >= this.maxConcurrent) return;

      if (now - this.windowStart >= 1_000) {
        this.windowStart = now;
        this.windowCount = 0;
      }

      if (this.windowCount >= this.maxRps) {
        const waitMs = 1_000 - (now - this.windowStart);
        this.drainTimer = setTimeout(() => this.drain(), Math.max(1, waitMs));
        return;
      }

      const next = this.queue.shift();
      if (!next) return;
      wocQueueDepth.set(this.queue.length);

      if (now - next.enqueuedAt > MAX_QUEUE_WAIT_MS) {
        next.reject(new WocUnavailableError("WhatsOnChain request timed out in queue"));
        continue;
      }

      this.windowCount++;
      this.inFlight++;
      next.run();
    }
  }

  private failQueue(err: Error): void {
    const queued = this.queue;
    this.queue = [];
    wocQueueDepth.set(0);
    for (const request of queued) request.reject(err);
  }
}

/** True when an error means "WoC would not answer", rather than "WoC said no". */
export function isWocUnavailable(err: unknown): boolean {
  return err instanceof WocRateLimitedError || err instanceof WocUnavailableError;
}
