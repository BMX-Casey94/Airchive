import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { AircraftState, PositionSnapshot } from "@/types/dashboard";
import {
  ALT_UNITS_PER_FT,
  TRAIL_BASE_LIFT,
  greatCircle,
  haversineMiles,
  projectLatLon,
  trackToWorldYaw,
} from "./projection";
import { createAircraftGeometry } from "./aircraft";

/**
 * Live flight trails and aircraft, driven directly by the existing fleet
 * store (which already stitches server baselines, IndexedDB history and live
 * WebSocket telemetry).
 *
 * Trails are neon amber — a deliberate contrast against the cyan/violet field
 * and rim. Each trail is drawn twice: a wide additive glow underlay and a
 * crisp solid core, altitude-ramped from dim ember on the ground to bright
 * gold at cruise. The selected flight's core is pushed into HDR so the bloom
 * pass halos it.
 */

interface TrailEntry {
  lineCore: LineSegments2;
  lineGlow: LineSegments2;
  materialCore: LineMaterial;
  materialGlow: LineMaterial;
  marker: THREE.Group;
  aircraft: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  hitArea: THREE.Mesh;
  pointCount: number;
  lastTs: number;
  /** False when no span survived the plausibility test, so nothing is drawn. */
  hasGeometry: boolean;
  /** World position of the oldest known trail point (the take-off end). */
  originPos: THREE.Vector3 | null;
}

const CRUISE_FT = 42_000;

/**
 * A break in the line has to mean "these two points cannot be the same
 * flight", and the only test that survives thinning is physical plausibility.
 * Absolute distance and silence thresholds do not: both the store and the
 * gateway decimate older points, so an ordinary cruise pair can end up half
 * an hour and several hundred miles apart without anything being wrong. What
 * decimation can never do is imply a speed no airliner can fly, which is
 * exactly what a seam between two unrelated flights looks like.
 */
const MAX_PLAUSIBLE_MPH = 800;
/** Floor so near-zero deltas (batching, clock skew) never split a real pair. */
const GAP_FLOOR_MILES = 60;
/**
 * Beyond this silence the aircraft did fly the span, it just was not heard —
 * ADS-B is a volunteer receiver network with little ocean coverage. Those
 * stretches are drawn dimmed so they read as inferred rather than tracked.
 */
const INFERRED_SILENCE_MS = 15 * 60_000;
const INFERRED_GAIN = 0.4;
/**
 * Long segments are subdivided along the great circle so they follow the
 * projection's curvature instead of cutting world-space chords. Step count
 * follows longitude span as well as angular distance, since meridians project
 * to straight radial lines but parallels project to circles.
 */
const DENSIFY_STEP_DEG = 1.2;
const DENSIFY_MAX_STEPS = 96;

const CORE_WIDTH = 1.6;
const CORE_WIDTH_SELECTED = 3.0;
const CORE_WIDTH_DIMMED = 1.0;
const GLOW_WIDTH = 4.5;
const GLOW_WIDTH_SELECTED = 9;
const GLOW_WIDTH_DIMMED = 2.5;

const BODY_COLOR = new THREE.Color("#dfeaf2");
const BODY_EMISSIVE = new THREE.Color("#131c26");
const BODY_EMISSIVE_SELECTED = new THREE.Color("#ffb347");

function altRatio(altFt: number): number {
  return Math.min(1, Math.max(0, altFt / CRUISE_FT));
}

/** Saturated amber for the additive glow pass. */
function pushGlowColor(altFt: number, gain: number, out: number[]): void {
  const t = altRatio(altFt);
  out.push(
    (0.5 + 0.35 * t) * gain,
    (0.18 + 0.32 * t) * gain,
    (0.03 + 0.08 * t) * gain,
  );
}

/**
 * Whiter ramp for the solid core line. Deliberately capped below the bloom
 * threshold (0.85) so ordinary trails stay crisp; only the selected flight
 * is pushed into HDR and halos.
 */
function pushCoreColor(altFt: number, gain: number, out: number[]): void {
  const t = altRatio(altFt);
  out.push(
    (0.62 + 0.2 * t) * gain,
    (0.38 + 0.34 * t) * gain,
    (0.14 + 0.36 * t) * gain,
  );
}

export class TrailsLayer {
  readonly group = new THREE.Group();

  private readonly entries = new Map<string, TrailEntry>();

  private readonly aircraftGeometry = createAircraftGeometry();

  private readonly hitGeometry = new THREE.CircleGeometry(1.1, 12);

  private readonly resolution = new THREE.Vector2(1, 1);

  private selectedIcao: string | null = null;

  /** Take-off pin shown at the selected flight's first known point. */
  private readonly originPin = createOriginPin();

  constructor() {
    this.group.add(this.originPin.group);
  }

  setResolution(width: number, height: number): void {
    this.resolution.set(width, height);
    for (const entry of this.entries.values()) {
      entry.materialCore.resolution.copy(this.resolution);
      entry.materialGlow.resolution.copy(this.resolution);
    }
  }

  /** Meshes for raycast picking; each carries `userData.icao`. */
  get pickables(): THREE.Object3D[] {
    const list: THREE.Object3D[] = [];
    for (const entry of this.entries.values()) {
      if (entry.marker.visible) list.push(entry.hitArea);
    }
    return list;
  }

  /** Current world position of an aircraft's marker, for camera focus. */
  getMarkerPosition(icao: string): THREE.Vector3 | null {
    const entry = this.entries.get(icao);
    return entry?.marker.visible ? entry.marker.position.clone() : null;
  }

  sync(
    aircraft: Map<string, AircraftState>,
    trails: Map<string, PositionSnapshot[]>,
    selectedIcao: string | null,
  ): void {
    this.selectedIcao = selectedIcao;

    for (const [icao, state] of aircraft) {
      const entry = this.entries.get(icao) ?? this.createEntry(icao);
      const points = trails.get(icao) ?? [];

      if (points.length >= 2) {
        const last = points[points.length - 1];
        if (
          points.length !== entry.pointCount
          || (last !== undefined && last.ts !== entry.lastTs)
        ) {
          this.rebuildLines(entry, points);
        }
        entry.lineCore.visible = entry.hasGeometry;
        entry.lineGlow.visible = entry.hasGeometry;
      } else {
        entry.lineCore.visible = false;
        entry.lineGlow.visible = false;
      }

      this.updateMarker(entry, state);
    }

    for (const [icao, entry] of this.entries) {
      if (!aircraft.has(icao)) {
        this.disposeEntry(entry);
        this.entries.delete(icao);
      }
    }

    this.applySelectionStyling();
  }

  /** Per-frame: distance-stable marker sizing and a soft selected pulse. */
  updateFrame(camera: THREE.Camera, elapsedSeconds: number): void {
    for (const [icao, entry] of this.entries) {
      if (!entry.marker.visible) continue;
      const dist = camera.position.distanceTo(entry.marker.position);
      let scale = THREE.MathUtils.clamp(dist * 0.028, 0.1, 0.8);
      if (icao === this.selectedIcao) {
        scale *= 1.18 + 0.07 * Math.sin(elapsedSeconds * 4.2);
      }
      entry.marker.scale.setScalar(scale);
    }

    if (this.originPin.group.visible) {
      const dist = camera.position.distanceTo(this.originPin.group.position);
      this.originPin.group.scale.setScalar(
        THREE.MathUtils.clamp(dist * 0.06, 0.5, 2.5),
      );
      this.originPin.animate(elapsedSeconds);
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      this.disposeEntry(entry);
    }
    this.entries.clear();
    this.aircraftGeometry.dispose();
    this.hitGeometry.dispose();
    this.originPin.dispose();
  }

  private createEntry(icao: string): TrailEntry {
    const materialGlow = new LineMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.11,
      linewidth: GLOW_WIDTH,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    materialGlow.resolution.copy(this.resolution);

    const materialCore = new LineMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      linewidth: CORE_WIDTH,
      depthWrite: false,
    });
    materialCore.resolution.copy(this.resolution);

    const makeLine = (material: LineMaterial, order: number): LineSegments2 => {
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions([0, 0, 0, 0, 0, 0]);
      const line = new LineSegments2(geometry, material);
      line.visible = false;
      line.renderOrder = order;
      line.frustumCulled = false;
      return line;
    };
    const lineGlow = makeLine(materialGlow, 4);
    const lineCore = makeLine(materialCore, 5);

    const aircraft = new THREE.Mesh(
      this.aircraftGeometry,
      new THREE.MeshStandardMaterial({
        color: BODY_COLOR.clone(),
        metalness: 0.4,
        roughness: 0.42,
        emissive: BODY_EMISSIVE.clone(),
        emissiveIntensity: 1,
        transparent: true,
        opacity: 1,
      }),
    );
    aircraft.renderOrder = 6;

    const hitArea = new THREE.Mesh(
      this.hitGeometry,
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    hitArea.rotation.x = -Math.PI / 2;
    hitArea.userData.icao = icao;

    const marker = new THREE.Group();
    marker.add(aircraft);
    marker.add(hitArea);
    marker.visible = false;

    this.group.add(lineGlow);
    this.group.add(lineCore);
    this.group.add(marker);

    const entry: TrailEntry = {
      lineCore,
      lineGlow,
      materialCore,
      materialGlow,
      marker,
      aircraft,
      hitArea,
      pointCount: 0,
      lastTs: 0,
      hasGeometry: false,
      originPos: null,
    };
    this.entries.set(icao, entry);
    return entry;
  }

  private rebuildLines(entry: TrailEntry, points: PositionSnapshot[]): void {
    const positions: number[] = [];
    const coreColors: number[] = [];
    const glowColors: number[] = [];

    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const distMiles = haversineMiles(a.lat, a.lon, b.lat, b.lon);
      const dtMs = Math.max(0, b.ts - a.ts);

      // Only an impossible jump is a seam between unrelated data. Anything an
      // airliner could actually have flown gets drawn, however coarsely the
      // pair happens to have been sampled.
      const reachableMiles = Math.max(
        GAP_FLOOR_MILES,
        (dtMs / 3_600_000) * MAX_PLAUSIBLE_MPH,
      );
      if (distMiles > reachableMiles) continue;

      const gain = dtMs > INFERRED_SILENCE_MS ? INFERRED_GAIN : 1;
      const aAlt = Number.isFinite(a.alt) ? a.alt : 0;
      const bAlt = Number.isFinite(b.alt) ? b.alt : 0;

      const arc = greatCircle(a.lat, a.lon, b.lat, b.lon);
      // Shorter way round in longitude, so a segment crossing the antimeridian
      // isn't subdivided as though it swept the long way around the pole.
      const dLon = Math.abs(((b.lon - a.lon + 540) % 360) - 180);
      const span = Math.max(arc.omegaDeg, dLon);
      const steps = Math.max(
        1,
        Math.min(DENSIFY_MAX_STEPS, Math.ceil(span / DENSIFY_STEP_DEG)),
      );

      let prev = projectLatLon(a.lat, a.lon, aAlt);
      let prevAlt = aAlt;
      for (let s = 1; s <= steps; s += 1) {
        const t = s / steps;
        const alt = aAlt + (bAlt - aAlt) * t;
        const [lat, lon] = arc.at(t);
        const next = projectLatLon(lat, lon, alt);
        positions.push(prev[0], prev[1], prev[2], next[0], next[1], next[2]);
        pushCoreColor(prevAlt, gain, coreColors);
        pushCoreColor(alt, gain, coreColors);
        pushGlowColor(prevAlt, gain, glowColors);
        pushGlowColor(alt, gain, glowColors);
        prev = next;
        prevAlt = alt;
      }
    }

    entry.hasGeometry = positions.length > 0;
    if (entry.hasGeometry) {
      const swap = (line: LineSegments2, colors: number[]): void => {
        line.geometry.dispose();
        const geometry = new LineSegmentsGeometry();
        geometry.setPositions(positions);
        geometry.setColors(colors);
        line.geometry = geometry;
      };
      swap(entry.lineCore, coreColors);
      swap(entry.lineGlow, glowColors);
    }

    const last = points[points.length - 1];
    entry.pointCount = points.length;
    entry.lastTs = last?.ts ?? 0;

    const first = points[0];
    if (first) {
      const [ox, , oz] = projectLatLon(first.lat, first.lon, 0);
      entry.originPos = (entry.originPos ?? new THREE.Vector3()).set(
        ox,
        TRAIL_BASE_LIFT,
        oz,
      );
    }
  }

  private updateMarker(entry: TrailEntry, state: AircraftState): void {
    const lat = state.lat;
    const lon = state.lon;
    if (
      !Number.isFinite(lat)
      || !Number.isFinite(lon)
      || (lat === 0 && lon === 0)
    ) {
      entry.marker.visible = false;
      return;
    }

    const alt = Number.isFinite(state.altBaro) ? Math.max(0, state.altBaro) : 0;
    const [x, , z] = projectLatLon(lat, lon, 0);
    entry.marker.position.set(
      x,
      TRAIL_BASE_LIFT + alt * ALT_UNITS_PER_FT + 0.006,
      z,
    );
    entry.marker.rotation.y = trackToWorldYaw(
      Number.isFinite(state.track) ? state.track : 0,
      lon,
    );
    entry.marker.visible = true;
  }

  private applySelectionStyling(): void {
    const hasSelection = this.selectedIcao !== null;

    const selected = hasSelection
      ? this.entries.get(this.selectedIcao as string)
      : undefined;
    if (selected?.originPos) {
      this.originPin.group.position.copy(selected.originPos);
      this.originPin.group.visible = true;
    } else {
      this.originPin.group.visible = false;
    }

    for (const [icao, entry] of this.entries) {
      const isSelected = icao === this.selectedIcao;
      if (isSelected) {
        entry.materialCore.linewidth = CORE_WIDTH_SELECTED;
        entry.materialCore.opacity = 1;
        // >1 channel values push the core over the bloom threshold.
        entry.materialCore.color.setRGB(2.0, 2.0, 2.0);
        entry.materialGlow.linewidth = GLOW_WIDTH_SELECTED;
        entry.materialGlow.opacity = 0.32;
        entry.materialGlow.color.setRGB(1.3, 1.3, 1.3);
        entry.aircraft.material.emissive.copy(BODY_EMISSIVE_SELECTED);
        entry.aircraft.material.emissiveIntensity = 0.9;
        entry.aircraft.material.opacity = 1;
      } else {
        entry.materialCore.linewidth = hasSelection
          ? CORE_WIDTH_DIMMED
          : CORE_WIDTH;
        entry.materialCore.opacity = hasSelection ? 0.12 : 0.85;
        entry.materialCore.color.setRGB(1, 1, 1);
        entry.materialGlow.linewidth = hasSelection
          ? GLOW_WIDTH_DIMMED
          : GLOW_WIDTH;
        entry.materialGlow.opacity = hasSelection ? 0.04 : 0.11;
        entry.materialGlow.color.setRGB(1, 1, 1);
        entry.aircraft.material.emissive.copy(BODY_EMISSIVE);
        entry.aircraft.material.emissiveIntensity = 1;
        entry.aircraft.material.opacity = hasSelection ? 0.3 : 1;
      }
    }
  }

  private disposeEntry(entry: TrailEntry): void {
    entry.lineCore.geometry.dispose();
    entry.lineGlow.geometry.dispose();
    entry.materialCore.dispose();
    entry.materialGlow.dispose();
    entry.aircraft.material.dispose();
    (entry.hitArea.material as THREE.Material).dispose();
    this.group.remove(entry.lineCore);
    this.group.remove(entry.lineGlow);
    this.group.remove(entry.marker);
  }
}

interface OriginPin {
  group: THREE.Group;
  animate: (elapsedSeconds: number) => void;
  dispose: () => void;
}

/**
 * The take-off marker: a warm node on the surface with a slim stem and a
 * pulse ring that breathes outward — enough to say "the flight began here"
 * without competing with the aircraft itself.
 */
function createOriginPin(): OriginPin {
  const group = new THREE.Group();
  group.visible = false;
  group.renderOrder = 7;

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const track = <G extends THREE.BufferGeometry, M extends THREE.Material>(
    geometry: G,
    material: M,
  ): THREE.Mesh => {
    geometries.push(geometry);
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 7;
    return mesh;
  };

  const dot = track(
    new THREE.CircleGeometry(0.035, 24),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color("#ffd9a0"),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    }),
  );
  dot.rotation.x = -Math.PI / 2;
  dot.position.y = 0.004;
  group.add(dot);

  const stem = track(
    new THREE.CylinderGeometry(0.006, 0.006, 0.16, 8),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color("#ffb347"),
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  stem.position.y = 0.08;
  group.add(stem);

  const node = track(
    new THREE.SphereGeometry(0.02, 12, 12),
    new THREE.MeshBasicMaterial({
      // HDR-tinted so the bloom pass gives the node a soft halo.
      color: new THREE.Color(1.5, 1.05, 0.55),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    }),
  );
  node.position.y = 0.16;
  group.add(node);

  const ringMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color("#ffb347"),
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const ring = track(new THREE.RingGeometry(0.09, 0.11, 48), ringMaterial);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.006;
  group.add(ring);

  return {
    group,
    animate(elapsedSeconds) {
      const phase = (elapsedSeconds % 2.4) / 2.4;
      const pulse = 1 + phase * 1.1;
      ring.scale.setScalar(pulse);
      ringMaterial.opacity = 0.5 * (1 - phase) ** 1.5;
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
