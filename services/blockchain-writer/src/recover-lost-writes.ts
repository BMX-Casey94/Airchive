import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Knex } from "knex";
import {
  WOC_BULK_LIMIT,
  WocRateLimitedError,
  WocUnavailableError,
} from "./woc-client.js";

/**
 * Recovers AIRCHIVE writes that Arcade accepted but that never reached the
 * network. Dry-run is the default. --apply --confirm requeues missing txids
 * through claimRejectRequeue and insertPendingWrite. It does not broadcast
 * and it does not spend.
 *
 * Do not statically import @airchive/db from this module. Postgres env and
 * Docker secret files are applied in main() before the database module loads.
 */

const TXID_PATTERN = /^[0-9a-fA-F]{64}$/;
const STATUS_PATTERN = /^[A-Z0-9_]+$/;
const TIMESTAMP_ZONE = /(?:Z|[+-]\d{2}:\d{2})$/i;

export const DEFAULT_STATUSES = ["SEEN_ON_NETWORK", "FAILED"] as const;
export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_DELAY_MS = 0;
export const DEFAULT_MAX_REQUEUE = 100_000;
export const DEFAULT_PAGE_SIZE = 500;
export const DEFAULT_PROGRESS_EVERY = 1_000;
export const DEFAULT_VERIFY_PROVIDER = "woc-bulk" as const;
export const RECOVERY_MAX_LOOKUP_ATTEMPTS = 5;
export const RECOVERY_BACKOFF_BASE_MS = 1_000;
export const RECOVERY_BACKOFF_MAX_MS = 30_000;
/**
 * Consecutive provider requests that exhausted 429/5xx/network retries before
 * the run stops. In woc-bulk mode one POST /txs/status is one request, not
 * one count per txid in that batch.
 */
export const RATE_LIMIT_ABORT_STREAK = 8;

/**
 * One claim per txid. claimRejectRequeue returns null once reject_requeues
 * reaches this, so a second process cannot insert another pending write.
 * The live writer still uses its own higher ceiling for later rejections.
 */
export const RECOVERY_MAX_REQUEUES = 1;

export type VerifyProvider = "woc-bulk" | "bitails" | "woc";

export type Presence = "found" | "missing" | "unverified";

export interface ResolvedPresence {
  presence: Presence;
  /** True when 429, 5xx, or a network error used up the retry budget. */
  retryExhausted: boolean;
}

export type RequeueOutcome =
  | "requeued"
  | "skipped_no_claim"
  | "skipped_unparseable"
  | "failed";

export type ProviderProbeResult =
  | { kind: "found" }
  | { kind: "not_found" }
  | { kind: "retryable"; status: number; retryAfterMs?: number }
  | { kind: "unverified"; reason: string };

/**
 * Result of one POST /txs/status batch.
 * `answered` means WhatsOnChain returned a body. `confirmed` holds only the
 * ids fetchTxStatuses kept: no error and block height greater than zero.
 * Every other id in the request is ambiguous (mempool or unknown).
 * `unavailable` is never a missing verdict, including a 404 on the endpoint.
 */
export type BulkProbeResult =
  | { kind: "answered"; confirmed: ReadonlySet<string> }
  | { kind: "unavailable"; retryable: boolean; retryAfterMs?: number; reason: string };

export interface BulkStatusClient {
  fetchTxStatuses(
    txids: string[],
  ): Promise<Map<string, { txid: string; blockHeight: number; confirmations: number }> | null>;
}

export interface RecoverCursor {
  createdAt: Date;
  txid: string;
}

export interface CandidateRow {
  txid: string;
  created_at: Date | string;
  status: string;
}

export interface RecoverCli {
  from: Date;
  to: Date;
  statuses: string[];
  limit: number | null;
  pageSize: number;
  apply: boolean;
  confirm: boolean;
  verifyProvider: VerifyProvider;
  concurrency: number;
  delayMs: number;
  maxRequeue: number;
  list: boolean;
  progressEvery: number;
  /** Minutes. Null keeps the follow-up GET for every id the bulk map omits. */
  unminedMissingAfterMin: number | null;
}

export interface RecoverySummary {
  mode: "dry-run" | "apply";
  candidates: number;
  found: number;
  missing: number;
  unverified: number;
  requeued: number;
  skippedAlreadyClaimed: number;
  skippedUnparseable: number;
  skippedOverCap: number;
  failed: number;
  capped: boolean;
  /** Missing because a successful bulk response left an old id unmined. */
  missingByUnminedAge: number;
}

export interface RecoveryIo {
  loadPage(cursor: RecoverCursor | null, pageSize: number): Promise<CandidateRow[]>;
  /** Per-txid GET. For woc-bulk this is the follow-up GET /tx/hash/{txid}. */
  lookup(txid: string): Promise<ProviderProbeResult>;
  /** WhatsOnChain POST /txs/status. Required when verifyProvider is woc-bulk. */
  lookupBulk?(txids: readonly string[]): Promise<BulkProbeResult>;
  requeue(txid: string): Promise<RequeueOutcome>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  listLine(line: string): void;
  /** When --unmined-missing-after-min is measured from. Defaults to executeRecovery's start. */
  startedAt?: Date;
}

export interface RecoveryProviderOptions {
  name: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyHeader?: string;
  maxRequestsPerSecond: number;
  maxConcurrent: number;
}

export interface CliDeps {
  run(options: RecoverCli): Promise<number>;
}

export class RecoverUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoverUsageError";
  }
}

export class RecoverRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoverRefusedError";
  }
}

export const USAGE = [
  "Recover AIRCHIVE writes that Arcade accepted but that never reached the network.",
  "",
  "Dry-run is the default. It reads tx_results and asks WhatsOnChain, in bulk,",
  "whether each txid is confirmed. It writes nothing. Unverified lookups are skipped.",
  "",
  "--apply --confirm requeues each missing txid as one preserved pending write.",
  "The running writer may broadcast those later, when spending is allowed.",
  "This process never broadcasts and never spends.",
  "",
  "Window: created_at >= --from and created_at < --to.",
  "Example: --from 2026-10-31T12:45:00Z --to 2026-10-31T13:57:00Z",
  "",
  "Usage:",
  "  node services/blockchain-writer/scripts/recover-lost-writes.mjs \\",
  "    --from <ISO-8601> --to <ISO-8601> [options]",
  "",
  "Options:",
  "  --from <timestamp>          Inclusive start. Required. Must end with Z or an offset.",
  "  --to <timestamp>            Exclusive end. Required. Same format as --from.",
  "  --status <list>             Comma-separated statuses (default SEEN_ON_NETWORK,FAILED).",
  "  --limit <n>                 Stop after examining this many candidates.",
  "  --verify-provider <name>    woc-bulk (default), bitails, or woc.",
  "                              woc-bulk posts 20 txids to /txs/status.",
  "                              Confirmed means block height above 0.",
  "                              Any other id is checked with GET /tx/hash/{txid}",
  "                              before it can be classed as missing.",
  "  --unmined-missing-after-min <n>",
  "                              woc-bulk only. After a successful bulk response,",
  "                              an id with no block height whose created_at is",
  "                              more than N minutes before this run started is",
  "                              missing, with no GET /tx/hash/{txid}. Unset by default.",
  "  --concurrency <n>           Parallel lookups (default 2, maximum 8).",
  "  --delay-ms <n>              Minimum gap between lookup starts (default 0).",
  "  --max-requeue <n>           Cap on pending writes inserted (default 100000).",
  "  --page-size <n>             Keyset page size (default 500).",
  "  --progress-every <n>        Progress interval in rows (default 1000).",
  "  --list                      Write missing txids to stdout as JSON lines.",
  "  --apply                     Requeue missing txids. Requires --confirm.",
  "  --confirm                   Required together with --apply.",
  "  --help                      Show this help.",
].join("\n");

type ParseResult =
  | { kind: "help"; text: string }
  | { kind: "options"; options: RecoverCli };

function usageError(detail: string): never {
  throw new RecoverUsageError(`${detail}\n\n${USAGE}`);
}

export function parseUtcTimestamp(value: string, flag: string): Date {
  const trimmed = value.trim();
  if (!TIMESTAMP_ZONE.test(trimmed)) {
    usageError(
      `${flag} must be an ISO-8601 timestamp with Z or a numeric offset, `
      + "for example 2026-10-31T13:00:00Z",
    );
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) usageError(`${flag} is not a valid timestamp: ${value}`);
  return new Date(parsed);
}

function parseBoundedInt(value: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) usageError(`${flag} must be an integer`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    usageError(`${flag} must be between ${min} and ${max}`);
  }
  return parsed;
}

function takeString(flags: Map<string, string | true>, key: string): string | undefined {
  const value = flags.get(key);
  if (value === undefined) return undefined;
  if (value === true) usageError(`--${key} needs a value`);
  return value;
}

export function parseRecoverArgs(argv: readonly string[]): ParseResult {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { kind: "help", text: USAGE };
  }

  const flags = new Map<string, string | true>();
  const booleanFlags = new Set(["apply", "confirm", "list", "help"]);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) usageError(`Unexpected argument: ${token}`);
    const equals = token.indexOf("=");
    const key = (equals === -1 ? token.slice(2) : token.slice(2, equals)).trim();
    if (!key) usageError(`Unexpected argument: ${token}`);
    if (booleanFlags.has(key)) {
      if (equals !== -1) usageError(`--${key} does not take a value`);
      flags.set(key, true);
      continue;
    }
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    const next = argv[index + 1];
    const value = inline ?? next;
    if (value === undefined || value.startsWith("--")) usageError(`--${key} needs a value`);
    flags.set(key, value);
    if (inline === undefined) index += 1;
  }

  const known = new Set([
    "from",
    "to",
    "status",
    "limit",
    "verify-provider",
    "concurrency",
    "delay-ms",
    "max-requeue",
    "page-size",
    "progress-every",
    "unmined-missing-after-min",
    "list",
    "apply",
    "confirm",
  ]);
  for (const key of flags.keys()) {
    if (!known.has(key)) usageError(`Unknown option --${key}`);
  }

  const fromRaw = takeString(flags, "from");
  const toRaw = takeString(flags, "to");
  if (!fromRaw) usageError("--from is required");
  if (!toRaw) usageError("--to is required");
  const from = parseUtcTimestamp(fromRaw, "--from");
  const to = parseUtcTimestamp(toRaw, "--to");
  if (from.getTime() >= to.getTime()) usageError("--from must be earlier than --to");

  const statusRaw = takeString(flags, "status") ?? DEFAULT_STATUSES.join(",");
  const statuses = statusRaw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (statuses.length === 0) usageError("--status must name at least one status");
  for (const status of statuses) {
    if (!STATUS_PATTERN.test(status)) usageError(`Unsafe status value: ${status}`);
  }

  const providerRaw = (takeString(flags, "verify-provider") ?? DEFAULT_VERIFY_PROVIDER).toLowerCase();
  if (providerRaw !== "woc-bulk" && providerRaw !== "bitails" && providerRaw !== "woc") {
    usageError("--verify-provider must be woc-bulk, bitails, or woc");
  }
  const verifyProvider: VerifyProvider = providerRaw;

  const unminedRaw = takeString(flags, "unmined-missing-after-min");
  const unminedMissingAfterMin = unminedRaw === undefined
    ? null
    : parseBoundedInt(unminedRaw, "--unmined-missing-after-min", 0, 1_000_000);

  const limitRaw = takeString(flags, "limit");
  return {
    kind: "options",
    options: {
      from,
      to,
      statuses,
      limit: limitRaw === undefined ? null : parseBoundedInt(limitRaw, "--limit", 1, 1_000_000),
      pageSize: parseBoundedInt(takeString(flags, "page-size") ?? String(DEFAULT_PAGE_SIZE), "--page-size", 1, 2_000),
      apply: flags.get("apply") === true,
      confirm: flags.get("confirm") === true,
      verifyProvider,
      concurrency: parseBoundedInt(
        takeString(flags, "concurrency") ?? String(DEFAULT_CONCURRENCY),
        "--concurrency",
        1,
        8,
      ),
      delayMs: parseBoundedInt(takeString(flags, "delay-ms") ?? String(DEFAULT_DELAY_MS), "--delay-ms", 0, 60_000),
      maxRequeue: parseBoundedInt(
        takeString(flags, "max-requeue") ?? String(DEFAULT_MAX_REQUEUE),
        "--max-requeue",
        0,
        1_000_000,
      ),
      list: flags.get("list") === true,
      unminedMissingAfterMin,
      progressEvery: parseBoundedInt(
        takeString(flags, "progress-every") ?? String(DEFAULT_PROGRESS_EVERY),
        "--progress-every",
        1,
        100_000,
      ),
    },
  };
}

export function refuseUnconfirmedApply(apply: boolean, confirm: boolean): void {
  if (apply && !confirm) {
    throw new RecoverRefusedError(
      "Refusing --apply without --confirm. No rows were read or written.",
    );
  }
}

export function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function envString(raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : fallback;
}

/** Same hosts and tx path the writer already uses. `/tx/{txid}` is WhatsOnChain and Bitails. */
export function txLookupPath(txid: string): string {
  return `/tx/${txid.trim().toLowerCase()}`;
}

/**
 * Single-transaction confirmation after a bulk miss.
 * WhatsOnChain documents GET /tx/hash/{txid}. The same path is what
 * BananaBlocks serves. A null body is the only clear not-found.
 */
export function txHashLookupPath(txid: string): string {
  return `/tx/hash/${txid.trim().toLowerCase()}`;
}

export function recoveryProviderOptions(
  provider: VerifyProvider,
  env: Record<string, string | undefined>,
): RecoveryProviderOptions {
  if (provider === "bitails") {
    return {
      name: "bitails",
      baseUrl: envString(env.BITAILS_API_URL, "https://api.bitails.io"),
      apiKey: env.BITAILS_API_KEY?.trim() || undefined,
      apiKeyHeader: "apikey",
      maxRequestsPerSecond: positiveInt(env.BITAILS_MAX_RPS, 8),
      maxConcurrent: 2,
    };
  }
  // woc and woc-bulk share the WhatsOnChain client, its rate limiter, and POST /txs/status.
  return {
    name: "whatsonchain",
    baseUrl: envString(env.WOC_API_URL, "https://api.whatsonchain.com/v1/bsv/main"),
    apiKey: env.WOC_API_KEY?.trim() || undefined,
    maxRequestsPerSecond: positiveInt(env.WOC_MAX_RPS, 3),
    maxConcurrent: 2,
  };
}

export function formatSqlTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

export function renderCandidateSql(input: {
  from: Date;
  to: Date;
  statuses: readonly string[];
  pageSize: number;
  cursor: RecoverCursor | null;
}): string {
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1) {
    throw new Error("Invalid page size");
  }
  for (const status of input.statuses) {
    if (!STATUS_PATTERN.test(status)) throw new Error(`Unsafe status value: ${status}`);
  }
  const lines = [
    "SELECT txid, created_at, status",
    "FROM tx_results",
    `WHERE created_at >= '${formatSqlTimestamp(input.from)}'`,
    `  AND created_at < '${formatSqlTimestamp(input.to)}'`,
    "  AND op_return IS NOT NULL",
    "  AND reject_requeues = 0",
    `  AND status IN (${input.statuses.map((status) => `'${status}'`).join(", ")})`,
  ];
  if (input.cursor) {
    if (!TXID_PATTERN.test(input.cursor.txid)) {
      throw new Error("Refusing to render a cursor txid that is not 64 hex characters");
    }
    lines.push(
      `  AND (created_at, txid) > ('${formatSqlTimestamp(input.cursor.createdAt)}', '${input.cursor.txid.toLowerCase()}')`,
    );
  }
  lines.push("ORDER BY created_at ASC, txid ASC");
  lines.push(`LIMIT ${input.pageSize}`);
  return lines.join("\n");
}

export function renderApplySql(): string {
  return [
    "-- only for txids a healthy provider answered 404, and only with --apply --confirm",
    "-- claimRejectRequeue locks one tx_results row and, when reject_requeues is 0:",
    "BEGIN;",
    "SELECT txid, aircraft_icao, record_type, flight_id, op_return, reject_requeues",
    "  FROM tx_results",
    " WHERE txid = $1 AND status <> 'MINED' AND op_return IS NOT NULL",
    " FOR UPDATE;",
    "UPDATE tx_results SET reject_requeues = 1 WHERE txid = $1;",
    "COMMIT;",
    "INSERT INTO pending_writes (aircraft_icao, record_type, payload, flight_id, preserved)",
    "VALUES ($1, $2, $3, $4, true);",
    "-- does not delete any row, does not broadcast, and does not spend",
  ].join("\n");
}

export function toUtcDate(value: Date | string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("Invalid created_at");
    return value;
  }
  const trimmed = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?$/.exec(trimmed);
  if (match) {
    const day = match[1];
    const time = match[2];
    const zone = match[3] ?? "Z";
    if (day && time) {
      const parsed = new Date(`${day}T${time}${zone}`);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  const fallback = new Date(trimmed);
  if (Number.isNaN(fallback.getTime())) throw new Error(`Invalid created_at: ${trimmed}`);
  return fallback;
}

export function advanceCursor(row: { created_at: Date | string; txid: string }): RecoverCursor {
  const txid = row.txid.trim();
  if (!txid) throw new Error("Candidate row is missing a txid");
  return { createdAt: toUtcDate(row.created_at), txid };
}

export function comparePosition(
  row: { created_at: Date | string; txid: string },
  cursor: RecoverCursor,
): number {
  const delta = toUtcDate(row.created_at).getTime() - cursor.createdAt.getTime();
  if (delta !== 0) return delta;
  const txid = row.txid.trim();
  if (txid === cursor.txid) return 0;
  return txid < cursor.txid ? -1 : 1;
}

export function pageAfterCursor<T extends { created_at: Date | string; txid: string }>(
  rows: readonly T[],
  cursor: RecoverCursor | null,
  pageSize: number,
): T[] {
  const ordered = [...rows].sort((left, right) => {
    const byTime = toUtcDate(left.created_at).getTime() - toUtcDate(right.created_at).getTime();
    if (byTime !== 0) return byTime;
    const a = left.txid.trim();
    const b = right.txid.trim();
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const filtered = cursor === null
    ? ordered
    : ordered.filter((row) => comparePosition(row, cursor) > 0);
  return filtered.slice(0, pageSize);
}

/**
 * Keep this predicate aligned with renderCandidateSql. Pages stay small so a
 * 100k-row hour is never loaded at once. op_return is filtered, not selected.
 */
export async function selectCandidatePage(
  db: Knex,
  query: {
    from: Date;
    to: Date;
    statuses: readonly string[];
    cursor: RecoverCursor | null;
  },
  pageSize: number,
): Promise<CandidateRow[]> {
  let builder = db("tx_results")
    .select("txid", "created_at", "status")
    .where("created_at", ">=", query.from)
    .where("created_at", "<", query.to)
    .whereNotNull("op_return")
    .where("reject_requeues", "=", 0)
    .whereIn("status", [...query.statuses])
    .orderBy([
      { column: "created_at", order: "asc" },
      { column: "txid", order: "asc" },
    ])
    .limit(pageSize);

  if (query.cursor) {
    const cursor = query.cursor;
    builder = builder.where(function (this: Knex.QueryBuilder) {
      void this
        .where("created_at", ">", cursor.createdAt)
        .orWhere(function (this: Knex.QueryBuilder) {
          void this
            .where("created_at", "=", cursor.createdAt)
            .where("txid", ">", cursor.txid);
        });
    });
  }

  const rows = await builder as Array<{
    txid: string;
    created_at: Date | string;
    status: string;
  }>;
  return rows.map((row) => ({
    txid: String(row.txid).trim(),
    created_at: row.created_at,
    status: String(row.status),
  }));
}

export function parseRetryAfterMs(header: string | null, nowMs = Date.now()): number | undefined {
  if (header == null) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  }
  const when = Date.parse(trimmed);
  if (Number.isFinite(when)) return Math.max(0, when - nowMs);
  return undefined;
}

export function classifyHttpResponse(
  status: number,
  retryAfterHeader: string | null,
  nowMs = Date.now(),
): ProviderProbeResult {
  if (status === 404) return { kind: "not_found" };
  if (status >= 200 && status < 300) return { kind: "found" };
  if (status === 429 || status >= 500) {
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader, nowMs);
    return retryAfterMs === undefined
      ? { kind: "retryable", status }
      : { kind: "retryable", status, retryAfterMs };
  }
  return { kind: "unverified", reason: `HTTP ${status}` };
}

function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  const code = "code" in err ? String(err.code) : "";
  return code === "UND_ERR_CONNECT_TIMEOUT"
    || code === "ECONNRESET"
    || code === "ECONNREFUSED"
    || code === "ETIMEDOUT"
    || code === "ENOTFOUND"
    || code === "EAI_AGAIN";
}

export function classifyLookupFailure(err: unknown): ProviderProbeResult {
  if (err instanceof WocRateLimitedError) {
    return { kind: "retryable", status: 429, retryAfterMs: err.retryAfterMs };
  }
  if (err instanceof WocUnavailableError) {
    const match = /returned (\d{3})\b/.exec(err.message);
    const statusText = match?.[1];
    if (statusText) return classifyHttpResponse(Number(statusText), null);
    return { kind: "unverified", reason: err.message };
  }
  if (isTransientNetworkError(err)) return { kind: "retryable", status: 0 };
  const reason = err instanceof Error ? err.message : "lookup failed";
  return { kind: "unverified", reason };
}

export interface TxLookupClient {
  getJson<T>(path: string, options: { label: string; allowNotFound?: boolean }): Promise<T | null>;
}

export async function probeTxid(
  client: TxLookupClient,
  txid: string,
  pathFor: (txid: string) => string = txLookupPath,
): Promise<ProviderProbeResult> {
  const id = txid.trim().toLowerCase();
  if (!TXID_PATTERN.test(id)) {
    return { kind: "unverified", reason: "txid is not 64 hex characters" };
  }
  try {
    const body = await client.getJson<unknown>(pathFor(id), {
      label: "recover_lost_tx",
      allowNotFound: true,
    });
    if (body == null) return { kind: "not_found" };
    if (typeof body !== "object") {
      return { kind: "unverified", reason: "provider returned an unexpected body" };
    }
    return { kind: "found" };
  } catch (err) {
    return classifyLookupFailure(err);
  }
}

export function recoveryBackoffMs(attempt: number, retryAfterMs?: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const exponential = Math.min(
    RECOVERY_BACKOFF_MAX_MS,
    RECOVERY_BACKOFF_BASE_MS * 2 ** (safeAttempt - 1),
  );
  const advised = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.floor(retryAfterMs)
    : 0;
  return Math.max(exponential, advised);
}

/**
 * fetchTxStatuses keeps a row only when it has a txid, no error, and a block
 * height above zero. The confirmation poller treats those map entries as
 * mined and treats every absence as "not mined this cycle", not as missing.
 * A mempool row (height omitted or zero) and an unknown row (error, or no
 * row) are therefore the same result: not in the map. Only a later
 * GET /tx/hash/{txid} can turn that into missing.
 */
export function classifyBulkHit(inConfirmedMap: boolean): "found" | "ambiguous" {
  return inConfirmedMap ? "found" : "ambiguous";
}

/**
 * True when created_at is strictly more than `afterMin` minutes before the
 * run started. An exact cutoff stays on the follow-up GET. Null disables it.
 */
export function unminedShortcutApplies(
  createdAt: Date | string,
  runStartedAt: Date,
  afterMin: number | null,
): boolean {
  if (afterMin === null) return false;
  if (!Number.isFinite(afterMin) || afterMin < 0) return false;
  const cutoff = runStartedAt.getTime() - afterMin * 60_000;
  return toUtcDate(createdAt).getTime() < cutoff;
}

export async function probeBulkStatuses(
  client: BulkStatusClient,
  txids: readonly string[],
): Promise<BulkProbeResult> {
  const ids = txids.map((txid) => txid.trim().toLowerCase());
  try {
    const statuses = await client.fetchTxStatuses(ids);
    if (!statuses) {
      return {
        kind: "unavailable",
        retryable: true,
        reason: "bulk status returned no body",
      };
    }
    return { kind: "answered", confirmed: new Set(statuses.keys()) };
  } catch (err) {
    const classified = classifyLookupFailure(err);
    if (classified.kind === "retryable") {
      return {
        kind: "unavailable",
        retryable: true,
        retryAfterMs: classified.retryAfterMs,
        reason: `bulk status HTTP ${classified.status}`,
      };
    }
    if (classified.kind === "not_found") {
      return {
        kind: "unavailable",
        retryable: false,
        reason: "bulk status endpoint returned 404",
      };
    }
    const reason = classified.kind === "unverified" ? classified.reason : "bulk status failed";
    return { kind: "unavailable", retryable: false, reason };
  }
}

export async function resolveBulkStatuses(
  txids: readonly string[],
  lookupBulk: (txids: readonly string[]) => Promise<BulkProbeResult>,
  options: { maxAttempts: number; sleep: (ms: number) => Promise<void> },
): Promise<
  | { ok: true; confirmed: ReadonlySet<string> }
  | { ok: false; retryExhausted: boolean; reason: string }
> {
  const maxAttempts = Math.max(1, options.maxAttempts);
  let lastReason = "bulk status failed";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result: BulkProbeResult;
    try {
      result = await lookupBulk(txids);
    } catch (err) {
      const classified = classifyLookupFailure(err);
      result = classified.kind === "retryable"
        ? {
          kind: "unavailable",
          retryable: true,
          retryAfterMs: classified.retryAfterMs,
          reason: `bulk status HTTP ${classified.status}`,
        }
        : {
          kind: "unavailable",
          retryable: false,
          reason: classified.kind === "unverified" ? classified.reason : "bulk status failed",
        };
    }
    if (result.kind === "answered") return { ok: true, confirmed: result.confirmed };
    lastReason = result.reason;
    if (result.retryable && attempt < maxAttempts) {
      await options.sleep(recoveryBackoffMs(attempt, result.retryAfterMs));
      continue;
    }
    return { ok: false, retryExhausted: result.retryable, reason: lastReason };
  }
  return { ok: false, retryExhausted: true, reason: lastReason };
}

export async function resolvePresence(
  txid: string,
  lookup: (txid: string) => Promise<ProviderProbeResult>,
  options: { maxAttempts: number; sleep: (ms: number) => Promise<void> },
): Promise<ResolvedPresence> {
  const maxAttempts = Math.max(1, options.maxAttempts);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result: ProviderProbeResult;
    try {
      result = await lookup(txid);
    } catch (err) {
      result = classifyLookupFailure(err);
    }
    if (result.kind === "found") return { presence: "found", retryExhausted: false };
    if (result.kind === "not_found") return { presence: "missing", retryExhausted: false };
    if (result.kind === "retryable" && attempt < maxAttempts) {
      await options.sleep(recoveryBackoffMs(attempt, result.retryAfterMs));
      continue;
    }
    return { presence: "unverified", retryExhausted: result.kind === "retryable" };
  }
  return { presence: "unverified", retryExhausted: true };
}

export async function paceLookups(
  gate: { next: number },
  delayMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number = Date.now,
): Promise<void> {
  if (delayMs <= 0) return;
  const current = now();
  const start = Math.max(current, gate.next);
  gate.next = start + delayMs;
  const wait = start - current;
  if (wait > 0) await sleep(wait);
}

/**
 * Docker exec does not re-run the image entrypoint, so FOO_FILE secrets are
 * applied here. The file wins, matching deploy/docker-entrypoint.sh.
 */
export function applyFileSecrets(
  env: NodeJS.ProcessEnv,
  read: (filePath: string) => string = (filePath) => readFileSync(filePath, "utf8"),
): void {
  const fileVars = Object.keys(env).filter((key) => key.endsWith("_FILE"));
  for (const key of fileVars) {
    const filePath = env[key];
    if (!filePath) continue;
    const name = key.slice(0, -"_FILE".length);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let raw: string;
    try {
      raw = read(filePath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot read ${key}=${filePath}: ${detail}`);
    }
    const value = raw.replace(/(?:\r?\n)+$/, "");
    if (!value) throw new Error(`${key}=${filePath} is empty`);
    env[name] = value;
    delete env[key];
  }
}

function emptySummary(mode: RecoverySummary["mode"]): RecoverySummary {
  return {
    mode,
    candidates: 0,
    found: 0,
    missing: 0,
    unverified: 0,
    requeued: 0,
    skippedAlreadyClaimed: 0,
    skippedUnparseable: 0,
    skippedOverCap: 0,
    failed: 0,
    capped: false,
    missingByUnminedAge: 0,
  };
}

export function formatSummary(summary: RecoverySummary): string {
  return [
    `mode=${summary.mode}`,
    `candidates=${summary.candidates}`,
    `found=${summary.found}`,
    `missing=${summary.missing}`,
    `unverified=${summary.unverified}`,
    `requeued=${summary.requeued}`,
    `skipped-already-claimed=${summary.skippedAlreadyClaimed}`,
    `skipped-unparseable=${summary.skippedUnparseable}`,
    `skipped-over-cap=${summary.skippedOverCap}`,
    `failed=${summary.failed}`,
    `capped=${summary.capped}`,
    `missing-by-unmined-age=${summary.missingByUnminedAge}`,
  ].join(" ");
}

export function exitCodeFor(summary: RecoverySummary): number {
  if (summary.failed > 0 || summary.skippedUnparseable > 0) return 1;
  return 0;
}

function assertBalanced(summary: RecoverySummary, apply: boolean): void {
  const classified = summary.found + summary.missing + summary.unverified;
  if (classified !== summary.candidates) {
    throw new Error(
      `Recovery counters diverged: classified ${classified}, candidates ${summary.candidates}`,
    );
  }
  if (!apply) return;
  const accounted = summary.requeued
    + summary.skippedAlreadyClaimed
    + summary.skippedUnparseable
    + summary.skippedOverCap
    + summary.failed;
  if (accounted !== summary.missing) {
    throw new Error(
      `Missing txids were not all accounted for: ${accounted} of ${summary.missing}`,
    );
  }
}

async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const runners = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: runners }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  }));
}

function rateLimitStopError(streak: number): Error {
  return new Error(
    `Stopping after ${streak} consecutive rate-limited or unavailable provider requests. `
    + "Unexamined rows were not requeued and still have reject_requeues = 0. "
    + "Wait for the provider quota to recover, then run again.",
  );
}

function logPreamble(options: RecoverCli, io: RecoveryIo): void {
  if (options.to.getTime() - options.from.getTime() > 6 * 60 * 60 * 1000) {
    io.log("warning: window is longer than 6 hours. Confirm --from and --to before relying on this run.");
  }
  if (new Date().getTimezoneOffset() !== 0) {
    io.log(
      "warning: this process is not in UTC. tx_results.created_at has no time zone; run with TZ=UTC.",
    );
  }
  io.log(options.apply
    ? "mode: apply — requeue missing txids only; no broadcast and no spend"
    : "mode: dry-run — no rows will be written");
  io.log(
    `window: created_at >= ${options.from.toISOString()} and created_at < ${options.to.toISOString()}`,
  );
  io.log(`status: ${options.statuses.join(",")}`);
  io.log(
    `lookup: provider=${options.verifyProvider} concurrency=${options.concurrency} `
    + `delayMs=${options.delayMs} maxRequeue=${options.maxRequeue}`,
  );
  if (options.verifyProvider === "woc-bulk") {
    io.log(
      `woc-bulk: POST /txs/status in batches of ${WOC_BULK_LIMIT}. `
      + "A block height above 0 is found. An id missing from that map is mempool or unknown, "
      + "so it is checked with GET /tx/hash/{txid} before it can be missing. "
      + `A request that exhausts its retries counts once toward the stop of ${RATE_LIMIT_ABORT_STREAK}.`,
    );
  }
  if (options.unminedMissingAfterMin !== null && options.verifyProvider === "woc-bulk") {
    io.log(
      `unmined-missing-after-min: ${options.unminedMissingAfterMin}. `
      + "After a successful bulk response, an id with no block height whose created_at is "
      + "more than this many minutes before the run started is missing, with no follow-up GET.",
    );
  } else if (options.unminedMissingAfterMin !== null) {
    io.log("warning: --unmined-missing-after-min applies to woc-bulk only. Each txid is still checked.");
  }
  io.log("sql:");
  io.log(renderCandidateSql({
    from: options.from,
    to: options.to,
    statuses: options.statuses,
    pageSize: options.pageSize,
    cursor: null,
  }));
  io.log("Later pages add AND (created_at, txid) > (last created_at, last txid), with the same filters.");
  io.log(options.apply ? "apply-sql:" : "apply-sql: not executed");
  io.log(renderApplySql());
}

export async function executeRecovery(
  options: RecoverCli,
  io: RecoveryIo,
): Promise<RecoverySummary> {
  const summary = emptySummary(options.apply ? "apply" : "dry-run");
  const gate = { next: 0 };
  const runStartedAt = io.startedAt ?? new Date();
  let inserted = 0;
  let rateStreak = 0;

  const countCandidate = (): void => {
    summary.candidates += 1;
    if (summary.candidates % options.progressEvery === 0) {
      io.log(`progress ${formatSummary(summary)}`);
    }
  };

  const noteRequest = (retryExhausted: boolean): void => {
    rateStreak = retryExhausted ? rateStreak + 1 : 0;
  };

  const stopForQuota = (): void => {
    if (rateStreak >= RATE_LIMIT_ABORT_STREAK) throw rateLimitStopError(rateStreak);
  };

  const acceptPresence = async (row: CandidateRow, presence: Presence): Promise<void> => {
    const txid = row.txid.trim().toLowerCase();
    if (presence === "found") {
      summary.found += 1;
      return;
    }
    if (presence === "unverified") {
      summary.unverified += 1;
      return;
    }
    summary.missing += 1;
    if (options.list) {
      io.listLine(JSON.stringify({
        txid,
        created_at: toUtcDate(row.created_at).toISOString(),
        status: row.status,
      }));
    }
    if (!options.apply) return;
    if (inserted >= options.maxRequeue) {
      summary.capped = true;
      summary.skippedOverCap += 1;
      return;
    }
    inserted += 1;
    let outcome: RequeueOutcome;
    try {
      outcome = await io.requeue(txid);
    } catch (err) {
      inserted -= 1;
      summary.failed += 1;
      const detail = err instanceof Error ? err.message : String(err);
      io.log(`requeue failed for ${txid}: ${detail}`);
      return;
    }
    if (outcome === "requeued") {
      summary.requeued += 1;
      return;
    }
    inserted -= 1;
    if (outcome === "skipped_no_claim") summary.skippedAlreadyClaimed += 1;
    else if (outcome === "skipped_unparseable") summary.skippedUnparseable += 1;
    else summary.failed += 1;
  };

  const handle = async (row: CandidateRow): Promise<void> => {
    const txid = row.txid.trim();
    try {
      if (!TXID_PATTERN.test(txid)) {
        summary.unverified += 1;
        io.log(`unverified ${txid || "(blank)"}: txid is not 64 hex characters`);
        return;
      }
      await paceLookups(gate, options.delayMs, io.sleep);
      const resolved = await resolvePresence(txid, io.lookup, {
        maxAttempts: RECOVERY_MAX_LOOKUP_ATTEMPTS,
        sleep: io.sleep,
      });
      noteRequest(resolved.retryExhausted);
      await acceptPresence(row, resolved.presence);
      if (resolved.presence === "unverified") stopForQuota();
    } finally {
      countCandidate();
    }
  };

  const confirmAmbiguous = async (row: CandidateRow): Promise<void> => {
    if (rateStreak >= RATE_LIMIT_ABORT_STREAK) return;
    await paceLookups(gate, options.delayMs, io.sleep);
    const resolved = await resolvePresence(row.txid, io.lookup, {
      maxAttempts: RECOVERY_MAX_LOOKUP_ATTEMPTS,
      sleep: io.sleep,
    });
    noteRequest(resolved.retryExhausted);
    await acceptPresence(row, resolved.presence);
    countCandidate();
    if (resolved.presence === "unverified") stopForQuota();
  };

  const examineBulkPage = async (
    page: readonly CandidateRow[],
    lookupBulk: (txids: readonly string[]) => Promise<BulkProbeResult>,
  ): Promise<void> => {
    const valid: CandidateRow[] = [];
    for (const row of page) {
      const txid = row.txid.trim();
      if (!TXID_PATTERN.test(txid)) {
        summary.unverified += 1;
        io.log(`unverified ${txid || "(blank)"}: txid is not 64 hex characters`);
        countCandidate();
        continue;
      }
      valid.push({ ...row, txid: txid.toLowerCase() });
    }

    for (let offset = 0; offset < valid.length; offset += WOC_BULK_LIMIT) {
      const chunk = valid.slice(offset, offset + WOC_BULK_LIMIT);
      await paceLookups(gate, options.delayMs, io.sleep);
      const bulk = await resolveBulkStatuses(
        chunk.map((row) => row.txid),
        lookupBulk,
        { maxAttempts: RECOVERY_MAX_LOOKUP_ATTEMPTS, sleep: io.sleep },
      );
      if (!bulk.ok) {
        io.log(`unverified batch of ${chunk.length}: ${bulk.reason}`);
        for (const row of chunk) {
          await acceptPresence(row, "unverified");
          countCandidate();
        }
        noteRequest(bulk.retryExhausted);
        stopForQuota();
        continue;
      }

      noteRequest(false);
      const ambiguous: CandidateRow[] = [];
      for (const row of chunk) {
        if (classifyBulkHit(bulk.confirmed.has(row.txid)) === "found") {
          await acceptPresence(row, "found");
          countCandidate();
          continue;
        }
        if (unminedShortcutApplies(row.created_at, runStartedAt, options.unminedMissingAfterMin)) {
          await acceptPresence(row, "missing");
          summary.missingByUnminedAge += 1;
          countCandidate();
          continue;
        }
        ambiguous.push(row);
      }
      await mapPool(ambiguous, options.concurrency, confirmAmbiguous);
    }
  };

  try {
    logPreamble(options, io);
    const bulkLookup = options.verifyProvider === "woc-bulk" ? io.lookupBulk : undefined;
    if (options.verifyProvider === "woc-bulk" && !bulkLookup) {
      throw new Error("woc-bulk requires a bulk status lookup");
    }
    let cursor: RecoverCursor | null = null;
    let seen = 0;
    while (options.limit === null || seen < options.limit) {
      const room = options.limit === null
        ? options.pageSize
        : Math.min(options.pageSize, options.limit - seen);
      const raw = await io.loadPage(cursor, room);
      const page = raw.slice(0, room);
      if (page.length === 0) break;
      seen += page.length;
      if (bulkLookup) await examineBulkPage(page, bulkLookup);
      else await mapPool(page, options.concurrency, handle);
      const last = page[page.length - 1];
      if (!last) break;
      const next = advanceCursor(last);
      if (
        cursor
        && next.createdAt.getTime() === cursor.createdAt.getTime()
        && next.txid === cursor.txid
      ) {
        throw new Error("Candidate pagination did not advance; refusing to loop");
      }
      cursor = next;
      if (page.length < room) break;
    }
    assertBalanced(summary, options.apply);
    return summary;
  } finally {
    io.log(`summary ${formatSummary(summary)}`);
    io.log(JSON.stringify(summary));
  }
}

function configureProcessForRun(): void {
  applyFileSecrets(process.env);
  process.env.SERVICE_NAME = "airchive-recover-lost-writes";
  process.env.POSTGRES_POOL_MIN = "0";
  const cap = process.env.RECOVER_POSTGRES_POOL_MAX?.trim();
  process.env.POSTGRES_POOL_MAX = cap && /^\d+$/.test(cap) ? cap : "2";
}

export async function main(argv: readonly string[], deps?: CliDeps): Promise<number> {
  let parsed: ParseResult;
  try {
    parsed = parseRecoverArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (parsed.kind === "help") {
    console.log(parsed.text);
    return 0;
  }
  try {
    refuseUnconfirmedApply(parsed.options.apply, parsed.options.confirm);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (deps) return deps.run(parsed.options);
  configureProcessForRun();
  try {
    const loaded = await import("./recover-lost-writes-db.js");
    return await loaded.runFromCli(parsed.options);
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 1;
  }
}

function invokedAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalised = entry.replace(/\\/g, "/");
  if (!normalised.endsWith("/recover-lost-writes.js") && !normalised.endsWith("/recover-lost-writes.ts")) {
    return false;
  }
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exit(1);
    });
}
