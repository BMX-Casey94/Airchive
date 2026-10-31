import type { Knex } from "knex";
import { Transaction, Utils } from "@bsv/sdk";
import { createLogger } from "@airchive/logger";
import { extractArcadeRejectDiagnosis } from "./arcade-reject-diagnosis.js";
import { isTerminalArcadeFailure } from "./arcade-broadcaster.js";
import { readBoolEnv, readNonNegativeInt } from "./live-path-policy.js";
import { ghostSpendRecoveryTotal } from "./metrics.js";

const log = createLogger({ service: "blockchain-writer:ghost-spend" });

const TABLE = "network_spent_outpoints";
const DEFAULT_INTERVAL_MS = 120_000;
const DEFAULT_BATCH = 20;
const DEFAULT_MAX_ATTEMPTS = 6;
const HOUR_MS = 60 * 60 * 1000;
const REPOST_AFTER_MS = 30 * 60 * 1000;
const DATAHUB_TIMEOUT_MS = 10_000;
const ARCADE_TIMEOUT_MS = 15_000;
const MAX_DATAHUB_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ARCADE_BODY_BYTES = 64 * 1024;
const ROW_CAP = 2_000;
const DETAIL_CAP = 500;

const DEFAULT_DATAHUB_URLS = [
  "https://mainnet.gorillanode.io/api/v1",
  "https://mainnet2.gorillanode.io/api/v1",
];

const ACTIVE_STATUSES = ["pending", "rejected", "unavailable", "rebroadcast"] as const;

const TXID_RE = /^[0-9a-f]{64}$/;
const P2PKH_RE = /^76a914([0-9a-f]{40})88ac$/;

export type GhostSpendOutcome =
  | "rebroadcast"
  | "mined"
  | "not_ours"
  | "unavailable"
  | "rejected"
  | "error";

export interface GhostSpendCycleSummary {
  rebroadcast: number;
  mined: number;
  not_ours: number;
  unavailable: number;
  rejected: number;
  error: number;
}

export interface OwnedWallets {
  treasuryAddress: string;
  aircraft: ReadonlyArray<{ icao: string; address: string }>;
}

export type MinedLookup =
  | { state: "mined"; blockHeight: number }
  | { state: "unmined" }
  | { state: "unknown" };

export interface GhostRecoverySettings {
  enabled: boolean;
  intervalMs: number;
  batch: number;
  maxAttempts: number;
  datahubUrls: string[];
  submitUrls: string[];
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface GhostSpendRecoveryDeps {
  db: Knex;
  /** Required in tests. Production omits it and uses global fetch. */
  fetch?: FetchLike;
  arcadeBaseUrl: string;
  callbackToken?: string;
  apiKey?: string;
  /** When set, including an empty list, env defaults are not used. */
  datahubUrls?: readonly string[];
  /** Teranode propagation bases that take `POST {base}/tx`. Empty by default. */
  submitUrls?: readonly string[];
  resolveOwned: () => OwnedWallets | Promise<OwnedWallets>;
  reconcileFunding: () => Promise<unknown>;
  reconcileAircraft: (icao: string, address: string) => Promise<unknown>;
  lookupMined: (txid: string) => Promise<MinedLookup>;
  now?: () => number;
  enabled?: boolean;
  intervalMs?: number;
  batch?: number;
  maxAttempts?: number;
}

interface RecoveryRow {
  txid: string;
  vout: number;
  storedSpentBy: string;
  spentBy: string;
  status: string;
  attempts: number;
  lastAttemptAt: unknown;
  notedAt: number;
}

interface SpenderGroup {
  spentBy: string;
  rows: RecoveryRow[];
  attempts: number;
  notedAt: number;
}

interface OwnedIndex {
  treasuryAddress: string;
  addresses: Set<string>;
  aircraft: Array<{ icao: string; address: string }>;
  byAddress: Map<string, { icao: string; address: string }>;
}

interface ReconcileTargets {
  funding: boolean;
  aircraft: Array<{ icao: string; address: string }>;
}

interface Decision {
  outcome: GhostSpendOutcome;
  status?: string;
  detail: string;
  bumpAttempt: boolean;
}

type HexFetch = { ok: true; hex: string } | { ok: false; hosts: string[] };

type PostResult =
  | { kind: "accepted"; detail: string }
  | { kind: "rejected"; detail: string }
  | { kind: "error"; detail: string };

export function ghostRecoverySettings(
  env: NodeJS.ProcessEnv = process.env,
): GhostRecoverySettings {
  const intervalMs = readNonNegativeInt("GHOST_RECOVERY_INTERVAL_MS", DEFAULT_INTERVAL_MS, env);
  const batch = readNonNegativeInt("GHOST_RECOVERY_BATCH", DEFAULT_BATCH, env);
  const maxAttempts = readNonNegativeInt("GHOST_RECOVERY_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS, env);
  return {
    enabled: readBoolEnv("GHOST_RECOVERY_ENABLED", true, env),
    intervalMs: intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS,
    batch: batch > 0 ? batch : DEFAULT_BATCH,
    maxAttempts: maxAttempts > 0 ? maxAttempts : DEFAULT_MAX_ATTEMPTS,
    datahubUrls: datahubUrlsFromEnv(env),
    submitUrls: (env.TERANODE_SUBMIT_URLS ?? "")
      .split(",")
      .map((base) => base.trim().replace(/\/+$/, ""))
      .filter((base) => /^https?:\/\//i.test(base)),
  };
}

/**
 * Block height from the writer's chain lookup. Null from the provider means
 * the lookup failed and must not be treated as "not mined". A map entry is
 * only present when a provider reported a positive block height.
 */
export async function minedLookupFromChain(
  chain: {
    fetchTxStatuses(
      txids: string[],
    ): Promise<Map<string, { blockHeight: number }> | null>;
  },
  txid: string,
): Promise<MinedLookup> {
  const normalised = txid.trim().toLowerCase();
  try {
    const statuses = await chain.fetchTxStatuses([normalised]);
    if (!statuses) return { state: "unknown" };
    const found = statuses.get(normalised);
    if (found && Number.isInteger(found.blockHeight) && found.blockHeight > 0) {
      return { state: "mined", blockHeight: found.blockHeight };
    }
    return { state: "unmined" };
  } catch {
    return { state: "unknown" };
  }
}

/**
 * Rebroadcasts a spender that one Teranode node accepted and then did not
 * propagate, so the quarantined inputs can be mined and the new outputs
 * return to the pools.
 *
 * The transaction is already signed. This job never creates or signs one,
 * and it does not ask the spend governor: the post pays no new fee and
 * spends nothing that is not already spent by that transaction.
 *
 * A datahub response is used only when its recomputed txid equals the
 * spender named on the quarantine row.
 */
export class GhostSpendRecovery {
  private running = false;
  private readonly stoppedLogged = new Set<string>();

  constructor(private readonly deps: GhostSpendRecoveryDeps) {}

  async runOnce(): Promise<GhostSpendCycleSummary> {
    if (this.running) return emptySummary();
    this.running = true;
    try {
      return await this.cycle();
    } finally {
      this.running = false;
    }
  }

  private async cycle(): Promise<GhostSpendCycleSummary> {
    const summary = emptySummary();
    const seeds = await this.loadCandidates();
    if (seeds === "unavailable") return summary;

    const now = this.now();
    const intervalMs = this.intervalMs();
    const maxAttempts = this.maxAttempts();
    const due = groupRows(seeds)
      .filter((group) =>
        group.rows.some((row) => row.status === "rebroadcast" || row.attempts < maxAttempts),
      )
      .filter((group) => isDue(group, now, intervalMs))
      .sort((a, b) =>
        dueRank(a) - dueRank(b)
        || a.notedAt - b.notedAt
        || a.spentBy.localeCompare(b.spentBy),
      )
      .slice(0, this.batchSize());
    if (due.length === 0) return summary;

    const storedNames = new Set<string>();
    for (const group of due) {
      for (const row of group.rows) storedNames.add(row.storedSpentBy);
    }
    const full = await this.loadBySpender([...storedNames]);
    if (full === "unavailable") return summary;
    const bySpender = new Map(groupRows(full).map((group) => [group.spentBy, group]));

    let owned: OwnedIndex;
    try {
      owned = indexOwned(await this.deps.resolveOwned());
    } catch (err) {
      log.error({ err }, "Ghost-spend recovery could not resolve owned wallets");
      return summary;
    }

    for (const seed of due) {
      const group = bySpender.get(seed.spentBy) ?? seed;
      if (!isDue(group, now, intervalMs)) continue;
      try {
        await this.processGroup(group, owned, now, summary);
      } catch (err) {
        summary.error += 1;
        ghostSpendRecoveryTotal.inc({ outcome: "error" });
        log.error(
          { err, txid: shortTxid(group.spentBy) },
          "Ghost-spend recovery failed for one spender",
        );
      }
    }

    const changed = summary.rebroadcast + summary.mined + summary.not_ours
      + summary.unavailable + summary.rejected + summary.error;
    if (changed > 0) {
      log.info({ ...summary }, "Ghost-spend recovery cycle");
    }
    return summary;
  }

  private async processGroup(
    group: SpenderGroup,
    owned: OwnedIndex,
    now: number,
    summary: GhostSpendCycleSummary,
  ): Promise<void> {
    if (!TXID_RE.test(group.spentBy)) {
      await this.persist(group, now, summary, {
        outcome: "rejected",
        status: "rejected",
        detail: "spent_by_txid is not a transaction id",
        bumpAttempt: true,
      });
      return;
    }

    const watching = group.rows.every((row) => row.status === "rebroadcast");
    if (watching) {
      await this.watchMined(group, owned, now, summary);
      return;
    }
    await this.recover(group, owned, now, summary);
  }

  private async watchMined(
    group: SpenderGroup,
    owned: OwnedIndex,
    now: number,
    summary: GhostSpendCycleSummary,
  ): Promise<void> {
    let lookup: MinedLookup;
    try {
      lookup = await this.deps.lookupMined(group.spentBy);
    } catch (err) {
      summary.error += 1;
      ghostSpendRecoveryTotal.inc({ outcome: "error" });
      log.error(
        { err, txid: shortTxid(group.spentBy) },
        "Chain lookup for a ghost spender failed",
      );
      return;
    }

    if (lookup.state === "unknown") {
      summary.error += 1;
      ghostSpendRecoveryTotal.inc({ outcome: "error" });
      return;
    }
    if (lookup.state === "mined") {
      await this.markMined(group, owned, now, summary, lookup.blockHeight);
      return;
    }

    const latest = latestAttempt(group);
    const repostDue = latest == null || now - latest >= REPOST_AFTER_MS;
    if (!repostDue) return;
    if (group.attempts >= this.maxAttempts()) {
      this.noteStopped(group.spentBy, "rebroadcast");
      return;
    }
    await this.recover(group, owned, now, summary);
  }

  private async markMined(
    group: SpenderGroup,
    owned: OwnedIndex,
    now: number,
    summary: GhostSpendCycleSummary,
    blockHeight: number,
  ): Promise<void> {
    const targets = await this.targetsForMinedSpender(group.spentBy, owned);
    const reconciled = await this.reconcileTargets(group.spentBy, targets);
    if (!reconciled) {
      summary.error += 1;
      ghostSpendRecoveryTotal.inc({ outcome: "error" });
      log.warn(
        { txid: shortTxid(group.spentBy), blockHeight },
        "Mined spender could not be reconciled — it will be tried again",
      );
      return;
    }

    await this.persist(group, now, summary, {
      outcome: "mined",
      status: "mined",
      detail: `Mined at height ${blockHeight}`,
      bumpAttempt: false,
    });
  }

  private async recover(
    group: SpenderGroup,
    owned: OwnedIndex,
    now: number,
    summary: GhostSpendCycleSummary,
  ): Promise<void> {
    const fetched = await this.fetchHex(group.spentBy);
    if (!fetched.ok) {
      await this.persist(group, now, summary, {
        outcome: "unavailable",
        status: "unavailable",
        detail: `No datahub returned the spender (tried ${fetched.hosts.join(", ") || "none"})`,
        bumpAttempt: true,
      });
      return;
    }

    const parsed = parseSpender(fetched.hex, group.spentBy);
    if (!parsed.ok) {
      await this.persist(group, now, summary, {
        outcome: "rejected",
        status: "rejected",
        detail: parsed.detail,
        bumpAttempt: true,
      });
      return;
    }

    const proof = proveOwnership(parsed.tx, group, owned);
    if (!proof.ok) {
      await this.persist(group, now, summary, {
        outcome: proof.status,
        status: proof.status,
        detail: proof.detail,
        bumpAttempt: true,
      });
      return;
    }

    // Post the fetched hex. Re-serialising could change the transaction,
    // and this path must not sign anything.
    const posted = await this.postArcade(fetched.hex);
    if (posted.kind !== "rejected") await this.submitToTeranodes(group.spentBy, fetched.hex);
    if (posted.kind === "accepted") {
      await this.persist(group, now, summary, {
        outcome: "rebroadcast",
        status: "rebroadcast",
        detail: posted.detail,
        bumpAttempt: true,
      });
      return;
    }
    if (posted.kind === "rejected") {
      await this.persist(group, now, summary, {
        outcome: "rejected",
        status: "rejected",
        detail: posted.detail,
        bumpAttempt: true,
      });
      return;
    }
    await this.persist(group, now, summary, {
      outcome: "error",
      detail: posted.detail,
      bumpAttempt: true,
    });
  }

  private async targetsForMinedSpender(
    txid: string,
    owned: OwnedIndex,
  ): Promise<ReconcileTargets> {
    const fetched = await this.fetchHex(txid);
    if (!fetched.ok) {
      log.warn(
        { txid: shortTxid(txid) },
        "Could not re-read the mined spender — reconciling every owned wallet",
      );
      return everyTarget(owned);
    }
    const parsed = parseSpender(fetched.hex, txid);
    if (!parsed.ok) {
      log.warn(
        { txid: shortTxid(txid), detail: parsed.detail },
        "Mined spender could not be parsed — reconciling every owned wallet",
      );
      return everyTarget(owned);
    }
    return outputTargets(parsed.tx, owned);
  }

  private async reconcileTargets(txid: string, targets: ReconcileTargets): Promise<boolean> {
    let ok = true;
    if (targets.funding) {
      try {
        const result = await this.deps.reconcileFunding();
        if (!reconcileSucceeded(result)) ok = false;
      } catch (err) {
        ok = false;
        log.error(
          { err, txid: shortTxid(txid) },
          "Treasury reconcile failed after a ghost spender mined",
        );
      }
    }
    for (const wallet of targets.aircraft) {
      try {
        const result = await this.deps.reconcileAircraft(wallet.icao, wallet.address);
        if (!reconcileSucceeded(result)) ok = false;
      } catch (err) {
        ok = false;
        log.error(
          { err, txid: shortTxid(txid), icao: wallet.icao },
          "Aircraft reconcile failed after a ghost spender mined",
        );
      }
    }
    return ok;
  }

  private async fetchHex(txid: string): Promise<HexFetch> {
    const hosts: string[] = [];
    for (const base of this.datahubs()) {
      hosts.push(hostLabel(base));
      const url = datahubHexUrl(base, txid);
      if (!url) continue;
      try {
        const res = await this.fetcher()(url, {
          method: "GET",
          headers: { Accept: "text/plain" },
          signal: AbortSignal.timeout(DATAHUB_TIMEOUT_MS),
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          continue;
        }
        const body = await readBody(res, MAX_DATAHUB_BODY_BYTES);
        if (!body) continue;
        const hex = body.text.replace(/\s+/g, "").toLowerCase();
        if (!/^[0-9a-f]+$/.test(hex) || hex.length < 20 || hex.length % 2 !== 0) continue;
        return { ok: true, hex };
      } catch {
        continue;
      }
    }
    return { ok: false, hosts };
  }

  private async postArcade(hex: string): Promise<PostResult> {
    const url = arcadeTxUrl(this.deps.arcadeBaseUrl);
    if (!url) return { kind: "error", detail: "Arcade URL is not set" };

    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      Accept: "application/json",
    };
    const token = this.deps.callbackToken?.trim();
    if (token) headers["X-CallbackToken"] = token;
    const apiKey = this.deps.apiKey?.trim();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    let res: Response;
    try {
      res = await this.fetcher()(url, {
        method: "POST",
        headers,
        body: Buffer.from(hex, "hex"),
        signal: AbortSignal.timeout(ARCADE_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: "error", detail: `Arcade request failed: ${message}` };
    }

    const body = await readBody(res, MAX_ARCADE_BODY_BYTES);
    if (!body) {
      return { kind: "error", detail: `Arcade HTTP ${res.status} response exceeded the size cap` };
    }

    let parsed: unknown = null;
    if (body.text.trim() !== "") {
      try {
        parsed = JSON.parse(body.text);
      } catch {
        parsed = null;
      }
    }
    const diagnosis = extractArcadeRejectDiagnosis(unwrapArcadeBody(parsed));
    const detail = arcadeDetail(res.status, diagnosis, body.text);

    if (res.status >= 500) return { kind: "error", detail };
    if (res.status >= 400 || isTerminalArcadeFailure(diagnosis.status)) {
      return { kind: "rejected", detail };
    }
    if (res.ok) {
      return {
        kind: "accepted",
        detail: diagnosis.status ? `Arcade ${diagnosis.status}` : "Arcade accepted the transaction",
      };
    }
    return { kind: "error", detail };
  }

  /**
   * Best effort: Arcade's acceptance has not always reached every node, so
   * the same bytes also go straight to each configured Teranode. The result
   * does not change the row's status; the mined check decides that.
   */
  private async submitToTeranodes(txid: string, hex: string): Promise<void> {
    for (const base of this.submitUrls()) {
      const url = `${base}/tx`;
      try {
        const res = await this.fetcher()(url, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: Buffer.from(hex, "hex"),
          signal: AbortSignal.timeout(DATAHUB_TIMEOUT_MS),
        });
        const body = await readBody(res, MAX_ARCADE_BODY_BYTES);
        log.info(
          { txid: shortTxid(txid), host: hostLabel(base), status: res.status, body: clip(body?.text ?? "").slice(0, 200) },
          "Submitted ghost spender directly to Teranode",
        );
      } catch (err) {
        log.warn(
          { txid: shortTxid(txid), host: hostLabel(base), err: err instanceof Error ? err.message : String(err) },
          "Direct Teranode submission failed",
        );
      }
    }
  }

  private async persist(
    group: SpenderGroup,
    now: number,
    summary: GhostSpendCycleSummary,
    decision: Decision,
  ): Promise<void> {
    const attempts = decision.bumpAttempt ? group.attempts + 1 : group.attempts;
    const detail = clip(decision.detail);
    for (const row of group.rows) {
      const patch: Record<string, unknown> = {
        recovery_detail: detail,
        last_attempt_at: new Date(now),
      };
      if (decision.bumpAttempt) patch.recovery_attempts = attempts;
      if (decision.status) patch.recovery_status = decision.status;
      await this.deps.db(TABLE).where({ txid: row.txid, vout: row.vout }).update(patch);
    }

    summary[decision.outcome] += 1;
    ghostSpendRecoveryTotal.inc({ outcome: decision.outcome });

    if (decision.outcome === "not_ours") {
      log.warn(
        { txid: shortTxid(group.spentBy), detail },
        "Quarantined spender is not one of our transactions — left quarantined",
      );
    } else if (decision.outcome === "rejected") {
      log.warn(
        { txid: shortTxid(group.spentBy), detail },
        "Ghost-spend rebroadcast was rejected",
      );
    }

    const status = decision.status ?? group.rows[0]?.status ?? decision.outcome;
    if (
      decision.bumpAttempt
      && attempts >= this.maxAttempts()
      && status !== "mined"
      && status !== "not_ours"
    ) {
      this.noteStopped(group.spentBy, status);
    }
  }

  private noteStopped(txid: string, status: string): void {
    if (this.stoppedLogged.has(txid)) return;
    if (this.stoppedLogged.size >= 10_000) this.stoppedLogged.clear();
    this.stoppedLogged.add(txid);
    log.warn(
      { txid: shortTxid(txid), status },
      "Ghost-spend recovery stopped after the attempt limit",
    );
  }

  private async loadCandidates(): Promise<RecoveryRow[] | "unavailable"> {
    try {
      const loaded: unknown = await this.deps.db(TABLE)
        .whereIn("recovery_status", [...ACTIVE_STATUSES])
        .orderBy("noted_at", "asc")
        .limit(ROW_CAP);
      if (Array.isArray(loaded) && loaded.length === ROW_CAP) {
        log.warn(
          { cap: ROW_CAP },
          "Ghost-spend recovery read was capped — remaining rows wait for a later cycle",
        );
      }
      return normaliseRows(loaded);
    } catch (err) {
      this.logReadFailure(err);
      return "unavailable";
    }
  }

  private async loadBySpender(storedNames: string[]): Promise<RecoveryRow[] | "unavailable"> {
    try {
      const loaded: unknown = await this.deps.db(TABLE)
        .whereIn("spent_by_txid", storedNames)
        .whereIn("recovery_status", [...ACTIVE_STATUSES]);
      return normaliseRows(loaded);
    } catch (err) {
      this.logReadFailure(err);
      return "unavailable";
    }
  }

  private logReadFailure(err: unknown): void {
    if (isMissingSchema(err)) {
      log.error(
        { err },
        "Ghost-spend recovery table is not available — migration 020 has not been applied",
      );
      return;
    }
    log.error({ err }, "Ghost-spend recovery could not read the quarantine table");
  }

  private datahubs(): string[] {
    if (this.deps.datahubUrls) {
      return this.deps.datahubUrls
        .map((base) => base.trim().replace(/\/+$/, ""))
        .filter((base) => /^https?:\/\//i.test(base));
    }
    return datahubUrlsFromEnv();
  }

  private submitUrls(): string[] {
    return (this.deps.submitUrls ?? [])
      .map((base) => base.trim().replace(/\/+$/, ""))
      .filter((base) => /^https?:\/\//i.test(base));
  }

  private fetcher(): FetchLike {
    if (this.deps.fetch) return this.deps.fetch;
    if (process.env.VITEST) {
      return async () => {
        throw new Error("Ghost-spend recovery called fetch without a test mock");
      };
    }
    return globalThis.fetch.bind(globalThis);
  }

  private intervalMs(): number {
    return positiveInt(this.deps.intervalMs, DEFAULT_INTERVAL_MS);
  }

  private batchSize(): number {
    return positiveInt(this.deps.batch, DEFAULT_BATCH);
  }

  private maxAttempts(): number {
    return positiveInt(this.deps.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

export function startGhostSpendRecovery(deps: GhostSpendRecoveryDeps): { stop(): void } {
  if (deps.enabled === false) {
    log.info("Ghost-spend recovery is disabled");
    return { stop() {} };
  }
  const intervalMs = positiveInt(deps.intervalMs, DEFAULT_INTERVAL_MS);
  const job = new GhostSpendRecovery({ ...deps, intervalMs });
  const timer = setInterval(() => {
    void job.runOnce().catch((err) => {
      log.error({ err }, "Ghost-spend recovery cycle failed");
    });
  }, intervalMs);
  timer.unref?.();
  log.info({ intervalMs }, "Ghost-spend recovery started");
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

function datahubUrlsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.TERANODE_DATAHUB_URLS;
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_DATAHUB_URLS];
  const urls = raw
    .split(",")
    .map((base) => base.trim().replace(/\/+$/, ""))
    .filter((base) => /^https?:\/\//i.test(base));
  return urls.length > 0 ? urls : [...DEFAULT_DATAHUB_URLS];
}

function emptySummary(): GhostSpendCycleSummary {
  return {
    rebroadcast: 0,
    mined: 0,
    not_ours: 0,
    unavailable: 0,
    rejected: 0,
    error: 0,
  };
}

/** Age a row must reach before another attempt. Caps at one hour. */
function backoffMs(intervalMs: number, attempts: number): number {
  const exponent = Math.min(Math.max(0, Math.floor(attempts)), 20);
  const delay = intervalMs * (2 ** exponent);
  if (!Number.isFinite(delay) || delay < 0) return HOUR_MS;
  return Math.min(delay, HOUR_MS);
}

function isDue(group: SpenderGroup, now: number, intervalMs: number): boolean {
  if (group.rows.some((row) => attemptTime(row.lastAttemptAt) == null)) return true;
  const latest = group.rows.reduce((max, row) => Math.max(max, attemptTime(row.lastAttemptAt) ?? 0), 0);
  return now - latest >= backoffMs(intervalMs, group.attempts);
}

function dueRank(group: SpenderGroup): number {
  return group.rows.some((row) => attemptTime(row.lastAttemptAt) == null) ? 0 : 1;
}

function latestAttempt(group: SpenderGroup): number | null {
  if (group.rows.some((row) => attemptTime(row.lastAttemptAt) == null)) return null;
  return group.rows.reduce((max, row) => Math.max(max, attemptTime(row.lastAttemptAt) ?? 0), 0);
}

function attemptTime(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function groupRows(rows: RecoveryRow[]): SpenderGroup[] {
  const grouped = new Map<string, RecoveryRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.spentBy);
    if (list) list.push(row);
    else grouped.set(row.spentBy, [row]);
  }
  const groups: SpenderGroup[] = [];
  for (const [spentBy, list] of grouped) {
    let attempts = 0;
    let notedAt = Number.POSITIVE_INFINITY;
    for (const row of list) {
      attempts = Math.max(attempts, row.attempts);
      if (row.notedAt < notedAt) notedAt = row.notedAt;
    }
    groups.push({
      spentBy,
      rows: list,
      attempts,
      notedAt: Number.isFinite(notedAt) ? notedAt : 0,
    });
  }
  return groups;
}

function normaliseRows(loaded: unknown): RecoveryRow[] {
  if (!Array.isArray(loaded)) return [];
  const rows: RecoveryRow[] = [];
  for (const item of loaded) {
    const row = normaliseRow(item);
    if (row) rows.push(row);
  }
  return rows;
}

function normaliseRow(item: unknown): RecoveryRow | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  const txid = String(raw.txid ?? "").trim();
  const storedSpentBy = String(raw.spent_by_txid ?? "").trim();
  const vout = Number(raw.vout);
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) return null;
  if (!Number.isInteger(vout) || vout < 0) return null;
  const attempts = Number(raw.recovery_attempts ?? 0);
  return {
    txid,
    vout,
    storedSpentBy,
    spentBy: storedSpentBy.toLowerCase(),
    status: String(raw.recovery_status ?? "pending"),
    attempts: Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : 0,
    lastAttemptAt: raw.last_attempt_at ?? null,
    notedAt: attemptTime(raw.noted_at) ?? 0,
  };
}

function indexOwned(owned: OwnedWallets): OwnedIndex {
  const treasuryAddress = owned.treasuryAddress.trim();
  const addresses = new Set<string>();
  if (treasuryAddress) addresses.add(treasuryAddress);
  const aircraft: Array<{ icao: string; address: string }> = [];
  const byAddress = new Map<string, { icao: string; address: string }>();
  for (const entry of owned.aircraft) {
    const icao = entry.icao.trim().toUpperCase();
    const address = entry.address.trim();
    if (!icao || !address) continue;
    const wallet = { icao, address };
    aircraft.push(wallet);
    addresses.add(address);
    byAddress.set(address, wallet);
  }
  return { treasuryAddress, addresses, aircraft, byAddress };
}

function p2pkhAddress(lockingScript: { toHex(): string }): string | null {
  const match = P2PKH_RE.exec(lockingScript.toHex().toLowerCase());
  const hashHex = match?.[1];
  if (!hashHex) return null;
  const hash: number[] = [];
  for (let i = 0; i < hashHex.length; i += 2) {
    hash.push(Number.parseInt(hashHex.slice(i, i + 2), 16));
  }
  return Utils.toBase58Check(hash);
}

type ParsedSpender =
  | { ok: true; tx: Transaction }
  | { ok: false; detail: string };

function parseSpender(hex: string, spentBy: string): ParsedSpender {
  let extended = true;
  let tx: Transaction;
  try {
    tx = Transaction.fromHexEF(hex);
  } catch {
    extended = false;
    try {
      tx = Transaction.fromHex(hex);
    } catch {
      return { ok: false, detail: "Datahub returned hex that is not a transaction" };
    }
  }

  const computed = tx.id("hex").toLowerCase();
  // The bytes must be the spender named on the row. A datahub must not be
  // able to substitute a different transaction.
  if (computed !== spentBy) {
    return {
      ok: false,
      detail: `Datahub returned ${shortTxid(computed)} which does not match the named spender`,
    };
  }
  if (!extended) {
    return {
      ok: false,
      detail: "Datahub returned a raw transaction, so source outputs are absent and ownership cannot be proven",
    };
  }
  return { ok: true, tx };
}

function proveOwnership(
  tx: Transaction,
  group: SpenderGroup,
  owned: OwnedIndex,
): { ok: true } | { ok: false; status: "not_ours" | "rejected"; detail: string } {
  if (tx.inputs.length === 0) {
    return { ok: false, status: "rejected", detail: "Spender has no inputs" };
  }

  const quarantined = new Set(group.rows.map((row) => `${row.txid.toLowerCase()}:${row.vout}`));
  let spendsQuarantine = false;
  for (let index = 0; index < tx.inputs.length; index += 1) {
    const input = tx.inputs[index];
    if (!input?.sourceTransaction) {
      return {
        ok: false,
        status: "rejected",
        detail: `Input ${index} has no source output, so ownership cannot be proven`,
      };
    }
    const output = input.sourceTransaction.outputs[input.sourceOutputIndex];
    if (!output?.lockingScript) {
      return {
        ok: false,
        status: "rejected",
        detail: `Input ${index} has no source output, so ownership cannot be proven`,
      };
    }
    const address = p2pkhAddress(output.lockingScript);
    if (!address || !owned.addresses.has(address)) {
      return {
        ok: false,
        status: "not_ours",
        detail: `Input ${index} is not a P2PKH output locked to a wallet this writer controls`,
      };
    }
    const sourceTxid = String(input.sourceTXID ?? "").trim().toLowerCase();
    if (quarantined.has(`${sourceTxid}:${input.sourceOutputIndex}`)) spendsQuarantine = true;
  }

  if (!spendsQuarantine) {
    return {
      ok: false,
      status: "rejected",
      detail: "Spender does not spend a quarantined outpoint from this group",
    };
  }
  return { ok: true };
}

function outputTargets(tx: Transaction, owned: OwnedIndex): ReconcileTargets {
  let funding = false;
  const aircraft = new Map<string, { icao: string; address: string }>();
  for (const output of tx.outputs) {
    if (!output.lockingScript) continue;
    const address = p2pkhAddress(output.lockingScript);
    if (!address) continue;
    if (owned.treasuryAddress && address === owned.treasuryAddress) funding = true;
    const wallet = owned.byAddress.get(address);
    if (wallet) aircraft.set(wallet.icao, wallet);
  }
  return {
    funding,
    aircraft: [...aircraft.values()].sort((a, b) => a.icao.localeCompare(b.icao)),
  };
}

function everyTarget(owned: OwnedIndex): ReconcileTargets {
  const aircraft = new Map<string, { icao: string; address: string }>();
  for (const wallet of owned.aircraft) aircraft.set(wallet.icao, wallet);
  return {
    funding: owned.treasuryAddress !== "",
    aircraft: [...aircraft.values()].sort((a, b) => a.icao.localeCompare(b.icao)),
  };
}

function reconcileSucceeded(result: unknown): boolean {
  if (!result || typeof result !== "object") return true;
  const record = result as { applied?: unknown; ok?: unknown };
  if (record.applied === false) return false;
  if (record.ok === false) return false;
  return true;
}

function datahubHexUrl(base: string, txid: string): string | null {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed) || !TXID_RE.test(txid)) return null;
  return `${trimmed}/tx/${txid}/hex`;
}

function arcadeTxUrl(base: string): string | null {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return `${trimmed}/tx`;
}

function hostLabel(base: string): string {
  try {
    const url = new URL(base);
    return `${url.host}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return "invalid-url";
  }
}

function unwrapArcadeBody(parsed: unknown): unknown {
  if (Array.isArray(parsed)) return parsed[0] ?? null;
  return parsed;
}

function arcadeDetail(
  status: number,
  diagnosis: { status: string; reason?: string; upstreamSnippet?: string },
  raw: string,
): string {
  const parts = [`HTTP ${status}`];
  if (diagnosis.status) parts.push(diagnosis.status);
  if (diagnosis.reason) parts.push(diagnosis.reason);
  else if (diagnosis.upstreamSnippet) parts.push(diagnosis.upstreamSnippet);
  else if (!diagnosis.status && raw.trim()) parts.push(raw.trim());
  return clip(parts.join(": "));
}

function clip(text: string): string {
  const flat = text.replace(/\0/g, "").replace(/\s+/g, " ").trim();
  if (flat.length <= DETAIL_CAP) return flat;
  return `${flat.slice(0, DETAIL_CAP - 3)}...`;
}

function shortTxid(txid: string): string {
  return txid.slice(0, 12);
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function errorCode(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const record = err as {
    code?: unknown;
    original?: { code?: unknown };
    cause?: { code?: unknown };
  };
  for (const value of [record.code, record.original?.code, record.cause?.code]) {
    if (typeof value === "string") return value;
  }
  return "";
}

function isMissingSchema(err: unknown): boolean {
  const code = errorCode(err);
  if (code === "42P01" || code === "42703") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /does not exist/i.test(message)
    && /network_spent_outpoints|recovery_status/i.test(message);
}

async function readBody(
  res: Response,
  maxBytes: number,
): Promise<{ text: string } | null> {
  const declared = Number(res.headers?.get?.("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  const body = res.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const step = await reader.read();
        if (step.value && step.value.byteLength > 0) {
          total += step.value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            return null;
          }
          chunks.push(step.value);
        }
        if (step.done) break;
      }
    } catch {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { text: new TextDecoder().decode(merged) };
  }

  try {
    const text = await res.text();
    if (text.length > maxBytes) return null;
    return { text };
  } catch {
    return null;
  }
}
