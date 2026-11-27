import * as THREE from "three";
import { ConvexHull } from "three/addons/math/ConvexHull.js";
import { partOf } from "../../scene/rig.js";
import { solidMeshes } from "../../scene/wire.js";
import { METRE } from "./physics.js";

/**
 * A car's shape as a crash meets it (game/crash.js), measured from its model once a model (its
 * clones share it): how high its ends stand, its roof, how low its body comes.
 */

/** @type {WeakMap<THREE.BufferGeometry, Hull>} by the model's body: clones share it */
const roofs = new WeakMap();
/** @type {WeakMap<THREE.BufferGeometry, import("./crush.js").Faces>} by the model's body */
const faces = new WeakMap();
const FACE_STEP = 0.05 * METRE; // the depths a car's ends are measured at

/**
 * How high a car's ends stand (its length is its z), from the road: at each depth in from either
 * end, the highest its body comes that far in, its bumpers too (not its wheels, nor its mirrors):
 * the face a crush that deep meets another car with (a car's bonnet, low; a van's flat front, all
 * of it). Measured once a model.
 *
 * @param {THREE.Object3D} object upright on the road, its world matrices up to date
 * @param {number} floor the road, in its frame
 * @returns {import("./crush.js").Faces}
 */
export function facesOf(object, floor) {
  const meshes = solidMeshes(object).filter(
    (mesh) => !["wheel", "mirror"].includes(partOf(mesh, object)?.userData.part),
  );
  const key = meshes[0]?.geometry;
  const known = key && faces.get(key);
  if (known) return known;
  const toObject = object.matrixWorld.clone().invert();
  /** @type {THREE.Vector3[]} */
  const points = [];
  for (const mesh of meshes) {
    const matrix = toObject.clone().multiply(mesh.matrixWorld);
    const position = mesh.geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      points.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix));
    }
  }
  const [near, far] = [
    Math.min(...points.map(({ z }) => z)),
    Math.max(...points.map(({ z }) => z)),
  ];
  const count = Math.ceil((far - near) / 2 / FACE_STEP) + 1; // to its middle
  const ends = /** @type {[Float32Array, Float32Array]} */ (
    [0, 1].map(() => new Float32Array(count))
  );
  for (const { y, z } of points) {
    for (const [end, depth] of /** @type {const} */ ([
      [0, z - near],
      [1, far - z],
    ])) {
      const k = Math.floor(depth / FACE_STEP);
      if (k < count) ends[end][k] = Math.max(ends[end][k], y - floor);
    }
  }
  // the highest that far in or less
  for (const end of ends) for (let k = 1; k < count; k++) end[k] = Math.max(end[k], end[k - 1]);
  const measured = { ends, step: FACE_STEP };
  if (key) faces.set(key, measured);
  return measured;
}

/**
 * @typedef {object} Hull a convex hull
 * @property {THREE.Vector3[]} corners
 * @property {number[]} faces its triangles, three corners each (by their index), turned outwards
 */

/**
 * The convex hull round points (three's: Rapier's own keeps every point, and with many in a plane,
 * a crush's cut, falls through the road).
 *
 * @param {THREE.Vector3[]} points
 * @returns {Hull} none (no faces) for fewer than four
 */
export function hullOf(points) {
  /** @type {Hull} */
  const hull = { corners: [], faces: [] };
  if (points.length < 4) return hull;
  const index = new Map();
  for (const { edge } of new ConvexHull().setFromPoints(points).faces) {
    const loop = [];
    let side = edge;
    do {
      const { point } = side.head();
      if (!index.has(point)) index.set(point, hull.corners.push(point) - 1);
      loop.push(index.get(point));
    } while ((side = side.next) !== edge);
    for (let i = 1; i + 1 < loop.length; i++) hull.faces.push(loop[0], loop[i], loop[i + 1]);
  }
  return hull;
}

/**
 * A car's body above a height, in its own frame (not its wheels, its bumpers, nor its mirrors,
 * which come off): what it lands on rolled over, above the box it meets other cars with, as its
 * hull (its shape, a roof's rounded edges and all: not a box round it).
 *
 * @param {THREE.Object3D} object upright on the road, its world matrices up to date
 * @param {number} from
 */
export function roofOf(object, from) {
  const meshes = solidMeshes(object).filter((mesh) => !partOf(mesh, object));
  const key = meshes[0]?.geometry;
  let roof = key && roofs.get(key);
  if (roof) return roof;
  const toObject = object.matrixWorld.clone().invert();
  const points = [];
  for (const mesh of meshes) {
    const matrix = toObject.clone().multiply(mesh.matrixWorld);
    const position = mesh.geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix);
      if (p.y > from) points.push(p, p.clone().setY(from)); // down to the box (a flat roof too)
    }
  }
  roof = hullOf(points);
  if (key) roofs.set(key, roof);
  return roof;
}

/**
 * How low a car's body comes (not its wheels, its bumpers, nor its mirrors), in its own frame.
 *
 * @param {THREE.Object3D} object upright on the road, its world matrices up to date
 */
export function underside(object) {
  const bounds = new THREE.Box3();
  for (const mesh of solidMeshes(object)) if (!partOf(mesh, object)) bounds.expandByObject(mesh);
  return object.worldToLocal(new THREE.Vector3(0, bounds.min.y, 0)).y;
}
