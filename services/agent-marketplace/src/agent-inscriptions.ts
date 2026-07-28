import type { Knex } from "knex";
import { insertTxResult } from "@airchive/db";
import { RecordType } from "@airchive/types";
import {
  buildOpReturnPayload,
  buildOpReturnScript,
  encodeAgentPayload,
  FLEET_PSEUDO_ICAO,
} from "@airchive/telemetry-codec";
import { createLogger } from "@airchive/logger";
import { agentInscriptionsTotal } from "./metrics.js";

const log = createLogger({ service: "agent-inscriptions" });

export interface InscriptionSink {
  inscribeScript(
    fromLabel: string,
    scriptBytes: number[],
  ): Promise<{ txid: string; feeSats: number; sizeBytes: number }>;
}

export interface InscriptionResult {
  txid: string;
  feeSats: number;
  sizeBytes: number;
}

/**
 * Writes an agent record in the same OP_RETURN format as aircraft telemetry.
 *
 * Agent output was previously raw JSON in a single push, which the AIRCHIVE
 * parser could not read, so it never reached `tx_results` and never appeared in
 * the explorer. Using the house header and MessagePack puts agent output in the
 * same audit trail as everything else.
 */
export async function inscribeAgentRecord(params: {
  db: Knex;
  sink: InscriptionSink | null;
  agentLabel: string;
  recordType: RecordType.AGENT_ANALYSIS | RecordType.AGENT_MONITOR;
  record: Record<string, unknown>;
  icao?: string;
}): Promise<InscriptionResult | null> {
  const { db, sink, agentLabel, recordType, record } = params;
  const icao = params.icao ?? FLEET_PSEUDO_ICAO;

  if (!sink) {
    agentInscriptionsTotal.inc({ agent: agentLabel, outcome: "no_sink" });
    log.warn(
      { agent: agentLabel },
      "No inscription channel configured — agent record not written on-chain",
    );
    return null;
  }

  const timestamp = Date.now();
  // Prefer a lean inscription over a broadcast that will fail for fee/UTXO
  // size. Fleet analysis can grow quickly once anomaly + stale lists fill up.
  const MAX_AGENT_PAYLOAD_BYTES = 8_192;
  let working = record;
  let payload = encodeAgentPayload(working);
  if (payload.length > MAX_AGENT_PAYLOAD_BYTES) {
    working = {
      ...working,
      anomalies: Array.isArray(working.anomalies)
        ? (working.anomalies as unknown[]).slice(0, 5)
        : working.anomalies,
      stale: Array.isArray(working.stale)
        ? (working.stale as unknown[]).slice(0, 5)
        : working.stale,
      truncated: true,
    };
    payload = encodeAgentPayload(working);
    log.warn(
      { agent: agentLabel, bytes: payload.length, limit: MAX_AGENT_PAYLOAD_BYTES },
      "Agent record truncated to fit OP_RETURN budget",
    );
  }
  // The codec declares its own RecordType, so the byte is passed as a literal
  // in the same way the blockchain-writer does.
  const recordTypeByte = recordType as 0x04 | 0x05;
  const scriptBytes = buildOpReturnScript(icao, timestamp, recordTypeByte, payload);

  try {
    const result = await sink.inscribeScript(agentLabel, scriptBytes);

    await insertTxResult(db, {
      txid: result.txid,
      aircraft_icao: icao,
      record_type: recordType,
      status: "SEEN_ON_NETWORK",
      timestamp,
      fee_sats: result.feeSats,
      size_bytes: result.sizeBytes,
      op_return: buildOpReturnPayload(icao, timestamp, recordTypeByte, payload),
    });

    agentInscriptionsTotal.inc({ agent: agentLabel, outcome: "inscribed" });
    log.info(
      { agent: agentLabel, txid: result.txid, recordType, bytes: payload.length },
      "Agent record inscribed on-chain",
    );
    return result;
  } catch (err) {
    // Inscription failures were previously logged at debug and reported as
    // success, which is how the dashboard came to show healthy agents that were
    // writing nothing at all.
    agentInscriptionsTotal.inc({ agent: agentLabel, outcome: "failed" });
    log.error(
      { agent: agentLabel, err: (err as Error).message, recordType },
      "Agent inscription failed — nothing was written on-chain",
    );
    return null;
  }
}
