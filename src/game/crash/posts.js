import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { MINIGAME } from "../../config.js";
import { METRE, PARTS, POSTS, UP, groups } from "./physics.js";

/**
 * @typedef {object} Post something rigid by the road (a palm's trunk, a rock): cars stop at it
 * @property {THREE.Object3D} object
 * @property {THREE.Vector3} at the middle of its foot, in the scene
 * @property {number} radius units
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
 * A palm hit by a car leans away from it for good and sways back and forth, dying down
 * (MINIGAME.crash.palm).
 *
 * @param {RAPIER.World} world
 * @param {() => Post[]} posts the ones by the road now (more come up as the camera goes on)
 * @param {(point: THREE.Vector3) => THREE.Vector3} onRoad a point of the scene on the road
 */
export function createPosts(world, posts, onRoad) {
  const { palm } = MINIGAME.crash;
  /** @type {Map<THREE.Object3D, Party>} */
  const stands = new Map();
  /** @type {Map<THREE.Object3D, { original: THREE.Quaternion, axis: THREE.Vector3, lean: number, swing: number, since: number }>} */
  const sways = new Map();
  const turn = new THREE.Quaternion();

  return {
    /** The posts there are now: new ones stand where they are on the road, gone ones go. */
    sync() {
      const there = posts();
      for (const { object, at, radius, height = HEIGHT, sways: leans, color } of there) {
        if (stands.has(object)) continue;
        const { x, y, z } = onRoad(at);
        const body = world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(x, y + height / 2, z),
        );
        const round = RAPIER.ColliderDesc.cylinder(height / 2, radius);
        // no mass: a fixed body's would count in the crush as if the palm weighed it
        world.createCollider(round.setDensity(0).setCollisionGroups(groups(POSTS, PARTS)), body);
        stands.set(object, {
          body,
          half: [radius, height / 2, radius],
          shift: new THREE.Vector3(),
          stiffness: Infinity,
          color,
          struck({ into }, speed, time) {
            if (!leans) return undefined;
            const share = Math.min(1, speed / METRE / palm.full);
            const was = sways.get(object);
            sways.set(object, {
              original: was?.original ?? object.quaternion.clone(),
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
      for (const [object, { original, axis, lean, swing, since }] of sways) {
        const t = time - since;
        const angle =
          lean * (1 - Math.exp(-t / palm.bend)) +
          swing * Math.exp(-t / palm.settle) * Math.sin((2 * Math.PI * t) / palm.period);
        object.quaternion.copy(original).premultiply(turn.setFromAxisAngle(axis, angle));
      }
    },

    /** Stands the palms up straight. */
    dispose() {
      for (const [object, { original }] of sways) object.quaternion.copy(original);
    },
  };
}
