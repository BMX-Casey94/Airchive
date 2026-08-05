/**
 * Normalise an ADS-B / Mode S callsign for storage and display.
 *
 * Identification messages encode eight characters from a 64-char alphabet
 * where code 0 is the empty pad, conventionally rendered as `@`. Feeds often
 * forward those pads literally, so an unset callsign arrives as `@@@@@@@@`,
 * and a short one as e.g. `BAW15@@@`. Treat pads and other filler as absent.
 */
export function normaliseCallsign(
  raw: string | null | undefined,
  icao?: string | null,
): string | null {
  if (raw == null) return null;

  const cs = raw.replace(/@/g, "").trim().toUpperCase();
  if (!cs) return null;

  // Reject pure filler / non-identity noise.
  if (/^[\-_.?#*]+$/.test(cs)) return null;
  if (!/[A-Z0-9]/.test(cs)) return null;

  const hex = icao?.trim().toUpperCase();
  if (hex && cs === hex) return null;

  return cs;
}
