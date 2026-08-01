import * as THREE from "three";
import { DISC_RADIUS } from "./projection";

/**
 * The toroidal energy field emanating from the North Pole.
 *
 * Three layers combine for the dense "plasma torus" look:
 *
 * 1. Field-line cage — poloidal loops through the pole, but each loop is
 *    helically twisted: as it travels pole → apex → rim → underside → pole it
 *    also advances in azimuth, so the cage swirls instead of reading as
 *    machined ribs. Twist direction alternates per shell (the interleaved
 *    counter-swirl of the reference imagery). Because every loop starts and
 *    ends exactly at the pole (ρ = 0), any twist amount still closes cleanly.
 * 2. Particle flow — thousands of points advected along the same field lines
 *    entirely in the vertex shader; only a clock uniform changes per frame.
 * 3. Axial beam — a bright column up and down through the pole axis.
 *
 * Colour runs cyan at the inner shells to violet at the outer ones. Every
 * loop remains exactly centred on the disc baseline: apex +c, underside −c.
 */

const SHELL_FRACTIONS = [0.14, 0.26, 0.38, 0.52, 0.66, 0.8, 0.92, 1.0];
const SPOKES = 24;
const SEGMENTS_PER_LOOP = 160;
const PARTICLE_COUNT = 2200;
/** Outermost loop ground-reach as a multiple of the disc radius. */
const MAX_REACH = 1.06;

const COLOR_INNER = new THREE.Color("#22e8ff");
const COLOR_OUTER = new THREE.Color("#b44dff");

/** Twist (azimuthal turns per poloidal lap) for a shell fraction. */
function shellTwist(frac: number): number {
  return 0.45 + 1.35 * frac;
}

function shellColor(frac: number, out: THREE.Color): THREE.Color {
  return out.copy(COLOR_INNER).lerp(COLOR_OUTER, Math.pow(frac, 1.2));
}

/* ── Field-line cage ─────────────────────────────────────────── */

const LINE_VERTEX = /* glsl */ `
  attribute float aT;
  attribute float aSeed;
  attribute vec3 aColor;
  varying float vT;
  varying float vSeed;
  varying vec3 vColor;
  void main() {
    vT = aT;
    vSeed = aSeed;
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const LINE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uDim;
  varying float vT;
  varying float vSeed;
  varying vec3 vColor;

  void main() {
    // Both ends of every loop converge on the pole; feather them away so
    // lines emerge from and dissolve into nothing rather than terminating.
    float taper = smoothstep(0.0, 0.14, vT) * smoothstep(1.0, 0.86, vT);

    // Comet pulses flowing pole -> apex -> rim -> underside -> pole, with a
    // feathered leading edge and a long exponential tail — no hard ends.
    float flow = fract(vT - uTime * 0.055 + vSeed);
    float p = fract(flow * 2.0);
    float comet = smoothstep(0.0, 0.07, p) * exp(-p * 7.0);

    float base = 0.03;
    vec3 color = vColor * (base + comet * 2.4);
    float alpha = (base + comet * 1.05) * taper * (1.0 - 0.5 * uDim);
    gl_FragColor = vec4(color, alpha);
  }
`;

function buildCage(cMax: number): {
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
} {
  const positions: number[] = [];
  const ts: number[] = [];
  const seeds: number[] = [];
  const colors: number[] = [];
  const tint = new THREE.Color();

  SHELL_FRACTIONS.forEach((frac, shellIndex) => {
    const twist = shellTwist(frac);
    const dir = shellIndex % 2 === 0 ? 1 : -1;
    shellColor(frac, tint);

    for (let s = 0; s < SPOKES; s += 1) {
      const phi0 = (s / SPOKES) * Math.PI * 2;
      // Small per-loop jitter keeps the cage organic instead of machined.
      const jitter = 1 + 0.035 * Math.sin(s * 12.9898 + frac * 78.233);
      const c = cMax * frac * jitter;
      const seed = ((s * 37 + frac * 101) % 17) / 17;

      let prev: [number, number, number] | null = null;
      let prevT = 0;
      for (let i = 0; i <= SEGMENTS_PER_LOOP; i += 1) {
        const t = i / SEGMENTS_PER_LOOP;
        // t=0 at the pole, 0.25 apex above, 0.5 at the rim, 0.75 below.
        const alpha = Math.PI - t * Math.PI * 2;
        const rho = c * (1 + Math.cos(alpha));
        const y = c * Math.sin(alpha);
        const phi = phi0 + dir * twist * Math.PI * 2 * t;
        const point: [number, number, number] = [
          rho * Math.sin(phi),
          y,
          rho * Math.cos(phi),
        ];
        if (prev) {
          positions.push(prev[0], prev[1], prev[2], point[0], point[1], point[2]);
          ts.push(prevT, t);
          seeds.push(seed, seed);
          colors.push(tint.r, tint.g, tint.b, tint.r, tint.g, tint.b);
        }
        prev = point;
        prevT = t;
      }
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aT", new THREE.Float32BufferAttribute(ts, 1));
  geometry.setAttribute("aSeed", new THREE.Float32BufferAttribute(seeds, 1));
  geometry.setAttribute("aColor", new THREE.Float32BufferAttribute(colors, 3));

  const material = new THREE.ShaderMaterial({
    vertexShader: LINE_VERTEX,
    fragmentShader: LINE_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uDim: { value: 0 } },
  });

  return { geometry, material };
}

/* ── Particle flow ───────────────────────────────────────────── */

const PARTICLE_VERTEX = /* glsl */ `
  attribute float aShell;
  attribute float aPhi0;
  attribute float aDir;
  attribute float aTwist;
  attribute float aSeed;
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uTime;
  varying vec3 vColor;
  varying float vFade;

  const float TWO_PI = 6.28318530718;
  const float PI = 3.14159265359;

  void main() {
    // Each particle rides its field line at its own speed and phase.
    float speed = 0.05 * (0.6 + 0.8 * fract(aSeed * 7.31));
    float t = fract(aSeed + uTime * speed);

    float alphaAng = PI - t * TWO_PI;
    float rho = aShell * (1.0 + cos(alphaAng));
    float y = aShell * sin(alphaAng);
    float phi = aPhi0 + aDir * aTwist * TWO_PI * t;
    vec3 pos = vec3(rho * sin(phi), y, rho * cos(phi));

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // Swell mid-lap, shrink into the pole at both ends.
    float swell = 0.45 + 0.75 * sin(PI * t);
    gl_PointSize = min(aSize * swell * (22.0 / max(1.0, -mvPosition.z)), 7.0);

    vColor = aColor;
    // Feather fully to nothing at both ends of the lap. sin() dips a hair
    // negative at the seam, and pow of a negative is NaN in GLSL — clamp.
    vFade = pow(max(sin(PI * t), 0.0), 1.3);
  }
`;

const PARTICLE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uDim;
  varying vec3 vColor;
  varying float vFade;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float alpha = smoothstep(0.5, 0.08, d) * 0.3 * vFade * (1.0 - 0.5 * uDim);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(vColor * (0.7 + 0.9 * vFade), alpha);
  }
`;

function buildParticles(cMax: number): {
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
} {
  const shells = new Float32Array(PARTICLE_COUNT);
  const phis = new Float32Array(PARTICLE_COUNT);
  const dirs = new Float32Array(PARTICLE_COUNT);
  const twists = new Float32Array(PARTICLE_COUNT);
  const seeds = new Float32Array(PARTICLE_COUNT);
  const sizes = new Float32Array(PARTICLE_COUNT);
  const colors = new Float32Array(PARTICLE_COUNT * 3);
  const tint = new THREE.Color();

  // Deterministic pseudo-random so reloads look identical.
  let state = 1234567;
  const rand = (): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };

  for (let i = 0; i < PARTICLE_COUNT; i += 1) {
    // Ride the same discrete shells (and twist directions) as the cage so
    // the particles trace coherent field lines instead of a random cloud.
    // sqrt-bias favours outer shells, whose loops are far longer.
    const shellIndex = Math.min(
      SHELL_FRACTIONS.length - 1,
      Math.floor(Math.sqrt(rand()) * SHELL_FRACTIONS.length),
    );
    const frac = SHELL_FRACTIONS[shellIndex] ?? 1;
    shells[i] = cMax * frac * (0.99 + 0.02 * rand());
    phis[i] = rand() * Math.PI * 2;
    dirs[i] = shellIndex % 2 === 0 ? 1 : -1;
    twists[i] = shellTwist(frac);
    seeds[i] = rand();
    sizes[i] = 1.5 + 4.5 * rand() * rand();

    shellColor(frac, tint);
    colors[i * 3] = tint.r;
    colors[i * 3 + 1] = tint.g;
    colors[i * 3 + 2] = tint.b;
  }

  const geometry = new THREE.BufferGeometry();
  // Positions are computed in the vertex shader; the attribute only needs to
  // exist so three.js knows the draw count.
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(PARTICLE_COUNT * 3), 3),
  );
  geometry.setAttribute("aShell", new THREE.BufferAttribute(shells, 1));
  geometry.setAttribute("aPhi0", new THREE.BufferAttribute(phis, 1));
  geometry.setAttribute("aDir", new THREE.BufferAttribute(dirs, 1));
  geometry.setAttribute("aTwist", new THREE.BufferAttribute(twists, 1));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));

  const material = new THREE.ShaderMaterial({
    vertexShader: PARTICLE_VERTEX,
    fragmentShader: PARTICLE_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uDim: { value: 0 } },
  });

  return { geometry, material };
}

/* ── Axial beam ──────────────────────────────────────────────── */

const BEAM_VERTEX = /* glsl */ `
  varying float vV;
  void main() {
    vV = uv.y * 2.0 - 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BEAM_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uDim;
  varying float vV;

  void main() {
    float falloff = pow(1.0 - abs(vV), 2.2);
    float flicker = 0.85 + 0.15 * sin(uTime * 2.7 + vV * 9.0);
    // Gain capped so the core stays below the bloom threshold's runaway
    // range — the beam should read as a polar axis, not a searchlight.
    vec3 color = uColor * (0.5 + 1.05 * falloff);
    gl_FragColor = vec4(color, falloff * uAlpha * flicker * (1.0 - 0.5 * uDim));
  }
`;

function buildBeam(
  radius: number,
  height: number,
  color: string,
  alpha: number,
): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } {
  const geometry = new THREE.CylinderGeometry(radius, radius, height, 12, 1, true);
  const material = new THREE.ShaderMaterial({
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uAlpha: { value: alpha },
      uDim: { value: 0 },
    },
  });
  return { mesh: new THREE.Mesh(geometry, material), material };
}

/* ── Assembly ────────────────────────────────────────────────── */

export interface TorusHandle {
  object: THREE.Object3D;
  /** Halve field opacity so trails and aircraft stand out. */
  setDimmed: (dimmed: boolean) => void;
  update: (elapsedSeconds: number, dt: number) => void;
  dispose: () => void;
}

export function createToroidalField(): TorusHandle {
  const cMax = (DISC_RADIUS * MAX_REACH) / 2;
  const group = new THREE.Group();

  const cage = buildCage(cMax);
  const cageLines = new THREE.LineSegments(cage.geometry, cage.material);
  cageLines.renderOrder = 3;
  cageLines.frustumCulled = false;
  group.add(cageLines);

  const particles = buildParticles(cMax);
  const points = new THREE.Points(particles.geometry, particles.material);
  points.renderOrder = 3;
  points.frustumCulled = false;
  group.add(points);

  const beamHeight = cMax * 2.6;
  const beamCore = buildBeam(0.026, beamHeight, "#d8fbff", 0.5);
  const beamHalo = buildBeam(0.12, beamHeight * 0.92, "#57ccff", 0.13);
  beamCore.mesh.renderOrder = 3;
  beamHalo.mesh.renderOrder = 3;
  group.add(beamCore.mesh);
  group.add(beamHalo.mesh);

  const materials = [cage.material, particles.material, beamCore.material, beamHalo.material];
  let dimTarget = 0;

  return {
    object: group,
    setDimmed(dimmed) {
      dimTarget = dimmed ? 1 : 0;
    },
    update(elapsedSeconds, dt) {
      for (const m of materials) {
        m.uniforms.uTime.value = elapsedSeconds;
        const dim = m.uniforms.uDim;
        const delta = dimTarget - (dim.value as number);
        if (Math.abs(delta) > 1e-4) {
          dim.value =
            (dim.value as number)
            + Math.sign(delta) * Math.min(Math.abs(delta), dt * 3);
        }
      }
    },
    dispose() {
      cage.geometry.dispose();
      particles.geometry.dispose();
      beamCore.mesh.geometry.dispose();
      beamHalo.mesh.geometry.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
