import type { EmergencyString, TelemetryRecord } from "@airchive/types";

export const EMERGENCY_SQUAWK_MAP: Readonly<Record<string, string>> = {
  "7700": "General Emergency",
  "7600": "Radio Failure",
  "7500": "Hijack/Unlawful Interference",
};

const EMERGENCY_FIELD_LABELS: Readonly<Partial<Record<EmergencyString, string>>> = {
  general: "General emergency",
  lifeguard: "Lifeguard / medical",
  minfuel: "Minimum fuel",
  nordo: "Loss of communication",
  unlawful: "Unlawful interference",
  downed: "Aircraft downed",
};

function normaliseSquawk(raw: string | undefined): string {
  if (raw == null) return "";
  const s = String(raw).trim();
  if (s.length === 0) return "";
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 4) return digits.slice(-4);
  return digits.padStart(4, "0");
}

export function isEmergencyCondition(record: TelemetryRecord): boolean {
  const code = normaliseSquawk(record.squawk);
  if (code === "7700" || code === "7600" || code === "7500") return true;

  const em = record.emergency;
  if (em === undefined || em === null) return false;
  if (em === "none") return false;
  return true;
}

export function getEmergencyDescription(record: TelemetryRecord): string | null {
  const code = normaliseSquawk(record.squawk);
  const squawkLabel = EMERGENCY_SQUAWK_MAP[code];

  const em = record.emergency;
  const fieldActive =
    em !== undefined && em !== null && em !== "none";
  const fieldLabel = fieldActive ? EMERGENCY_FIELD_LABELS[em as EmergencyString] : undefined;

  if (squawkLabel && fieldLabel) {
    return `Squawk ${code} — ${squawkLabel}; ${fieldLabel}`;
  }
  if (squawkLabel) {
    return `Squawk ${code} — ${squawkLabel}`;
  }
  if (fieldLabel) {
    return fieldLabel;
  }
  return null;
}
