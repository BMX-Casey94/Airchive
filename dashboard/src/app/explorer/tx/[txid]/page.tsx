"use client";

import Link from "next/link";
import useSWR from "swr";
import { clsx } from "clsx";
import { apiBaseUrl, fetcher } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";
import type { TxResultDTO, DecodedPayload } from "@/types/dashboard";
import { use } from "react";

const RECORD_TYPE_LABEL: Record<number, string> = {
  0x01: "Telemetry",
  0x02: "Flight Event",
  0x03: "Telemetry Delta",
};

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    SEEN_ON_NETWORK:
      "bg-neon-amber/20 border-neon-amber/40 text-neon-amber",
    MINED: "bg-signal-green/20 border-signal-green/40 text-signal-green",
    FAILED: "bg-alert-red/20 border-alert-red/40 text-alert-red",
  };
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-mono",
        styles[status] ?? styles.FAILED,
      )}
    >
      <span
        className={clsx(
          "h-1.5 w-1.5 rounded-full",
          status === "MINED"
            ? "bg-signal-green"
            : status === "SEEN_ON_NETWORK"
              ? "bg-neon-amber animate-pulse"
              : "bg-alert-red",
        )}
      />
      {status}
    </span>
  );
}

function SpvBadge({ hasMerklePath }: { hasMerklePath: boolean }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-mono",
        hasMerklePath
          ? "bg-signal-green/20 border-signal-green/40 text-signal-green"
          : "bg-panel-bg border-panel-border text-hud-muted",
      )}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-3.5 w-3.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        {hasMerklePath ? (
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
          />
        ) : (
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M20.618 5.984A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
          />
        )}
      </svg>
      {hasMerklePath ? "SPV Verified" : "Awaiting SPV"}
    </span>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-2 border-b border-panel-border/50 last:border-0">
      <span className="text-xs text-hud-muted w-32 shrink-0 pt-0.5">
        {label}
      </span>
      <div className="text-sm text-white min-w-0 flex-1">{children}</div>
    </div>
  );
}

export default function TxExplorerPage({
  params,
}: {
  params: Promise<{ txid: string }>;
}) {
  const { txid } = use(params);

  const { data: tx, error: txError, isLoading: txLoading } = useSWR<TxResultDTO>(
    `${apiBaseUrl}/api/explorer/tx/${txid}`,
    fetcher,
  );

  const { data: decoded, error: decodeError, isLoading: decodeLoading } =
    useSWR<DecodedPayload>(
      `${apiBaseUrl}/api/explorer/tx/${txid}/decode`,
      fetcher,
    );

  if (txLoading) {
    return (
      <div className="min-h-screen bg-space-black p-6 space-y-6">
        <div className="animate-pulse space-y-4">
          <div className="h-6 w-48 rounded bg-panel-border" />
          <div className="panel p-6 space-y-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-4 rounded bg-panel-border" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (txError || !tx) {
    return (
      <div className="min-h-screen bg-space-black p-6">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-sm text-hud-muted hover:text-electric-cyan transition-colors mb-6"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Dashboard
        </Link>
        <div className="panel-alert p-8 text-center">
          <p className="text-lg text-alert-red font-semibold mb-2">
            Transaction Not Found
          </p>
          <p className="text-sm text-hud-muted">
            The transaction <code className="data-readout text-xs">{txid}</code>{" "}
            could not be located.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-space-black p-6 space-y-6">
      {/* ── Header ────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <Link
            href={`/explorer/aircraft/${tx.aircraftIcao}`}
            className="flex items-center gap-1.5 text-sm text-hud-muted hover:text-electric-cyan transition-colors shrink-0"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            {tx.aircraftIcao.toUpperCase()}
          </Link>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-white">
              Transaction Explorer
            </h1>
            <p className="data-readout text-xs truncate">{txid}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <StatusBadge status={tx.status} />
          <SpvBadge hasMerklePath={!!tx.merklePath} />
        </div>
      </div>

      {/* ── Transaction details ───────────────────────────── */}
      <div className="panel p-5">
        <p className="hud-label text-[9px] mb-4">Transaction Details</p>
        <div className="space-y-0">
          <FieldRow label="TXID">
            <code className="data-readout text-xs break-all">{tx.txid}</code>
          </FieldRow>
          <FieldRow label="Aircraft">
            <Link
              href={`/explorer/aircraft/${tx.aircraftIcao}`}
              className="data-readout text-xs hover:text-white transition-colors"
            >
              {tx.aircraftIcao.toUpperCase()}
            </Link>
          </FieldRow>
          <FieldRow label="Record Type">
            <span className="font-mono text-xs">
              {RECORD_TYPE_LABEL[tx.recordType] ?? `0x${tx.recordType.toString(16).padStart(2, "0")}`}
            </span>
          </FieldRow>
          <FieldRow label="ARC Status">
            <StatusBadge status={tx.status} />
          </FieldRow>
          <FieldRow label="Timestamp">
            <span className="font-mono text-xs">
              {new Date(tx.timestamp).toLocaleString("en-GB")}
              <span className="text-hud-muted ml-2">
                ({formatTimestamp(tx.timestamp)})
              </span>
            </span>
          </FieldRow>
          <FieldRow label="Fee">
            <span className="data-readout text-xs">
              {tx.feeSats.toLocaleString("en-GB")} sats
            </span>
          </FieldRow>
          <FieldRow label="Size">
            <span className="data-readout text-xs">
              {tx.sizeBytes.toLocaleString("en-GB")} bytes
            </span>
          </FieldRow>
          {tx.blockHeight != null && (
            <FieldRow label="Block Height">
              <span className="data-readout text-xs">
                {tx.blockHeight.toLocaleString("en-GB")}
              </span>
            </FieldRow>
          )}
          {tx.merklePath && (
            <FieldRow label="Merkle Path">
              <pre className="text-[10px] font-mono text-signal-green/80 bg-space-black rounded-lg p-3 overflow-x-auto border border-panel-border break-all max-h-32 overflow-y-auto">
                {tx.merklePath}
              </pre>
            </FieldRow>
          )}
          {tx.flightId && (
            <FieldRow label="Flight ID">
              <span className="font-mono text-xs text-neon-amber">
                {tx.flightId}
              </span>
            </FieldRow>
          )}
        </div>
      </div>

      {/* ── Decoded payload ───────────────────────────────── */}
      <div className="panel p-5">
        <p className="hud-label text-[9px] mb-4">Decoded OP_RETURN Payload</p>

        {decodeLoading ? (
          <div className="animate-pulse space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-4 rounded bg-panel-border" />
            ))}
          </div>
        ) : decodeError || !decoded ? (
          <p className="text-xs text-hud-muted">
            Unable to decode the OP_RETURN payload for this transaction.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="hud-label text-[9px]">Protocol</p>
                <p className="data-readout text-sm">
                  {decoded.protocolId} v{decoded.version}
                </p>
              </div>
              <div>
                <p className="hud-label text-[9px]">ICAO</p>
                <p className="data-readout text-sm">{decoded.icaoHex}</p>
              </div>
              <div>
                <p className="hud-label text-[9px]">Record</p>
                <p className="font-mono text-sm text-white">
                  {RECORD_TYPE_LABEL[decoded.recordType] ?? "Unknown"}
                </p>
              </div>
              <div>
                <p className="hud-label text-[9px]">Timestamp</p>
                <p className="font-mono text-sm text-white">
                  {new Date(decoded.timestamp).toLocaleString("en-GB")}
                </p>
              </div>
            </div>

            {Object.keys(decoded.fields).length > 0 && (
              <div>
                <p className="hud-label text-[9px] mb-2">
                  Decoded Fields ({Object.keys(decoded.fields).length})
                </p>
                <pre className="text-xs font-mono text-electric-cyan/80 bg-space-black rounded-lg p-4 overflow-x-auto border border-panel-border max-h-96 overflow-y-auto">
                  {JSON.stringify(decoded.fields, null, 2)}
                </pre>
              </div>
            )}

            <div>
              <p className="hud-label text-[9px] mb-2">Raw OP_RETURN Hex</p>
              <pre className="text-xs font-mono text-neon-amber/80 bg-space-black rounded-lg p-4 overflow-x-auto border border-panel-border break-all">
                {decoded.rawHex}
              </pre>
            </div>
          </div>
        )}
      </div>

      {/* ── SPV verification ──────────────────────────────── */}
      <div className="panel p-5">
        <p className="hud-label text-[9px] mb-4">SPV Verification</p>
        <div className="flex items-center gap-4">
          <SpvBadge hasMerklePath={!!tx.merklePath} />
          {tx.merklePath ? (
            <p className="text-xs text-signal-green/80">
              This transaction has been independently verified via its Merkle
              proof path against the block header.
            </p>
          ) : tx.status === "MINED" ? (
            <p className="text-xs text-neon-amber/80">
              Transaction is mined but the Merkle path has not yet been
              retrieved. SPV verification will be available shortly.
            </p>
          ) : (
            <p className="text-xs text-hud-muted">
              SPV verification requires the transaction to be included in a
              mined block with a valid Merkle path.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
