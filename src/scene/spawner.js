import { MathUtils } from "three";
import { SPAWN } from "../config.js";
import { createFader } from "./fade.js";

/**
 * @typedef {object} SpawnerOptions
 * @property {import("three").Object3D} parent where instances are added
 * @property {number} speed units per second at speedMultiplier 1
 * @property {(roll: number) => number} interval seconds between spawns at speed 1 and density 1;
 *   `roll` is a random number in [0, 1) fixed for the current cycle (for random intervals)
 * @property {number} [minInterval] lower bound in seconds after speed and density scaling
 * @property {() => import("three").Object3D[]} create new instances placed in x/y; z is set here
 * @property {number} [startZ]
 * @property {number} [endZ]
 * @property {number} [fadeIn] seconds new instances take to fade in from transparent (0 = pop in)
 * @property {number} [fadeOut] seconds instances take to fade out before endZ at speedMultiplier 1;
 *   a fixed distance, so faster objects fade quicker (0 = vanish at endZ)
 *
 * startZ, endZ, fadeIn and fadeOut default to SPAWN.
 */

/**
 * Spawns objects at startZ by the way travelled and moves them towards endZ with the world
 * speed, all inside update(dt). Speed and density changes apply immediately, including to
 * objects already on the way. Instances fade in after spawning and fade out before endZ.
 *
 * @param {SpawnerOptions} options
 */
export function createSpawner({
  parent,
  speed,
  interval,
  minInterval = 0,
  create,
  startZ = SPAWN.startZ,
  endZ = SPAWN.endZ,
  fadeIn = SPAWN.fadeIn,
  fadeOut = SPAWN.fadeOut,
}) {
  /** @type {import("three").Object3D[]} */
  const objects = [];
  /** @type {Map<import("three").Object3D, number>} seconds since each instance appeared */
  const ages = new Map();
  let due = 0; // seconds at speed 1 since the last spawn
  let roll = Math.random();
  const fader = createFader();
  const fadeOutDistance = speed * fadeOut;

  /**
   * Fade-in by age, fade-out by the distance left to endZ, both eased.
   *
   * @param {import("three").Object3D} object
   */
  function opacityOf(object) {
    const age = /** @type {number} */ (ages.get(object));
    const fadingIn = fadeIn > 0 ? age / fadeIn : 1;
    const fadingOut = fadeOutDistance > 0 ? (endZ - object.position.z) / fadeOutDistance : 1;
    return MathUtils.smoothstep(Math.min(fadingIn, fadingOut), 0, 1); // eased, not linear
  }

  const spawner = {
    objects,
    /** Spawn-rate multiplier (GUI density). */
    density: 1,
    /** When false, existing objects keep moving but nothing new spawns. */
    spawning: true,

    /** @param {number} speedMultiplier */
    currentInterval(speedMultiplier) {
      return Math.max(minInterval, interval(roll) / (speedMultiplier * spawner.density));
    },

    /**
     * @param {number} dt
     * @param {number} speedMultiplier how fast the objects move
     * @param {number} [coming] how fast new ones come, spacing them: as fast, unless something else
     *   moves them (after a crash the physics moves the traffic, still coming a while)
     */
    update(dt, speedMultiplier, coming = speedMultiplier) {
      const velocity = speed * speedMultiplier;

      for (let i = objects.length - 1; i >= 0; i--) {
        const object = objects[i];
        object.position.z += velocity * dt;
        if (object.position.z > endZ) {
          fader.release(object);
          ages.delete(object);
          parent.remove(object);
          objects.splice(i, 1);
        } else {
          ages.set(object, /** @type {number} */ (ages.get(object)) + dt);
          fader.set(object, opacityOf(object));
        }
      }

      if (!spawner.spawning) {
        due = 0; // the first spawn after re-enabling waits a full interval
        return;
      }

      // The way travelled, in seconds at speed 1: a world standing still (after a crash) saves up
      // no spawns for when it moves again.
      due += dt * coming;
      if (coming <= 0) return;
      let wait = spawner.currentInterval(coming) * coming;
      while (due >= wait) {
        due -= wait;
        // Objects spawned late in a long frame start a bit further, keeping the spacing even.
        const late = due / coming; // seconds
        for (const object of create()) {
          object.position.z = startZ + late * speed * coming;
          parent.add(object);
          objects.push(object);
          ages.set(object, late);
          fader.set(object, opacityOf(object));
        }
        roll = Math.random();
        wait = spawner.currentInterval(coming) * coming;
      }
    },

    /**
     * Fast-forwards one trip from startZ to `reach` (endZ: the whole way) at speed 1, so the track
     * starts lined with objects instead of waiting for the first ones to come from far away.
     * Spacing does not depend on the step (see update), so big steps are fine.
     *
     * @param {number} [step] seconds
     * @param {number} [reach] z none gets past (the first a spawn short of it)
     */
    prewarm(step = 0.25, reach = endZ) {
      const trip = (reach - startZ) / speed;
      for (let time = 0; time < trip; time += step) spawner.update(step, 1);
    },

    /** Removes every instance and restarts the timer. */
    clear() {
      fader.clear();
      for (const object of objects) parent.remove(object);
      objects.length = 0;
      ages.clear();
      due = 0;
    },
  };

  return spawner;
}
