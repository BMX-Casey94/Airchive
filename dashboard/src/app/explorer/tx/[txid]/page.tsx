"use client";

import { use } from "react";
import Link from "next/link";
import useSWR from "swr";
import { clsx } from "clsx";
import { apiBaseUrl, fetcher } from "@/lib/api";
import { fmtBytes, fmtRelativeTime, fmtSats, formatTimestamp } from "@/lib/format";
import { useAircraftIdentity } from "@/hooks/useAircraftIdentity";
import {
  AircraftIdentityHeader,
  BackLink,
  CopyButton,
  RecordTypeChip,
  SpvBadge,
  TxStatusBadge,
  recordTypeLabel,
} from "@/components/explorer/ExplorerChrome";
import type { DecodedPayload, TxResultDTO } from "@/types/dashboard";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-panel-border/40 py-2.5 last:border-0">
      <span className="w-32 shrink-0 text-xs text-hud-muted">{label}</span>
      <div className="min-w-0 flex-1 text-sm text-white">{children}</div>
    </div>
  );
}

/**
 * Renders the values a reader is most likely to want at a glance. The full
 * decoded object is still shown below — this is a summary, not a substitute.
 */
function TelemetryGrid({ fields }: { fields: Record<string, unknown> }) {
  const pick = (key: string): string | null => {
    const value = fields[key];
    if (value == null || value === "") return null;
    if (typeof value === "number") return value.toLocaleString("en-GB");
    if (typeof value === "boolean") return value ? "Yes" : "No";
    return String(value);
  };

  const entries: Array<[string, string | null]> = [
    ["Callsign", pick("callsign")],
    ["Latitude", pick("lat")],
    ["Longitude", pick("lon")],
    ["Baro altitude", pick("alt_baro")],
    ["Ground speed", pick("gs")],
    ["Track", pick("track")],
    ["Vertical rate", pick("baro_rate") ?? pick("geom_rate")],
    ["Squawk", pick("squawk")],
    ["On ground", pick("on_ground")],
    ["Mach", pick("mach")],
  ].filter(([, value]) => value !== null) as Array<[string, string]>;

  if (entries.length === 0) return null;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {entries.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <p className="hud-label text-[9px]">{label}</p>
          <p className="truncate font-mono text-xs text-white/85">{value}</p>
        </div>
      ))}
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
      { revalidateOnFocus: false },
    );

  const identity = useAircraftIdentity(tx?.aircraftIcao ?? "");

  if (txLoading) {
    return (
      <div className="min-h-screen space-y-5 bg-space-black p-6">
        <div className="panel h-28 animate-pulse" />
        <div className="panel space-y-3 p-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-4 animate-pulse rounded bg-panel-border/60" />
          ))}
        </div>
      </div>
    );
  }

  if (txError || !tx) {
    return (
      <div className="min-h-screen space-y-5 bg-space-black p-6">
        <BackLink href="/">Dashboard</BackLink>
        <div className="panel-alert p-10 text-center">
          <p className="mb-2 text-lg font-semibold text-alert-red">
            Transaction not found
          </p>
          <p className="text-sm text-hud-muted">
            No record of <code className="data-readout text-xs">{txid}</code> in
            this archive.
          </p>
        </div>
      </div>
    );
  }

  const confirmed = tx.status === "MINED";

  return (
    <div className="min-h-screen space-y-5 bg-space-black p-6">
      <AircraftIdentityHeader
        identity={identity}
        backHref={`/explorer/aircraft/${tx.aircraftIcao}`}
        backLabel={tx.aircraftIcao.toUpperCase()}
        subtitle={
          <span>
            Recorded{" "}
            <span className="text-white/70">{formatTimestamp(tx.timestamp)}</span>
            <span className="text-hud-muted/70">
              {" "}
              ({fmtRelativeTime(tx.timestamp)} ago)
            </span>
          </span>
        }
        actions={
          <>
            <TxStatusBadge status={tx.status} size="md" />
            <SpvBadge
              spvVerified={Boolean(tx.spvVerified)}
              proofReceived={Boolean(tx.merklePath)}
            />
          </>
        }
      />

      {/* ── Identity of the transaction itself ────────────── */}
      <div className="panel space-y-3 p-5">
        <div className="flex items-center justify-between gap-3">
          <p className="hud-label text-[9px]">Transaction ID</p>
          <div className="flex items-center gap-2">
            <CopyButton value={tx.txid} label="Copy TXID" />
            <a
              href={`https://whatsonchain.com/tx/${tx.txid}`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded border border-panel-border px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-hud-muted transition-colors hover:border-electric-cyan/60 hover:text-electric-cyan"
            >
              View on-chain ↗
            </a>
          </div>
        </div>
        <code className="block break-all font-mono text-sm text-electric-cyan/90">
          {tx.txid}
        </code>

        <div className="grid grid-cols-2 gap-4 border-t border-panel-border/40 pt-3 md:grid-cols-4">
          <div>
            <p className="hud-label text-[9px]">Record type</p>
            <div className="mt-1">
              <RecordTypeChip recordType={tx.recordType} />
            </div>
          </div>
          <div>
            <p className="hud-label text-[9px]">Miner fee</p>
            <p className="mt-1 font-mono text-sm text-neon-amber">
              {fmtSats(tx.feeSats)}
            </p>
          </div>
          <div>
            <p className="hud-label text-[9px]">Size</p>
            <p className="mt-1 font-mono text-sm text-white/85">
              {fmtBytes(tx.sizeBytes)}
            </p>
          </div>
          <div>
            <p className="hud-label text-[9px]">Block</p>
            <p
              className={clsx(
                "mt-1 font-mono text-sm",
                confirmed ? "text-signal-green" : "text-hud-muted",
              )}
            >
              {tx.blockHeight != null
                ? tx.blockHeight.toLocaleString("en-GB")
                : "Unconfirmed"}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* ── Decoded payload ─────────────────────────────── */}
        <div className="panel space-y-4 p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="hud-label text-[9px]">Decoded OP_RETURN payload</p>
            {decoded && (
              <span className="font-mono text-[10px] text-hud-muted">
                {decoded.protocolId} v{decoded.version} ·{" "}
                {recordTypeLabel(decoded.recordType)}
              </span>
            )}
          </div>

          {decodeLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-4 animate-pulse rounded bg-panel-border/60" />
              ))}
            </div>
          ) : decodeError || !decoded ? (
            <p className="text-xs text-hud-muted">
              The OP_RETURN payload for this transaction could not be decoded. It
              may predate the current envelope schema.
            </p>
          ) : (
            <div className="space-y-4">
              <TelemetryGrid fields={decoded.fields} />

              {Object.keys(decoded.fields).length > 0 && (
                <details open>
                  <summary className="hud-label cursor-pointer select-none text-[9px] transition-colors hover:text-electric-cyan">
                    All decoded fields ({Object.keys(decoded.fields).length})
                  </summary>
                  <pre className="mt-2 max-h-96 overflow-auto rounded-lg border border-panel-border bg-space-black p-4 font-mono text-xs text-electric-cyan/80">
                    {JSON.stringify(decoded.fields, null, 2)}
                  </pre>
                </details>
              )}

              <details>
                <summary className="hud-label cursor-pointer select-none text-[9px] transition-colors hover:text-neon-amber">
                  Raw OP_RETURN hex
                </summary>
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-panel-border bg-space-black p-4 font-mono text-xs text-neon-amber/80">
                  {decoded.rawHex}
                </pre>
              </details>
            </div>
          )}
        </div>

        {/* ── Provenance ──────────────────────────────────── */}
        <div className="space-y-5">
          <div className="panel space-y-3 p-5">
            <p className="hud-label text-[9px]">Proof of inclusion</p>
            <SpvBadge
              spvVerified={Boolean(tx.spvVerified)}
              proofReceived={Boolean(tx.merklePath)}
            />
            {tx.spvVerified ? (
              <p className="text-xs leading-relaxed text-signal-green/80">
                The inclusion proof was recomputed to a Merkle root matching a
                block header held locally, whose proof of work this system checked
                itself. No third party was trusted for this result.
              </p>
            ) : tx.merklePath ? (
              <p className="text-xs leading-relaxed text-neon-amber/80">
                An inclusion proof has been received but not yet verified — the
                matching block header has not been synchronised. Verification is
                retried as the header chain catches up.
              </p>
            ) : (
              <p className="text-xs leading-relaxed text-hud-muted">
                Awaiting an inclusion proof. One becomes available once the
                transaction is mined into a block.
              </p>
            )}
            {tx.merklePath && (
              <details>
                <summary className="hud-label cursor-pointer select-none text-[9px] transition-colors hover:text-signal-green">
                  Merkle path
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-panel-border bg-space-black p-3 font-mono text-[10px] text-signal-green/80">
                  {tx.merklePath}
                </pre>
              </details>
            )}
          </div>

          <div className="panel space-y-0 p-5">
            <p className="hud-label mb-2 text-[9px]">Provenance</p>
            <Field label="Aircraft">
              <Link
                href={`/explorer/aircraft/${tx.aircraftIcao}`}
                className="data-readout text-xs transition-colors hover:text-white hover:underline"
              >
                {identity.registration
                  ? `${identity.registration} · ${tx.aircraftIcao.toUpperCase()}`
                  : tx.aircraftIcao.toUpperCase()}
              </Link>
            </Field>
            {identity.typeCode && (
              <Field label="Type">
                <span className="font-mono text-xs text-white/85">
                  {identity.description ?? identity.typeCode}
                </span>
              </Field>
            )}
            {identity.operator && (
              <Field label="Operator">
                <span className="text-xs text-white/85">{identity.operator}</span>
              </Field>
            )}
            {tx.flightId && (
              <Field label="Flight">
                <span className="font-mono text-xs text-neon-amber">
                  {tx.flightId}
                </span>
              </Field>
            )}
            <Field label="Recorded">
              <span className="font-mono text-xs">
                {formatTimestamp(tx.timestamp)}
              </span>
            </Field>
            <Field label="Indexed">
              <span className="font-mono text-xs text-hud-muted">
                {formatTimestamp(tx.createdAt)}
              </span>
            </Field>
            {identity.walletAddress && (
              <Field label="Wallet">
                <div className="flex items-center gap-2">
                  <code className="min-w-0 break-all font-mono text-[11px] text-electric-cyan/80">
                    {identity.walletAddress}
                  </code>
                  <CopyButton value={identity.walletAddress} />
                </div>
              </Field>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
