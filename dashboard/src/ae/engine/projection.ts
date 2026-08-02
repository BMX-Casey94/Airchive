/**
 * Azimuthal Equidistant projection, north-polar aspect, plus the small pieces
 * of solar and spherical geometry the AE scene needs.
 *
 * World-space convention: the disc lies in the XZ plane with the North Pole
 * at the origin and Y up. Longitude 0° points toward +Z (so with the default
 * camera the Americas sit left and Asia right, matching the classic
 * pole-centred AE layout), longitude +90°E toward +X.
 */

export const DISC_RADIUS = 10;

/** Disc radius spans a colatitude of π (pole to the Antarctic rim). */
export const UNITS_PER_RADIAN = DISC_RADIUS / Math.PI;

/**
 * Vertical exaggeration for altitude, in world units per foot. Real scale
 * would make a cruising airliner invisibly close to the disc: 40,000 ft is
 * ~12 km against a 20,000 km disc radius. This lifts cruise to ~0.06 units —
 * enough for subtle relief, but shallow enough that a climb-out doesn't
 * render as a steep glowing ramp above the departure airport.
 */
export const ALT_UNITS_PER_FT = 1.6e-6;

/** Minimum lift above the disc so trails never z-fight the surface. */
export const TRAIL_BASE_LIFT = 0.02;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Forward AEQD projection to world space. Altitude in feet. */
export function projectLatLon(
  lat: number,
  lon: number,
  altFt = 0,
  out?: [number, number, number],
): [number, number, number] {
  const colat = (90 - lat) * DEG2RAD;
  const rho = colat * UNITS_PER_RADIAN;
  const lonRad = lon * DEG2RAD;
  const target = out ?? [0, 0, 0];
  target[0] = rho * Math.sin(lonRad);
  target[1] = TRAIL_BASE_LIFT + Math.max(0, altFt) * ALT_UNITS_PER_FT;
  target[2] = rho * Math.cos(lonRad);
  return target;
}

/**
 * World-space yaw (radians, for `Object3D.rotation.y`) of an aircraft whose
 * ADS-B track is `trackDeg` at longitude `lonDeg`. On a north-polar AE disc,
 * local north at any point is the direction toward the disc centre, so the
 * on-screen heading depends on longitude as well as track.
 */
export function trackToWorldYaw(trackDeg: number, lonDeg: number): number {
  const t = trackDeg * DEG2RAD;
  const l = lonDeg * DEG2RAD;
  return Math.atan2(Math.sin(t - l), -Math.cos(t - l));
}

/**
 * Subsolar point (the lat/lon where the sun is directly overhead) from a
 * standard low-precision solar ephemeris — accurate to well under a degree,
 * which is far tighter than a terminator gradient can show.
 */
export function subsolarPoint(date: Date): { lat: number; lon: number } {
  const ms = date.getTime();
  const d = ms / 86_400_000 - 10_957.5; // days since J2000.0

  const g = (357.529 + 0.98560028 * d) * DEG2RAD; // mean anomaly
  const q = 280.459 + 0.98564736 * d; // mean longitude (deg)
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG2RAD;
  const e = (23.439 - 0.00000036 * d) * DEG2RAD; // obliquity

  const lat = Math.asin(Math.sin(e) * Math.sin(L)) * RAD2DEG; // declination

  // Equation of time: mean solar longitude minus right ascension.
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) * RAD2DEG;
  let eqTimeDeg = (((q - ra) % 360) + 540) % 360 - 180;

  const utcHours = ((ms % 86_400_000) + 86_400_000) % 86_400_000 / 3_600_000;
  let lon = -15 * (utcHours - 12) - eqTimeDeg;
  lon = ((lon % 360) + 540) % 360 - 180;

  return { lat, lon };
}

/** Unit vector for a lat/lon on the sphere, same frame as the disc shader. */
export function latLonToUnitVector(
  latDeg: number,
  lonDeg: number,
): [number, number, number] {
  const lat = latDeg * DEG2RAD;
  const lon = lonDeg * DEG2RAD;
  return [
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
    Math.cos(lat) * Math.cos(lon),
  ];
}

/**
 * Great-circle interpolator between two lat/lon points, with the endpoint
 * vectors precomputed so `at()` stays cheap inside a densification loop.
 * Interpolating linearly in lat/lon instead traces a rhumb-like path that
 * bows away from the true route over long spans — very visible on the outer
 * half of the disc, where AE stretches east-west distances several fold.
 */
export function greatCircle(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): { omegaDeg: number; at: (t: number) => [number, number] } {
  const a = latLonToUnitVector(lat1, lon1);
  const b = latLonToUnitVector(lat2, lon2);
  const dot = Math.min(
    1,
    Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]),
  );
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);

  return {
    omegaDeg: omega * RAD2DEG,
    at(t: number): [number, number] {
      // Coincident or antipodal endpoints have no well-defined arc; both are
      // degenerate for a trail segment, so hold the start point.
      if (sinOmega < 1e-8) return [lat1, lon1];
      const s1 = Math.sin((1 - t) * omega) / sinOmega;
      const s2 = Math.sin(t * omega) / sinOmega;
      const x = a[0] * s1 + b[0] * s2;
      const y = a[1] * s1 + b[1] * s2;
      const z = a[2] * s1 + b[2] * s2;
      const r = Math.hypot(x, y, z) || 1;
      return [
        Math.asin(Math.min(1, Math.max(-1, y / r))) * RAD2DEG,
        Math.atan2(x, z) * RAD2DEG,
      ];
    },
  };
}

const EARTH_RADIUS_MILES = 3958.7613;

/** Great-circle distance in miles. */
export function haversineMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const p1 = lat1 * DEG2RAD;
  const p2 = lat2 * DEG2RAD;
  const dp = (lat2 - lat1) * DEG2RAD;
  const dl = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dp / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Emit `a`→`b` as one or more short segments, subdividing in lat/lon space so
 * long edges follow parallels and meridians instead of cutting straight
 * chords across the disc — essential near the rim where AE distortion is
 * extreme. Vertices are pushed as flat XYZ triples onto `target` in
 * line-segment pairs.
 */
export function pushDensifiedSegment(
  target: number[],
  aLon: number,
  aLat: number,
  bLon: number,
  bLat: number,
  y: number,
  maxStepDeg = 0.75,
): void {
  const dLat = Math.abs(bLat - aLat);
  const dLon = Math.abs(bLon - aLon);
  const steps = Math.max(1, Math.ceil(Math.max(dLat, dLon) / maxStepDeg));

  let prev = projectLatLon(aLat, aLon, 0);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const lat = aLat + (bLat - aLat) * t;
    const lon = aLon + (bLon - aLon) * t;
    const next = projectLatLon(lat, lon, 0);
    target.push(prev[0], y, prev[2], next[0], y, next[2]);
    prev = next;
  }
}
