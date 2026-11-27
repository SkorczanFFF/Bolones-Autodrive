import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { MINIGAME } from "../../config.js";
import { boundsOf } from "../../scene/instances.js";
import { solidMeshes } from "../../scene/wire.js";
import { convexOutline } from "./boxes.js";
import { METRE, PARTS, POSTS, UP, groups } from "./physics.js";

/**
 * @typedef {object} Post something rigid by the road (a palm's trunk, a rock): cars stop at it
 * @property {THREE.Object3D} object
 * @property {THREE.Vector3} at the middle of its foot, in the scene
 * @property {number} radius units: a palm's trunk is round, a rock's outline reaches as far at most
 * @property {THREE.Vector2[]} [outline] a rock's, seen from above round `at` (x, z), units
 * @property {number} [height] units; a palm's trunk is taller than any car
 * @property {boolean} [sways] a palm: hit, it leans and sways
 * @property {THREE.Color} [color] its shards; none, it sheds none (a rock does not break)
 *
 * @typedef {import("../crash.js").Party} Party
 */

const HEIGHT = 4 * METRE; // a palm's trunk, for a crash: taller than any car
/** The heights a palm's trunk is measured at for a crash: where the cars hit it, units. */
const TRUNK = [0.5, 1.8];

/**
 * A palm's trunk where the cars hit it (TRUNK), in the palm's frame: the middle and half the
 * width of what is there (the trunk, leaning a little).
 *
 * @param {THREE.Object3D} palm the model of the palms
 */
function trunkOf(palm) {
  const points = pointsOf(palm).filter(({ y }) => y > TRUNK[0] && y < TRUNK[1]);
  const box = new THREE.Box3().setFromPoints(points);
  const centre = box.getCenter(new THREE.Vector3()).setY(0);
  const size = box.getSize(new THREE.Vector3());
  return { centre, radius: (size.x + size.z) / 4 };
}

/**
 * A rock seen from above, in its frame: the outline round it (x, z).
 *
 * @param {THREE.Object3D} rock the model of a rock
 */
const outlineOf = (rock) =>
  convexOutline(pointsOf(rock).map(({ x, z }) => new THREE.Vector2(x, z)));

/**
 * The points of a model's meshes, in its frame.
 *
 * @param {THREE.Object3D} model
 */
function pointsOf(model) {
  model.updateWorldMatrix(true, true);
  const toModel = model.matrixWorld.clone().invert();
  /** @type {THREE.Vector3[]} */
  const points = [];
  for (const mesh of solidMeshes(model)) {
    const position = mesh.geometry.getAttribute("position");
    const matrix = toModel.clone().multiply(mesh.matrixWorld);
    for (let i = 0; i < position.count; i++) {
      points.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix));
    }
  }
  return points;
}

/** @type {WeakMap<THREE.Object3D, ReturnType<typeof trunkOf>>} by the palms' model, once */
const trunks = new WeakMap();
/** @type {WeakMap<THREE.Object3D, THREE.Vector2[]>} by a rock's model, measured once */
const outlines = new WeakMap();

/**
 * What is measured for a key, kept: measured once.
 *
 * @template {object} K
 * @template V
 * @param {WeakMap<K, V>} cache
 * @param {K} key
 * @param {(key: K) => V} measure
 */
function cached(cache, key, measure) {
  let value = cache.get(key);
  if (value === undefined) cache.set(key, (value = measure(key)));
  return value;
}

/**
 * The palms and the rocks by the road as posts (createPosts), each measured where it stands when
 * it comes up: a palm's trunk where the cars hit it, a rock as its outline stands up from the road.
 *
 * @param {THREE.Object3D[]} palms the nodes of their copies (scene/instances.js), as there are now
 * @param {THREE.Object3D[]} rocks
 * @param {THREE.Color} color the palms' shards
 * @returns {() => Post[]}
 */
export function roadside(palms, rocks, color) {
  /** @type {WeakMap<THREE.Object3D, Post>} */
  const measured = new WeakMap();
  /** @param {THREE.Object3D} palm */
  const palmPost = (palm) => {
    const { centre, radius } = cached(trunks, palm.userData.model, trunkOf); // scene/instances.js
    palm.updateWorldMatrix(true, false);
    const at = palm.localToWorld(centre.clone()).setY(0);
    return { object: palm, at, radius: radius * palm.scale.x, sways: true, color };
  };
  /** @param {THREE.Object3D} rock */
  const rockPost = (rock) => {
    const bounds = boundsOf(rock);
    const { x, z } = bounds.getCenter(new THREE.Vector3());
    const at = new THREE.Vector3(x, bounds.min.y, z);
    /** @type {THREE.Object3D} */
    const model = rock.userData.model; // scene/instances.js
    const around = cached(outlines, model, outlineOf);
    // as the rock stands, turned and scaled, round its middle (boundsOf brought it up to date)
    const outline = around.map((p) => {
      const { x: px, z: pz } = rock.localToWorld(new THREE.Vector3(p.x, 0, p.y));
      return new THREE.Vector2(px - x, pz - z);
    });
    const radius = Math.max(...outline.map((p) => p.length()));
    return { object: rock, at, radius, outline, height: bounds.max.y - bounds.min.y };
  };
  return () => [
    ...palms.map((palm) => cached(measured, palm, palmPost)),
    ...rocks.map((rock) => cached(measured, rock, rockPost)),
  ];
}

/**
 * The palms and the rocks by the road in a crash: posts that do not give, fixed where they are on
 * the road. Cars meet them through the crush (crash/crush.js), the parts torn off bounce off them.
 * A palm hit by a car leans away from it for good about the foot of its trunk (still after the
 * crash) and sways back and forth, dying down (MINIGAME.crash.palm).
 *
 * @param {RAPIER.World} world
 * @param {() => Post[]} posts the ones by the road now (more come up as the camera goes on)
 * @param {(point: THREE.Vector3) => THREE.Vector3} onRoad a point of the scene on the road
 */
export function createPosts(world, posts, onRoad) {
  const { palm } = MINIGAME.crash;
  /** @type {Map<THREE.Object3D, Party>} */
  const stands = new Map();
  /**
   * The palms hit: how they stood (`upright`), as they were at the last hit (`original`), leaning
   * on from there about `axis` by `lean`, swaying `swing`, since then.
   *
   * @type {Map<THREE.Object3D, { upright: THREE.Quaternion, original: THREE.Quaternion, foot: THREE.Vector3, axis: THREE.Vector3, lean: number, swing: number, since: number }>}
   */
  const sways = new Map();
  const turn = new THREE.Quaternion();
  const up = new THREE.Vector3();

  return {
    /** The posts there are now: new ones stand where they are on the road, gone ones go. */
    sync() {
      const there = posts();
      for (const { object, at, radius, outline, height = HEIGHT, sways: leans, color } of there) {
        if (stands.has(object)) continue;
        const { x, y, z } = onRoad(at);
        const body = world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(x, y + height / 2, z),
        );
        // a rock as its outline stands up from the road (as the crush meets it), a trunk round
        const [low, high] = [-height / 2, height / 2];
        const shape = outline
          ? /** @type {RAPIER.ColliderDesc} */ (
              RAPIER.ColliderDesc.convexHull(
                new Float32Array(outline.flatMap((p) => [p.x, low, p.y, p.x, high, p.y])),
              )
            )
          : RAPIER.ColliderDesc.cylinder(height / 2, radius);
        // no mass: a fixed body's would count in the crush as if the palm weighed it
        world.createCollider(shape.setDensity(0).setCollisionGroups(groups(POSTS, PARTS)), body);
        object.updateWorldMatrix(true, false);
        const foot = object.worldToLocal(at.clone()); // a palm leans about it
        stands.set(object, {
          body,
          half: [radius, height / 2, radius],
          shift: new THREE.Vector3(),
          outline,
          stiffness: Infinity,
          color,
          struck({ into }, speed, time) {
            // a touch (or the dents following where a car stays in it) does not sway it; hit
            // again, it leans on from as it is now (swaying, leaning), as far as `lean` in all
            if (!leans || speed / METRE < MINIGAME.crash.nudge) return undefined;
            const share = Math.min(1, speed / METRE / palm.full);
            const upright = sways.get(object)?.upright ?? object.quaternion.clone();
            const leant = up
              .copy(UP)
              .applyQuaternion(object.quaternion)
              .angleTo(UP.clone().applyQuaternion(upright));
            sways.set(object, {
              upright,
              original: object.quaternion.clone(),
              foot,
              axis: UP.clone().cross(into).normalize(),
              lean: Math.min(palm.lean * share, Math.max(0, palm.lean - leant)),
              swing: palm.swing * share,
              since: time,
            });
            return undefined;
          },
        });
      }
      const standing = new Set(there.map(({ object }) => object));
      for (const [object, { body }] of stands) {
        if (standing.has(object)) continue;
        world.removeRigidBody(body);
        stands.delete(object);
      }
      return [...stands.values()];
    },

    /**
     * Sways the palms hit: each bends over at once, then sways, dying down.
     *
     * @param {number} time game seconds since the crash
     */
    sway(time) {
      for (const [object, { original, foot, axis, lean, swing, since }] of sways) {
        const t = time - since;
        const angle =
          lean * (1 - Math.exp(-t / palm.bend)) +
          swing * Math.exp(-t / palm.settle) * Math.sin((2 * Math.PI * t) / palm.period);
        turnAbout(object, foot, turn.setFromAxisAngle(axis, angle).multiply(original));
      }
    },

    /** Leaves the palms hit leaning as they settled, swaying no more: they stand so on. */
    dispose() {
      for (const [object, { original, foot, axis, lean }] of sways) {
        turnAbout(object, foot, turn.setFromAxisAngle(axis, lean).multiply(original));
      }
    },
  };
}

/**
 * Turns a palm about a point of it (in its frame), which stays where it is.
 *
 * @param {THREE.Object3D} object
 * @param {THREE.Vector3} point
 * @param {THREE.Quaternion} quaternion
 */
function turnAbout(object, point, quaternion) {
  const from = point.clone().multiply(object.scale);
  const at = from.clone().applyQuaternion(object.quaternion).add(object.position);
  object.quaternion.copy(quaternion);
  object.position.copy(at).sub(from.applyQuaternion(quaternion));
}
