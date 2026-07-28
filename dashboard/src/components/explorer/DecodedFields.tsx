"use client";

import { clsx } from "clsx";
import { useMemo, useState } from "react";

/**
 * Plain-English labels and units for the ADS-B envelope fields.
 *
 * The raw JSON is the source of truth and stays one click away, but most
 * readers are not fluent in ADS-B shorthand — `alt_baro`, `gs`, `nic` and
 * `squawk` mean nothing without this table.
 */
interface FieldSpec {
  label: string;
  unit?: string;
  /** Sort order within the rendered list; lower comes first. */
  group: number;
  describe?: (value: unknown) => string | null;
  /** Wide narrative / nested objects span the full grid rather than a cell. */
  wide?: boolean;
}

const SQUAWK_MEANING: Record<string, string> = {
  "7500": "Unlawful interference (hijack)",
  "7600": "Radio failure",
  "7700": "General emergency",
};

const EVENT_LABELS: Record<string, string> = {
  TAKEOFF: "Take-off",
  LANDING: "Landing",
  TAXI_START: "Taxi start",
  TAXI_END: "Taxi end",
  PARKED: "Parked",
  EMERGENCY: "Emergency",
  APPROACH: "Approach",
  CLIMB: "Climb",
  CRUISE: "Cruise",
  DESCENT: "Descent",
};

const FIELD_SPECS: Record<string, FieldSpec> = {
  icao: { label: "ICAO 24-bit address", group: 0 },
  callsign: { label: "Callsign", group: 0 },
  reg: { label: "Registration", group: 0 },
  aircraft_type: { label: "Aircraft type code", group: 0 },
  aircraft_desc: { label: "Aircraft type", group: 0 },
  category: { label: "ADS-B emitter category", group: 0 },
  squawk: {
    label: "Squawk code",
    group: 0,
    describe: (value) => SQUAWK_MEANING[String(value)] ?? null,
  },

  ts: { label: "Reported at", group: 1 },
  ts_pos: { label: "Position age", unit: "s", group: 1 },

  lat: { label: "Latitude", unit: "°", group: 2 },
  lon: { label: "Longitude", unit: "°", group: 2 },
  alt_baro: { label: "Barometric altitude", unit: "ft", group: 2 },
  alt_geom: { label: "Geometric altitude (GPS)", unit: "ft", group: 2 },
  on_ground: { label: "On the ground", group: 2 },

  gs: { label: "Ground speed", unit: "kts", group: 3 },
  ias: { label: "Indicated airspeed", unit: "kts", group: 3 },
  tas: { label: "True airspeed", unit: "kts", group: 3 },
  mach: { label: "Mach number", group: 3 },
  track: { label: "Track over ground", unit: "°", group: 3 },
  true_heading: { label: "True heading", unit: "°", group: 3 },
  mag_heading: { label: "Magnetic heading", unit: "°", group: 3 },
  baro_rate: { label: "Vertical rate (barometric)", unit: "ft/min", group: 3 },
  geom_rate: { label: "Vertical rate (geometric)", unit: "ft/min", group: 3 },
  roll: { label: "Roll angle", unit: "°", group: 3 },

  wind_dir: { label: "Wind direction", unit: "°", group: 4 },
  wind_speed: { label: "Wind speed", unit: "kts", group: 4 },
  oat: { label: "Outside air temperature", unit: "°C", group: 4 },
  tat: { label: "Total air temperature", unit: "°C", group: 4 },

  nav_qnh: { label: "Altimeter setting", unit: "hPa", group: 5 },
  nav_altitude_mcp: { label: "Selected altitude (autopilot)", unit: "ft", group: 5 },
  nav_altitude_fms: { label: "Selected altitude (FMS)", unit: "ft", group: 5 },
  nav_heading: { label: "Selected heading", unit: "°", group: 5 },
  nav_modes: { label: "Active autopilot modes", group: 5 },

  nic: { label: "Navigation integrity category", group: 6 },
  nac_p: { label: "Position accuracy category", group: 6 },
  nac_v: { label: "Velocity accuracy category", group: 6 },
  sil: { label: "Source integrity level", group: 6 },
  sil_type: { label: "Integrity level basis", group: 6 },
  rc: { label: "Containment radius", unit: "m", group: 6 },
  gva: { label: "Geometric vertical accuracy", group: 6 },
  sda: { label: "System design assurance", group: 6 },
  version: { label: "ADS-B version", group: 6 },

  rssi: { label: "Signal strength", unit: "dBFS", group: 7 },
  messages: { label: "Messages received", group: 7 },
  seen: { label: "Last seen", unit: "s ago", group: 7 },
  seen_pos: { label: "Position last seen", unit: "s ago", group: 7 },
  alert: { label: "Alert flag", group: 7 },
  spi: { label: "Ident (SPI) active", group: 7 },
  flight_id: { label: "Flight session", group: 7 },
  event: {
    label: "Flight event",
    group: 0,
    describe: (value) => EVENT_LABELS[String(value)] ?? null,
  },
  phase: { label: "Flight phase", group: 7 },
  type: { label: "Record kind", group: 0 },

  // Flight-event envelope fields. The narrative `summary` and nested
  // `flight_stats` are what used to blow out of the grid: they are wide by
  // design and rendered as their own full-width rows.
  summary: { label: "Summary", group: 8, wide: true },
  airport_icao: { label: "Airport ICAO", group: 8 },
  airport_name: { label: "Airport name", group: 8 },
  destination_icao: { label: "Destination ICAO", group: 8 },
  destination_name: { label: "Destination name", group: 8 },
  est_flight_time_min: { label: "Estimated flight time", unit: "min", group: 8 },
  flight_stats: { label: "Flight statistics", group: 8, wide: true },
};

/** Field names whose numeric value is epoch milliseconds, not a measurement. */
const EPOCH_FIELDS = new Set(["ts", "timestamp", "time"]);

/** Nested object keys we know how to label when expanding `flight_stats`. */
const NESTED_LABELS: Record<string, { label: string; unit?: string }> = {
  duration_min: { label: "Duration", unit: "min" },
  distance_miles: { label: "Distance", unit: "miles" },
  max_alt_ft: { label: "Maximum altitude", unit: "ft" },
  avg_gs_kts: { label: "Average ground speed", unit: "kts" },
  total_tx_count: { label: "Telemetry writes", unit: undefined },
  total_bsv_sats: { label: "Fees spent", unit: "sats" },
};

function humaniseKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatScalar(key: string, value: unknown, unit?: string): string {
  if (value === null || value === undefined || value === "") return "—";

  if (typeof value === "boolean") return value ? "Yes" : "No";

  if (typeof value === "number") {
    if (EPOCH_FIELDS.has(key) && value > 1_000_000_000_000) {
      return new Date(value).toLocaleString("en-GB");
    }
    const formatted = Number.isInteger(value)
      ? value.toLocaleString("en-GB")
      : value.toLocaleString("en-GB", { maximumFractionDigits: 6 });
    return unit ? `${formatted} ${unit}` : formatted;
  }

  if (Array.isArray(value)) {
    return value.length === 0 ? "None" : value.map(String).join(", ");
  }

  return unit ? `${String(value)} ${unit}` : String(value);
}

interface ObjectEntry {
  label: string;
  value: string;
}

function expandObject(value: Record<string, unknown>): ObjectEntry[] {
  return Object.entries(value).map(([key, nested]) => {
    const known = NESTED_LABELS[key];
    return {
      label: known?.label ?? humaniseKey(key),
      value: formatScalar(key, nested, known?.unit),
    };
  });
}

interface ReadableRow {
  key: string;
  label: string;
  value: string;
  note: string | null;
  group: number;
  wide: boolean;
  /** Expanded nested object shown as labelled lines instead of a JSON blob. */
  entries: ObjectEntry[] | null;
}

export function readableFields(fields: Record<string, unknown>): ReadableRow[] {
  return Object.entries(fields)
    .map(([key, value]) => {
      const spec = FIELD_SPECS[key];
      const isObject =
        value !== null
        && typeof value === "object"
        && !Array.isArray(value);

      return {
        key,
        label: spec?.label ?? humaniseKey(key),
        value: isObject ? "" : formatScalar(key, value, spec?.unit),
        note: spec?.describe?.(value) ?? null,
        group: spec?.group ?? 99,
        wide: Boolean(spec?.wide) || isObject || (
          typeof value === "string" && value.length > 80
        ),
        entries: isObject ? expandObject(value as Record<string, unknown>) : null,
      };
    })
    .sort((a, b) => a.group - b.group || a.label.localeCompare(b.label));
}

interface DecodedFieldsProps {
  fields: Record<string, unknown>;
  /** Larger type and a wider grid for the dedicated transaction page. */
  size?: "compact" | "full";
  defaultView?: "readable" | "json";
}

export default function DecodedFields({
  fields,
  size = "compact",
  defaultView = "readable",
}: DecodedFieldsProps) {
  const [view, setView] = useState<"readable" | "json">(defaultView);
  const rows = useMemo(() => readableFields(fields), [fields]);

  if (rows.length === 0) {
    return (
      <p className="text-xs text-hud-muted">
        This transaction carries no decoded fields.
      </p>
    );
  }

  const compactRows = rows.filter((row) => !row.wide);
  const wideRows = rows.filter((row) => row.wide);

  return (
    <div className="min-w-0 space-y-2 overflow-hidden">
      <div className="flex items-center justify-between gap-3">
        <p className="hud-label text-[9px]">Decoded fields ({rows.length})</p>
        <div
          role="group"
          aria-label="Decoded field display format"
          className="flex overflow-hidden rounded border border-panel-border"
        >
          {(["readable", "json"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setView(mode)}
              aria-pressed={view === mode}
              className={clsx(
                "px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
                view === mode
                  ? "bg-electric-cyan/15 text-electric-cyan"
                  : "text-hud-muted hover:text-white",
              )}
            >
              {mode === "readable" ? "Readable" : "JSON"}
            </button>
          ))}
        </div>
      </div>

      {view === "json" ? (
        <pre
          className={clsx(
            "max-w-full overflow-x-auto rounded-lg border border-panel-border bg-space-black p-3 font-mono text-electric-cyan/80 whitespace-pre-wrap break-all",
            size === "full" ? "max-h-96 text-xs p-4" : "max-h-60 text-[10px]",
          )}
        >
          {JSON.stringify(fields, null, 2)}
        </pre>
      ) : (
        <div className="min-w-0 space-y-3 overflow-hidden rounded-lg border border-panel-border/60 bg-space-black/50 p-3">
          <dl
            className={clsx(
              "grid min-w-0 gap-x-6 gap-y-1.5",
              size === "full"
                ? "grid-cols-1 md:grid-cols-2 xl:grid-cols-3"
                : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
            )}
          >
            {compactRows.map((row) => (
              <div
                key={row.key}
                className="flex min-w-0 items-baseline justify-between gap-3 border-b border-panel-border/25 py-1 last:border-0"
              >
                <dt
                  className="min-w-0 shrink truncate text-[11px] text-hud-muted"
                  title={row.key}
                >
                  {row.label}
                </dt>
                <dd className="min-w-0 max-w-[65%] text-right">
                  <span className="block break-words font-mono text-[11px] tabular-nums text-white/90">
                    {row.value}
                  </span>
                  {row.note && (
                    <span className="block text-[9px] text-neon-amber">{row.note}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>

          {wideRows.map((row) => (
            <div
              key={row.key}
              className="min-w-0 border-t border-panel-border/40 pt-2 first:border-0 first:pt-0"
            >
              <p className="hud-label text-[9px]" title={row.key}>
                {row.label}
              </p>
              {row.entries ? (
                <dl className="mt-1.5 grid min-w-0 grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                  {row.entries.map((entry) => (
                    <div
                      key={entry.label}
                      className="flex min-w-0 items-baseline justify-between gap-3"
                    >
                      <dt className="min-w-0 truncate text-[11px] text-hud-muted">
                        {entry.label}
                      </dt>
                      <dd className="min-w-0 max-w-[65%] break-words text-right font-mono text-[11px] tabular-nums text-white/90">
                        {entry.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="mt-1 break-words text-[12px] leading-relaxed text-white/85">
                  {row.value}
                </p>
              )}
              {row.note && (
                <p className="mt-1 text-[9px] text-neon-amber">{row.note}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
