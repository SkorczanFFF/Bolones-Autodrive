import * as THREE from "three";
import { BLOOM, WIRE } from "../config.js";
import {
  isLineMaterial,
  lineGeometry,
  memoByGeometry,
  movedLineGeometry,
  polygonLineGeometry,
} from "./lines.js";

/**
 * Replaces every mesh material under root (disposing the loader's defaults) and sets up shadows.
 *
 * @param {THREE.Object3D} root
 * @param {THREE.Material} material
 * @param {boolean} [shadows] cast and receive them (false: far outside the shadow box)
 */
export function applyMaterial(root, material, shadows = true) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object.userData.isWire) return;
    const previous = Array.isArray(object.material) ? object.material : [object.material];
    for (const old of previous) if (old !== material) old.dispose();
    object.material = material;
    object.castShadow = shadows;
    object.receiveShadow = shadows;
  });
}

/** One EdgesGeometry per source geometry: clones share geometries, so they share outlines. */
const edgesOf = memoByGeometry((geometry) => new THREE.EdgesGeometry(geometry, WIRE.edgeAngle));

/**
 * The solid meshes under a root (and it, if one): not their wireframe twins.
 *
 * @param {THREE.Object3D} root
 * @returns {THREE.Mesh[]}
 */
export function solidMeshes(root) {
  /** @type {THREE.Mesh[]} */
  const meshes = [];
  root.traverse((object) => {
    if (object instanceof THREE.Mesh && !object.userData.isWire) meshes.push(object);
  });
  return meshes;
}

/**
 * Adds a line twin as a child of every mesh under root: outlines (LineSegments over the
 * mesh's creases) for line materials, shader-drawn lines for the materials of scene/lines.js
 * (triangle edges, or polygon outlines per the material's userData.wirePolygons), the plain
 * geometry otherwise. The twin inherits the transform and animation of its parent, so nothing
 * has to be kept in sync.
 *
 * @param {THREE.Object3D} root
 * @param {THREE.Material} material
 * @param {boolean} [shadows] receive them (false: far outside the shadow box)
 */
export function addWireframe(root, material, shadows = true) {
  for (const mesh of solidMeshes(root)) {
    const geometry = wireGeometry(mesh.geometry, material);
    const wire =
      material instanceof THREE.LineBasicMaterial
        ? new THREE.LineSegments(geometry, material)
        : new THREE.Mesh(geometry, material);
    wire.userData.isWire = true;
    wire.layers.enable(BLOOM.layer); // glows (core/bloom.js)
    wire.castShadow = false; // thin lines add no visible shadow, only shadow-pass draw calls
    wire.receiveShadow = shadows;
    mesh.add(wire);
  }
}

/**
 * The line twin's geometry for a mesh geometry (see addWireframe), also when the mesh gets a new
 * one (a dent, scene/dents.js).
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Material} material the wireframe material
 * @param {THREE.BufferGeometry} [source] what the geometry is a copy of, its points moved (a
 *   dent): the same lines, measured afresh
 */
export function wireGeometry(geometry, material, source) {
  if (material instanceof THREE.LineBasicMaterial) return edgesOf(geometry);
  if (!isLineMaterial(material)) return geometry;
  if (!material.userData.wirePolygons) return lineGeometry(geometry);
  return source ? movedLineGeometry(geometry, source) : polygonLineGeometry(geometry);
}

/**
 * Solid look + wireframe twin in one call.
 *
 * @param {THREE.Object3D} root
 * @param {THREE.Material} solid
 * @param {THREE.Material} wire
 * @param {{ shadows?: boolean }} [options] shadows: false for things far outside the shadow box
 */
export function dress(root, solid, wire, { shadows = true } = {}) {
  applyMaterial(root, solid, shadows);
  addWireframe(root, wire, shadows);
  return root;
}
