import type { Knex } from "knex";
import { RecordType } from "@airchive/types";
import { parseOpReturnPayload } from "@airchive/telemetry-codec";
import { claimRejectRequeue, insertPendingWrite } from "@airchive/db";
import { createLogger } from "@airchive/logger";
import type { TerminalRejectionContext } from "./broadcaster.js";

const log = createLogger({ service: "blockchain-writer:rebuffer" });

/** Cap per txid so a permanently unmineable payload cannot loop forever. */
export const MAX_REJECT_REQUEUES = 3;

export type RebufferOutcome =
  | "requeued"
  | "skipped_no_claim"
  | "skipped_unparseable"
  | "failed";

export interface RebufferDeps {
  db: Knex;
  /** Called after a pending row is inserted so gauges stay honest. */
  onQueued?: () => void | Promise<void>;
  maxRequeues?: number;
  /** Live rejection diagnosis from SSE/poller; falls back to stored columns. */
  rejection?: TerminalRejectionContext;
}

/**
 * Re-queues the AIRCHIVE envelope from a terminally rejected transaction as a
 * fresh pending write. The rejected txid itself is never resubmitted — retry
 * builds a new transaction against a live UTXO.
 *
 * Rows are inserted as `preserved` so recovery coalescing cannot collapse the
 * sample away before it is drained.
 */
export async function rebufferRejectedTransaction(
  txid: string,
  deps: RebufferDeps,
): Promise<RebufferOutcome> {
  const maxRequeues = deps.maxRequeues ?? MAX_REJECT_REQUEUES;

  let claim;
  try {
    claim = await claimRejectRequeue(deps.db, txid, maxRequeues);
  } catch (err) {
    log.error({ err, txid: txid.slice(0, 12) }, "Failed to claim reject-requeue slot");
    return "failed";
  }

  if (!claim) {
    log.info(
      {
        txid: txid.slice(0, 12),
        ...rejectionLogFields(deps.rejection),
      },
      "Reject requeue skipped — no envelope, already mined, or requeue ceiling reached",
    );
    return "skipped_no_claim";
  }

  let parsed;
  try {
    parsed = parseOpReturnPayload(new Uint8Array(claim.op_return));
  } catch (err) {
    log.error(
      {
        err,
        txid: txid.slice(0, 12),
        requeues: claim.reject_requeues,
        ...rejectionLogFields(deps.rejection, claim),
      },
      "Reject requeue skipped — stored OP_RETURN could not be parsed",
    );
    return "skipped_unparseable";
  }

  const recordType = Number.isFinite(parsed.recordType)
    ? parsed.recordType
    : claim.record_type;
  if (!isRebufferableRecordType(recordType)) {
    log.warn(
      {
        txid: txid.slice(0, 12),
        recordType,
        ...rejectionLogFields(deps.rejection, claim),
      },
      "Reject requeue skipped — unsupported record type",
    );
    return "skipped_unparseable";
  }

  const icao = (parsed.icao || claim.aircraft_icao).trim().toUpperCase();
  try {
    await insertPendingWrite(deps.db, {
      aircraft_icao: icao,
      record_type: recordType as RecordType,
      payload: Buffer.from(parsed.payload),
      flight_id: claim.flight_id ?? undefined,
      // Preserve so ordinary telemetry coalescing cannot delete this sample
      // while the fleet is still draining a recovery backlog.
      preserved: true,
    });
    await deps.onQueued?.();
    const diagnosis = rejectionLogFields(deps.rejection, claim);
    log.warn(
      {
        txid: txid.slice(0, 12),
        icao,
        recordType,
        requeues: claim.reject_requeues,
        maxRequeues,
        ...diagnosis,
      },
      "Re-queued rejected transaction payload for a fresh broadcast",
    );
    return "requeued";
  } catch (err) {
    log.error(
      {
        err,
        txid: txid.slice(0, 12),
        icao,
        ...rejectionLogFields(deps.rejection, claim),
      },
      "Failed to insert pending write for rejected transaction",
    );
    return "failed";
  }
}

function isRebufferableRecordType(recordType: number): boolean {
  return (
    recordType === RecordType.TELEMETRY
    || recordType === RecordType.FLIGHT_EVENT
    || recordType === RecordType.TELEMETRY_DELTA
    || recordType === RecordType.AGENT_ANALYSIS
    || recordType === RecordType.AGENT_MONITOR
  );
}

function rejectionLogFields(
  live?: TerminalRejectionContext,
  stored?: {
    reject_status?: string | null;
    reject_reason?: string | null;
    reject_competing_txs?: string[] | null;
  },
): Record<string, unknown> {
  const rejectStatus = live?.status ?? stored?.reject_status ?? undefined;
  const reason = live?.reason ?? stored?.reject_reason ?? undefined;
  const competingTxs = live?.competingTxs ?? stored?.reject_competing_txs ?? undefined;
  const source = live?.source;

  return {
    rejectStatus: rejectStatus || undefined,
    reason: reason || "(upstream gave no reason)",
    competingTxs: competingTxs?.length ? competingTxs : undefined,
    upstreamSnippet: live?.upstreamSnippet || undefined,
    source: source || undefined,
  };
}
