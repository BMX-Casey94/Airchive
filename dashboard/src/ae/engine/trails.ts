import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { AircraftState, PositionSnapshot } from "@/types/dashboard";
import {
  ALT_UNITS_PER_FT,
  TRAIL_BASE_LIFT,
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
  lineCore: Line2;
  lineGlow: Line2;
  materialCore: LineMaterial;
  materialGlow: LineMaterial;
  marker: THREE.Group;
  aircraft: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  hitArea: THREE.Mesh;
  pointCount: number;
  lastTs: number;
}

const CRUISE_FT = 42_000;

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
function pushGlowColor(altFt: number, out: number[]): void {
  const t = altRatio(altFt);
  out.push(0.5 + 0.35 * t, 0.18 + 0.32 * t, 0.03 + 0.08 * t);
}

/**
 * Whiter ramp for the solid core line. Deliberately capped below the bloom
 * threshold (0.85) so ordinary trails stay crisp; only the selected flight
 * is pushed into HDR and halos.
 */
function pushCoreColor(altFt: number, out: number[]): void {
  const t = altRatio(altFt);
  out.push(0.62 + 0.2 * t, 0.38 + 0.34 * t, 0.14 + 0.36 * t);
}

export class TrailsLayer {
  readonly group = new THREE.Group();

  private readonly entries = new Map<string, TrailEntry>();

  private readonly aircraftGeometry = createAircraftGeometry();

  private readonly hitGeometry = new THREE.CircleGeometry(1.1, 12);

  private readonly resolution = new THREE.Vector2(1, 1);

  private selectedIcao: string | null = null;

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
        entry.lineCore.visible = true;
        entry.lineGlow.visible = true;
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
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      this.disposeEntry(entry);
    }
    this.entries.clear();
    this.aircraftGeometry.dispose();
    this.hitGeometry.dispose();
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

    const makeLine = (material: LineMaterial, order: number): Line2 => {
      const geometry = new LineGeometry();
      geometry.setPositions([0, 0, 0, 0, 0, 0]);
      const line = new Line2(geometry, material);
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
    };
    this.entries.set(icao, entry);
    return entry;
  }

  private rebuildLines(entry: TrailEntry, points: PositionSnapshot[]): void {
    const positions: number[] = [];
    const coreColors: number[] = [];
    const glowColors: number[] = [];
    for (const p of points) {
      const [x, y, z] = projectLatLon(p.lat, p.lon, p.alt ?? 0);
      positions.push(x, y, z);
      pushCoreColor(p.alt ?? 0, coreColors);
      pushGlowColor(p.alt ?? 0, glowColors);
    }

    const swap = (line: Line2, colors: number[]): void => {
      line.geometry.dispose();
      const geometry = new LineGeometry();
      geometry.setPositions(positions);
      geometry.setColors(colors);
      line.geometry = geometry;
    };
    swap(entry.lineCore, coreColors);
    swap(entry.lineGlow, glowColors);

    const last = points[points.length - 1];
    entry.pointCount = points.length;
    entry.lastTs = last?.ts ?? 0;
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
