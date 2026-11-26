import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { MINIGAME } from "../../config.js";
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
  /** @type {Map<THREE.Object3D, { original: THREE.Quaternion, foot: THREE.Vector3, axis: THREE.Vector3, lean: number, swing: number, since: number }>} */
  const sways = new Map();
  const turn = new THREE.Quaternion();

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
            // a touch (or the dents following where a car stays in it) does not sway it, each
            // hit starting it over
            if (!leans || speed / METRE < MINIGAME.crash.nudge) return undefined;
            const share = Math.min(1, speed / METRE / palm.full);
            const was = sways.get(object);
            sways.set(object, {
              original: was?.original ?? object.quaternion.clone(),
              foot,
              axis: UP.clone().cross(into).normalize(),
              lean: Math.min(palm.lean, (was?.lean ?? 0) + palm.lean * share),
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
