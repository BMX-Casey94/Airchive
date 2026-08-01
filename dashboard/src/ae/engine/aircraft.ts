import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * A low-poly airliner built procedurally: the plan-view silhouette (fuselage,
 * swept wings, tailplane) extruded with a soft bevel, plus a vertical
 * stabiliser. Shading comes from the scene's directional/ambient lights via
 * MeshStandardMaterial, which is what makes it read as a solid 3D aircraft
 * rather than a sprite. Nose points +Z to match `trackToWorldYaw`.
 */
export function createAircraftGeometry(): THREE.BufferGeometry {
  const body = new THREE.Shape();
  body.moveTo(0, 1.08);
  body.quadraticCurveTo(0.12, 0.98, 0.14, 0.66);
  body.lineTo(0.14, 0.24); // wing root, leading edge
  body.lineTo(1.02, -0.26); // swept leading edge
  body.lineTo(1.06, -0.42); // wingtip
  body.lineTo(0.16, -0.3); // trailing edge back to the root
  body.lineTo(0.12, -0.74); // rear fuselage
  body.lineTo(0.5, -0.98); // tailplane leading edge
  body.lineTo(0.52, -1.1); // tailplane tip
  body.lineTo(0.1, -1.04); // tailplane root
  body.lineTo(0.06, -1.12); // tail cone
  body.lineTo(-0.06, -1.12);
  body.lineTo(-0.1, -1.04);
  body.lineTo(-0.52, -1.1);
  body.lineTo(-0.5, -0.98);
  body.lineTo(-0.12, -0.74);
  body.lineTo(-0.16, -0.3);
  body.lineTo(-1.06, -0.42);
  body.lineTo(-1.02, -0.26);
  body.lineTo(-0.14, 0.24);
  body.lineTo(-0.14, 0.66);
  body.quadraticCurveTo(-0.12, 0.98, 0, 1.08);

  const bodyGeom = new THREE.ExtrudeGeometry(body, {
    depth: 0.1,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.035,
    bevelSegments: 2,
    steps: 1,
  });
  // Shape +y (nose) → world +Z; extrusion thickness → vertical.
  bodyGeom.rotateX(Math.PI / 2);
  bodyGeom.translate(0, 0.1, 0);

  // Vertical stabiliser in the (Z, Y) plane at the tail.
  const fin = new THREE.Shape();
  fin.moveTo(-0.68, 0.02);
  fin.lineTo(-1.1, 0.46);
  fin.lineTo(-1.14, 0.06);
  fin.closePath();
  const finGeom = new THREE.ExtrudeGeometry(fin, {
    depth: 0.05,
    bevelEnabled: false,
  });
  finGeom.rotateY(-Math.PI / 2);
  finGeom.translate(0.025, 0.08, 0);

  const merged = mergeGeometries([bodyGeom, finGeom]);
  bodyGeom.dispose();
  finGeom.dispose();
  // Match the footprint the old marker scaling logic was tuned for.
  merged.scale(0.5, 0.5, 0.5);
  return merged;
}
