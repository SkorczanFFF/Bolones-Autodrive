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
 * The minigames' traffic put together: each car's body and headlamps (scene/sedan.js,
 * scene/van.js), its wheels on the rig, its bumpers and mirrors (scene/carParts.js) nodes of
 * their own for a crash to move and tear off; and the whole car as one mesh, to draw far away.
 *
 * @typedef {import("./trafficModels.js").TrafficModel} TrafficModel
 * @typedef {import("./polygons.js").Part} Part
 */

/**
 * How far the widest of the cars reaches out from its centre line, mirrors and all (their
 * `reach`), in scene units: the minigame keeps lanes this far from the centre.
 *
 * @param {THREE.Object3D[]} models createTrafficModels()
 */
export function widestReach(models) {
  return Math.max(
    ...models.map(({ userData: { reach } }) => Math.max(-reach.min[0], reach.max[0])),
  );
}

/**
 * The minigames' low-poly traffic of the communist era, traced from blueprints, one template per
 * TRAFFIC_MODELS entry (a van by van.js, the others by sedan.js); the front faces +z (towards the
 * camera). The body is one geometry (one draw call plus its wireframe twin), with
 * `userData.polygons` like the FBX models (core/fbx.js), so its lines follow the designed
 * outlines, not every triangle. Each wheel,
 * bumper and the spare wheel is a node of its own (`userData.part`), so a crash can move a wheel or
 * the spare whole and tear any off; each headlamp is a mesh of its own ("lamp"), so a crash can put out just the ones it
 * crushes.
 *
 * The local hitbox (the bounds of the body, its wheels and bumpers: the crash's box for the
 * physics) is in `userData.hitbox` as { min, max } arrays: clone() copies userData through JSON,
 * which would turn a Box3 into a plain object. The mirrors (a node each, `userData.part`
 * "mirror", which a crash tears off) stand out of it: `userData.reach`, the same with them, is
 * what the Bolones must not touch (game/minigame.js). The car's mass is in `userData.mass`.
 *
 * @param {import("./materials.js").Materials} materials
 * @returns {THREE.Group[]}
 */
export function createTrafficModels(materials) {
  return Object.values(TRAFFIC_MODELS).map((model) => {
    const { body, lamps } = "van" in model ? vanGeometry(model) : sedanGeometry(model);
    const scale = TRAFFIC.scale;
    const shell = new THREE.Mesh(body.scale(scale, scale, scale));
    const car = new THREE.Group().add(shell);
    /**
     * A bumper, a mirror or the spare wheel, a node of its own: it bends with the body (not the
     * spare), or comes off.
     *
     * @param {Loose} loose
     */
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
      const front = at.z > 0; // the front faces +z
      const mesh = new THREE.Mesh(loose.geometry.scale(scale, scale, scale));
      car.add(mountWheel(mesh, at, model.wheel.radius * scale, front));
    }
    for (const lamp of lamps) {
      const mesh = new THREE.Mesh(lamp.scale(TRAFFIC.scale, TRAFFIC.scale, TRAFFIC.scale));
      mesh.name = "lamp";
      car.add(mesh);
    }
    dress(car, materials.solid.traffic, materials.wire.traffic);
    for (const lamp of car.getObjectsByProperty("name", "lamp")) {
      // lit, its outline waiting for a crash to put it out (game/minigame.js)
      /** @type {THREE.Mesh} */ (lamp).material = materials.headlight;
      lamp.children[0].visible = false;
    }

    car.updateMatrixWorld(true);
    const { min, max } = new THREE.Box3().setFromObject(car);
    car.userData.hitbox = { min: min.toArray(), max: max.toArray() };
    // after the hitbox: the mirrors stand out of it (a box as wide would make the physics' box
    // wider and, one mirror only, shift its middle), within the reach
    const { mirrors } = model;
    for (const parts of mirrors ? mirrors.sides.map((side) => mirrorParts(mirrors, side)) : []) {
      const mirror = apart(loose(parts, "mirror", model));
      car.add(dress(mirror, materials.solid.traffic, materials.wire.traffic));
    }
    car.updateMatrixWorld(true);
    // only the body casts a shadow: the wheels', bumpers', lamps' and mirrors' fall in the body's
    // (five sun shadow passes each saved)
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
 * What stands in for a car far away (drawFar): the car as one mesh, its lamps as another, its
 * parts where they are at rest and their lines as measured (they do not change when a part only
 * moves), `userData.far`, hidden until drawFar() shows them.
 *
 * @param {THREE.Group} car built, its parts on the rig
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
 * Draws a car of the traffic as one mesh (far) or whole, on its rig: far away its parts are a few
 * pixels each, yet as many draw calls as up close. After a crash, a car it dents or one near the camera is whole
 * (game/minigame.js).
 *
 * @param {THREE.Object3D} car createTrafficModels()
 * @param {boolean} far
 */
export function drawFar(car, far) {
  for (const child of car.children) child.visible = Boolean(child.userData.far) === far;
}

/**
 * @typedef {object} Loose a wheel, a bumper or a mirror of a car: a node of its own
 * @property {THREE.BufferGeometry} geometry round its middle
 * @property {THREE.Vector3} at its middle in the car, metres
 * @property {import("./rig.js").PartName} part
 */

/**
 * A part round its middle, in metres, and where that is.
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
 * A car's bumpers (the guard with the front one), wheels and spare wheel, each round its middle, in metres
 * (the car's origin on the ground in the middle of its length).
 *
 * @param {TrafficModel | import("./trafficModels.js").VanModel} model
 * @returns {Loose[]}
 */
function looseParts(model) {
  const { wheel } = model;
  return [
    ...("spare" in model && model.spare ? [loose(spareParts(model), "spare", model)] : []),
    loose(
      [
        bumper(model.bumpers.front, model.length, -1),
        ...("guard" in model && model.guard ? guardParts(model.guard) : []),
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
