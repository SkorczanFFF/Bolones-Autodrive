import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { MINIGAME } from "../../config.js";
import { boxOf, endOn, extent, level, meeting, middleOf, overlap, penetration } from "./boxes.js";
import {
  AHEAD,
  IDENTITY,
  METRE,
  ORIGIN,
  STEP,
  UP,
  giving,
  rotation,
  vector,
  velocityAt,
} from "./physics.js";

/**
 * @typedef {object} Solid what meets in a crash, as the crush sees it: a car, or a post
 * @property {RAPIER.RigidBody} body
 * @property {number[]} half its box's half size
 * @property {THREE.Vector3} shift its box from the body's centre
 * @property {number} stiffness its crumple zone's spring rate, force per unit of crush; Infinity:
 *   a post, it does not give
 *
 * @typedef {object} Meeting two solids crashing (closing faster than a nudge)
 * @property {THREE.Vector3} normal they met along, from the first to the second
 * @property {import("../../scene/crumple.js").Hit[]} hits one for each, on the road
 * @property {THREE.Vector3} at the middle of where they meet, on the road
 * @property {number} speed they close at, units/s
 * @property {number} energy the crumple zones take up, joules
 *
 * @typedef {object} Crush two solids crushing into each other
 * @property {THREE.Vector3} facing the normal they met along, in the first one's frame
 * @property {number} e coefficient of restitution of this crash
 * @property {number} capacity how deep the crumple zones go together, units; beyond, solid
 * @property {number} deepest the most the crumple zones have been crushed, units
 * @property {number} meetings how many times the pair has met (MEETINGS at most)
 * @property {(deepest: number) => void} dent shows how far the dents have gone in
 * @property {boolean} [nudge] they only touched (MINIGAME.crash.nudge): no crumple zones, no dents
 * @property {number} [share] how wide they met, of the narrower one's width
 * @property {RAPIER.ImpulseJoint} [snag] holds the crushed fronts together, until `free`
 * @property {number} [free] game time the snag lets go
 */

const SOLID = 20; // past their crumple zones, cars are this much stiffer
const MEETINGS = 4; // a pair meets again through other faces at most this often (they slid past)
const SLACK = 0.1; // units: how much deeper the old faces must overlap than the new ones

/** Whether a solid is a post (a palm's trunk, a rock): it does not give. @param {Solid} solid */
const isPost = ({ stiffness }) => stiffness === Infinity;

/** @type {WeakMap<Solid, number>} a solid's box does not change: its reach, measured once */
const reaches = new WeakMap();
/** How far from its body's middle a solid's box reaches at most. @param {Solid} solid */
export const reachOf = (solid) => {
  let reach = reaches.get(solid);
  if (reach === undefined) {
    const { half, shift } = solid;
    reaches.set(solid, (reach = Math.hypot(half[0], half[1], half[2]) + shift.length()));
  }
  return reach;
};

/**
 * Cars meet through their crumple zones, not as rigid boxes: a front is a spring as stiff as the
 * car is heavy (MINIGAME.crash.stiffness), loading until the closing speed is used up (some
 * 0.1 s), unloading only a little (MINIGAME.crash.restitution). Momentum is kept, the energy goes
 * into the crush, the lighter car takes the deeper dent, and both grow with the speed. Ends
 * crushed into each other are caught for a while (MINIGAME.crash.interlock); a post takes
 * nothing, the car all of the crush.
 *
 * @template {Solid} T
 * @param {RAPIER.World} world
 * @param {(a: T, b: T, crash?: Meeting) => ((progress: number) => void) | undefined} met two met
 *   for the first time (or again, through other faces), crashing or only touching; for a crash,
 *   what shows the crush going in (0..1)
 */
export function createCrushes(world, met) {
  const { restitution, scrape, nudge, interlock } = MINIGAME.crash;
  /** @type {WeakMap<T, WeakMap<T, Crush>>} */
  const crushes = new WeakMap();
  /** @type {Set<Crush>} */
  const snagged = new Set();

  /**
   * Two solids crushing for the first time (or again).
   *
   * @param {T} a
   * @param {T} b
   * @param {import("./boxes.js").Box[]} boxes theirs, now
   * @param {{ depth: number, normal: THREE.Vector3 }} face they met through, from a to b
   * @param {number} closing units/s
   * @param {number} k the fronts' stiffness together
   * @param {number} meetings how many times they met before
   * @returns {Crush}
   */
  function meet(a, b, [boxA, boxB], { depth, normal }, closing, k, meetings) {
    const speed = Math.max(0, closing);
    const e = restitution.atRest * Math.exp(-speed / METRE / restitution.falloff);
    const facing = normal.clone().applyQuaternion(rotation(a.body.rotation()).invert());
    const crush = { facing, e, capacity: depth, deepest: 0, meetings: meetings + 1 };
    if (speed / METRE < nudge) {
      // a nudge has no crumple zones but what they overlap already (no kick from the solid)
      met(a, b);
      return { ...crush, nudge: true, dent() {} };
    }
    const mass = 1 / (a.body.invMass() + b.body.invMass());
    const full = Math.sqrt(depth ** 2 + (mass * speed ** 2) / k); // all the closing energy
    const ahead = new THREE.Vector3(normal.x, 0, normal.z).normalize(); // from a to b, level
    const across = new THREE.Vector3(-ahead.z, 0, ahead.x);
    // as wide as they overlap halfway through the crush (where the dent is half as deep), there
    const stretch = meeting(boxA, boxB, ahead, (full - depth) / 2);
    const reach = stretch?.half ?? penetration(boxA, boxB, across) / 2;
    // of the narrower one's width
    const share = reach / Math.min(extent(boxA, across), extent(boxB, across));
    // a corner takes up its share of the closing energy only, then glances off
    const taken = Math.min(1, share / interlock.overlap);
    const expected = Math.sqrt(depth ** 2 + (taken * mass * speed ** 2) / k);
    const at = middleOf(boxA, boxB, ahead);
    if (stretch) at.addScaledVector(across, stretch.middle - at.dot(across));
    // each takes its share of the crush (the stiffer front gives less), from its face, half the
    // first overlap away from the middle
    const hits = [a, b].map((solid, i) => ({
      point: at,
      into: new THREE.Vector3(ahead.x, 0, ahead.z).multiplyScalar(i ? 1 : -1),
      plane: (expected * k) / solid.stiffness - depth / 2,
      reach,
    }));
    const energy = (0.5 * taken * mass * speed ** 2 * (1 - e ** 2)) / METRE ** 2;
    const show = met(a, b, { normal, hits, at, speed, energy });
    return {
      ...crush,
      share,
      capacity: expected,
      dent: (deepest) => show?.(Math.min(1, deepest / expected)),
    };
  }

  return {
    /**
     * Two solids (a car, then a car or a post) that overlap: an elastic-plastic spring between
     * their crumple zones, pushing along the overlap's normal at its middle, with `scrape`
      share,
     * friction along the faces.
     *
     * @param {T} a
     * @param {T} b
     * @param {number} time game seconds
     */
    collide(a, b, time) {
      // a post is round: as wide whichever way the car meets it
      const turn = rotation(a.body.rotation());
      const { x, z } = AHEAD.clone().applyQuaternion(turn);
      const round = isPost(b)
        ? new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(x, z))
        : undefined;
      const boxes = [boxOf(a), boxOf(b, round)];
      const [boxA, boxB] = boxes;
      const contact = overlap(boxA, boxB);
      if (!contact) return;
      const k = 1 / (1 / a.stiffness + 1 / b.stiffness); // the fronts in series
      const sides = contact.faces.filter((f) => Math.abs(f.normal.y) < 0.7); // not top or bottom
      const least = sides.reduce((best, f) => (f.depth < best.depth ? f : best));
      const pairs = crushes.get(a) ?? new WeakMap();
      crushes.set(a, pairs);
      const last = pairs.get(b);
      let crush = last;
      const { point } = contact;
      const relative = velocityAt(b.body, point).sub(velocityAt(a.body, point));
      if (last && !last.snag && last.meetings < MEETINGS) {
        // Done with (crushed and let go, or solid) and slid past each other, a corner into a
        // side: the faces they met through no longer keep them apart, they meet again through
        // the faces they overlap least across. Met wide, what their crumple zones took up is no
        // overlap (a fast crush goes deeper than the fronts are wide): they stay in each other,
        // corners glance off. Only touched, they crash when they close fast enough.
        const facing = level(last.facing.clone().applyQuaternion(turn));
        const stale = penetration(boxA, boxB, facing);
        const done = last.free !== undefined || stale > last.capacity;
        const wide = (last.share ?? 0) >= interlock.overlap;
        const beyond = stale - (wide ? last.deepest : 0);
        if (facing.lengthSq() < 0.5) {
          crush = undefined; // rolled over: the faces they met through face up or down now
        } else if (
          done &&
          least.normal.dot(facing) < Math.SQRT1_2 &&
          beyond > least.depth + SLACK
        ) {
          crush = undefined;
        } else if (last.nudge && -relative.dot(facing) >= nudge * METRE) {
          crush = undefined;
        }
      }
      if (!crush) {
        // The faces they first met through: crossed the most recently at the speed they close
        // at (the least overlap would be wrong for fast cars, caught a frame deep).
        const since = (/** @type {{ normal: THREE.Vector3, depth: number }} */ face) =>
          face.depth / Math.max(-relative.dot(face.normal), 1e-6);
        const face = last ? least : sides.reduce((best, f) => (since(f) < since(best) ? f : best));
        crush = meet(a, b, boxes, face, -relative.dot(face.normal), k, last?.meetings ?? 0);
        pairs.set(b, crush);
      }
      const normal = level(crush.facing.clone().applyQuaternion(turn));
      const depth = penetration(boxA, boxB, normal);
      if (depth <= 0) return;
      // they push in the middle of where they overlap (not low on a tall palm: it would trip the
      // car)
      const middle = middleOf(boxA, boxB, normal);
      const moving = velocityAt(b.body, middle).sub(velocityAt(a.body, middle));
      if (crush.snag) {
        // caught: no spring, nothing to kick back; what goes deeper meanwhile stays crushed (not
        // squeezed into the solid, to fly apart when they let go)
        crush.capacity = Math.max(crush.capacity, depth);
        crush.deepest = Math.max(crush.deepest, depth);
        return;
      }
      const closing = -moving.dot(normal);

      // the crumple zones, as deep as the crash goes
      const crushed = Math.min(depth, crush.capacity);
      let force = 0;
      if (crushed > 0 && crushed >= crush.deepest) {
        crush.deepest = crushed;
        force = k * crushed;
      } else if (crushed > 0) {
        // springs back along a steeper line, returning e² of the energy; the rest stays crushed
        const kept = crush.deepest * (1 - crush.e ** 2);
        force =
          crushed > kept ? (k * crush.deepest * (crushed - kept)) / (crush.deepest - kept) : 0;
        if (crush.free === undefined) {
          // fully crushed: fronts (or a front and a rear) are caught in each other, the wreck
          // turns as one for a while; sides swiped, a front in a side, a palm, a touch: they
          // slide on
          const caught =
            !crush.nudge &&
            !isPost(b) &&
            endOn(a.body, normal) &&
            endOn(b.body, normal) &&
            crush.share !== undefined &&
            crush.share >= interlock.overlap;
          if (caught) {
            // held as they are now: the first one's middle where it is from the second
            const back = rotation(b.body.rotation()).invert();
            const anchor = vector(a.body.translation())
              .sub(vector(b.body.translation()))
              .applyQuaternion(back);
            const joint = RAPIER.JointData.fixed(ORIGIN, IDENTITY, anchor, back.multiply(turn));
            crush.snag = world.createImpulseJoint(joint, a.body, b.body, true);
            snagged.add(crush);
          }
          crush.free = time + (caught ? interlock.time : 0);
        }
      }
      crush.dent(crush.deepest);
      // beyond them (or a nudge): solid, springy and damped, so the cars do not pass into each
      // other
      if (depth > crush.capacity) {
        // as heavy as they are where they touch (a corner turns away easily), as stiff as a step
        // can take without blowing up
        const mass = 1 / (giving(a.body, middle, normal) + giving(b.body, middle, normal));
        const stiff = Math.min(SOLID * k, (0.25 * mass) / STEP ** 2);
        const solid = stiff * (depth - crush.capacity) + Math.sqrt(stiff * mass) * closing;
        force += Math.max(0, solid);
      }
      if (force <= 0) return;

      const slip = moving.addScaledVector(normal, closing); // along the faces
      const push = normal.clone().multiplyScalar(force);
      const speed = slip.length();
      // Coulomb friction, eased in below 1 m/s of slip so it does not jitter
      if (speed > 0) push.addScaledVector(slip, -(scrape * force) / Math.max(speed, METRE));
      b.body.addForceAtPoint(push, middle, true);
      a.body.addForceAtPoint(push.negate(), middle, true);
    },

    /**
     * Lets go of the ends caught long enough.
     *
     * @param {number} time game seconds
     */
    release(time) {
      for (const crush of snagged) {
        if (time < /** @type {number} */ (crush.free)) continue;
        world.removeImpulseJoint(/** @type {RAPIER.ImpulseJoint} */ (crush.snag), true);
        delete crush.snag;
        snagged.delete(crush);
      }
    },
  };
}
