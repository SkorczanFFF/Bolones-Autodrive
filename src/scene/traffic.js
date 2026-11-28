import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { TRAFFIC } from "../config.js";
import { bumper, centred, guardParts, mirrorParts, spareParts, wheelParts } from "./carParts.js";
import { withPolygons } from "./polygons.js";
import { mountWheel } from "./rig.js";
import { sedanGeometry } from "./sedan.js";
import { TRAFFIC_MODELS } from "./trafficModels.js";
import { vanGeometry } from "./van.js";
import { dress, solidMeshes, wireOf } from "./wire.js";

/**
 * @typedef {import("./trafficModels.js").TrafficModel} TrafficModel
 * @typedef {import("./polygons.js").Part} Part
 */

/**
 * How far the widest car reaches from its centre line, mirrors and all, in scene units: the
 * minigame keeps its lanes this far out.
 *
 * @param {THREE.Object3D[]} models createTrafficModels()
 */
export function widestReach(models) {
  return Math.max(
    ...models.map(({ userData: { reach } }) => Math.max(-reach.min[0], reach.max[0])),
  );
}

/**
 * A vehicle's body and headlamps, in metres, by its kind.
 *
 * @param {TrafficModel} model
 */
const bodyOf = (model) => (model.kind === "van" ? vanGeometry(model) : sedanGeometry(model));

/**
 * One template per TRAFFIC_MODELS entry, its front towards +z, in scene units. The body is one
 * mesh, its lines along `userData.polygons` (as core/fbx.js); each wheel, bumper, mirror and the
 * spare wheel is a node of its own (`userData.part`) for a crash to move or tear off; each headlamp a mesh ("lamp")
 * for a crash to put out.
 *
 * userData: `hitbox` (body, wheels and bumpers: the physics' box) and `reach` (with the mirrors:
 * what the Bolones must not touch) as { min, max } arrays, since clone() copies userData through
 * JSON; `mass`, `label`.
 *
 * @param {import("./materials.js").Materials} materials
 * @returns {THREE.Group[]}
 */
export function createTrafficModels(materials) {
  const scale = TRAFFIC.scale;
  return TRAFFIC_MODELS.map((model) => {
    const { body, lamps } = bodyOf(model);
    const shell = new THREE.Mesh(body.scale(scale, scale, scale));
    const car = new THREE.Group().add(shell);
    /** A bumper, a mirror or the spare wheel: a node of its own. @param {Loose} loose */
    const apart = ({ geometry, at, part }) => {
      const node = new THREE.Group().add(new THREE.Mesh(geometry.scale(scale, scale, scale)));
      node.position.copy(at).multiplyScalar(scale);
      node.userData.part = part;
      return node;
    };
    for (const loose of looseParts(model)) {
      if (loose.part !== "wheel") {
        car.add(apart(loose));
        continue;
      }
      const at = loose.at.multiplyScalar(scale);
      const mesh = new THREE.Mesh(loose.geometry.scale(scale, scale, scale));
      car.add(mountWheel(mesh, at, model.wheel.radius * scale, at.z > 0));
    }
    for (const lamp of lamps) {
      const mesh = new THREE.Mesh(lamp.scale(scale, scale, scale));
      mesh.name = "lamp";
      car.add(mesh);
    }
    dress(car, materials.solid.traffic, materials.wire.traffic);
    for (const lamp of car.getObjectsByProperty("name", "lamp")) {
      // lit, its outline shown once a crash puts it out (game/minigame.js)
      /** @type {THREE.Mesh} */ (lamp).material = materials.headlight;
      lamp.children[0].visible = false;
    }

    car.updateMatrixWorld(true);
    const { min, max } = new THREE.Box3().setFromObject(car);
    car.userData.hitbox = { min: min.toArray(), max: max.toArray() };
    // after the hitbox: in it, they would widen the physics' box (one mirror: shift it)
    const { mirrors } = model;
    for (const parts of mirrors ? mirrors.sides.map((side) => mirrorParts(mirrors, side)) : []) {
      const mirror = apart(loose(parts, "mirror", model));
      car.add(dress(mirror, materials.solid.traffic, materials.wire.traffic));
    }
    car.updateMatrixWorld(true);
    // only the body casts a shadow, the parts' fall in it (shadow passes saved)
    for (const mesh of solidMeshes(car)) mesh.castShadow = mesh === shell;
    const reach = new THREE.Box3().setFromObject(car);
    car.userData.reach = { min: reach.min.toArray(), max: reach.max.toArray() };
    car.userData.mass = model.mass;
    car.userData.label = model.label;
    car.add(...farMeshes(car, materials));
    return car;
  });
}

/**
 * A car far away (drawFar): its parts at rest as one mesh with their lines, its lamps another;
 * `userData.far`, hidden until drawn.
 *
 * @param {THREE.Group} car
 * @param {import("./materials.js").Materials} materials
 */
function farMeshes(car, materials) {
  car.updateMatrixWorld(true);
  /** @type {(geometry: THREE.BufferGeometry, mesh: THREE.Mesh) => THREE.BufferGeometry} */
  const placed = (geometry, mesh) => geometry.clone().applyMatrix4(mesh.matrixWorld);
  const meshes = solidMeshes(car);
  const lamps = meshes.filter(({ name }) => name === "lamp");
  const parts = meshes.filter((mesh) => !lamps.includes(mesh));
  const lines = parts.map((mesh) =>
    placed(/** @type {THREE.Mesh} */ (wireOf(mesh)).geometry, mesh),
  );
  const body = dress(
    new THREE.Mesh(mergeGeometries(lines)), // its lines in it: scene/lines.js uses them as is
    materials.solid.traffic,
    materials.wire.traffic,
  );
  const lit = new THREE.Mesh(
    mergeGeometries(lamps.map((lamp) => placed(lamp.geometry, lamp))),
    materials.headlight,
  );
  for (const mesh of [body, lit]) Object.assign(mesh, { visible: false }).userData.far = true;
  return [body, lit];
}

/**
 * Draws a car as one mesh (far) or whole: far away its parts are a few pixels each, yet as many
 * draw calls. A car a crash dents, or one near the camera, is drawn whole (game/minigame.js).
 *
 * @param {THREE.Object3D} car createTrafficModels()
 * @param {boolean} far
 */
export function drawFar(car, far) {
  for (const child of car.children) child.visible = Boolean(child.userData.far) === far;
}

/**
 * @typedef {object} Loose a node of its own
 * @property {THREE.BufferGeometry} geometry round its middle
 * @property {THREE.Vector3} at its middle in the car, metres
 * @property {import("./rig.js").PartName} part
 */

/**
 * Parts as one geometry round its middle, and where that is.
 *
 * @param {Part[]} of
 * @param {Loose["part"]} part
 * @param {{ length: number }} model
 * @returns {Loose}
 */
function loose(of, part, model) {
  const geometry = centred(withPolygons(of), model);
  geometry.computeBoundingBox();
  const at = /** @type {THREE.Box3} */ (geometry.boundingBox).getCenter(new THREE.Vector3());
  geometry.translate(-at.x, -at.y, -at.z);
  return { geometry, at, part };
}

/**
 * A car's bumpers (the guard on the front one), wheels and spare wheel.
 *
 * @param {TrafficModel} model
 * @returns {Loose[]}
 */
function looseParts(model) {
  const { wheel } = model;
  return [
    ...(model.spare ? [loose(spareParts(model), "spare", model)] : []),
    loose(
      [
        bumper(model.bumpers.front, model.length, -1),
        ...(model.guard ? guardParts(model.guard) : []),
      ],
      "bumper",
      model,
    ),
    loose([bumper(model.bumpers.rear, 0, 1)], "bumper", model),
    ...wheel.axles.flatMap((axle, i) =>
      [-1, 1].map((side) =>
        loose(
          wheelParts(wheel, [(side * wheel.track[i]) / 2, wheel.radius, axle], side),
          "wheel",
          model,
        ),
      ),
    ),
  ];
}
