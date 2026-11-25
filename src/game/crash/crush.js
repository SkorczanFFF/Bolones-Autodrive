import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { MINIGAME } from "../../config.js";
import {
  boxOf,
  endOn,
  extent,
  level,
  meeting,
  middleOf,
  OVER,
  overlap,
  penetration,
} from "./boxes.js";
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
 * @property {number} [roof] how much higher its box goes rolled over: up to its roof (boxes.js)
 * @property {Faces} [faces] how high its ends stand (a car's, game/crash.js facesOf)
 * @property {number} stiffness its crumple zone's spring rate, force per unit of crush; Infinity:
 *   a post, it does not give
 *
 * @typedef {object} Faces how high a car's ends stand, from the road: at depths `step` apart in
 *   from its -z end and its +z end, the highest it comes that far in
 * @property {[Float32Array, Float32Array]} ends
 * @property {number} step
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
 * @property {number} deepest the most they have overlapped, units (past `capacity`: solid)
 * @property {number} back what the crumple zones may still give back as they part: e² of what
 *   they took crushing, and what pressing them back along the line they spring back on put in
 * @property {number} meetings how many times the pair has met (MEETINGS at most)
 * @property {(deepest: number) => void} dent shows how far the dents have gone in
 * @property {boolean} [nudge] they only touched (MINIGAME.crash.nudge): no crumple zones, no dents
 * @property {number} [share] how wide they met, of the narrower one's width
 * @property {[THREE.Vector3, THREE.Vector3]} [dented] where the dents are, in each one's frame:
 *   `reach` either way, `covered` deep
 * @property {number} [reach] half the width dented
 * @property {number} [covered] how deep they overlap where the dents meet
 * @property {number} [follows] how many times the dents followed where they overlap (FOLLOWS)
 * @property {RAPIER.ImpulseJoint} [snag] holds the crushed fronts together, until `free`
 * @property {number} [free] game time the snag lets go
 */

const PARTING = 1.5 * METRE; // units/s two solids overlapping past their crumple zones part at most
const SETTLE = 0.2; // seconds they take to part, as deep as they overlap (no faster than PARTING)
const FOLLOWS = 3; // the dents follow where two overlap this often at most (a crumple each)
const DEEPER = 0.1 * METRE; // how much deeper than their dents they may overlap
const MEETINGS = 4; // a pair meets again through other faces at most this often (they slid past)
const SLACK = 0.1; // units: how much deeper the old faces must overlap than the new ones

/** Whether a solid is a post (a palm's trunk, a rock): it does not give. @param {Solid} solid */
const isPost = ({ stiffness }) => stiffness === Infinity;

/**
 * How high a solid meets another, in the world: on its wheels, an end with its face as far in as
 * the crush goes (a car's bonnet, a van's flat front: crash.js facesOf); else all of it, up to its
 * roof (a side, a car rolled over, a post).
 *
 * @param {Solid} solid
 * @param {THREE.Vector3} towards level, unit: where the other one is
 * @param {number} deep how far the crush goes in
 */
function meetsWith(solid, towards, deep) {
  const whole = boxOf(solid, undefined, true);
  const low = whole.centre.y - extent(whole, UP);
  const high = whole.centre.y + extent(whole, UP);
  const turn = rotation(solid.body.rotation());
  const { faces } = solid;
  if (!faces || UP.clone().applyQuaternion(turn).y < OVER[1] || !endOn(solid.body, towards)) {
    return { low, high };
  }
  const end = faces.ends[AHEAD.clone().applyQuaternion(turn).dot(towards) > 0 ? 1 : 0];
  const face = end[Math.min(end.length - 1, Math.floor(deep / faces.step))];
  // as much of its height as it stands now (leaning a little, its box stands taller)
  const height = 2 * solid.half[1] + (solid.roof ?? 0);
  return { low, high: low + (high - low) * Math.min(1, face / height) };
}

/**
 * Where a crush dents each of two solids (scene/crumple.js Hit): from the middle of where they
 * meet, each its share of the crush (the stiffer gives less), from its face, half the overlap away
 * from the middle; as wide as `reach`, as high as the other one meets it (as far in as the whole
 * crush goes, that far its own uncrushed parts may reach): no part of either left standing where
 * the other comes.
 *
 * @param {Solid} a
 * @param {Solid} b
 * @param {THREE.Vector3} at the middle of where they meet
 * @param {THREE.Vector3} ahead level, unit: from a to b
 * @param {number} deep how deep the crush goes, all told
 * @param {number} depth how deep they overlap now
 * @param {number} k their crumple zones' stiffness together
 * @param {number} reach half the width crushed
 * @returns {import("../../scene/crumple.js").Hit[]}
 */
function hitsOf(a, b, at, ahead, deep, depth, k, reach) {
  const meets = [meetsWith(b, ahead.clone().negate(), deep), meetsWith(a, ahead, deep)];
  return [a, b].map((solid, i) => {
    const { low, high } = meets[i];
    return {
      point: at.clone().setY((low + high) / 2),
      into: ahead.clone().multiplyScalar(i ? 1 : -1),
      plane: (deep * k) / solid.stiffness - depth / 2,
      reach,
      tall: Math.max(0, high - low) / 2,
    };
  });
}

/**
 * A world point in a solid's frame.
 *
 * @param {Solid} solid
 * @param {THREE.Vector3} point
 */
const frameOf = ({ body }, point) =>
  point.clone().sub(vector(body.translation())).applyQuaternion(rotation(body.rotation()).invert());

/**
 * Whether where two solids overlap now has gone on past their dents across the way they met, in
 * either one's frame (a corner sliding along the other one; not a crush going deeper): beyond
 * `reach` and the dents' run-out.
 *
 * @param {Crush} crush they crashed, dented
 * @param {THREE.Vector3} middle of where they overlap now
 * @param {THREE.Vector3} normal they met along, level
 * @param {Solid} a
 * @param {Solid} b
 */
function slid({ dented, reach = 0 }, middle, normal, a, b) {
  const past = reach + MINIGAME.crash.dents.fade;
  return [a, b].some((solid, i) => {
    const back = rotation(solid.body.rotation()).invert();
    const along = normal.clone().applyQuaternion(back);
    const off = frameOf(solid, middle).sub(/** @type {THREE.Vector3[]} */ (dented)[i]);
    const { x, z } = off.addScaledVector(along, -off.dot(along));
    return Math.hypot(x, z) > past;
  });
}

/** @type {WeakMap<Solid, number>} a solid's box does not change: its reach, measured once */
const reaches = new WeakMap();
/** How far from its body's middle a solid's box reaches at most. @param {Solid} solid */
export const reachOf = (solid) => {
  let reach = reaches.get(solid);
  if (reach === undefined) {
    const { half, shift, roof = 0 } = solid; // rolled over, its box up to the roof at most
    const up = half[1] + roof / 2;
    reaches.set(solid, (reach = Math.hypot(half[0], up, half[2]) + shift.length() + roof / 2));
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
   * @param {boolean} again they crashed before: a crash however slowly they close, not a nudge
   * @returns {Crush}
   */
  function meet(a, b, [boxA, boxB], { depth, normal }, closing, k, meetings, again) {
    const speed = Math.max(0, closing);
    const e = restitution.atRest * Math.exp(-speed / METRE / restitution.falloff);
    const facing = normal.clone().applyQuaternion(rotation(a.body.rotation()).invert());
    const crush = {
      facing,
      e,
      capacity: depth,
      deepest: depth,
      back: 0,
      meetings: meetings + 1,
    };
    if (speed / METRE < nudge && !again) {
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
    const hits = hitsOf(a, b, at, ahead, expected, depth, k, reach);
    const energy = (0.5 * taken * mass * speed ** 2 * (1 - e ** 2)) / METRE ** 2;
    const show = met(a, b, { normal, hits, at, speed, energy });
    return {
      ...crush,
      share,
      reach,
      dented: /** @type {[THREE.Vector3, THREE.Vector3]} */ (
        [a, b].map((solid) => frameOf(solid, at))
      ),
      covered: expected,
      follows: 0,
      capacity: expected,
      dent: (deepest) => show?.(Math.min(1, deepest / expected)),
    };
  }

  /**
   * The dents of a crush follow where two solids overlap now: dented there too, as deep as they
   * overlap (each its share, their faces meeting in the middle), at once. The crash goes on as it
   * was: only the dents follow.
   *
   * @param {T} a
   * @param {T} b
   * @param {Crush} crush theirs
   * @param {import("./boxes.js").Box[]} boxes theirs, now
   * @param {THREE.Vector3} normal they met along, level, from a to b
   * @param {THREE.Vector3} middle of where they overlap
   * @param {number} depth how deep they overlap along `normal`
   * @param {number} k the fronts' stiffness together
   */
  function follow(a, b, crush, [boxA, boxB], normal, middle, depth, k) {
    const across = new THREE.Vector3(-normal.z, 0, normal.x);
    const stretch = meeting(boxA, boxB, normal, 0);
    const reach = stretch?.half ?? penetration(boxA, boxB, across) / 2;
    const at = middle.clone();
    if (stretch) at.addScaledVector(across, stretch.middle - at.dot(across));
    const hits = hitsOf(a, b, at, normal, depth, depth, k, reach);
    met(a, b, { normal, hits, at, speed: 0, energy: 0 })?.(1);
    crush.dented = [frameOf(a, at), frameOf(b, at)];
    crush.reach = reach;
    crush.covered = depth;
    crush.follows = (crush.follows ?? 0) + 1;
  }

  return {
    /**
     * Two solids (a car, then a car or a post) that overlap: an elastic-plastic spring between
     * their crumple zones, pushing along the overlap's normal at its middle, with `scrape`
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
        // met again after a crash, what they overlap is crushed however slowly they close
        const again = Boolean(last && !last.nudge);
        const closing = -relative.dot(face.normal);
        crush = meet(a, b, boxes, face, closing, k, last?.meetings ?? 0, again);
        pairs.set(b, crush);
      }
      const normal = level(crush.facing.clone().applyQuaternion(turn));
      const depth = penetration(boxA, boxB, normal);
      if (depth <= 0) return;
      // they push in the middle of where they overlap (not low on a tall palm: it would trip the
      // car)
      const middle = middleOf(boxA, boxB, normal);
      const moving = velocityAt(b.body, middle).sub(velocityAt(a.body, middle));
      const closing = -moving.dot(normal);
      // the dents go where they overlap: a corner sliding on along the other one, or a crush going
      // deeper than they do (a car behind pushing, fronts caught in each other) the way they met
      // (not one turning about the hit, its box swinging on into the other's through another face):
      // dented there too, as deep as they overlap now
      const { dented, covered = 0, follows = 0 } = crush;
      const fresh = least.normal.dot(normal) >= Math.SQRT1_2;
      const deeper = fresh && depth > covered + DEEPER;
      if (dented && follows < FOLLOWS && (deeper || slid(crush, middle, normal, a, b))) {
        follow(a, b, crush, boxes, normal, middle, depth, k);
      }
      if (crush.snag) {
        // caught: no spring, nothing to kick back; what goes deeper meanwhile stays crushed (not
        // squeezed into the solid, to fly apart when they let go)
        crush.capacity = Math.max(crush.capacity, depth);
        crush.deepest = Math.max(crush.deepest, depth);
        crush.back = 0;
        return;
      }

      // the crumple zones, as deep as the crash goes; past them the cars are solid
      let force = 0;
      if (depth >= crush.deepest && closing > 0) {
        // crushing on: e² of it can come back (none of what goes past them)
        const [was, now] = [crush.deepest, depth].map((d) => Math.min(d, crush.capacity));
        crush.back += 0.5 * k * (now ** 2 - was ** 2) * crush.e ** 2;
        crush.deepest = depth;
        force = k * now;
      } else {
        // springs back from as deep as it went along a steeper line: parting, it gives back what
        // it may, no more (the boxes of a car turning about the hit swing on into each other while
        // they part: no pushing on for it); pressed back along it, it may give that back too
        const peak = Math.min(crush.deepest, crush.capacity);
        const kept = crush.deepest - peak * crush.e ** 2;
        const crushed = Math.min(depth, crush.deepest);
        force = crushed > kept ? (k * peak * (crushed - kept)) / (crush.deepest - kept) : 0;
        const { back } = crush;
        if (closing < 0 && force * -closing * STEP > back) force = back / (-closing * STEP);
        crush.back = Math.max(0, back + force * closing * STEP);
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
      // beyond them (or a nudge): solid, so the cars do not pass into each other (not even swung
      // into each other by a turn): a step stops them and parts them, as fast as their overlap
      // goes in SETTLE (a touch hardly at all), not throwing them apart (PARTING)
      if (depth > crush.capacity) {
        // as heavy as they are where they touch (a corner turns away easily)
        const mass = 1 / (giving(a.body, middle, normal) + giving(b.body, middle, normal));
        const parting = Math.min(PARTING, (depth - crush.capacity) / SETTLE);
        force += Math.max(0, (mass * (parting + closing)) / STEP - force);
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
