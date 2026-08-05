"use client";

import { use, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { clsx } from "clsx";
import { apiBaseUrl, fetcher } from "@/lib/api";
import {
  fmtAltitude,
  fmtBytes,
  fmtSpeed,
  formatPhase,
  formatTimestamp,
  truncateTxId,
} from "@/lib/format";
import { useAircraftIdentity } from "@/hooks/useAircraftIdentity";
import {
  AircraftIdentityHeader,
  RecordTypeChip,
  TxStatusBadge,
  recordTypeLabel,
} from "@/components/explorer/ExplorerChrome";
import DecodedFields from "@/components/explorer/DecodedFields";
import DateTimePicker from "@/components/ui/DateTimePicker";
import type { DecodedPayload, FlightPhase, TxResultDTO } from "@/types/dashboard";

const PAGE_SIZE = 25;

const RECORD_TYPE_FILTERS: Array<{ label: string; value: string }> = [
  { label: "All records", value: "" },
  { label: "Telemetry", value: "1" },
  { label: "Flight events", value: "2" },
  { label: "Deltas", value: "3" },
];

interface AircraftSummary {
  total: number;
  feeSats: number;
  sizeBytes: number;
  firstSeen: number | null;
  lastSeen: number | null;
  mined: number;
  pending: number;
  failed: number;
  spvVerified: number;
}

interface SummaryResponse {
  success: boolean;
  data: AircraftSummary;
}

function Stat({
  label,
  value,
  sub,
  tone = "cyan",
  loading = false,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "cyan" | "green" | "amber" | "plain";
  loading?: boolean;
}) {
  return (
    <div className="min-w-0 border-l border-panel-border/40 px-4 first:border-l-0 first:pl-0">
      <p className="hud-label text-[9px]">{label}</p>
      {loading ? (
        <div
          className="mt-2 flex h-7 items-center"
          role="status"
          aria-label={`Loading ${label}`}
        >
          <div className="relative h-1.5 w-16 overflow-hidden rounded-full bg-panel-border/50">
            <div className="absolute inset-y-0 w-1/2 animate-[stat-shimmer_1.1s_ease-in-out_infinite] rounded-full bg-electric-cyan/70" />
          </div>
        </div>
      ) : (
        <p
          className={clsx(
            "truncate font-mono text-lg tabular-nums",
            tone === "cyan" && "text-electric-cyan",
            tone === "green" && "text-signal-green",
            tone === "amber" && "text-neon-amber",
            tone === "plain" && "text-white/85",
          )}
        >
          {value}
        </p>
      )}
      {sub && !loading && (
        <p className="truncate text-[10px] text-hud-muted">{sub}</p>
      )}
    </div>
  );
}

function DecodedPayloadPanel({ txid }: { txid: string }) {
  const { data, error, isLoading } = useSWR<DecodedPayload>(
    `${apiBaseUrl}/api/explorer/tx/${txid}/decode`,
    fetcher,
    { revalidateOnFocus: false },
  );

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-2 py-2">
        <div className="h-3 w-3/4 rounded bg-panel-border" />
        <div className="h-3 w-1/2 rounded bg-panel-border" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <p className="py-2 text-xs text-alert-red/80">
        Failed to decode the OP_RETURN payload for this transaction.
      </p>
    );
  }

  const fieldCount = Object.keys(data.fields).length;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div>
          <p className="hud-label text-[9px]">Protocol</p>
          <p className="data-readout text-xs">
            {data.protocolId} v{data.version}
          </p>
        </div>
        <div>
          <p className="hud-label text-[9px]">ICAO</p>
          <p className="data-readout text-xs">{data.icaoHex}</p>
        </div>
        <div>
          <p className="hud-label text-[9px]">Record</p>
          <p className="font-mono text-xs text-white/85">
            {recordTypeLabel(data.recordType)}
          </p>
        </div>
        <div>
          <p className="hud-label text-[9px]">Recorded</p>
          <p className="font-mono text-xs text-white/85">
            {formatTimestamp(data.timestamp)}
          </p>
        </div>
      </div>

      {fieldCount > 0 && <DecodedFields fields={data.fields} />}

      <details>
        <summary className="hud-label cursor-pointer select-none text-[10px] transition-colors hover:text-neon-amber">
          Raw OP_RETURN hex
        </summary>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-panel-border bg-space-black p-3 font-mono text-[10px] text-neon-amber/80">
          {data.rawHex}
        </pre>
      </details>
    </div>
  );
}

function TxRow({ tx }: { tx: TxResultDTO }) {
  const [expanded, setExpanded] = useState(false);
  const phase = tx.phase ? formatPhase(tx.phase as FlightPhase) : null;

  return (
    <>
      <tr
        onClick={() => setExpanded((prev) => !prev)}
        className={clsx(
          "cursor-pointer border-t border-panel-border/30 transition-colors hover:bg-electric-cyan/[0.04]",
          expanded && "bg-electric-cyan/[0.04]",
        )}
      >
        <td className="py-2.5 pl-4 pr-2">
          <div className="flex items-center gap-2">
            <svg
              className={clsx(
                "h-3 w-3 shrink-0 text-hud-muted transition-transform",
                expanded && "rotate-90",
              )}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            <Link
              href={`/explorer/tx/${tx.txid}`}
              onClick={(e) => e.stopPropagation()}
              className="data-readout text-xs transition-colors hover:text-white hover:underline"
            >
              {truncateTxId(tx.txid)}
            </Link>
          </div>
        </td>
        <td className="px-2 py-2.5">
          <RecordTypeChip recordType={tx.recordType} />
        </td>
        <td className="px-2 py-2.5">
          {phase ? (
            <span className={clsx("font-mono text-[11px]", phase.colourClass)}>
              {phase.label}
            </span>
          ) : (
            <span className="text-[11px] text-hud-muted">—</span>
          )}
        </td>
        <td className="px-2 py-2.5 text-right font-mono text-[11px] tabular-nums text-white/75">
          {tx.telemetry?.altitudeFt != null
            ? `${fmtAltitude(tx.telemetry.altitudeFt)} ft`
            : "—"}
        </td>
        <td className="px-2 py-2.5 text-right font-mono text-[11px] tabular-nums text-white/75">
          {tx.telemetry?.groundSpeedKts != null
            ? `${fmtSpeed(tx.telemetry.groundSpeedKts)} kts`
            : "—"}
        </td>
        <td className="px-2 py-2.5 text-right font-mono text-[11px] tabular-nums text-hud-muted">
          {tx.feeSats}
        </td>
        <td className="px-2 py-2.5 text-right font-mono text-[11px] tabular-nums text-hud-muted">
          {fmtBytes(tx.sizeBytes)}
        </td>
        <td className="px-2 py-2.5">
          <TxStatusBadge status={tx.status} />
        </td>
        <td className="whitespace-nowrap py-2.5 pl-2 pr-4 text-right font-mono text-[10px] text-hud-muted">
          {formatTimestamp(tx.timestamp)}
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-panel-border/30 bg-space-black/40">
          <td colSpan={9} className="px-4 py-3">
            <DecodedPayloadPanel txid={tx.txid} />
          </td>
        </tr>
      )}
    </>
  );
}

export default function AircraftExplorerPage({
  params,
}: {
  params: Promise<{ icao: string }>;
}) {
  const { icao } = use(params);
  const upperIcao = icao.toUpperCase();

  const [page, setPage] = useState(0);
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");
  const [recordType, setRecordType] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const rangeParams = useMemo(() => {
    const p = new URLSearchParams();
    if (timeFrom) p.set("from", new Date(timeFrom).getTime().toString());
    if (timeTo) p.set("to", new Date(timeTo).getTime().toString());
    return p;
  }, [timeFrom, timeTo]);

  const listQuery = useMemo(() => {
    const p = new URLSearchParams(rangeParams);
    p.set("limit", PAGE_SIZE.toString());
    p.set("offset", (page * PAGE_SIZE).toString());
    p.set("decode", "true");
    if (recordType) p.set("recordType", recordType);
    return p.toString();
  }, [rangeParams, page, recordType]);

  const exportQuery = useMemo(() => {
    const p = new URLSearchParams(rangeParams);
    if (recordType) p.set("recordType", recordType);
    return p.toString();
  }, [rangeParams, recordType]);

  const { data, error, isLoading } = useSWR<TxResultDTO[]>(
    `${apiBaseUrl}/api/explorer/aircraft/${icao}/transactions?${listQuery}`,
    fetcher,
    { keepPreviousData: true },
  );

  const { data: summary, isLoading: summaryLoading } = useSWR<SummaryResponse>(
    `${apiBaseUrl}/api/explorer/aircraft/${icao}/summary?${rangeParams.toString()}`,
    fetcher,
    { refreshInterval: 30_000 },
  );

  const filtered = Boolean(timeFrom || timeTo || recordType);
  const exportable = (summary?.data.total ?? 0) > 0 || (data?.length ?? 0) > 0;

  // An aircraft parked for days is absent from live fleet state, but its own
  // envelopes still carry `aircraft_desc` — so the header names it from the
  // archive rather than reporting "type unknown".
  const onChainIdentity = useMemo(() => {
    const sample = data?.find((tx) => tx.telemetry?.aircraftDesc
      || tx.telemetry?.registration
      || tx.telemetry?.aircraftType);
    return {
      registration: sample?.telemetry?.registration ?? null,
      typeCode: sample?.telemetry?.aircraftType ?? null,
      description: sample?.telemetry?.aircraftDesc ?? null,
      callsign: sample?.telemetry?.callsign ?? null,
    };
  }, [data]);

  const identity = useAircraftIdentity(icao, onChainIdentity);

  /**
   * Downloads the full filtered history from the gateway — not the current
   * page. The browser never holds the whole ledger in memory; it just relays
   * the CSV the API already assembled.
   */
  const handleExportCsv = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const headers: HeadersInit = { Accept: "text/csv" };
      if (typeof window !== "undefined") {
        const token = sessionStorage.getItem("airchive_token");
        if (token) headers.Authorization = `Bearer ${token}`;
      }

      const query = exportQuery ? `?${exportQuery}` : "";
      const res = await fetch(
        `${apiBaseUrl}/api/explorer/aircraft/${icao}/export.csv${query}`,
        { headers },
      );

      if (!res.ok) {
        let message = `Export failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          // Non-JSON error bodies still get the status message above.
        }
        throw new Error(message);
      }

      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const matched = /filename="([^"]+)"/.exec(disposition);
      const filename = matched?.[1] ?? `airchive-${upperIcao}-export.csv`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }, [exporting, exportQuery, icao, upperIcao]);

  const stats = summary?.data;
  const statsLoading = summaryLoading && !stats;

  return (
    <div className="min-h-screen bg-space-black p-6 space-y-5">
      <AircraftIdentityHeader
        identity={identity}
        backHref="/"
        backLabel="Dashboard"
        subtitle={<span>On-chain transaction ledger</span>}
        actions={
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              onClick={() => void handleExportCsv()}
              disabled={!exportable || exporting}
              title="Downloads every matching transaction, including decoded fields"
              className={clsx(
                "flex items-center gap-2 rounded-lg border px-4 py-2 font-mono text-xs transition-all",
                exportable && !exporting
                  ? "border-electric-cyan/40 text-electric-cyan hover:bg-electric-cyan/10 hover:shadow-glow-cyan"
                  : "cursor-not-allowed border-panel-border text-hud-muted",
              )}
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              {exporting ? "Exporting…" : "Export CSV"}
            </button>
            {exportError && (
              <p className="max-w-xs text-right text-[10px] text-alert-red">
                {exportError}
              </p>
            )}
          </div>
        }
      />

      {/* ── Lifetime totals ───────────────────────────────── */}
      <div className="panel flex flex-wrap gap-y-4 p-4">
        <Stat
          label={filtered ? "Writes in range" : "Total writes"}
          value={stats ? stats.total.toLocaleString("en-GB") : "—"}
          loading={statsLoading}
          sub={
            stats
              ? `${stats.mined.toLocaleString("en-GB")} confirmed · `
                + `${stats.pending.toLocaleString("en-GB")} broadcast`
              : undefined
          }
        />
        <Stat
          label="SPV verified"
          value={stats ? stats.spvVerified.toLocaleString("en-GB") : "—"}
          loading={statsLoading}
          sub={
            !stats || stats.total === 0
              ? undefined
              : stats.mined === 0
                // A proof can only be checked once a block contains the write,
                // so 0% here means "nothing mined yet", not "verification off".
                ? "awaiting first confirmation"
                : `${Math.round((stats.spvVerified / stats.total) * 100)}% of writes`
          }
          tone="green"
        />
        <Stat
          label="On-chain data"
          value={stats ? fmtBytes(stats.sizeBytes) : "—"}
          loading={statsLoading}
          sub={stats ? `${stats.failed.toLocaleString("en-GB")} failed` : undefined}
          tone="plain"
        />
        <Stat
          label="Miner fees"
          value={stats ? stats.feeSats.toLocaleString("en-GB") : "—"}
          loading={statsLoading}
          sub="satoshis"
          tone="amber"
        />
        <Stat
          label="First write"
          value={stats?.firstSeen ? formatTimestamp(stats.firstSeen) : "—"}
          loading={statsLoading}
          tone="plain"
        />
        <Stat
          label="Latest write"
          value={stats?.lastSeen ? formatTimestamp(stats.lastSeen) : "—"}
          loading={statsLoading}
          tone="plain"
        />
      </div>

      {/* Raised above the ledger: the calendar popover overflows this panel and
          the table below it opens its own stacking context via backdrop-blur. */}
      <div className="panel relative z-30 space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {RECORD_TYPE_FILTERS.map((filter) => (
            <button
              key={filter.value || "all"}
              type="button"
              onClick={() => {
                setRecordType(filter.value);
                setPage(0);
              }}
              className={clsx(
                "rounded-full border px-3 py-1 font-mono text-[11px] transition-colors",
                recordType === filter.value
                  ? "border-electric-cyan/60 bg-electric-cyan/10 text-electric-cyan"
                  : "border-panel-border text-hud-muted hover:border-electric-cyan/30 hover:text-white/80",
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <DateTimePicker
            id="filter-from"
            label="From"
            value={timeFrom}
            onChange={(next) => {
              setTimeFrom(next);
              setPage(0);
            }}
          />
          <DateTimePicker
            id="filter-to"
            label="To"
            value={timeTo}
            onChange={(next) => {
              setTimeTo(next);
              setPage(0);
            }}
          />
          {filtered && (
            <button
              type="button"
              onClick={() => {
                setTimeFrom("");
                setTimeTo("");
                setRecordType("");
                setPage(0);
              }}
              className="pb-1 text-xs text-hud-muted transition-colors hover:text-alert-red"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* ── Ledger ────────────────────────────────────────── */}
      {isLoading && !data ? (
        <div className="panel space-y-2 p-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-6 animate-pulse rounded bg-panel-border/60" />
          ))}
        </div>
      ) : error ? (
        <div className="panel-alert p-4">
          <p className="text-sm text-alert-red">
            Failed to load transactions for {upperIcao}. The gateway may be
            unreachable.
          </p>
        </div>
      ) : data && data.length > 0 ? (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse">
              <thead>
                <tr className="bg-space-black/60">
                  <th className="py-2.5 pl-4 pr-2 text-left hud-label text-[9px]">
                    Transaction
                  </th>
                  <th className="px-2 py-2.5 text-left hud-label text-[9px]">Record</th>
                  <th className="px-2 py-2.5 text-left hud-label text-[9px]">Phase</th>
                  <th className="px-2 py-2.5 text-right hud-label text-[9px]">
                    Altitude
                  </th>
                  <th className="px-2 py-2.5 text-right hud-label text-[9px]">Speed</th>
                  <th className="px-2 py-2.5 text-right hud-label text-[9px]">Fee</th>
                  <th className="px-2 py-2.5 text-right hud-label text-[9px]">Size</th>
                  <th className="px-2 py-2.5 text-left hud-label text-[9px]">Status</th>
                  <th className="py-2.5 pl-2 pr-4 text-right hud-label text-[9px]">
                    Recorded
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((tx) => (
                  <TxRow key={tx.txid} tx={tx} />
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-panel-border/40 px-4 py-3">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className={clsx(
                "rounded-lg border px-4 py-1.5 font-mono text-xs transition-all",
                page > 0
                  ? "border-panel-border text-white hover:border-electric-cyan/40 hover:text-electric-cyan"
                  : "cursor-not-allowed border-panel-border/50 text-hud-muted/50",
              )}
            >
              Previous
            </button>
            <span className="font-mono text-[11px] text-hud-muted">
              Rows {page * PAGE_SIZE + 1}–{page * PAGE_SIZE + data.length}
              {stats ? ` of ${stats.total.toLocaleString("en-GB")}` : ""}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={data.length < PAGE_SIZE}
              className={clsx(
                "rounded-lg border px-4 py-1.5 font-mono text-xs transition-all",
                data.length >= PAGE_SIZE
                  ? "border-panel-border text-white hover:border-electric-cyan/40 hover:text-electric-cyan"
                  : "cursor-not-allowed border-panel-border/50 text-hud-muted/50",
              )}
            >
              Next
            </button>
          </div>
        </div>
      ) : (
        <div className="panel p-10 text-center">
          <p className="text-sm text-hud-muted">
            No transactions recorded for {upperIcao}
            {filtered && " with the current filters"}.
          </p>
        </div>
      )}
    </div>
  );
}
