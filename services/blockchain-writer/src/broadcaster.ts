import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { ARC, type Transaction } from "@bsv/sdk";
import { createLogger } from "@airchive/logger";
import {
  txBroadcastBreakerOpen,
  txBroadcastFailures,
  txBroadcastInFlight,
  txBroadcastLatency,
  txBroadcastQueueDepth,
  txBroadcastRetryTotal,
  txBroadcastTotal,
} from "./metrics.js";

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

export type BroadcastKind =
  | "telemetry"
  | "flight_event"
  | "retry"
  | "refill"
  | "consolidation"
  | "tx";

export interface BroadcastOptions {
  kind?: BroadcastKind;
  priority?: number;
  allowTransientRetry?: boolean;
}

export const BroadcastPriority = {
  REFILL: 0,
  FLIGHT_EVENT: 10,
  LIVE_TELEMETRY: 20,
  RETRY_EVENT: 30,
  RETRY_TELEMETRY: 40,
  CONSOLIDATION: 80,
} as const;

export function isDependencyPendingBroadcastFailure(
  result: Pick<BroadcastOutcome, "status" | "code">,
): boolean {
  return result.status === "FAILED" && result.code === "SEEN_IN_ORPHAN_MEMPOOL";
}

const LOCAL_BACKPRESSURE_CODES = new Set([
  "ARC_QUEUE_SATURATED",
  "ARC_CIRCUIT_OPEN",
]);

export function isLocalBackpressureBroadcastFailure(
  result: Pick<BroadcastOutcome, "status" | "code">,
): boolean {
  return result.status === "FAILED"
    && LOCAL_BACKPRESSURE_CODES.has(String(result.code ?? "").trim().toUpperCase());
}

const TRANSIENT_FAILURE_CODES = new Set([
  "408",
  "429",
  "500",
  "502",
  "503",
  "504",
  "ABORTERROR",
  "TYPEERROR",
]);

export function isTransientBroadcastFailure(
  result: Pick<BroadcastOutcome, "status" | "code" | "description">,
): boolean {
  if (result.status !== "FAILED") return false;

  const code = String(result.code ?? "").trim().toUpperCase();
  const description = String(result.description ?? "").trim().toLowerCase();
  if (code === "SEEN_IN_ORPHAN_MEMPOOL") return false;
  if (LOCAL_BACKPRESSURE_CODES.has(code)) return false;
  if (TRANSIENT_FAILURE_CODES.has(code)) return true;

  return description.includes("fetch failed")
    || description.includes("network")
    || description.includes("timeout")
    || description.includes("timed out")
    || description.includes("temporarily unavailable")
    || description.includes("connection reset")
    || description.includes("socket");
}

export interface ArcCallbackPayload {
  txid: string;
  txStatus: string;
  blockHeight?: number;
  blockHash?: string;
  merklePath?: string;
  /**
   * The upstream's reason. A rejection without one is undiagnosable, and every
   * rejection reason implies a different fix — a missing input, a fee below
   * policy and a malformed script are not the same incident.
   */
  extraInfo?: string;
  competingTxs?: string[];
}

/**
 * Diagnosis carried from the terminal-reject source (SSE or poller) through
 * unwind and rebuffer so logs and `tx_results` stay actionable.
 */
export interface TerminalRejectionContext {
  /** Arcade/ARC status, e.g. REJECTED or DOUBLE_SPEND_ATTEMPTED. */
  status: string;
  /** Upstream free-text reason when provided. */
  reason?: string;
  competingTxs?: string[];
  source: "sse" | "poller";
  /**
   * Truncated upstream JSON when Arcade returned a terminal status but no
   * human-readable reason field — used for log diagnosis only.
   */
  upstreamSnippet?: string;
}

/**
 * The contract every broadcast upstream satisfies, so Arcade and ARC are
 * interchangeable at the call sites without those sites knowing which is live.
 */
export interface Broadcaster {
  /**
   * True when the upstream withholds a success outcome until the network has
   * actually seen the transaction. Call sites use this to decide whether an
   * orphan-mempool result may be treated optimistically: with a gate in place
   * an orphan outcome is a genuine failure, without one it is only "not yet".
   */
  readonly hasSeenOnNetworkGate?: boolean;
  broadcast(
    tx: Transaction,
    icao?: string,
    options?: BroadcastOptions,
  ): Promise<BroadcastOutcome>;
  getState(): ArcBroadcasterState;
  getLimits(): Pick<ArcBroadcasterConfig, "maxConcurrentBroadcasts" | "maxQueueDepth">;
  isDegraded(): boolean;
  setupCallbackReceiver(port: number): void;
  closeCallbackReceiver(): Promise<void>;
  on(event: "status-update", listener: (payload: ArcCallbackPayload) => void): this;
}

export interface ArcEndpointConfig {
  name: string;
  url: string;
  apiKey?: string;
}

export interface ArcBroadcasterConfig {
  maxConcurrentBroadcasts: number;
  maxQueueDepth: number;
  transientRetryAttempts: number;
  transientRetryBaseMs: number;
  circuitFailureThreshold: number;
  circuitWindowMs: number;
  circuitOpenMs: number;
  emitStateMetrics?: boolean;
}

export interface ArcBroadcasterState {
  inFlight: number;
  queueDepth: number;
  circuitOpen: boolean;
  circuitOpenRemainingMs: number;
}

interface ResolvedBroadcastOptions {
  kind: BroadcastKind;
  priority: number;
  allowTransientRetry: boolean;
}

interface QueuedBroadcast {
  seq: number;
  tx: Transaction;
  icao?: string;
  options: ResolvedBroadcastOptions;
  enqueuedAt: number;
  resolve: (outcome: BroadcastOutcome) => void;
}

interface AttemptResult {
  outcome: BroadcastOutcome;
  latency: number;
}

const DEFAULT_CONFIG: ArcBroadcasterConfig = {
  maxConcurrentBroadcasts: 4,
  maxQueueDepth: 12,
  transientRetryAttempts: 2,
  transientRetryBaseMs: 250,
  circuitFailureThreshold: 8,
  circuitWindowMs: 10_000,
  circuitOpenMs: 8_000,
};

const DEFAULT_BROADCAST_OPTIONS: ResolvedBroadcastOptions = {
  kind: "tx",
  priority: 50,
  allowTransientRetry: true,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SingleArcBroadcaster extends EventEmitter {
  private readonly arc: ARC;
  private readonly config: ArcBroadcasterConfig;
  private readonly upstreamName: string;
  private readonly emitStateMetrics: boolean;
  private callbackServer: Server | null = null;
  private readonly queue: QueuedBroadcast[] = [];
  private inFlight = 0;
  private seq = 0;
  private breakerOpenUntil = 0;
  private transientFailureTimes: number[] = [];
  private breakerResumeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    upstreamName: string,
    arcUrl: string,
    apiKey: string | undefined,
    config?: Partial<ArcBroadcasterConfig>,
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.upstreamName = upstreamName;
    this.emitStateMetrics = config?.emitStateMetrics ?? true;
    this.arc = new ARC(arcUrl, {
      apiKey,
      httpClient: nodeFetchHttpClient(),
    });
    this.updateStateMetrics();
  }

  async broadcast(
    tx: Transaction,
    icao?: string,
    options?: BroadcastOptions,
  ): Promise<BroadcastOutcome> {
    const resolved = this.resolveOptions(options);
    const label = icao ?? "unknown";

    if (this.isCircuitOpen()) {
      return this.failLocalBackpressure(
        label,
        "ARC_CIRCUIT_OPEN",
        "ARC circuit breaker open",
      );
    }

    if (this.queue.length >= this.config.maxQueueDepth) {
      return this.failLocalBackpressure(
        label,
        "ARC_QUEUE_SATURATED",
        "ARC broadcaster queue saturated",
      );
    }

    return new Promise<BroadcastOutcome>((resolve) => {
      this.queue.push({
        seq: this.seq++,
        tx,
        icao,
        options: resolved,
        enqueuedAt: Date.now(),
        resolve,
      });
      this.queue.sort((a, b) =>
        a.options.priority - b.options.priority || a.seq - b.seq);
      this.updateStateMetrics();
      this.schedule();
    });
  }

  getState(): ArcBroadcasterState {
    this.pruneTransientFailures();
    const remaining = Math.max(0, this.breakerOpenUntil - Date.now());
    return {
      inFlight: this.inFlight,
      queueDepth: this.queue.length,
      circuitOpen: remaining > 0,
      circuitOpenRemainingMs: remaining,
    };
  }

  getLimits(): Pick<ArcBroadcasterConfig, "maxConcurrentBroadcasts" | "maxQueueDepth"> {
    return {
      maxConcurrentBroadcasts: this.config.maxConcurrentBroadcasts,
      maxQueueDepth: this.config.maxQueueDepth,
    };
  }

  isDegraded(): boolean {
    const state = this.getState();
    return state.circuitOpen
      || state.queueDepth >= Math.max(1, this.config.maxConcurrentBroadcasts)
      || state.inFlight >= this.config.maxConcurrentBroadcasts;
  }

  private schedule(): void {
    if (this.isCircuitOpen()) {
      this.updateStateMetrics();
      return;
    }

    while (
      this.inFlight < this.config.maxConcurrentBroadcasts
      && this.queue.length > 0
    ) {
      const next = this.queue.shift();
      if (!next) break;
      this.inFlight++;
      this.updateStateMetrics();
      void this.runTask(next);
    }
  }

  private async runTask(task: QueuedBroadcast): Promise<void> {
    try {
      const outcome = await this.executeQueuedBroadcast(task);
      task.resolve(outcome);
    } catch (err) {
      task.resolve({
        txid: "",
        status: "FAILED",
        code: (err as Error).name,
        description: (err as Error).message,
      });
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.updateStateMetrics();
      this.schedule();
    }
  }

  private async executeQueuedBroadcast(
    task: QueuedBroadcast,
  ): Promise<BroadcastOutcome> {
    const label = task.icao ?? "unknown";
    const totalAttempts = Math.max(
      1,
      1 + (task.options.allowTransientRetry ? this.config.transientRetryAttempts : 0),
    );

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      const attemptResult = await this.broadcastOnce(task.tx, label);
      const { outcome, latency } = attemptResult;

      if (outcome.status === "SEEN_ON_NETWORK") {
        this.transientFailureTimes = [];
        txBroadcastTotal.inc({
          icao: label,
          record_type: task.options.kind,
          status: "SEEN_ON_NETWORK",
        });
        log.info(
          {
            upstream: this.upstreamName,
            txid: outcome.txid,
            icao: label,
            kind: task.options.kind,
            latency,
            queueMs: Date.now() - task.enqueuedAt,
            attempt: attempt + 1,
          },
          "Broadcast accepted",
        );
        return outcome;
      }

      const isDependency = isDependencyPendingBroadcastFailure(outcome);
      const isLocalBackpressure = isLocalBackpressureBroadcastFailure(outcome);
      const isTransient = isTransientBroadcastFailure(outcome);

      if (
        isTransient
        && attempt < totalAttempts - 1
      ) {
        const retryDelayMs = this.getRetryDelayMs(attempt);
        txBroadcastRetryTotal.inc({ kind: task.options.kind, reason: outcome.code ?? "unknown" });
        log.debug(
          {
            upstream: this.upstreamName,
            icao: label,
            kind: task.options.kind,
            attempt: attempt + 1,
            totalAttempts,
            retryDelayMs,
            code: outcome.code,
            description: outcome.description,
          },
          "Retrying transient broadcast failure",
        );
        await sleep(retryDelayMs);
        continue;
      }

      this.recordFailure(
        label,
        task.options.kind,
        outcome,
        latency,
        isDependency,
        isLocalBackpressure,
        isTransient,
      );
      return outcome;
    }

    return {
      txid: "",
      status: "FAILED",
      code: "ARC_UNKNOWN_FAILURE",
      description: "Broadcast exhausted without a terminal outcome",
    };
  }

  private async broadcastOnce(
    tx: Transaction,
    label: string,
  ): Promise<AttemptResult> {
    const start = performance.now();

    try {
      const response = await this.arc.broadcast(tx);
      const latency = (performance.now() - start) / 1_000;
      txBroadcastLatency.observe({ icao: label }, latency);

      if (response.status === "error" || !response.txid) {
        const failure = response as unknown as {
          code?: unknown;
          description?: unknown;
        };
        return {
          latency,
          outcome: {
            txid: "",
            status: "FAILED",
            code: String(failure.code ?? "") || undefined,
            description: String(failure.description ?? "") || undefined,
          },
        };
      }

      return {
        latency,
        outcome: {
          txid: response.txid,
          status: "SEEN_ON_NETWORK",
        },
      };
    } catch (err) {
      const latency = (performance.now() - start) / 1_000;
      txBroadcastLatency.observe({ icao: label }, latency);
      return {
        latency,
        outcome: {
          txid: "",
          status: "FAILED",
          code: (err as Error).name,
          description: (err as Error).message,
        },
      };
    }
  }

  private recordFailure(
    label: string,
    kind: BroadcastKind,
    outcome: BroadcastOutcome,
    latency: number,
    isDependency: boolean,
    isLocalBackpressure: boolean,
    isTransient: boolean,
  ): void {
    const errorType = isDependency
      ? "DEPENDENCY_PENDING"
      : isLocalBackpressure
        ? "LOCAL_BACKPRESSURE"
        : isTransient
          ? "TRANSIENT_UPSTREAM"
          : "ARC_REJECTED";

    txBroadcastFailures.inc({
      icao: label,
      error_type: errorType,
    });

    if (isTransient) {
      this.noteTransientFailure();
    }

    if (isDependency) {
      log.warn(
        {
          upstream: this.upstreamName,
          icao: label,
          kind,
          latency,
          code: outcome.code,
          description: outcome.description,
        },
        `Broadcast dependency pending: ${outcome.description ?? outcome.code ?? "unknown"}`,
      );
      return;
    }

    if (isLocalBackpressure) {
      log.debug(
        {
          upstream: this.upstreamName,
          icao: label,
          kind,
          latency,
          code: outcome.code,
          description: outcome.description,
        },
        "Broadcast skipped due to local backpressure",
      );
      return;
    }

    if (isTransient) {
      log.warn(
        {
          upstream: this.upstreamName,
          icao: label,
          kind,
          latency,
          code: outcome.code,
          description: outcome.description,
        },
        `Broadcast transient failure: ${outcome.description ?? outcome.code ?? "unknown"}`,
      );
      return;
    }

    log.error(
      {
        upstream: this.upstreamName,
        icao: label,
        kind,
        latency,
        code: outcome.code,
        description: outcome.description,
      },
      `Broadcast rejected: ${outcome.description ?? outcome.code ?? "unknown"}`,
    );
  }

  private failLocalBackpressure(
    label: string,
    code: "ARC_CIRCUIT_OPEN" | "ARC_QUEUE_SATURATED",
    description: string,
  ): BroadcastOutcome {
    txBroadcastFailures.inc({
      icao: label,
      error_type: "LOCAL_BACKPRESSURE",
    });
    this.updateStateMetrics();
    return {
      txid: "",
      status: "FAILED",
      code,
      description,
    };
  }

  private resolveOptions(options?: BroadcastOptions): ResolvedBroadcastOptions {
    return {
      kind: options?.kind ?? DEFAULT_BROADCAST_OPTIONS.kind,
      priority: options?.priority ?? DEFAULT_BROADCAST_OPTIONS.priority,
      allowTransientRetry:
        options?.allowTransientRetry ?? DEFAULT_BROADCAST_OPTIONS.allowTransientRetry,
    };
  }

  private isCircuitOpen(): boolean {
    const open = this.breakerOpenUntil > Date.now();
    this.updateStateMetrics();
    return open;
  }

  private getRetryDelayMs(attempt: number): number {
    const base = this.config.transientRetryBaseMs * (2 ** attempt);
    const jitter = Math.floor(Math.random() * this.config.transientRetryBaseMs);
    return base + jitter;
  }

  private noteTransientFailure(): void {
    const now = Date.now();
    this.transientFailureTimes.push(now);
    this.pruneTransientFailures(now);
    if (
      this.transientFailureTimes.length >= this.config.circuitFailureThreshold
      && now >= this.breakerOpenUntil
    ) {
      this.breakerOpenUntil = now + this.config.circuitOpenMs;
      this.scheduleBreakerResume();
      log.warn(
        {
          upstream: this.upstreamName,
          failuresInWindow: this.transientFailureTimes.length,
          windowMs: this.config.circuitWindowMs,
          openMs: this.config.circuitOpenMs,
        },
        "ARC circuit breaker opened after transient failure burst",
      );
      this.updateStateMetrics();
    }
  }

  private pruneTransientFailures(now = Date.now()): void {
    const minTs = now - this.config.circuitWindowMs;
    this.transientFailureTimes = this.transientFailureTimes.filter((ts) => ts >= minTs);
  }

  private updateStateMetrics(): void {
    if (this.emitStateMetrics) {
      txBroadcastQueueDepth.set(this.queue.length);
      txBroadcastInFlight.set(this.inFlight);
      txBroadcastBreakerOpen.set(this.breakerOpenUntil > Date.now() ? 1 : 0);
    }
    this.emit("state-change");
  }

  private scheduleBreakerResume(): void {
    if (this.breakerResumeTimer) {
      clearTimeout(this.breakerResumeTimer);
      this.breakerResumeTimer = null;
    }

    const delayMs = Math.max(0, this.breakerOpenUntil - Date.now());
    this.breakerResumeTimer = setTimeout(() => {
      this.breakerResumeTimer = null;
      this.updateStateMetrics();
      this.schedule();
    }, delayMs);
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
      log.info({ upstream: this.upstreamName, port }, "ARC callback receiver listening");
    });
  }

  async closeCallbackReceiver(): Promise<void> {
    return new Promise((resolve) => {
      if (this.breakerResumeTimer) {
        clearTimeout(this.breakerResumeTimer);
        this.breakerResumeTimer = null;
      }
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

export class ArcBroadcaster extends EventEmitter implements Broadcaster {
  private readonly broadcasters: SingleArcBroadcaster[];
  private readonly primaryBroadcaster: SingleArcBroadcaster;

  constructor(
    endpoints: ArcEndpointConfig[],
    config?: Partial<ArcBroadcasterConfig>,
  ) {
    super();

    if (endpoints.length === 0) {
      throw new Error("At least one ARC endpoint must be configured");
    }

    this.broadcasters = endpoints.map((endpoint) =>
      new SingleArcBroadcaster(
        endpoint.name,
        endpoint.url,
        endpoint.apiKey,
        { ...config, emitStateMetrics: false },
      ));
    this.primaryBroadcaster = this.broadcasters[0]!;

    this.primaryBroadcaster.on("status-update", (payload: ArcCallbackPayload) => {
      this.emit("status-update", payload);
    });
    for (const broadcaster of this.broadcasters) {
      broadcaster.on("state-change", () => {
        this.updateStateMetrics();
      });
    }

    this.updateStateMetrics();
  }

  async broadcast(
    tx: Transaction,
    icao?: string,
    options?: BroadcastOptions,
  ): Promise<BroadcastOutcome> {
    const preferred = this.selectBroadcaster(icao);
    return preferred.broadcast(tx, icao, options);
  }

  getState(): ArcBroadcasterState {
    const states = this.broadcasters.map((broadcaster) => broadcaster.getState());
    const circuitOpen = states.length > 0 && states.every((state) => state.circuitOpen);
    const circuitOpenRemainingMs = circuitOpen
      ? Math.min(...states.map((state) => state.circuitOpenRemainingMs))
      : 0;

    return {
      inFlight: states.reduce((sum, state) => sum + state.inFlight, 0),
      queueDepth: states.reduce((sum, state) => sum + state.queueDepth, 0),
      circuitOpen,
      circuitOpenRemainingMs,
    };
  }

  getLimits(): Pick<ArcBroadcasterConfig, "maxConcurrentBroadcasts" | "maxQueueDepth"> {
    return this.broadcasters.reduce(
      (sum, broadcaster) => {
        const limits = broadcaster.getLimits();
        sum.maxConcurrentBroadcasts += limits.maxConcurrentBroadcasts;
        sum.maxQueueDepth += limits.maxQueueDepth;
        return sum;
      },
      { maxConcurrentBroadcasts: 0, maxQueueDepth: 0 },
    );
  }

  isDegraded(): boolean {
    return this.broadcasters.every((broadcaster) => broadcaster.isDegraded());
  }

  setupCallbackReceiver(port: number): void {
    this.primaryBroadcaster.setupCallbackReceiver(port);
  }

  async closeCallbackReceiver(): Promise<void> {
    await Promise.all(this.broadcasters.map((broadcaster) => broadcaster.closeCallbackReceiver()));
  }

  private selectBroadcaster(icao?: string): SingleArcBroadcaster {
    const ordered = this.getOrderedBroadcasters(icao);
    const available = ordered.find((broadcaster) => {
      const state = broadcaster.getState();
      const limits = broadcaster.getLimits();
      return !state.circuitOpen && state.queueDepth < limits.maxQueueDepth;
    });
    return available ?? ordered[0] ?? this.primaryBroadcaster;
  }

  private getOrderedBroadcasters(icao?: string): SingleArcBroadcaster[] {
    if (this.broadcasters.length <= 1) {
      return this.broadcasters;
    }

    if (!icao) {
      return [...this.broadcasters].sort((a, b) => this.getLoadScore(a) - this.getLoadScore(b));
    }

    const start = this.hashIcao(icao) % this.broadcasters.length;
    return this.broadcasters.map(
      (_unused, index) => this.broadcasters[(start + index) % this.broadcasters.length]!,
    );
  }

  private getLoadScore(broadcaster: SingleArcBroadcaster): number {
    const state = broadcaster.getState();
    return state.queueDepth * 1000 + state.inFlight;
  }

  private hashIcao(icao: string): number {
    const input = icao.trim().toUpperCase();
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash * 31) + input.charCodeAt(i)) >>> 0;
    }
    return hash;
  }

  private updateStateMetrics(): void {
    const state = this.getState();
    txBroadcastQueueDepth.set(state.queueDepth);
    txBroadcastInFlight.set(state.inFlight);
    txBroadcastBreakerOpen.set(state.circuitOpen ? 1 : 0);
  }
}
