import * as THREE from "three";
import * as topojson from "topojson-client";
import { pushDensifiedSegment } from "./projection";

/**
 * Crisp vector linework over the imagery: Natural Earth coastlines and
 * borders (projected on the CPU once, with adaptive densification so edges
 * follow parallels/meridians rather than cutting chords), plus a restrained
 * 15° graticule. Native GL hairlines are exactly what this layer wants —
 * one pixel at any zoom.
 */

type TopoTopology = Parameters<typeof topojson.mesh>[0];
type TopoObject = Parameters<typeof topojson.mesh>[1];

const COAST_Y = 0.008;
const BORDER_Y = 0.006;
const GRATICULE_Y = 0.004;

function buildLineSegments(
  positions: number[],
  color: string,
  opacity: number,
): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.renderOrder = 1;
  return lines;
}

function multiLineToSegments(
  geo: GeoJSON.MultiLineString | GeoJSON.LineString,
  y: number,
): number[] {
  const lines =
    geo.type === "LineString" ? [geo.coordinates] : geo.coordinates;
  const out: number[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i += 1) {
      const a = line[i];
      const b = line[i + 1];
      if (!a || !b) continue;
      pushDensifiedSegment(out, a[0], a[1], b[0], b[1], y);
    }
  }
  return out;
}

async function fetchTopo(url: string): Promise<TopoTopology | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as TopoTopology;
  } catch {
    return null;
  }
}

function buildGraticule(): THREE.LineSegments[] {
  const minor: number[] = [];
  const equator: number[] = [];

  // Parallels: circles of constant colatitude, drawn as chords of 2.5°.
  for (let lat = -75; lat <= 75; lat += 15) {
    const target = lat === 0 ? equator : minor;
    for (let lon = -180; lon < 180; lon += 2.5) {
      pushDensifiedSegment(target, lon, lat, lon + 2.5, lat, GRATICULE_Y, 3);
    }
  }

  // Meridians are radial lines on a polar AE disc — straight by definition.
  for (let lon = -180; lon < 180; lon += 15) {
    pushDensifiedSegment(minor, lon, 88, lon, -88, GRATICULE_Y, 4);
  }

  return [
    buildLineSegments(minor, "#2b4a6f", 0.16),
    buildLineSegments(equator, "#3d6f9e", 0.28),
  ];
}

export interface VectorLayersHandle {
  group: THREE.Group;
  dispose: () => void;
}

/**
 * Builds the graticule synchronously and streams the Natural Earth layers in
 * as their TopoJSON arrives. Missing data degrades to graticule-only rather
 * than failing the scene.
 */
export function createVectorLayers(): VectorLayersHandle {
  const group = new THREE.Group();
  let disposed = false;

  for (const lines of buildGraticule()) {
    group.add(lines);
  }

  void (async () => {
    const [land, countries] = await Promise.all([
      fetchTopo("/ae/data/land-50m.json"),
      fetchTopo("/ae/data/countries-50m.json"),
    ]);
    if (disposed) return;

    if (land && land.objects.land) {
      const coast = topojson.mesh(land, land.objects.land as TopoObject);
      group.add(
        buildLineSegments(multiLineToSegments(coast, COAST_Y), "#8fd0f0", 0.40),
      );
    }

    if (countries && countries.objects.countries) {
      const borders = topojson.mesh(
        countries,
        countries.objects.countries as TopoObject,
        (a, b) => a !== b,
      );
      group.add(
        buildLineSegments(
          multiLineToSegments(borders, BORDER_Y),
          "#5a86ad",
          0.15,
        ),
      );
    }
  })();

  return {
    group,
    dispose() {
      disposed = true;
      for (const child of group.children) {
        const lines = child as THREE.LineSegments;
        lines.geometry.dispose();
        (lines.material as THREE.Material).dispose();
      }
    },
  };
}
