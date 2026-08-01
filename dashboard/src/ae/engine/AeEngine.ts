import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { AircraftState, PositionSnapshot } from "@/types/dashboard";
import { DISC_RADIUS, latLonToUnitVector, subsolarPoint } from "./projection";
import { createDisc, type DiscHandle } from "./disc";
import { createVectorLayers, type VectorLayersHandle } from "./vectors";
import { createToroidalField, type TorusHandle } from "./torus";
import { TrailsLayer } from "./trails";

/**
 * The /ae scene: a biblical-model AE disc suspended in a pure void — no
 * starfield, no planet-in-space framing; the disc is the world. Orbit is
 * locked to the polar axis, constrained above the horizon, with a restrained
 * bloom pass supplying the glow for the rim, the toroidal field and the
 * selected flight trail.
 */

export interface AeEngineOptions {
  container: HTMLElement;
  onSelect: (icao: string | null) => void;
  onContextLost?: () => void;
}

const VOID_COLOR = 0x02040a;
const CAMERA_HOME = new THREE.Vector3(0, 8.5, 14.5);
const CAMERA_INTRO_START = new THREE.Vector3(0, 30, 0.8);
const INTRO_DURATION_S = 2.4;
const SUN_UPDATE_INTERVAL_S = 60;
const CLICK_MAX_DISTANCE_PX = 6;
const CLICK_MAX_DURATION_MS = 400;
/** The orbit/zoom pivot may roam anywhere on the disc, but not off it. */
const MAX_TARGET_RADIUS = DISC_RADIUS * 0.98;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export class AeEngine {
  private readonly opts: AeEngineOptions;

  private readonly renderer: THREE.WebGLRenderer;

  private readonly scene = new THREE.Scene();

  private readonly camera: THREE.PerspectiveCamera;

  private readonly composer: EffectComposer;

  private readonly bloomPass: UnrealBloomPass;

  private readonly controls: OrbitControls;

  private readonly disc: DiscHandle;

  private readonly vectors: VectorLayersHandle;

  private readonly torus: TorusHandle;

  private readonly trails = new TrailsLayer();

  private readonly raycaster = new THREE.Raycaster();

  private readonly clock = new THREE.Clock();

  private readonly resizeObserver: ResizeObserver;

  private rafId: number | null = null;

  private disposed = false;

  private introElapsed = 0;

  private introDone: boolean;

  private sunTimer = Number.POSITIVE_INFINITY;

  private pointerDown: { x: number; y: number; at: number } | null = null;

  constructor(opts: AeEngineOptions) {
    this.opts = opts;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(VOID_COLOR, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    opts.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.touchAction = "none";

    const { clientWidth: w, clientHeight: h } = opts.container;
    this.camera = new THREE.PerspectiveCamera(46, w / Math.max(1, h), 0.1, 200);

    const reducedMotion =
      typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.introDone = reducedMotion;
    this.camera.position.copy(reducedMotion ? CAMERA_HOME : CAMERA_INTRO_START);
    this.camera.lookAt(0, 0, 0);

    // Scene content.
    this.disc = createDisc(this.renderer);
    this.scene.add(this.disc.group);
    this.disc.loadTextures("/ae/textures/earth-day.jpg", "/ae/textures/earth-night.jpg");

    this.vectors = createVectorLayers();
    this.scene.add(this.vectors.group);

    this.torus = createToroidalField();
    this.scene.add(this.torus.object);

    this.scene.add(this.trails.group);

    // Lighting only affects the aircraft (MeshStandardMaterial); the disc,
    // vectors and field are all unlit shaders. A cool key light plus a cyan
    // rim light give the fuselages their metallic 3D read.
    this.scene.add(new THREE.AmbientLight(0x8fb8d8, 0.55));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.9);
    keyLight.position.set(6, 12, 8);
    this.scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x66d9ff, 0.6);
    rimLight.position.set(-8, 4, -6);
    this.scene.add(rimLight);

    this.updateSun();

    // Post-processing: restrained bloom; only HDR-pushed elements halo.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.max(1, w), Math.max(1, h)),
      0.55,
      0.5,
      0.85,
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    // Free exploration of the whole disc: wheel zoom dives toward the cursor
    // rather than the pole, and right-drag (or two-finger drag) pans the
    // pivot across the surface. `clampTarget` keeps the pivot on the disc so
    // the camera can never wander into empty void.
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = false;
    this.controls.panSpeed = 0.8;
    this.controls.zoomToCursor = true;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 1.1;
    this.controls.maxDistance = 34;
    this.controls.minPolarAngle = 0.05;
    this.controls.maxPolarAngle = 1.35;
    this.controls.enabled = this.introDone;

    this.setSize(w, h);
    this.resizeObserver = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = opts.container;
      this.setSize(clientWidth, clientHeight);
    });
    this.resizeObserver.observe(opts.container);

    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.addEventListener(
      "webglcontextlost",
      this.onContextLost,
      false,
    );
    document.addEventListener("visibilitychange", this.onVisibility);

    this.start();
  }

  /** Feed the scene from the fleet store; call on every store change. */
  syncData(
    aircraft: Map<string, AircraftState>,
    trails: Map<string, PositionSnapshot[]>,
    selectedIcao: string | null,
  ): void {
    if (this.disposed) return;
    this.trails.sync(aircraft, trails, selectedIcao);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.removeEventListener("webglcontextlost", this.onContextLost);

    this.controls.dispose();
    this.trails.dispose();
    this.torus.dispose();
    this.vectors.dispose();
    this.disc.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private setSize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.trails.setResolution(w, h);
  }

  private start(): void {
    const tick = () => {
      if (this.disposed) return;
      this.rafId = requestAnimationFrame(tick);

      const dt = Math.min(0.1, this.clock.getDelta());
      const elapsed = this.clock.elapsedTime;

      if (!this.introDone) {
        this.introElapsed += dt;
        const t = Math.min(1, this.introElapsed / INTRO_DURATION_S);
        const k = easeInOutCubic(t);
        this.camera.position.lerpVectors(CAMERA_INTRO_START, CAMERA_HOME, k);
        this.camera.lookAt(0, 0, 0);
        if (t >= 1) {
          this.introDone = true;
          this.controls.enabled = true;
        }
      } else {
        this.controls.update();
        this.clampTarget();
      }

      this.sunTimer += dt;
      if (this.sunTimer >= SUN_UPDATE_INTERVAL_S) {
        this.updateSun();
      }

      this.disc.update(dt);
      this.torus.update(elapsed);
      this.trails.updateFrame(this.camera, elapsed);

      this.composer.render();
    };
    tick();
  }

  /** Keep the orbit pivot glued to the disc plane and inside its rim. */
  private clampTarget(): void {
    const target = this.controls.target;
    target.y = 0;
    const radial = Math.hypot(target.x, target.z);
    if (radial > MAX_TARGET_RADIUS) {
      const k = MAX_TARGET_RADIUS / radial;
      target.x *= k;
      target.z *= k;
    }
  }

  private updateSun(): void {
    this.sunTimer = 0;
    const { lat, lon } = subsolarPoint(new Date());
    this.disc.setSunDirection(latLonToUnitVector(lat, lon));
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.pointerDown = { x: e.clientX, y: e.clientY, at: performance.now() };
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down) return;

    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    if (
      Math.hypot(dx, dy) > CLICK_MAX_DISTANCE_PX
      || performance.now() - down.at > CLICK_MAX_DURATION_MS
    ) {
      return;
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.trails.pickables, false);
    const icao = hits[0]?.object.userData.icao as string | undefined;
    this.opts.onSelect(icao ?? null);
  };

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.opts.onContextLost?.();
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.clock.stop();
    } else if (this.rafId === null && !this.disposed) {
      this.clock.start();
      this.start();
    }
  };
}
