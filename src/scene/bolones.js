import * as THREE from "three";
import { CAR } from "../config.js";
import { unionFind } from "../core/fbx.js";
import { pruneEmpty, wheelCenter } from "./model.js";
import { HOLE_SEGMENTS } from "./outline.js";
import { withPolygons } from "./polygons.js";
import { mountWheel, partOf, wheelsOf } from "./rig.js";
import { dress, solidMeshes } from "./wire.js";

/**
 * The Bolones' model put together from its FBX files (bolones.fbx, wheel.fbx): the body with its
 * mirrors taken apart and the fuel cap on it, the wheels on the rig (scene/rig.js), each part of
 * the motion (scene/car.js) on a node of its own, so nothing has to be synced:
 *
 *   group          lateral position (x) + yaw: the nose turns towards the lane change; CAR.lift (y)
 *   └ wreck        where a crash threw the car (game/crash.js), at rest otherwise
 *     ├ chassis    body roll around the axle line (CAR.rollCenterY)
 *     │ └ body     with the fuel cap on its mesh, its mirrors nodes of their own (they come off)
 *     └ 4× wheel   on its rig (scene/rig.js): the mount on the axle, mid-width; front ones steer
 *       └ … spin → mirror → wheel model, offset so its axle and mid-width sit on the mount
 */

const UP = new THREE.Vector3(0, 1, 0);
const PROUD = 0.01; // units the fuel cap stands off the wing

/**
 * The fuel cap (CAR.fuelCap): a round lid (an octagon) where a ray from the right meets the body,
 * a little proud of it, outlined. A part of the body's mesh, so it dents with it.
 *
 * @param {THREE.Object3D} car its world matrices up to date
 * @param {THREE.Object3D} body
 * @param {THREE.Material} solid
 * @param {THREE.Material} wire
 */
function addFuelCap(car, body, solid, wire) {
  const { at, radius } = CAR.fuelCap;
  const meshes = solidMeshes(body);
  const from = car.localToWorld(new THREE.Vector3(10, at[1], at[0]));
  const left = new THREE.Vector3(-1, 0, 0).transformDirection(car.matrixWorld);
  const [hit] = new THREE.Raycaster(from, left).intersectObjects(meshes, false);
  if (!hit?.face) {
    console.warn("CAR.fuelCap is off the body: no fuel cap");
    return;
  }
  const mesh = hit.object;
  const normal = hit.face.normal.clone();
  if (normal.clone().transformDirection(mesh.matrixWorld).dot(left) > 0) normal.negate();
  const scale = mesh.getWorldScale(new THREE.Vector3()).x;
  const segments = HOLE_SEGMENTS; // low poly, as the traffic's round holes
  // turned half a segment: a flat side up (the turn onto the normal keeps the disc's y up)
  const disc = new THREE.CircleGeometry(radius / scale, segments, Math.PI / segments);
  const polygon = Array(segments).fill(0);
  const cap = new THREE.Mesh(withPolygons([{ geometry: disc.toNonIndexed(), polygon }]));
  cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  cap.position.copy(mesh.worldToLocal(hit.point.clone())).addScaledVector(normal, PROUD / scale);
  mesh.add(dress(cap, solid, wire));
  cap.castShadow = false; // only the body casts a shadow (see the wheels)
}

/**
 * Takes a body modelled as one mesh apart into it and its outside mirrors, a node each
 * (`userData.part` "mirror", scene/rig.js) that a crash tears off: the islands of its triangles
 * (joined at their corners) that stand out of the rest of it across the car.
 *
 * @param {THREE.Object3D} model the body, x across
 */
function mirrorsApart(model) {
  model.updateWorldMatrix(true, true);
  const toModel = model.matrixWorld.clone().invert();
  for (const mesh of solidMeshes(model)) {
    const { geometry, parent } = mesh;
    if (geometry.index) continue; // a model's are FBXLoader's: not indexed
    const position = geometry.getAttribute("position");
    const count = position.count / 3; // triangles
    const islands = unionFind(count);
    /** @type {Map<string, number>} a triangle at each corner */
    const at = new Map();
    for (let i = 0; i < position.count; i++) {
      const key = `${position.getX(i)},${position.getY(i)},${position.getZ(i)}`;
      const other = at.get(key);
      if (other === undefined) at.set(key, Math.floor(i / 3));
      else islands.union(Math.floor(i / 3), other);
    }
    // each island's triangles, and how far across it reaches
    const matrix = toModel.clone().multiply(mesh.matrixWorld);
    const p = new THREE.Vector3();
    /** @type {Map<number, { triangles: number[], low: number, high: number }>} */
    const of = new Map();
    for (let t = 0; t < count; t++) {
      const root = islands.find(t);
      let island = of.get(root);
      if (!island) of.set(root, (island = { triangles: [], low: Infinity, high: -Infinity }));
      island.triangles.push(t);
      for (let k = 0; k < 3; k++) {
        const { x } = p.fromBufferAttribute(position, 3 * t + k).applyMatrix4(matrix);
        island.low = Math.min(island.low, x);
        island.high = Math.max(island.high, x);
      }
    }
    const [body, ...rest] = [...of.values()].sort(
      (a, b) => b.triangles.length - a.triangles.length,
    );
    const mirrors = rest.filter(({ low, high }) => low < body.low || high > body.high);
    if (!parent || !mirrors.length) continue;
    for (const side of [-1, 1]) {
      const triangles = mirrors
        .filter(({ low, high }) => (low + high) * side > 0)
        .flatMap((mirror) => mirror.triangles);
      if (!triangles.length) continue; // a mirror on one side only
      const mirror = new THREE.Mesh(trianglesOf(geometry, triangles), mesh.material);
      mirror.position.copy(mesh.position);
      mirror.quaternion.copy(mesh.quaternion);
      mirror.scale.copy(mesh.scale);
      const node = new THREE.Group().add(mirror);
      node.userData.part = "mirror";
      parent.add(node);
    }
    const off = new Set(mirrors.flatMap((mirror) => mirror.triangles));
    mesh.geometry = trianglesOf(
      geometry,
      Array.from({ length: count }, (_, t) => t).filter((t) => !off.has(t)),
    );
  }
  return model;
}

/**
 * Some of the triangles of a geometry not indexed (FBXLoader's), its polygons with them.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {number[]} triangles
 */
function trianglesOf(geometry, triangles) {
  const part = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const { array, itemSize } = /** @type {THREE.BufferAttribute} */ (attribute);
    const size = 3 * itemSize; // a triangle's
    const values = new Float32Array(triangles.length * size);
    triangles.forEach((t, i) => values.set(array.subarray(t * size, (t + 1) * size), i * size));
    part.setAttribute(name, new THREE.BufferAttribute(values, itemSize));
  }
  /** @type {import("../core/fbx.js").Polygons | undefined} */
  const polygons = geometry.userData.polygons;
  if (polygons) {
    part.userData.polygons = {
      inner: Uint8Array.from(triangles, (t) => polygons.inner[t]),
      polygon: Uint32Array.from(triangles, (t) => polygons.polygon[t]),
    };
  }
  return part;
}

/**
 * Builds the Bolones (its node tree above), not yet in a scene.
 *
 * @param {Record<string, THREE.Group>} models bolones.fbx's and wheel.fbx's
 * @param {import("./materials.js").Materials} materials
 */
export function buildBolones(models, materials) {
  const solid = materials.solid.bolones;
  const wire = materials.wire.bolones;

  const body = dress(mirrorsApart(models.bolones), solid, wire);
  // only the body casts a shadow (see the wheels): its mirrors' fall in it
  for (const mesh of solidMeshes(body)) if (partOf(mesh, body)) mesh.castShadow = false;
  body.position.set(CAR.bodyX, -CAR.rollCenterY, 0);

  const chassis = new THREE.Group();
  chassis.position.y = CAR.rollCenterY;
  chassis.add(body);

  // Spin around the modelled axle (through the model origin) and steer around the middle of
  // the wheel's width, which is off the origin in wheel.fbx.
  const wheelModel = dress(pruneEmpty(models.wheel), solid, wire);
  // only the body casts a shadow: the wheels' fall in its (five sun shadow passes each saved)
  for (const mesh of solidMeshes(wheelModel)) mesh.castShadow = false;
  const center = wheelCenter(wheelModel);
  const radius = new THREE.Box3().setFromObject(wheelModel).getSize(new THREE.Vector3()).y / 2;

  /** @type {THREE.Object3D[]} */
  const spins = [];
  /** @type {THREE.Object3D[]} the front wheels' steer nodes */
  const frontWheels = [];

  const wheels = CAR.wheels.map(([x, y, z]) => {
    const mirrored = x > 0;
    const wheel = wheelModel.clone();
    wheel.position.copy(center).negate();

    const mirror = new THREE.Group();
    if (mirrored) mirror.rotation.y = Math.PI;
    mirror.add(wheel);

    // (x, y, z) is the model origin; the mount sits in the middle of the width
    const centerOffset = center.clone().applyAxisAngle(UP, mirrored ? Math.PI : 0);
    const at = new THREE.Vector3(x, y, z).add(centerOffset);
    const mount = mountWheel(mirror, at, radius, z < 0); // the nose is towards -z
    const [{ steer, spin }] = wheelsOf(mount);
    spins.push(spin);
    if (z < 0) frontWheels.push(steer);
    return mount;
  });

  const wreck = new THREE.Group().add(chassis, ...wheels);
  const group = new THREE.Group().add(wreck);
  group.position.y = CAR.lift;
  group.updateMatrixWorld(true);
  addFuelCap(group, body, solid, wire);
  // the crash's box: the body's, not its mirrors' (they come off)
  const box = new THREE.Box3();
  for (const mesh of solidMeshes(body)) if (!partOf(mesh, body)) box.expandByObject(mesh);
  box.translate(group.position.clone().negate());

  return { group, wreck, chassis, body, box, spins, frontWheels, radius };
}
