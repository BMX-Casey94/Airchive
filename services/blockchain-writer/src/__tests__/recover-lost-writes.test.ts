import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecordType, type TelemetryRecord } from "@airchive/types";
import {
  buildOpReturnPayload,
  encodeTelemetryPayload,
  RecordType as CodecRecordType,
} from "@airchive/telemetry-codec";
import { rebufferRejectedTransaction } from "../rebuffer-rejected.js";
import { WOC_BULK_LIMIT, WocRateLimitedError, WocUnavailableError } from "../woc-client.js";
import { createMemoryDb } from "./memory-db.js";
import {
  RATE_LIMIT_ABORT_STREAK,
  RECOVERY_BACKOFF_BASE_MS,
  RECOVERY_MAX_LOOKUP_ATTEMPTS,
  RECOVERY_BACKOFF_MAX_MS,
  RECOVERY_MAX_REQUEUES,
  applyFileSecrets,
  classifyBulkHit,
  classifyHttpResponse,
  classifyLookupFailure,
  comparePosition,
  executeRecovery,
  exitCodeFor,
  formatSqlTimestamp,
  main,
  paceLookups,
  pageAfterCursor,
  parseRecoverArgs,
  parseRetryAfterMs,
  probeBulkStatuses,
  probeTxid,
  recoveryBackoffMs,
  recoveryProviderOptions,
  refuseUnconfirmedApply,
  renderApplySql,
  renderCandidateSql,
  resolveBulkStatuses,
  resolvePresence,
  selectCandidatePage,
  unminedShortcutApplies,
  txHashLookupPath,
  txLookupPath,
  type CandidateRow,
  type ProviderProbeResult,
  type RecoverCli,
  type RecoverCursor,
  type RecoveryIo,
  type TxLookupClient,
} from "../recover-lost-writes.js";

const FROM = new Date("2026-10-31T13:00:00.000Z");
const TO = new Date("2026-10-31T14:00:00.000Z");

function tx(n: number): string {
  return n.toString(16).padStart(2, "0").repeat(32);
}

function candidate(n: number, at: Date, status = "SEEN_ON_NETWORK"): CandidateRow {
  return { txid: tx(n), created_at: at, status };
}

function baseOptions(overrides: Partial<RecoverCli> = {}): RecoverCli {
  return {
    from: FROM,
    to: TO,
    statuses: ["SEEN_ON_NETWORK", "FAILED"],
    limit: null,
    pageSize: 2,
    apply: false,
    confirm: false,
    verifyProvider: "bitails",
    concurrency: 1,
    delayMs: 0,
    maxRequeue: 100_000,
    list: false,
    progressEvery: 1_000,
    unminedMissingAfterMin: null,
    ...overrides,
  };
}

function io(overrides: Partial<RecoveryIo> & { log?: (line: string) => void } = {}): RecoveryIo & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    loadPage: async () => [],
    lookup: async () => ({ kind: "found" }),
    requeue: async () => "requeued",
    sleep: async () => {},
    log: (line) => logs.push(line),
    listLine: () => {},
    ...overrides,
  };
}

describe("classification", () => {
  it("treats 404 as missing and any other failure as unverified or retryable", () => {
    expect(classifyHttpResponse(404, null)).toEqual({ kind: "not_found" });
    expect(classifyHttpResponse(200, null)).toEqual({ kind: "found" });
    expect(classifyHttpResponse(204, null)).toEqual({ kind: "found" });
    expect(classifyHttpResponse(401, null)).toEqual({ kind: "unverified", reason: "HTTP 401" });
    expect(classifyHttpResponse(429, "4")).toEqual({
      kind: "retryable",
      status: 429,
      retryAfterMs: 4_000,
    });
    expect(classifyHttpResponse(503, null)).toEqual({ kind: "retryable", status: 503 });
    expect(classifyHttpResponse(500, "not-a-delay")).toEqual({ kind: "retryable", status: 500 });
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-31T13:00:00.000Z");
    expect(parseRetryAfterMs("2.5", now)).toBe(2_500);
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 00:00:10 GMT", now)).toBe(0);
    expect(parseRetryAfterMs("Sat, 31 Oct 2026 13:00:05 GMT", now)).toBe(5_000);
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });

  it("maps provider errors without turning them into a 404", () => {
    expect(classifyLookupFailure(new WocRateLimitedError(1_500))).toEqual({
      kind: "retryable",
      status: 429,
      retryAfterMs: 1_500,
    });
    expect(classifyLookupFailure(new WocUnavailableError("bitails returned 503 for recover_lost_tx")))
      .toEqual({ kind: "retryable", status: 503 });
    expect(classifyLookupFailure(new WocUnavailableError("bitails returned 404 for recover_lost_tx")))
      .toEqual({ kind: "not_found" });
    expect(classifyLookupFailure(new WocUnavailableError("bitails returned 401 for recover_lost_tx")))
      .toEqual({ kind: "unverified", reason: "HTTP 401" });
    expect(classifyLookupFailure(new Error("boom"))).toEqual({ kind: "unverified", reason: "boom" });
    const reset = new Error("socket hang up");
    (reset as Error & { code: string }).code = "ECONNRESET";
    expect(classifyLookupFailure(reset)).toEqual({ kind: "retryable", status: 0 });
  });

  it("asks the existing /tx/{txid} route and treats a null body as not found", async () => {
    const calls: Array<{ path: string; allowNotFound?: boolean; label: string }> = [];
    const present: TxLookupClient = {
      async getJson<T>(
        path: string,
        options: { label: string; allowNotFound?: boolean },
      ): Promise<T | null> {
        calls.push({ path, label: options.label, allowNotFound: options.allowNotFound });
        return { txid: "present" } as T;
      },
    };
    const id = tx(4);
    await expect(probeTxid(present, id)).resolves.toEqual({ kind: "found" });
    expect(calls).toEqual([{
      path: txLookupPath(id),
      label: "recover_lost_tx",
      allowNotFound: true,
    }]);
    expect(txLookupPath(id)).toBe(`/tx/${id}`);
    expect(txHashLookupPath(id)).toBe(`/tx/hash/${id}`);

    const hashCalls: string[] = [];
    const hashClient: TxLookupClient = {
      async getJson<T>(path: string): Promise<T | null> {
        hashCalls.push(path);
        return null;
      },
    };
    await expect(probeTxid(hashClient, id, txHashLookupPath)).resolves.toEqual({ kind: "not_found" });
    expect(hashCalls).toEqual([`/tx/hash/${id}`]);

    await expect(probeTxid(lookupReturning(null), id)).resolves.toEqual({ kind: "not_found" });
    await expect(probeTxid(lookupReturning("nope"), id)).resolves.toEqual({
      kind: "unverified",
      reason: "provider returned an unexpected body",
    });
    let skipped = 0;
    const unused: TxLookupClient = {
      async getJson() {
        skipped += 1;
        return null;
      },
    };
    await expect(probeTxid(unused, "not-a-txid")).resolves.toMatchObject({ kind: "unverified" });
    expect(skipped).toBe(0);
  });
});

describe("rate-limit backoff", () => {
  it("waits at least the exponential delay and any Retry-After", () => {
    expect(recoveryBackoffMs(1)).toBe(RECOVERY_BACKOFF_BASE_MS);
    expect(recoveryBackoffMs(2)).toBe(2_000);
    expect(recoveryBackoffMs(3)).toBe(4_000);
    expect(recoveryBackoffMs(1, 5_000)).toBe(5_000);
    expect(recoveryBackoffMs(8)).toBe(RECOVERY_BACKOFF_MAX_MS);
  });

  it("retries 429 and 5xx, then records missing only after a real 404", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const presence = await resolvePresence(tx(1), async () => {
      calls += 1;
      if (calls === 1) return { kind: "retryable", status: 429, retryAfterMs: 5_000 };
      if (calls === 2) return { kind: "retryable", status: 503 };
      return { kind: "not_found" };
    }, {
      maxAttempts: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(presence).toEqual({ presence: "missing", retryExhausted: false });
    expect(sleeps).toEqual([recoveryBackoffMs(1, 5_000), recoveryBackoffMs(2)]);
  });

  it("never classifies an exhausted rate limit or a thrown error as missing", async () => {
    const sleeps: number[] = [];
    const limited = await resolvePresence(
      tx(1),
      async () => ({ kind: "retryable", status: 429, retryAfterMs: 50 }),
      {
        maxAttempts: 3,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(limited).toEqual({ presence: "unverified", retryExhausted: true });
    expect(sleeps).toEqual([recoveryBackoffMs(1, 50), recoveryBackoffMs(2, 50)]);

    let attempts = 0;
    const crashed = await resolvePresence(tx(1), async () => {
      attempts += 1;
      throw new Error("boom");
    }, { maxAttempts: 4, sleep: async () => {} });
    expect(crashed).toEqual({ presence: "unverified", retryExhausted: false });
    expect(attempts).toBe(1);

    const abort = new Error("timed out");
    abort.name = "AbortError";
    let networkCalls = 0;
    const recovered = await resolvePresence(tx(2), async () => {
      networkCalls += 1;
      if (networkCalls < 3) throw abort;
      return { kind: "found" };
    }, { maxAttempts: 5, sleep: async () => {} });
    expect(recovered).toEqual({ presence: "found", retryExhausted: false });
    expect(networkCalls).toBe(3);
  });

  it("stops the run when the provider keeps failing, and does not requeue those rows", async () => {
    const requeue = vi.fn(async () => "requeued" as const);
    const rows = Array.from({ length: RATE_LIMIT_ABORT_STREAK + 2 }, (_, index) =>
      candidate(index + 1, new Date(Date.UTC(2026, 9, 31, 13, index, 0))),
    );
    const harness = io({
      loadPage: async (cursor, pageSize) => pageAfterCursor(rows, cursor, pageSize),
      lookup: async () => ({ kind: "retryable", status: 429 }),
      requeue,
      sleep: async () => {},
    });
    await expect(executeRecovery(baseOptions({
      pageSize: rows.length,
      concurrency: 1,
    }), harness)).rejects.toThrow(/reject_requeues = 0/);
    expect(requeue).not.toHaveBeenCalled();
    const summaryLine = [...harness.logs].reverse().find((line) => line.startsWith("{"));
    expect(JSON.parse(summaryLine ?? "{}")).toMatchObject({
      candidates: RATE_LIMIT_ABORT_STREAK,
      unverified: RATE_LIMIT_ABORT_STREAK,
      missing: 0,
      requeued: 0,
    });
  });

  it("spaces lookup starts by the configured delay", async () => {
    let clock = 1_000;
    const gate = { next: 0 };
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    };
    await paceLookups(gate, 100, sleep, () => clock);
    await paceLookups(gate, 100, sleep, () => clock);
    await paceLookups(gate, 100, sleep, () => clock);
    expect(sleeps).toEqual([100, 100]);
  });
});

describe("pagination cursor", () => {
  it("walks created_at then txid without repeating the boundary row", () => {
    const shared = new Date("2026-10-31T13:10:00.000Z");
    const rows = [
      candidate(2, shared),
      candidate(1, shared),
      candidate(3, new Date("2026-10-31T13:11:00.000Z")),
    ];
    const first = pageAfterCursor(rows, null, 1);
    expect(first.map((row) => row.txid)).toEqual([tx(1)]);
    const cursor = { createdAt: shared, txid: tx(1) };
    expect(comparePosition(first[0]!, cursor)).toBe(0);
    expect(pageAfterCursor(rows, cursor, 2).map((row) => row.txid)).toEqual([tx(2), tx(3)]);
  });

  it("selects the window in keyset pages and skips rows that cannot be recovered", async () => {
    const shared = new Date("2026-10-31T13:10:00.000Z");
    const later = new Date("2026-10-31T13:11:00.000Z");
    const included = [
      candidateRow(tx(1), shared, "SEEN_ON_NETWORK", 0),
      candidateRow(tx(2), shared, "FAILED", 0),
      candidateRow(tx(3), later, "SEEN_ON_NETWORK", 0),
    ];
    const { db } = createMemoryDb({
      tx_results: [
        candidateRow(tx(9), new Date("2026-10-31T12:59:59.000Z"), "SEEN_ON_NETWORK", 0),
        ...included,
        candidateRow(tx(4), shared, "SEEN_ON_NETWORK", 1),
        candidateRow(tx(5), shared, "SEEN_ON_NETWORK", 0, null),
        candidateRow(tx(6), shared, "MINED", 0),
        candidateRow(tx(7), TO, "SEEN_ON_NETWORK", 0),
      ],
    });
    const query = {
      from: FROM,
      to: TO,
      statuses: ["SEEN_ON_NETWORK", "FAILED"] as const,
      cursor: null as RecoverCursor | null,
    };
    const page = await selectCandidatePage(db, query, 2);
    expect(page.map((row) => row.txid)).toEqual([tx(1), tx(2)]);
    const nextCursor = { createdAt: shared, txid: tx(2) };
    const rest = await selectCandidatePage(db, { ...query, cursor: nextCursor }, 10);
    expect(rest.map((row) => row.txid)).toEqual([tx(3)]);
    expect(pageAfterCursor(included, nextCursor, 10).map((row) => row.txid)).toEqual([tx(3)]);
  });
});

describe("sql and arguments", () => {
  const options = baseOptions();

  it("logs a read-only candidate query and describes the apply write separately", () => {
    const sql = renderCandidateSql({
      from: options.from,
      to: options.to,
      statuses: options.statuses,
      pageSize: options.pageSize,
      cursor: null,
    });
    expect(sql).toContain("op_return IS NOT NULL");
    expect(sql).toContain("reject_requeues = 0");
    expect(sql).toContain("SEEN_ON_NETWORK");
    expect(sql).toContain(formatSqlTimestamp(FROM));
    expect(sql).not.toMatch(/\b(DELETE|UPDATE|INSERT)\b/);
    const withCursor = renderCandidateSql({
      from: options.from,
      to: options.to,
      statuses: options.statuses,
      pageSize: 2,
      cursor: { createdAt: FROM, txid: tx(1) },
    });
    expect(withCursor).toContain(`'${tx(1)}'`);
    expect(renderApplySql()).toContain("preserved");
    expect(renderApplySql()).toContain("UPDATE tx_results SET reject_requeues = 1");
    expect(renderApplySql()).not.toMatch(/DELETE FROM/);
    expect(() => renderCandidateSql({
      from: FROM,
      to: TO,
      statuses: ["SEEN; DROP"],
      pageSize: 1,
      cursor: null,
    })).toThrow(/Unsafe status/);
  });

  it("parses the operator flags and refuses an unconfirmed apply", () => {
    const parsed = parseRecoverArgs([
      "--from", "2026-10-31T13:00:00Z",
      "--to", "2026-10-31T14:00:00Z",
    ]);
    expect(parsed.kind).toBe("options");
    if (parsed.kind !== "options") return;
    expect(parsed.options.apply).toBe(false);
    expect(parsed.options.confirm).toBe(false);
    expect(parsed.options.verifyProvider).toBe("woc-bulk");
    expect(parsed.options.unminedMissingAfterMin).toBeNull();
    expect(parsed.options.statuses).toEqual(["SEEN_ON_NETWORK", "FAILED"]);
    expect(parsed.options.concurrency).toBe(2);
    expect(parsed.options.delayMs).toBe(0);
    expect(parsed.options.maxRequeue).toBe(100_000);
    expect(parsed.options.limit).toBeNull();

    const aged = parseRecoverArgs([
      "--from", "2026-10-31T12:45:00Z",
      "--to", "2026-10-31T13:57:00Z",
      "--unmined-missing-after-min", "90",
    ]);
    expect(aged.kind).toBe("options");
    if (aged.kind === "options") expect(aged.options.unminedMissingAfterMin).toBe(90);
    expect(() => parseRecoverArgs([
      "--from", "2026-10-31T12:45:00Z",
      "--to", "2026-10-31T13:57:00Z",
      "--unmined-missing-after-min", "-1",
    ])).toThrow(/unmined-missing-after-min/);

    expect(() => parseRecoverArgs(["--to", "2026-10-31T14:00:00Z"])).toThrow(/--from is required/);
    expect(() => parseRecoverArgs([
      "--from", "2026-10-31T13:00:00",
      "--to", "2026-10-31T14:00:00Z",
    ])).toThrow(/Z or a numeric offset/);
    expect(() => parseRecoverArgs([
      "--from", "2026-10-31T14:00:00Z",
      "--to", "2026-10-31T13:00:00Z",
    ])).toThrow(/earlier than --to/);
    expect(() => parseRecoverArgs([
      "--from", "2026-10-31T13:00:00Z",
      "--to", "2026-10-31T14:00:00Z",
      "--verify-provider", "arcade",
    ])).toThrow(/woc-bulk, bitails, or woc/);
    expect(parseRecoverArgs(["--help"])).toMatchObject({ kind: "help" });
    expect(() => refuseUnconfirmedApply(true, false)).toThrow(/Refusing --apply without --confirm/);
    expect(() => refuseUnconfirmedApply(true, true)).not.toThrow();
  });

  it("uses the Bitails and WhatsOnChain clients the writer already configures", () => {
    expect(recoveryProviderOptions("bitails", {})).toMatchObject({
      name: "bitails",
      baseUrl: "https://api.bitails.io",
      apiKeyHeader: "apikey",
      maxRequestsPerSecond: 8,
      maxConcurrent: 2,
    });
    expect(recoveryProviderOptions("woc", { WOC_API_URL: "https://api.whatsonchain.com/v1/bsv/main" }))
      .toMatchObject({
        name: "whatsonchain",
        baseUrl: "https://api.whatsonchain.com/v1/bsv/main",
        maxRequestsPerSecond: 3,
        maxConcurrent: 2,
      });
    expect(recoveryProviderOptions("woc-bulk", {})).toMatchObject({
      name: "whatsonchain",
      baseUrl: "https://api.whatsonchain.com/v1/bsv/main",
      maxRequestsPerSecond: 3,
      maxConcurrent: 2,
    });
    expect(recoveryProviderOptions("bitails", {
      BITAILS_API_URL: "https://api.bitails.io/",
      BITAILS_API_KEY: "secret",
      BITAILS_MAX_RPS: "4",
    })).toMatchObject({
      baseUrl: "https://api.bitails.io/",
      apiKey: "secret",
      maxRequestsPerSecond: 4,
    });
  });

  it("lets a Docker secret file replace the environment, as the entrypoint does", () => {
    const env: NodeJS.ProcessEnv = {
      POSTGRES_PASSWORD: "stale",
      POSTGRES_PASSWORD_FILE: "/run/secrets/postgres_password",
    };
    applyFileSecrets(env, () => "from-file\n");
    expect(env.POSTGRES_PASSWORD).toBe("from-file");
    expect(env.POSTGRES_PASSWORD_FILE).toBeUndefined();
    expect(() => applyFileSecrets(
      { BITAILS_API_KEY_FILE: "/missing" },
      () => "",
    )).toThrow(/empty/);
    expect(() => applyFileSecrets(
      { BITAILS_API_KEY_FILE: "/missing" },
      () => {
        throw new Error("ENOENT");
      },
    )).toThrow(/ENOENT/);
  });
});

describe("dry-run and apply", () => {
  const rows = [
    candidate(1, new Date("2026-10-31T13:01:00.000Z")),
    candidate(2, new Date("2026-10-31T13:02:00.000Z")),
    candidate(3, new Date("2026-10-31T13:03:00.000Z"), "FAILED"),
    candidate(4, new Date("2026-10-31T13:04:00.000Z")),
    candidate(5, new Date("2026-10-31T13:05:00.000Z")),
  ];

  function lookupFor(flaky: string): (txid: string) => Promise<ProviderProbeResult> {
    const seen = new Map<string, number>();
    return async (txid) => {
      const attempt = (seen.get(txid) ?? 0) + 1;
      seen.set(txid, attempt);
      if (txid === tx(1)) return { kind: "found" };
      if (txid === tx(2)) return { kind: "not_found" };
      if (txid === flaky) {
        if (attempt === 1) return { kind: "retryable", status: 429, retryAfterMs: 5_000 };
        return { kind: "not_found" };
      }
      if (txid === tx(4)) return { kind: "unverified", reason: "HTTP 401" };
      throw new Error("boom");
    };
  }

  it("reports missing txids and does not requeue them on a dry run", async () => {
    const requeue = vi.fn(async () => "requeued" as const);
    const listed: string[] = [];
    const sleeps: number[] = [];
    const harness = io({
      loadPage: async (cursor, pageSize) => pageAfterCursor(rows, cursor, pageSize),
      lookup: lookupFor(tx(3)),
      requeue,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      listLine: (line) => listed.push(line),
    });
    const summary = await executeRecovery(baseOptions({
      list: true,
      progressEvery: 2,
      pageSize: 2,
    }), harness);
    expect(requeue).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      mode: "dry-run",
      candidates: 5,
      found: 1,
      missing: 2,
      unverified: 2,
      requeued: 0,
      capped: false,
    });
    expect(listed.map((line) => JSON.parse(line).txid)).toEqual([tx(2), tx(3)]);
    expect(sleeps).toEqual([5_000]);
    expect(harness.logs.some((line) => line.includes("mode: dry-run"))).toBe(true);
    expect(harness.logs.some((line) => line.includes("op_return IS NOT NULL"))).toBe(true);
    expect(harness.logs.some((line) => line.includes("apply-sql: not executed"))).toBe(true);
    expect(harness.logs.filter((line) => line.startsWith("progress "))).toHaveLength(2);
    expect(exitCodeFor(summary)).toBe(0);
  });

  it("requeues only missing txids when apply is set, and stops at the cap", async () => {
    const requeue = vi.fn(async () => "requeued" as const);
    const summary = await executeRecovery(baseOptions({
      apply: true,
      confirm: true,
      concurrency: 2,
      pageSize: 10,
      maxRequeue: 1,
    }), io({
      loadPage: async () => rows.filter((row) => row.txid === tx(2) || row.txid === tx(3) || row.txid === tx(5)),
      lookup: async () => ({ kind: "not_found" }),
      requeue,
    }));
    expect(requeue).toHaveBeenCalledTimes(1);
    expect(summary.requeued).toBe(1);
    expect(summary.missing).toBe(3);
    expect(summary.skippedOverCap).toBe(2);
    expect(summary.capped).toBe(true);
    expect(summary.found).toBe(0);
    expect(summary.unverified).toBe(0);
  });

  it("counts a failed requeue and does not keep the cap slot", async () => {
    const summary = await executeRecovery(baseOptions({
      apply: true,
      confirm: true,
      pageSize: 10,
      maxRequeue: 1,
    }), io({
      loadPage: async () => [candidate(2, FROM), candidate(3, new Date("2026-10-31T13:02:00.000Z"))],
      lookup: async () => ({ kind: "not_found" }),
      requeue: async (txid) => {
        if (txid === tx(2)) return "skipped_no_claim";
        return "failed";
      },
    }));
    expect(summary).toMatchObject({
      missing: 2,
      requeued: 0,
      skippedAlreadyClaimed: 1,
      failed: 1,
      capped: false,
      skippedOverCap: 0,
    });
    expect(exitCodeFor(summary)).toBe(1);
  });
});

describe("idempotent claim", () => {
  const txid = "aa".repeat(32);

  function envelope(): Buffer {
    const telemetry = mockTelemetry();
    const payload = encodeTelemetryPayload(telemetry);
    return Buffer.from(buildOpReturnPayload(
      telemetry.icao,
      telemetry.ts,
      CodecRecordType.TELEMETRY,
      payload,
    ));
  }

  it("inserts one preserved pending write and a second claim does not insert another", async () => {
    const opReturn = envelope();
    const { db, table } = createMemoryDb({
      tx_results: [{
        txid,
        aircraft_icao: "ABCDEF",
        record_type: RecordType.TELEMETRY,
        flight_id: "flight-1",
        op_return: opReturn,
        reject_requeues: 0,
        status: "SEEN_ON_NETWORK",
        created_at: new Date("2026-10-31T13:12:00.000Z"),
        reject_status: null,
        reject_reason: null,
        reject_competing_txs: null,
      }],
      pending_writes: [],
    });

    const run = () => executeRecovery(baseOptions({
      apply: true,
      confirm: true,
      pageSize: 10,
    }), io({
      loadPage: (cursor, pageSize) => selectCandidatePage(db, {
        from: FROM,
        to: TO,
        statuses: ["SEEN_ON_NETWORK", "FAILED"],
        cursor,
      }, pageSize),
      lookup: async () => ({ kind: "not_found" }),
      requeue: (id) => rebufferRejectedTransaction(id, {
        db,
        maxRequeues: RECOVERY_MAX_REQUEUES,
      }),
    }));

    const first = await run();
    expect(first).toMatchObject({ candidates: 1, missing: 1, requeued: 1, failed: 0 });
    expect(table("pending_writes")).toHaveLength(1);
    expect(table("pending_writes")[0]).toMatchObject({
      aircraft_icao: "ABCDEF",
      record_type: RecordType.TELEMETRY,
      flight_id: "flight-1",
      preserved: true,
    });
    expect(table("tx_results")).toHaveLength(1);
    expect(table("tx_results")[0]).toMatchObject({
      status: "SEEN_ON_NETWORK",
      reject_requeues: 1,
      op_return: opReturn,
    });

    const second = await run();
    expect(second.candidates).toBe(0);
    expect(second.requeued).toBe(0);
    expect(table("pending_writes")).toHaveLength(1);

    await expect(rebufferRejectedTransaction(txid, {
      db,
      maxRequeues: RECOVERY_MAX_REQUEUES,
    })).resolves.toBe("skipped_no_claim");
    expect(table("pending_writes")).toHaveLength(1);
    expect(table("tx_results")).toHaveLength(1);
  });
});

describe("woc-bulk", () => {
  it("treats only a block-height hit as confirmed", () => {
    expect(classifyBulkHit(true)).toBe("found");
    expect(classifyBulkHit(false)).toBe("ambiguous");
  });

  it("keeps a null or failed bulk response unverified, never missing", async () => {
    const mined = tx(1);
    const answered = await probeBulkStatuses({
      async fetchTxStatuses() {
        return new Map([[mined, { txid: mined, blockHeight: 800_000, confirmations: 2 }]]);
      },
    }, [mined, tx(2)]);
    expect(answered).toEqual({ kind: "answered", confirmed: new Set([mined]) });

    const silent = await probeBulkStatuses({
      async fetchTxStatuses() {
        return null;
      },
    }, [mined]);
    expect(silent).toMatchObject({ kind: "unavailable", retryable: true });

    const missingEndpoint = await probeBulkStatuses({
      async fetchTxStatuses() {
        throw new WocUnavailableError("whatsonchain returned 404 for txs_status");
      },
    }, [mined]);
    expect(missingEndpoint).toEqual({
      kind: "unavailable",
      retryable: false,
      reason: "bulk status endpoint returned 404",
    });
  });

  it("retries a bulk outage and then keeps the confirmed set", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const mined = tx(3);
    const resolved = await resolveBulkStatuses([mined], async () => {
      calls += 1;
      if (calls < 3) return { kind: "unavailable", retryable: true, reason: "bulk status returned no body" };
      return { kind: "answered", confirmed: new Set([mined]) };
    }, {
      maxAttempts: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(resolved).toEqual({ ok: true, confirmed: new Set([mined]) });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([recoveryBackoffMs(1), recoveryBackoffMs(2)]);
  });

  it("confirms map hits, and only a follow-up 404 is missing", async () => {
    const confirmed = tx(1);
    const mempool = tx(2);
    const absent = tx(3);
    const rows = [confirmed, mempool, absent].map((id, index) => ({
      txid: id,
      created_at: new Date(Date.UTC(2026, 9, 31, 13, index, 0)),
      status: "SEEN_ON_NETWORK",
    }));
    const lookedUp: string[] = [];
    const requeue = vi.fn(async () => "requeued" as const);
    const harness = io({
      loadPage: async (cursor, pageSize) => pageAfterCursor(rows, cursor, pageSize),
      lookupBulk: async () => ({ kind: "answered", confirmed: new Set([confirmed]) }),
      lookup: async (txid) => {
        lookedUp.push(txid);
        return txid === absent ? { kind: "not_found" } : { kind: "found" };
      },
      requeue,
    });
    const summary = await executeRecovery(baseOptions({
      verifyProvider: "woc-bulk",
      apply: true,
      confirm: true,
      pageSize: rows.length,
    }), harness);
    expect(lookedUp.sort()).toEqual([mempool, absent].sort());
    expect(requeue).toHaveBeenCalledTimes(1);
    expect(requeue).toHaveBeenCalledWith(absent);
    expect(summary).toMatchObject({
      candidates: 3,
      found: 2,
      missing: 1,
      unverified: 0,
      requeued: 1,
    });
    expect(harness.logs.some((line) => line.includes("GET /tx/hash/{txid}"))).toBe(true);
  });

  it("does not follow up or requeue when the bulk request itself fails", async () => {
    const rows = Array.from({ length: WOC_BULK_LIMIT }, (_, index) =>
      candidate(index + 1, new Date(Date.UTC(2026, 9, 31, 13, 0, index))),
    );
    const lookup = vi.fn(async () => ({ kind: "not_found" }) as ProviderProbeResult);
    const requeue = vi.fn(async () => "requeued" as const);
    let bulkCalls = 0;
    const harness = io({
      loadPage: async (cursor, pageSize) => pageAfterCursor(rows, cursor, pageSize),
      lookupBulk: async (txids) => {
        bulkCalls += 1;
        expect(txids).toHaveLength(WOC_BULK_LIMIT);
        return { kind: "unavailable", retryable: false, reason: "bulk status HTTP 401" };
      },
      lookup,
      requeue,
    });
    const summary = await executeRecovery(baseOptions({
      verifyProvider: "woc-bulk",
      apply: true,
      confirm: true,
      pageSize: rows.length,
    }), harness);
    expect(bulkCalls).toBe(1);
    expect(lookup).not.toHaveBeenCalled();
    expect(requeue).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      candidates: WOC_BULK_LIMIT,
      unverified: WOC_BULK_LIMIT,
      missing: 0,
      requeued: 0,
    });
  });

  it("sends at most one bulk batch per request and stops after eight failed batches", async () => {
    const rows = Array.from({ length: WOC_BULK_LIMIT + 1 }, (_, index) =>
      candidate(index + 1, new Date(Date.UTC(2026, 9, 31, 12, 45, index))),
    );
    const sizes: number[] = [];
    const sized = io({
      loadPage: async (cursor, pageSize) => pageAfterCursor(rows, cursor, pageSize),
      lookupBulk: async (txids) => {
        sizes.push(txids.length);
        return { kind: "answered", confirmed: new Set(txids) };
      },
    });
    await executeRecovery(baseOptions({
      verifyProvider: "woc-bulk",
      pageSize: rows.length,
    }), sized);
    expect(sizes).toEqual([WOC_BULK_LIMIT, 1]);

    const failing = Array.from({ length: RATE_LIMIT_ABORT_STREAK + 2 }, (_, index) =>
      candidate(index + 1, new Date(Date.UTC(2026, 9, 31, 12, 50, index))),
    );
    let batches = 0;
    const requeue = vi.fn(async () => "requeued" as const);
    const harness = io({
      loadPage: async (cursor, pageSize) => pageAfterCursor(failing, cursor, pageSize),
      lookupBulk: async () => {
        batches += 1;
        return { kind: "unavailable", retryable: true, reason: "bulk status returned no body" };
      },
      lookup: async () => ({ kind: "not_found" }),
      requeue,
    });
    await expect(executeRecovery(baseOptions({
      verifyProvider: "woc-bulk",
      pageSize: 1,
      apply: true,
      confirm: true,
    }), harness)).rejects.toThrow(/reject_requeues = 0/);
    expect(batches).toBe(RATE_LIMIT_ABORT_STREAK * RECOVERY_MAX_LOOKUP_ATTEMPTS);
    expect(requeue).not.toHaveBeenCalled();
    const summaryLine = [...harness.logs].reverse().find((line) => line.startsWith("{"));
    expect(JSON.parse(summaryLine ?? "{}")).toMatchObject({
      candidates: RATE_LIMIT_ABORT_STREAK,
      unverified: RATE_LIMIT_ABORT_STREAK,
      missing: 0,
      requeued: 0,
    });
  });

  it("stops after eight exhausted follow-up requests", async () => {
    const rows = Array.from({ length: RATE_LIMIT_ABORT_STREAK + 2 }, (_, index) =>
      candidate(index + 1, new Date(Date.UTC(2026, 9, 31, 13, 10, index))),
    );
    let lookups = 0;
    const harness = io({
      loadPage: async (cursor, pageSize) => pageAfterCursor(rows, cursor, pageSize),
      lookupBulk: async () => ({ kind: "answered", confirmed: new Set<string>() }),
      lookup: async () => {
        lookups += 1;
        return { kind: "retryable", status: 429 };
      },
    });
    await expect(executeRecovery(baseOptions({
      verifyProvider: "woc-bulk",
      pageSize: rows.length,
      concurrency: 1,
    }), harness)).rejects.toThrow(/reject_requeues = 0/);
    expect(lookups).toBe(RATE_LIMIT_ABORT_STREAK * 5);
    const summaryLine = [...harness.logs].reverse().find((line) => line.startsWith("{"));
    expect(JSON.parse(summaryLine ?? "{}")).toMatchObject({
      candidates: RATE_LIMIT_ABORT_STREAK,
      unverified: RATE_LIMIT_ABORT_STREAK,
      missing: 0,
    });
  });

  it("marks an old unmined id as missing only after a successful bulk response", async () => {
    const startedAt = new Date("2026-10-31T15:30:00.000Z");
    expect(unminedShortcutApplies(new Date("2026-10-31T13:59:59.999Z"), startedAt, 90)).toBe(true);
    expect(unminedShortcutApplies(new Date("2026-10-31T14:00:00.000Z"), startedAt, 90)).toBe(false);
    expect(unminedShortcutApplies(new Date("2026-10-31T13:00:00.000Z"), startedAt, null)).toBe(false);

    const confirmedOld = tx(1);
    const absentOld = tx(2);
    const absentExact = tx(3);
    const absentNew = tx(4);
    const rows: CandidateRow[] = [
      { txid: confirmedOld, created_at: new Date("2026-10-31T12:50:00.000Z"), status: "SEEN_ON_NETWORK" },
      { txid: absentOld, created_at: new Date("2026-10-31T13:00:00.000Z"), status: "SEEN_ON_NETWORK" },
      { txid: absentExact, created_at: new Date("2026-10-31T14:00:00.000Z"), status: "SEEN_ON_NETWORK" },
      { txid: absentNew, created_at: new Date("2026-10-31T15:00:00.000Z"), status: "SEEN_ON_NETWORK" },
    ];
    const lookedUp: string[] = [];
    const requeuedIds: string[] = [];
    const requeue = vi.fn(async (txid: string) => {
      requeuedIds.push(txid);
      return "requeued" as const;
    });
    const harness = io({
      startedAt,
      loadPage: async (cursor, pageSize) => pageAfterCursor(rows, cursor, pageSize),
      lookupBulk: async () => ({ kind: "answered", confirmed: new Set([confirmedOld]) }),
      lookup: async (txid) => {
        lookedUp.push(txid);
        return { kind: "not_found" };
      },
      requeue,
    });
    const summary = await executeRecovery(baseOptions({
      verifyProvider: "woc-bulk",
      apply: true,
      confirm: true,
      pageSize: rows.length,
      unminedMissingAfterMin: 90,
    }), harness);
    expect(lookedUp.sort()).toEqual([absentExact, absentNew].sort());
    expect(requeuedIds.sort()).toEqual([absentOld, absentExact, absentNew].sort());
    expect(summary).toMatchObject({
      candidates: 4,
      found: 1,
      missing: 3,
      unverified: 0,
      requeued: 3,
      missingByUnminedAge: 1,
    });
    expect(harness.logs.some((line) => line.includes("missing-by-unmined-age=1"))).toBe(true);

    const failedLookup = vi.fn(async (): Promise<ProviderProbeResult> => ({ kind: "not_found" }));
    const failed = io({
      startedAt,
      loadPage: async (cursor) => (cursor ? [] : [rows[1]!]),
      lookupBulk: async () => ({
        kind: "unavailable",
        retryable: false,
        reason: "bulk status returned no body",
      }),
      lookup: failedLookup,
    });
    const failedSummary = await executeRecovery(baseOptions({
      verifyProvider: "woc-bulk",
      pageSize: 1,
      unminedMissingAfterMin: 90,
    }), failed);
    expect(failedLookup).not.toHaveBeenCalled();
    expect(failedSummary).toMatchObject({
      candidates: 1,
      missing: 0,
      unverified: 1,
      missingByUnminedAge: 0,
    });

    const unsetLookup = vi.fn(async (): Promise<ProviderProbeResult> => ({ kind: "found" }));
    const unset = io({
      startedAt,
      loadPage: async (cursor) => (cursor ? [] : [rows[1]!]),
      lookupBulk: async () => ({ kind: "answered", confirmed: new Set<string>() }),
      lookup: unsetLookup,
    });
    const unsetSummary = await executeRecovery(baseOptions({
      verifyProvider: "woc-bulk",
      pageSize: 1,
    }), unset);
    expect(unsetLookup).toHaveBeenCalledTimes(1);
    expect(unsetSummary).toMatchObject({ found: 1, missing: 0, missingByUnminedAge: 0 });
  });
});

describe("cli gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not open a database for help, bad arguments, or an unconfirmed apply", async () => {
    const run = vi.fn(async () => 0);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(main(["--help"], { run })).resolves.toBe(0);
    await expect(main(["--from", "2026-10-31T13:00:00Z"], { run })).resolves.toBe(1);
    await expect(main([
      "--from", "2026-10-31T13:00:00Z",
      "--to", "2026-10-31T14:00:00Z",
      "--apply",
    ], { run })).resolves.toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("passes a dry run through and an apply only when confirm is present", async () => {
    const seen: RecoverCli[] = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await main([
      "--from", "2026-10-31T13:00:00Z",
      "--to", "2026-10-31T14:00:00Z",
      "--verify-provider", "woc",
      "--limit", "10",
    ], {
      run: async (options) => {
        seen.push(options);
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(seen[0]).toMatchObject({ apply: false, confirm: false, verifyProvider: "woc", limit: 10 });

    const applied = await main([
      "--from=2026-10-31T13:00:00Z",
      "--to=2026-10-31T14:00:00Z",
      "--apply",
      "--confirm",
      "--max-requeue", "25",
    ], {
      run: async (options) => {
        seen.push(options);
        return 0;
      },
    });
    expect(applied).toBe(0);
    expect(seen[1]).toMatchObject({ apply: true, confirm: true, maxRequeue: 25 });
  });
});

function lookupReturning(body: unknown): TxLookupClient {
  return {
    async getJson<T>(): Promise<T | null> {
      return body as T | null;
    },
  };
}

function candidateRow(
  txid: string,
  createdAt: Date,
  status: string,
  rejectRequeues: number,
  opReturn: Buffer | null = Buffer.from([1]),
) {
  return {
    txid,
    created_at: createdAt,
    status,
    reject_requeues: rejectRequeues,
    op_return: opReturn,
  };
}

function mockTelemetry(): TelemetryRecord {
  return {
    icao: "ABCDEF",
    callsign: "TEST01",
    reg: "G-TEST",
    squawk: "1234",
    aircraft_type: "A35K",
    category: "",
    ts: 1_704_067_200_000,
    ts_pos: 1_704_067_200_000,
    lat: 51.47,
    lon: -0.46,
    alt_baro: 32_000,
    alt_geom: 32_000,
    on_ground: false,
    gs: 450,
    ias: 280,
    tas: 470,
    mach: 0.78,
    track: 90,
    true_heading: 92,
    mag_heading: 90,
    baro_rate: 0,
    geom_rate: 0,
    roll: 0,
    wind_dir: 270,
    wind_speed: 40,
    oat: -45,
    tat: -12,
    nav_qnh: 1013,
    nav_alt_mcp: 32_000,
    nav_alt_fms: 32_000,
    nav_heading: 90,
    nav_modes: ["LNAV", "VNAV"],
    nic: 8,
    rc: 0,
    adsb_version: 2,
    position_source: 1,
    num_receivers: 3,
    emergency: "none",
    data_sources: ["adsbfi"],
    seq: 1,
  };
}
