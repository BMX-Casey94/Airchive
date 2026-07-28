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
}

const SQUAWK_MEANING: Record<string, string> = {
  "7500": "Unlawful interference (hijack)",
  "7600": "Radio failure",
  "7700": "General emergency",
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
  event: { label: "Flight event", group: 7 },
  phase: { label: "Flight phase", group: 7 },
};

/** Field names whose numeric value is epoch milliseconds, not a measurement. */
const EPOCH_FIELDS = new Set(["ts", "timestamp", "time"]);

function humaniseKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(key: string, value: unknown, spec?: FieldSpec): string {
  if (value === null || value === undefined || value === "") return "—";

  if (typeof value === "boolean") return value ? "Yes" : "No";

  if (typeof value === "number") {
    if (EPOCH_FIELDS.has(key) && value > 1_000_000_000_000) {
      return new Date(value).toLocaleString("en-GB");
    }
    const formatted = Number.isInteger(value)
      ? value.toLocaleString("en-GB")
      : value.toLocaleString("en-GB", { maximumFractionDigits: 6 });
    return spec?.unit ? `${formatted} ${spec.unit}` : formatted;
  }

  if (Array.isArray(value)) {
    return value.length === 0 ? "None" : value.map(String).join(", ");
  }

  if (typeof value === "object") return JSON.stringify(value);

  return spec?.unit ? `${String(value)} ${spec.unit}` : String(value);
}

interface ReadableRow {
  key: string;
  label: string;
  value: string;
  note: string | null;
  group: number;
}

export function readableFields(fields: Record<string, unknown>): ReadableRow[] {
  return Object.entries(fields)
    .map(([key, value]) => {
      const spec = FIELD_SPECS[key];
      return {
        key,
        label: spec?.label ?? humaniseKey(key),
        value: formatValue(key, value, spec),
        note: spec?.describe?.(value) ?? null,
        // Unmapped fields sort last rather than being hidden — the archive
        // should never quietly drop something it wrote on-chain.
        group: spec?.group ?? 99,
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

  return (
    <div className="space-y-2">
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
            "overflow-auto rounded-lg border border-panel-border bg-space-black p-3 font-mono text-electric-cyan/80",
            size === "full" ? "max-h-96 text-xs p-4" : "max-h-60 text-[10px]",
          )}
        >
          {JSON.stringify(fields, null, 2)}
        </pre>
      ) : (
        <dl
          className={clsx(
            "grid gap-x-6 gap-y-1.5 rounded-lg border border-panel-border/60 bg-space-black/50 p-3",
            size === "full"
              ? "grid-cols-1 md:grid-cols-2 xl:grid-cols-3"
              : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
          )}
        >
          {rows.map((row) => (
            <div
              key={row.key}
              className="flex items-baseline justify-between gap-3 border-b border-panel-border/25 py-1 last:border-0"
            >
              <dt className="min-w-0 truncate text-[11px] text-hud-muted" title={row.key}>
                {row.label}
              </dt>
              <dd className="shrink-0 text-right">
                <span className="font-mono text-[11px] tabular-nums text-white/90">
                  {row.value}
                </span>
                {row.note && (
                  <span className="block text-[9px] text-neon-amber">{row.note}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
