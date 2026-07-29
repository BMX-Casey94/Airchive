import type { AircraftState, FlightPhase } from "@/types/dashboard";

/**
 * Aircraft appearance on the globe.
 *
 * Colours match the phase palette the fleet grid and detail panels already
 * use, so a green marker on the globe and a green badge in the table mean the
 * same thing. Previously the globe knew only three states — emergency, on the
 * ground, airborne — which made a taxiing aircraft and one climbing out of it
 * look identical.
 */

const PHASE_COLOURS: Record<FlightPhase, string> = {
  PARKED: "#8A94A6",
  TAXI: "#FFB800",
  TAXI_IN: "#FFB800",
  TAKEOFF: "#00F5FF",
  LANDING: "#00F5FF",
  CLIMB: "#4DA3FF",
  DESCENT: "#4DA3FF",
  APPROACH: "#4DA3FF",
  CRUISE: "#22E88A",
  UNKNOWN: "#8A94A6",
};

const EMERGENCY_COLOUR = "#FF3B5C";

const VSI_CLIMB = 300;
const VSI_DESCENT = -300;

/**
 * Sharpens the reported phase with live vertical speed, mirroring
 * `lib/refine-phase.ts`. The backend classifier needs sustained movement
 * before it commits, so without this an aircraft visibly descending can still
 * be painted as cruising for some time.
 */
export function refineGlobePhase(ac: AircraftState): FlightPhase {
  if (ac.onGround) return ac.phase === "UNKNOWN" ? "TAXI" : ac.phase;

  const vr = ac.baroRate;
  if (!Number.isFinite(vr)) return ac.phase;

  if (ac.phase === "CRUISE") {
    if (vr > VSI_CLIMB) return "CLIMB";
    if (vr < VSI_DESCENT) return "DESCENT";
  }
  if (ac.phase === "CLIMB" && vr < VSI_DESCENT) return "DESCENT";
  if (ac.phase === "DESCENT" && vr > VSI_CLIMB) return "CLIMB";

  return ac.phase;
}

export function aircraftColourHex(ac: AircraftState): string {
  if (ac.emergency !== "none") return EMERGENCY_COLOUR;
  return PHASE_COLOURS[refineGlobePhase(ac)] ?? PHASE_COLOURS.UNKNOWN;
}

/* ── Sprite ─────────────────────────────────────────────────────────────── */

/**
 * Right-hand half of an airliner seen from above, nose pointing up, in a
 * coordinate space roughly 64 units tall. The left half is mirrored from it so
 * the shape cannot drift out of symmetry.
 */
const HALF_OUTLINE: ReadonlyArray<readonly [number, number]> = [
  [0, -30],
  [2.2, -26],
  [3.4, -8],
  [29, 5],
  [29, 9.5],
  [4.2, 3],
  [3.6, 17],
  [12.5, 24],
  [12.5, 27.5],
  [2.6, 23],
  [1.8, 29],
  [0, 30],
];

function traceAircraft(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.moveTo(HALF_OUTLINE[0]![0], HALF_OUTLINE[0]![1]);
  for (const [x, y] of HALF_OUTLINE) ctx.lineTo(x, y);
  for (let i = HALF_OUTLINE.length - 1; i >= 0; i--) {
    const [x, y] = HALF_OUTLINE[i]!;
    ctx.lineTo(-x, y);
  }
  ctx.closePath();
}

function shade(hex: string, amount: number): string {
  const value = hex.replace("#", "");
  const num = Number.parseInt(value, 16);
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const r = clamp(((num >> 16) & 0xff) + amount);
  const g = clamp(((num >> 8) & 0xff) + amount);
  const b = clamp((num & 0xff) + amount);
  return `rgb(${r}, ${g}, ${b})`;
}

const spriteCache = new Map<string, HTMLCanvasElement>();

/**
 * Draws the aircraft marker to a canvas.
 *
 * Generated rather than loaded as an image for three reasons: it is rendered
 * at the display's true pixel density so it stays crisp where a fixed-size PNG
 * went soft; the lighting is baked per colour, which reads as a solid object
 * instead of the flat silhouette a tinted stock icon produced; and it adds no
 * binary asset to serve.
 *
 * Cached per colour, so the handful of phase colours share a few textures
 * between hundreds of aircraft rather than one per marker.
 */
export function aircraftSprite(colourHex: string, pixelRatio: number): HTMLCanvasElement {
  const scale = Math.min(Math.max(pixelRatio, 1), 3);
  const key = `${colourHex}@${scale}`;
  const cached = spriteCache.get(key);
  if (cached) return cached;

  const size = 72;
  const canvas = document.createElement("canvas");
  canvas.width = size * scale;
  canvas.height = size * scale;

  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  ctx.scale(scale, scale);
  ctx.translate(size / 2, size / 2);

  // Soft halo so aircraft stay legible against bright terrain and dark ocean
  // alike, which a hard-edged silhouette does not.
  ctx.save();
  ctx.shadowColor = colourHex;
  ctx.shadowBlur = 7;
  ctx.fillStyle = colourHex;
  traceAircraft(ctx);
  ctx.fill();
  ctx.restore();

  // Light from the upper left, so the body reads as rounded rather than cut
  // from paper.
  const body = ctx.createLinearGradient(-24, -24, 22, 26);
  body.addColorStop(0, shade(colourHex, 70));
  body.addColorStop(0.45, colourHex);
  body.addColorStop(1, shade(colourHex, -62));

  traceAircraft(ctx);
  ctx.fillStyle = body;
  ctx.fill();

  ctx.lineJoin = "round";
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = shade(colourHex, -95);
  ctx.stroke();

  // Spine highlight along the fuselage completes the raised-body illusion.
  const spine = ctx.createLinearGradient(0, -30, 0, 30);
  spine.addColorStop(0, "rgba(255,255,255,0.92)");
  spine.addColorStop(0.55, "rgba(255,255,255,0.34)");
  spine.addColorStop(1, "rgba(255,255,255,0)");
  ctx.beginPath();
  ctx.moveTo(-0.9, -26);
  ctx.lineTo(0.9, -26);
  ctx.lineTo(1.3, 24);
  ctx.lineTo(-1.3, 24);
  ctx.closePath();
  ctx.fillStyle = spine;
  ctx.fill();

  spriteCache.set(key, canvas);
  return canvas;
}
