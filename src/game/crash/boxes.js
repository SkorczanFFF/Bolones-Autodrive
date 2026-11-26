import * as THREE from "three";
import { ENDS } from "../../scene/crumple.js";
import { ACROSS, AHEAD, UP, rotation, vector } from "./physics.js";

/**
 * A box in the world: its centre, axes and half sizes along them.
 *
 * @typedef {{ centre: THREE.Vector3, axes: THREE.Vector3[], half: number[] }} Box
 * @typedef {import("@dimforge/rapier3d-compat").RigidBody} Body
 */

const AXES = [ACROSS, UP, AHEAD];

/** How upright (its up's height) a car goes over between: cos 60°, cos 20°. */
export const OVER = [0.5, 0.94];

/**
 * A body's box in the world, turned as the body is, or as `turn` says. A car's (the lower part of
 * it, MINIGAME.crash.car.box) goes up to its roof as it rolls over, from 20° over to 60°: on its
 * side it meets the others with its roof, not with the box inside it.
 *
 * @param {{ body: Body, half: number[], shift: THREE.Vector3, roof?: number }} solid
 * @param {THREE.Quaternion} [turn]
 * @param {boolean} [whole] up to its roof however it stands: all of the car
 * @returns {Box}
 */
export function boxOf({ body, half, shift, roof = 0 }, turn = rotation(body.rotation()), whole) {
  const axes = AXES.map((axis) => axis.clone().applyQuaternion(turn));
  const over = whole ? 1 : 1 - THREE.MathUtils.smoothstep(axes[1].y, OVER[0], OVER[1]);
  const grow = (roof * over) / 2; // its half
  return {
    centre: shift
      .clone()
      .addScaledVector(UP, grow)
      .applyQuaternion(turn)
      .add(vector(body.translation())),
    axes,
    half: grow ? [half[0], half[1] + grow, half[2]] : half,
  };
}

/**
 * Which way a body turned so heads on the road: its length seen from above, radians about the up.
 *
 * @param {THREE.Quaternion} turn
 */
export function headingOf(turn) {
  const { x, z } = AHEAD.clone().applyQuaternion(turn);
  return Math.atan2(x, z);
}

/**
 * A post's box as a car meets it: turned as the car is about the upright, as far as the post
 * reaches along each of the car's sides (a palm's trunk, round, as wide whichever way the car
 * meets it; a rock as its outline reaches).
 *
 * @param {{ body: Body, half: number[], outline?: THREE.Vector2[] }} post
 * @param {THREE.Quaternion} turn the car's
 * @returns {Box}
 */
export function postBox({ body, half, outline }, turn) {
  const yaw = new THREE.Quaternion().setFromAxisAngle(UP, headingOf(turn));
  const axes = AXES.map((axis) => axis.clone().applyQuaternion(yaw));
  const centre = vector(body.translation());
  if (!outline) return { centre, axes, half };
  const [across, ahead] = [axes[0], axes[2]].map((axis) => {
    const along = outline.map((p) => p.x * axis.x + p.y * axis.z);
    const [low, high] = [Math.min(...along), Math.max(...along)];
    centre.addScaledVector(axis, (low + high) / 2);
    return (high - low) / 2;
  });
  return { centre, axes, half: [across, half[1], ahead] };
}

/**
 * Half the extent of a box along a unit axis.
 *
 * @param {Box} box
 * @param {THREE.Vector3} n
 */
export const extent = (box, n) =>
  box.axes.reduce((sum, axis, k) => sum + box.half[k] * Math.abs(axis.dot(n)), 0);

/**
 * How deep two boxes overlap along a unit normal (from a to b); 0 or less: apart along it.
 *
 * @param {Box} a
 * @param {Box} b
 * @param {THREE.Vector3} n
 */
export const penetration = (a, b, n) =>
  extent(a, n) + extent(b, n) - Math.abs(new THREE.Vector3().subVectors(b.centre, a.centre).dot(n));

/**
 * Whether a car's body meets along its length (its front or its rear), not its side.
 *
 * @param {Body} body
 * @param {THREE.Vector3} normal
 */
export function endOn(body, normal) {
  return Math.abs(AHEAD.clone().applyQuaternion(rotation(body.rotation())).dot(normal)) > ENDS[1];
}

/**
 * A normal made level: cars meet on the road (tilted with a rolling car, it would take in a tall
 * palm's height and push harder the more it rolls).
 *
 * @param {THREE.Vector3} normal
 */
export function level(normal) {
  normal.y = 0;
  return normal.normalize();
}

/**
 * The middle of where two boxes overlap: along a unit normal, across it and up.
 *
 * @param {Box} a
 * @param {Box} b
 * @param {THREE.Vector3} normal
 */
export function middleOf(a, b, normal) {
  const side = new THREE.Vector3().crossVectors(normal, UP);
  if (side.lengthSq() < 1e-6) side.crossVectors(normal, AHEAD); // one on top of the other
  side.normalize();
  const third = new THREE.Vector3().crossVectors(side, normal);
  return [normal, side, third].reduce(
    (point, axis) => point.addScaledVector(axis, middle(a, b, axis)),
    new THREE.Vector3(),
  );
}

/**
 * The middle of where two boxes overlap along a unit axis, as a distance along it.
 *
 * @param {Box} a
 * @param {Box} b
 * @param {THREE.Vector3} n
 */
function middle(a, b, n) {
  const [ca, cb] = [a.centre.dot(n), b.centre.dot(n)];
  const [ea, eb] = [extent(a, n), extent(b, n)];
  return (Math.max(ca - ea, cb - eb) + Math.min(ca + ea, cb + eb)) / 2;
}

/**
 * Where two boxes' footprints (seen from above) overlap once a has come `further` on along a level
 * unit normal (from a to b): the middle and half the width of it across the normal (as a distance
 * along UP × normal's other side, -normal.z, normal.x). Their extents across overlap far wider
 * than they meet when a corner goes into a side at an angle: over most of a car's length.
 *
 * @param {Box} a
 * @param {Box} b
 * @param {THREE.Vector3} normal
 * @param {number} further
 * @returns {{ middle: number, half: number } | null} null: they would not overlap
 */
export function meeting(a, b, normal, further) {
  /**
   * A box seen from above, `shift` on along the normal: the outline round its corners, in turn.
   * Upright it is a rectangle; a car leaning or on its side shows its height too (its roof stands
   * out to the side), up to a hexagon.
   *
   * @param {Box} box
   * @param {number} shift
   */
  const footprint = (box, shift) =>
    convexOutline(
      corners(box).map(({ x, z }) => new THREE.Vector2(x + normal.x * shift, z + normal.z * shift)),
    );
  // a's footprint clipped by each side of b's (Sutherland-Hodgman)
  let region = footprint(a, further);
  const fence = footprint(b, 0);
  const inner = new THREE.Vector2(b.centre.x, b.centre.z);
  fence.forEach((p, k) => {
    const q = fence[(k + 1) % fence.length];
    const sideOf = (/** @type {THREE.Vector2} */ v) =>
      (q.x - p.x) * (v.y - p.y) - (q.y - p.y) * (v.x - p.x);
    const inward = Math.sign(sideOf(inner)) || 1;
    /** @type {THREE.Vector2[]} */
    const kept = [];
    region.forEach((v, i) => {
      const next = region[(i + 1) % region.length];
      const [sv, sn] = [sideOf(v) * inward, sideOf(next) * inward];
      if (sv >= 0) kept.push(v);
      if (sv * sn < 0) kept.push(v.clone().lerp(next, sv / (sv - sn)));
    });
    region = kept;
  });
  if (!region.length) return null;
  const across = region.map((v) => -normal.z * v.x + normal.x * v.y);
  const [low, high] = [Math.min(...across), Math.max(...across)];
  return { middle: (low + high) / 2, half: (high - low) / 2 };
}

/**
 * A box's eight corners.
 *
 * @param {Box} box
 */
const corners = (box) =>
  [-1, 1].flatMap((x) =>
    [-1, 1].flatMap((y) =>
      [-1, 1].map((z) =>
        box.centre
          .clone()
          .addScaledVector(box.axes[0], x * box.half[0])
          .addScaledVector(box.axes[1], y * box.half[1])
          .addScaledVector(box.axes[2], z * box.half[2]),
      ),
    ),
  );

/**
 * The convex outline round points in a plane, in turn (Andrew's monotone chain): the points on it
 * only, none twice.
 *
 * @param {THREE.Vector2[]} points
 */
export function convexOutline(points) {
  const sorted = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  /** > 0: o, p, q turn left. @param {THREE.Vector2} o @param {THREE.Vector2} p @param {THREE.Vector2} q */
  const turn = (o, p, q) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  /** One side of the outline, from the first point to the last. @param {THREE.Vector2[]} list */
  const chain = (list) => {
    /** @type {THREE.Vector2[]} */
    const kept = [];
    for (const p of list) {
      while (kept.length >= 2 && turn(kept[kept.length - 2], kept[kept.length - 1], p) <= 0) {
        kept.pop();
      }
      kept.push(p);
    }
    kept.pop(); // where the other side begins
    return kept;
  };
  return [...chain(sorted), ...chain(sorted.reverse())];
}

/**
 * Whether two boxes overlap (separating axis test) and if so, the depth along each face normal
 * (from a to b) and the point between them: the corners of each inside the other, or the middle
 * of their nearest points.
 *
 * @param {Box} a
 * @param {Box} b
 * @returns {{ faces: { normal: THREE.Vector3, depth: number }[], point: THREE.Vector3 } | null}
 */
export function overlap(a, b) {
  const apart = new THREE.Vector3().subVectors(b.centre, a.centre);
  const reach = a.half[0] + a.half[1] + a.half[2] + b.half[0] + b.half[1] + b.half[2];
  if (apart.length() > reach) return null;
  for (const p of a.axes) {
    for (const q of b.axes) {
      const axis = new THREE.Vector3().crossVectors(p, q);
      const length = axis.length();
      if (length > 1e-6 && penetration(a, b, axis.divideScalar(length)) < 0) return null;
    }
  }
  const faces = [...a.axes, ...b.axes].map((axis) => {
    const normal = apart.dot(axis) < 0 ? axis.clone().negate() : axis.clone();
    return { normal, depth: penetration(a, b, normal) };
  });
  if (faces.some(({ depth }) => depth < 0)) return null;
  const normal = faces.reduce((best, f) => (f.depth < best.depth ? f : best)).normal;

  const inside = (/** @type {Box} */ box, /** @type {THREE.Vector3} */ p) => {
    const d = new THREE.Vector3().subVectors(p, box.centre);
    return box.axes.every((axis, k) => Math.abs(d.dot(axis)) <= box.half[k] + 1e-6);
  };
  const touching = [
    ...corners(a).filter((p) => inside(b, p)),
    ...corners(b).filter((p) => inside(a, p)),
  ];
  const support = (/** @type {Box} */ box, /** @type {THREE.Vector3} */ n) =>
    box.axes.reduce(
      (p, axis, k) => p.addScaledVector(axis, Math.sign(axis.dot(n)) * box.half[k]),
      box.centre.clone(),
    );
  const point = touching.length
    ? touching.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(touching.length)
    : support(a, normal).add(support(b, normal.clone().negate())).multiplyScalar(0.5);
  return { faces, point };
}
