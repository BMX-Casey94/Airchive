import * as THREE from "three";
import { DISC_RADIUS, UNITS_PER_RADIAN } from "./projection";

/**
 * The AE disc itself. A single circle whose fragment shader runs the inverse
 * azimuthal-equidistant projection per pixel: disc XZ → colatitude/longitude →
 * equirectangular UV. Sampling NASA's equirect imagery this way is exact at
 * every zoom level — there is no pre-warped raster to blur or seam.
 *
 * Day/night comes from a real subsolar position: the night side falls back to
 * a deep-blue read of the day texture plus Black Marble city lights, and the
 * terminator is a soft dot-product ramp against the sphere normal (the disc
 * is a projection of a sphere, so lighting uses sphere normals, not the
 * disc's flat normal).
 */

const VERTEX = /* glsl */ `
  varying vec2 vPos;
  void main() {
    vPos = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;

  uniform sampler2D uDay;
  uniform sampler2D uNight;
  uniform float uHasDay;
  uniform float uHasNight;
  uniform float uTexFade;
  uniform float uDim;
  uniform vec3 uSunDir;
  uniform float uRadius;
  uniform float uUnitsPerRadian;

  varying vec2 vPos;

  out vec4 outColor;

  const float PI = 3.141592653589793;

  void main() {
    float rho = length(vPos);
    // The surface dissolves over the last fraction of a percent of the
    // radius rather than ending on a hard circle, so the imagery feathers
    // into the void and the rim glow has something to bloom out of.
    float edge = 1.0 - smoothstep(uRadius * 0.986, uRadius, rho);
    if (edge <= 0.001) discard;

    float colat = rho / uUnitsPerRadian;
    float lat = PI * 0.5 - colat;
    float lon = atan(vPos.x, vPos.y);
    vec2 uv = vec2(lon / (2.0 * PI) + 0.5, lat / PI + 0.5);

    // The u coordinate jumps 0<->1 along the antimeridian ray; correct the
    // screen-space derivatives there so mip selection cannot draw a seam.
    vec2 ddxUv = dFdx(uv);
    vec2 ddyUv = dFdy(uv);
    if (abs(ddxUv.x) > 0.5) ddxUv.x -= sign(ddxUv.x);
    if (abs(ddyUv.x) > 0.5) ddyUv.x -= sign(ddyUv.x);

    vec3 sphereNormal = vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
    float sunDot = dot(sphereNormal, uSunDir);
    float dayF = smoothstep(-0.03, 0.18, sunDot);

    // Vector-mode base: deep ocean navy, still day/night shaded.
    vec3 color = vec3(0.030, 0.055, 0.095) * (0.45 + 0.55 * dayF);

    if (uHasDay > 0.5) {
      vec3 day = textureGrad(uDay, uv, ddxUv, ddyUv).rgb;
      vec3 nightBase = day * vec3(0.11, 0.16, 0.26);
      vec3 lit = mix(nightBase, day, dayF);
      color = mix(color, lit, uTexFade);
    }

    if (uHasNight > 0.5) {
      vec3 lights = textureGrad(uNight, uv, ddxUv, ddyUv).rgb;
      color += lights * vec3(1.0, 0.82, 0.55) * 1.35 * (1.0 - dayF) * uTexFade;
    }

    // Gentle radial falloff so the rim reads as a physical edge.
    color *= 1.0 - 0.16 * smoothstep(0.72 * uRadius, uRadius, rho);

    // User-toggled dim: halve the map's brightness so overlaid aircraft and
    // trails dominate. Brightness, not alpha — the disc must stay opaque or
    // the void gradient would read through the surface.
    color *= 1.0 - 0.5 * uDim;

    outColor = vec4(color, edge);
  }
`;

/**
 * Rim glow. A single ring whose radial profile is a gaussian core line at the
 * disc boundary plus an outward halo that decays to exactly zero — value and
 * gradient both — before the geometry ends. Nothing terminates on an edge, so
 * the band feathers into the void instead of stopping at a visible circle.
 */
const RIM_VERTEX = /* glsl */ `
  varying float vR;
  void main() {
    vR = length(position.xy);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RIM_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform float uRadius;
  uniform vec3 uCoreColor;
  uniform vec3 uHaloColor;
  uniform float uCoreAlpha;
  uniform float uHaloAlpha;
  uniform float uCoreWidth;
  uniform float uHaloReach;

  varying float vR;

  void main() {
    float d = vR - uRadius;

    float core = exp(-(d * d) / (uCoreWidth * uCoreWidth));

    float t = clamp(max(d, 0.0) / uHaloReach, 0.0, 1.0);
    float halo = pow(1.0 - t, 2.6);

    float alpha = uCoreAlpha * core + uHaloAlpha * halo;
    if (alpha < 0.002) discard;

    gl_FragColor = vec4(mix(uHaloColor, uCoreColor, core), alpha);
  }
`;

/** World-unit spread of the bright edge line either side of the boundary. */
const RIM_CORE_WIDTH = 0.055;
/** How far the halo reaches beyond the boundary before it is exactly zero. */
const RIM_HALO_REACH = 0.78;

export interface DiscHandle {
  group: THREE.Group;
  setSunDirection: (v: [number, number, number]) => void;
  /** Dim the map surface to half brightness so overlays stand out. */
  setDimmed: (dimmed: boolean) => void;
  /** Advance the texture fade-in and dim transition; call each frame. */
  update: (dt: number) => void;
  loadTextures: (dayUrl: string, nightUrl: string) => void;
  dispose: () => void;
}

function configureEquirect(tex: THREE.Texture, renderer: THREE.WebGLRenderer): void {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
}

export function createDisc(renderer: THREE.WebGLRenderer): DiscHandle {
  const group = new THREE.Group();

  const geometry = new THREE.CircleGeometry(DISC_RADIUS * 1.002, 256);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: true,
    uniforms: {
      uDay: { value: null },
      uNight: { value: null },
      uHasDay: { value: 0 },
      uHasNight: { value: 0 },
      uTexFade: { value: 0 },
      uDim: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uRadius: { value: DISC_RADIUS },
      uUnitsPerRadian: { value: UNITS_PER_RADIAN },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 0;
  group.add(mesh);

  // Rim: a crisp cyan edge line bleeding into a wide halo, both feathered to
  // nothing by the shader profile; the bloom pass turns them into the disc's
  // premium "contained world" glow. The geometry is deliberately wider than
  // the halo reaches, so the ring's own outer edge is never visible.
  const rimGeometry = new THREE.RingGeometry(
    DISC_RADIUS * 0.982,
    DISC_RADIUS * 1.088,
    256,
  );
  const rimMaterial = new THREE.ShaderMaterial({
    vertexShader: RIM_VERTEX,
    fragmentShader: RIM_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uRadius: { value: DISC_RADIUS },
      uCoreColor: { value: new THREE.Color("#00f5ff") },
      uHaloColor: { value: new THREE.Color("#0aa8c8") },
      uCoreAlpha: { value: 0.55 },
      uHaloAlpha: { value: 0.16 },
      uCoreWidth: { value: RIM_CORE_WIDTH },
      uHaloReach: { value: RIM_HALO_REACH },
    },
  });
  const rim = new THREE.Mesh(rimGeometry, rimMaterial);
  rim.rotation.x = -Math.PI / 2;
  rim.renderOrder = 2;
  group.add(rim);

  let texFadeTarget = 0;
  let dimTarget = 0;
  const loader = new THREE.TextureLoader();

  const handle: DiscHandle = {
    group,

    setSunDirection(v) {
      (material.uniforms.uSunDir.value as THREE.Vector3).set(v[0], v[1], v[2]).normalize();
    },

    setDimmed(dimmed) {
      dimTarget = dimmed ? 1 : 0;
    },

    update(dt) {
      const fade = material.uniforms.uTexFade;
      if (fade.value < texFadeTarget) {
        fade.value = Math.min(texFadeTarget, fade.value + dt * 0.8);
      }
      const dim = material.uniforms.uDim;
      const delta = dimTarget - (dim.value as number);
      if (Math.abs(delta) > 1e-4) {
        dim.value = (dim.value as number)
          + Math.sign(delta) * Math.min(Math.abs(delta), dt * 3);
      }
    },

    loadTextures(dayUrl, nightUrl) {
      loader.load(dayUrl, (tex) => {
        configureEquirect(tex, renderer);
        material.uniforms.uDay.value = tex;
        material.uniforms.uHasDay.value = 1;
        texFadeTarget = 1;
      });
      loader.load(nightUrl, (tex) => {
        configureEquirect(tex, renderer);
        material.uniforms.uNight.value = tex;
        material.uniforms.uHasNight.value = 1;
        texFadeTarget = 1;
      });
    },

    dispose() {
      geometry.dispose();
      material.dispose();
      rimGeometry.dispose();
      rimMaterial.dispose();
      const day = material.uniforms.uDay.value as THREE.Texture | null;
      const night = material.uniforms.uNight.value as THREE.Texture | null;
      day?.dispose();
      night?.dispose();
    },
  };

  return handle;
}
