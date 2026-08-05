/**
 * Pulls a usable reject diagnosis out of Arcade/ARC status payloads.
 *
 * Field names and nesting vary by upstream version: some omit `extraInfo`
 * entirely on later GET /tx polls even when the status is REJECTED, others
 * nest competing txids, and some put the human text in `title`/`detail`.
 *
 * Important: Arcade forgets rejected txids quickly. A later poll may return
 * only `{"error":"transaction not found"}` — that is not itself a REJECTED
 * verdict and must not be coerced into one.
 */

const REASON_KEYS = [
  "extraInfo",
  "extra_info",
  "detail",
  "title",
  "message",
  "reason",
  "rejectReason",
  "reject_reason",
  "description",
  "error",
] as const;

export interface ArcadeRejectDiagnosis {
  status: string;
  reason?: string;
  competingTxs?: string[];
  /** Truncated JSON of the upstream body — only when reason could not be found. */
  upstreamSnippet?: string;
  /** True when Arcade no longer has any record of the txid. */
  notFound?: boolean;
}

export function isArcadeTxNotFound(body: unknown): boolean {
  const record = asRecord(body);
  if (!record) return false;
  const error = firstString(record.error, record.message, record.detail, record.title);
  return /transaction not found/i.test(error);
}

export function extractArcadeRejectDiagnosis(
  body: unknown,
  fallbackStatus = "",
): ArcadeRejectDiagnosis {
  const record = asRecord(body);
  const notFound = isArcadeTxNotFound(body);

  // Never invent REJECTED from an empty/not-found body. Callers pass the
  // already-parsed txStatus when they have one.
  const status = firstString(
    record?.txStatus,
    record?.tx_status,
    typeof record?.status === "string" ? record.status : undefined,
    fallbackStatus,
  ).toUpperCase();

  const reason = firstString(
    ...REASON_KEYS.map((key) => record?.[key]),
    ...REASON_KEYS.map((key) => asRecord(record?.error)?.[key]),
    ...REASON_KEYS.map((key) => asRecord(record?.data)?.[key]),
  ) || undefined;

  const competingTxs = flattenCompetingTxs(
    record?.competingTxs ?? record?.competing_txs,
  );

  const diagnosis: ArcadeRejectDiagnosis = {
    status,
    reason,
    competingTxs: competingTxs.length > 0 ? competingTxs : undefined,
    notFound: notFound || undefined,
  };

  if (!diagnosis.reason && record) {
    const snippet = safeJsonSnippet(record);
    if (snippet) diagnosis.upstreamSnippet = snippet;
  }

  return diagnosis;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      // Numeric HTTP status codes as strings are not human reasons.
      if (trimmed && !/^\d{3}$/.test(trimmed)) return trimmed;
    }
  }
  return "";
}

function flattenCompetingTxs(value: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      const trimmed = node.trim().toLowerCase();
      if (trimmed) out.push(trimmed);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
    }
  };
  visit(value);
  return out.slice(0, 20);
}

function safeJsonSnippet(value: Record<string, unknown>): string | undefined {
  try {
    const json = JSON.stringify(value);
    if (!json || json === "{}") return undefined;
    return json.length > 800 ? `${json.slice(0, 800)}…` : json;
  } catch {
    return undefined;
  }
}
