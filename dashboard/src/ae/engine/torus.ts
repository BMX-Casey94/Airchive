import * as THREE from "three";
import { DISC_RADIUS } from "./projection";

/**
 * The toroidal energy field emanating from the North Pole.
 *
 * Geometry: a cage of poloidal field-line loops — circles in vertical planes
 * through the polar axis, each passing through the pole itself. A loop of
 * scale `c` rises to +c above the disc plane, dips to −c below it (exactly
 * centred on the baseline, as specified) and reaches a ground radius of 2c;
 * the outermost shell is sized so its far edge lands just beyond the disc
 * rim. Several shells at twelve azimuths read as a classic dipole/toroid.
 *
 * Motion: each vertex carries its arc-length parameter; the fragment shader
 * runs comet-like pulses along it, flowing out of the pole, up and over,
 * down past the rim, underneath, and back into the pole. The lines
 * themselves stay barely visible so the structure is felt more than seen.
 */

const SHELL_FRACTIONS = [0.16, 0.3, 0.46, 0.64, 0.82, 1.0];
const SPOKES = 12;
const SEGMENTS_PER_LOOP = 128;
/** Outermost loop ground-reach as a multiple of the disc radius. */
const MAX_REACH = 1.06;

const VERTEX = /* glsl */ `
  attribute float aT;
  attribute float aSeed;
  varying float vT;
  varying float vSeed;
  void main() {
    vT = aT;
    vSeed = aSeed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec3 uColor;
  varying float vT;
  varying float vSeed;

  void main() {
    // One full lap every ~18 s, phase-shifted per loop so the field shimmers
    // rather than strobing in unison. Two pulses live on each loop.
    float flow = fract(vT - uTime * 0.055 + vSeed);
    float p = fract(flow * 2.0);
    float comet = exp(-p * 9.0);

    float base = 0.045;
    vec3 color = uColor * (base + comet * 1.7);
    float alpha = base + comet * 0.85;
    gl_FragColor = vec4(color, alpha);
  }
`;

export interface TorusHandle {
  object: THREE.Object3D;
  update: (elapsedSeconds: number) => void;
  dispose: () => void;
}

export function createToroidalField(): TorusHandle {
  const cMax = (DISC_RADIUS * MAX_REACH) / 2;

  const positions: number[] = [];
  const ts: number[] = [];
  const seeds: number[] = [];

  for (const frac of SHELL_FRACTIONS) {
    for (let s = 0; s < SPOKES; s += 1) {
      const phi = (s / SPOKES) * Math.PI * 2;
      // Small per-loop jitter keeps the cage organic instead of machined.
      const jitter = 1 + 0.04 * Math.sin(s * 12.9898 + frac * 78.233);
      const c = cMax * frac * jitter;
      const seed = ((s * 37 + frac * 101) % 17) / 17;

      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);

      let prev: [number, number, number] | null = null;
      let prevT = 0;
      for (let i = 0; i <= SEGMENTS_PER_LOOP; i += 1) {
        const t = i / SEGMENTS_PER_LOOP;
        // t=0 at the pole, 0.25 apex above, 0.5 at the rim, 0.75 below.
        const alpha = Math.PI - t * Math.PI * 2;
        const rho = c * (1 + Math.cos(alpha));
        const y = c * Math.sin(alpha);
        const point: [number, number, number] = [
          rho * sinPhi,
          y,
          rho * cosPhi,
        ];
        if (prev) {
          positions.push(prev[0], prev[1], prev[2], point[0], point[1], point[2]);
          ts.push(prevT, t);
          seeds.push(seed, seed);
        }
        prev = point;
        prevT = t;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aT", new THREE.Float32BufferAttribute(ts, 1));
  geometry.setAttribute("aSeed", new THREE.Float32BufferAttribute(seeds, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color("#00e0ff") },
    },
  });

  const lines = new THREE.LineSegments(geometry, material);
  lines.renderOrder = 3;
  lines.frustumCulled = false;

  return {
    object: lines,
    update(elapsedSeconds) {
      material.uniforms.uTime.value = elapsedSeconds;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
