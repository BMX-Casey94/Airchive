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

/**
 * Live flight trails and aircraft markers, driven directly by the existing
 * fleet store (which already stitches server baselines, IndexedDB history and
 * live WebSocket telemetry). Trails are altitude-tinted ribbons — dim teal on
 * the ground rising to icy cyan at cruise — and the selected flight is pushed
 * into HDR so the bloom pass halos it.
 */

interface TrailEntry {
  line: Line2;
  material: LineMaterial;
  marker: THREE.Group;
  chevron: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  hitArea: THREE.Mesh;
  pointCount: number;
  lastTs: number;
}

const CRUISE_FT = 42_000;

const UNSELECTED_WIDTH = 2.1;
const SELECTED_WIDTH = 3.6;
const DIMMED_WIDTH = 1.4;

function pushTrailColor(altFt: number, out: number[]): void {
  const t = Math.min(1, Math.max(0, altFt / CRUISE_FT));
  out.push(0.06 + 0.5 * t, 0.45 + 0.5 * t, 0.7 + 0.3 * t);
}

function createChevronGeometry(): THREE.BufferGeometry {
  // A flat delta pointing +Z; yaw rotation then aims it along the track.
  const geometry = new THREE.BufferGeometry();
  const vertices = new Float32Array([
    0, 0, 0.55,   -0.38, 0, -0.4,   0, 0, -0.18,
    0, 0, 0.55,    0, 0, -0.18,     0.38, 0, -0.4,
  ]);
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export class TrailsLayer {
  readonly group = new THREE.Group();

  private readonly entries = new Map<string, TrailEntry>();

  private readonly chevronGeometry = createChevronGeometry();

  private readonly hitGeometry = new THREE.CircleGeometry(1.1, 12);

  private readonly resolution = new THREE.Vector2(1, 1);

  private selectedIcao: string | null = null;

  setResolution(width: number, height: number): void {
    this.resolution.set(width, height);
    for (const entry of this.entries.values()) {
      entry.material.resolution.copy(this.resolution);
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
          this.rebuildLine(entry, points);
        }
        entry.line.visible = true;
      } else {
        entry.line.visible = false;
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
      let scale = THREE.MathUtils.clamp(dist * 0.014, 0.06, 0.4);
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
    this.chevronGeometry.dispose();
    this.hitGeometry.dispose();
  }

  private createEntry(icao: string): TrailEntry {
    const material = new LineMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      linewidth: UNSELECTED_WIDTH,
      depthWrite: false,
    });
    material.resolution.copy(this.resolution);

    const geometry = new LineGeometry();
    geometry.setPositions([0, 0, 0, 0, 0, 0]);
    const line = new Line2(geometry, material);
    line.visible = false;
    line.renderOrder = 4;
    line.frustumCulled = false;

    const chevron = new THREE.Mesh(
      this.chevronGeometry,
      new THREE.MeshBasicMaterial({
        color: new THREE.Color("#bdf3ff"),
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    chevron.renderOrder = 5;

    const hitArea = new THREE.Mesh(
      this.hitGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    hitArea.rotation.x = -Math.PI / 2;
    hitArea.userData.icao = icao;

    const marker = new THREE.Group();
    marker.add(chevron);
    marker.add(hitArea);
    marker.visible = false;

    this.group.add(line);
    this.group.add(marker);

    const entry: TrailEntry = {
      line,
      material,
      marker,
      chevron,
      hitArea,
      pointCount: 0,
      lastTs: 0,
    };
    this.entries.set(icao, entry);
    return entry;
  }

  private rebuildLine(entry: TrailEntry, points: PositionSnapshot[]): void {
    const positions: number[] = [];
    const colors: number[] = [];
    for (const p of points) {
      const [x, y, z] = projectLatLon(p.lat, p.lon, p.alt ?? 0);
      positions.push(x, y, z);
      pushTrailColor(p.alt ?? 0, colors);
    }

    entry.line.geometry.dispose();
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    geometry.setColors(colors);
    entry.line.geometry = geometry;

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
        entry.material.linewidth = SELECTED_WIDTH;
        entry.material.opacity = 1;
        // >1 channel values push the trail over the bloom threshold.
        entry.material.color.setRGB(2.1, 2.1, 2.1);
        entry.chevron.material.color.set("#00f5ff");
        entry.chevron.material.opacity = 1;
      } else {
        entry.material.linewidth = hasSelection ? DIMMED_WIDTH : UNSELECTED_WIDTH;
        entry.material.opacity = hasSelection ? 0.14 : 0.85;
        entry.material.color.setRGB(1, 1, 1);
        entry.chevron.material.color.set("#bdf3ff");
        entry.chevron.material.opacity = hasSelection ? 0.35 : 0.95;
      }
    }
  }

  private disposeEntry(entry: TrailEntry): void {
    entry.line.geometry.dispose();
    entry.material.dispose();
    entry.chevron.material.dispose();
    (entry.hitArea.material as THREE.Material).dispose();
    this.group.remove(entry.line);
    this.group.remove(entry.marker);
  }
}
