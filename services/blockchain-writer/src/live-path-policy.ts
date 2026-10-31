/**
 * Live-path safety policy for the writer. Timing changes are env-gated and the
 * defaults match today's production behaviour so a restart does not slow spends
 * or widen reconcile until an operator opts in.
 */

const SEEN_GATE_PENDING_STATUSES = new Set([
  "",
  "RECEIVED",
  "SENT_TO_NETWORK",
  "ACCEPTED_BY_NETWORK",
]);

/** Hard cap on the in-memory spend ledger so a long-running writer cannot grow it without bound. */
const RECENT_SPEND_LEDGER_MAX = 8_192;

/** Hard cap on tracked treasury outpoints. Confirmed entries are preferred when evicting. */
const FUNDING_DEPTH_MAX = 8_192;

export function readNonNegativeInt(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

export function readBoolEnv(
  name: string,
  fallback: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Telemetry change. Default 0 — unchanged from today. Recommended 2000. */
export function chainPropagationCooldownMs(): number {
  return readNonNegativeInt("CHAIN_PROPAGATION_COOLDOWN_MS", 0);
}

/** Aircraft refill outputs. Default 500. Recommended 2000. */
export function refillPropagationCooldownMs(): number {
  return readNonNegativeInt("REFILL_PROPAGATION_COOLDOWN_MS", 500);
}

/** Treasury change. Default 500. Recommended 2000. */
export function fundingPropagationCooldownMs(): number {
  return readNonNegativeInt("FUNDING_PROPAGATION_COOLDOWN_MS", 500);
}

/**
 * Reconcile must not delete a local output this fresh, nor resurrect an
 * outpoint spent this recently. Default 30 seconds.
 */
export function reconcileRecentGuardMs(): number {
  return readNonNegativeInt("RECONCILE_RECENT_OUTPUT_GUARD_MS", 30_000);
}

/**
 * Refuse to spend a funding output whose unconfirmed ancestor depth in this
 * process exceeds this cap. Default 4. Restart clears the in-memory counter.
 */
export function fundingMaxUnconfirmedChainDepth(): number {
  return readNonNegativeInt("FUNDING_MAX_UNCONFIRMED_CHAIN_DEPTH", 4);
}

/** Default false: production still treats a 2xx Arcade accept as spendable. */
export function arcadeAwaitSeenBeforeSpendEnabled(): boolean {
  return readBoolEnv("ARCADE_AWAIT_SEEN_BEFORE_SPEND", false);
}

export function coerceTimestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export function outpointKey(txid: string, vout: number): string {
  return `${txid.trim()}:${vout}`;
}

/**
 * True when `at` falls inside the guard window. A timestamp slightly ahead of
 * this process (database clock skew) still counts as recent, so a fresh row is
 * not deleted because the clocks disagree.
 */
export function isWithinGuardWindow(
  atMs: number | null,
  nowMs: number,
  guardMs: number,
): boolean {
  if (atMs == null || !Number.isFinite(atMs) || !(guardMs > 0)) return false;
  const age = nowMs - atMs;
  if (age < 0) return age >= -guardMs;
  return age <= guardMs;
}

export function shouldRetainLocalDuringReconcile(input: {
  nowMs: number;
  guardMs: number;
  createdAtMs: number | null;
  spentAtMs: number | null;
  creatingBroadcastAtMs: number | null;
}): boolean {
  return isWithinGuardWindow(input.createdAtMs, input.nowMs, input.guardMs)
    || isWithinGuardWindow(input.spentAtMs, input.nowMs, input.guardMs)
    || isWithinGuardWindow(input.creatingBroadcastAtMs, input.nowMs, input.guardMs);
}

export function shouldSuppressChainReinsert(input: {
  nowMs: number;
  guardMs: number;
  spentAtMs: number | null;
}): boolean {
  return isWithinGuardWindow(input.spentAtMs, input.nowMs, input.guardMs);
}

/**
 * Bounded memory of outpoints this process has spent and transactions it has
 * broadcast. Entries expire with the reconcile guard so a later chain snapshot
 * can restore an output whose spend never landed.
 */
export class RecentSpendLedger {
  private readonly spentAt = new Map<string, number>();
  private readonly broadcastAt = new Map<string, number>();

  noteSpent(txid: string, vout: number, at = Date.now()): void {
    this.spentAt.set(outpointKey(txid, vout), at);
    this.bound(this.spentAt);
  }

  noteBroadcast(txid: string, at = Date.now()): void {
    const key = txid.trim();
    if (!key) return;
    this.broadcastAt.set(key, at);
    this.bound(this.broadcastAt);
  }

  spentAtIfFresh(txid: string, vout: number, nowMs: number, guardMs: number): number | null {
    return this.fresh(this.spentAt, outpointKey(txid, vout), nowMs, guardMs);
  }

  broadcastAtIfFresh(txid: string, nowMs: number, guardMs: number): number | null {
    return this.fresh(this.broadcastAt, txid.trim(), nowMs, guardMs);
  }

  private fresh(
    map: Map<string, number>,
    key: string,
    nowMs: number,
    guardMs: number,
  ): number | null {
    const at = map.get(key);
    if (at === undefined) return null;
    if (!isWithinGuardWindow(at, nowMs, guardMs)) {
      map.delete(key);
      return null;
    }
    return at;
  }

  private bound(map: Map<string, number>): void {
    while (map.size > RECENT_SPEND_LEDGER_MAX) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [key, at] of map) {
        if (at < oldest) {
          oldest = at;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      map.delete(oldestKey);
    }
  }
}

/**
 * In-process unconfirmed depth for treasury outputs. There is no database
 * column: a restart resets every output to depth 0, and a chain height above
 * zero clears the entry.
 */
export class FundingChainDepth {
  private readonly depth = new Map<string, number>();
  private readonly confirmed = new Set<string>();

  constructor(private readonly cap: () => number = fundingMaxUnconfirmedChainDepth) {}

  depthOf(txid: string, vout: number): number {
    return this.depth.get(outpointKey(txid, vout)) ?? 0;
  }

  /** True when this output must not be spent. Depth equal to the cap is still allowed. */
  exceedsCap(txid: string, vout: number): boolean {
    return this.depthOf(txid, vout) > this.cap();
  }

  isConfirmed(txid: string, vout: number): boolean {
    return this.confirmed.has(outpointKey(txid, vout));
  }

  noteUnconfirmed(txid: string, vout: number, depth: number): void {
    const key = outpointKey(txid, vout);
    this.confirmed.delete(key);
    if (!Number.isFinite(depth) || depth <= 0) {
      this.depth.delete(key);
      return;
    }
    this.depth.set(key, Math.floor(depth));
    this.bound();
  }

  confirm(txid: string, vout: number): void {
    const key = outpointKey(txid, vout);
    this.depth.delete(key);
    this.confirmed.add(key);
    this.bound();
  }

  forget(txid: string, vout: number): void {
    const key = outpointKey(txid, vout);
    this.depth.delete(key);
    this.confirmed.delete(key);
  }

  private bound(): void {
    while (this.depth.size + this.confirmed.size > FUNDING_DEPTH_MAX) {
      if (this.depth.size > 0) {
        const oldest = this.depth.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.depth.delete(oldest);
        continue;
      }
      const oldestConfirmed = this.confirmed.values().next().value as string | undefined;
      if (oldestConfirmed === undefined) break;
      this.confirmed.delete(oldestConfirmed);
    }
  }
}

/**
 * A 2xx whose per-tx status is still short of SEEN_ON_NETWORK. Silent means
 * Arcade listed no status for this txid, which today is treated as acceptance.
 * SEEN_ON_NETWORK and MINED do not wait. The orphan-mempool path has its own gate.
 */
export function shouldAwaitSeenBeforeSpend(input: {
  enabled: boolean;
  httpStatus: number;
  txStatus: string | null | undefined;
}): boolean {
  if (!input.enabled) return false;
  if (input.httpStatus < 200 || input.httpStatus >= 300) return false;
  const status = String(input.txStatus ?? "").trim().toUpperCase();
  return SEEN_GATE_PENDING_STATUSES.has(status);
}
