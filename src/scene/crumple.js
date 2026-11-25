import * as THREE from "three";
import { MINIGAME } from "../config.js";
import { valueNoise } from "../core/noise.js";
import { dent, dentable, moveNodes } from "./dents.js";
import { partOf } from "./rig.js";

/**
 * @typedef {object} Hit where a car was hit, in world space
 * @property {THREE.Vector3} point the middle of where the cars met
 * @property {THREE.Vector3} into unit, level: into the car (or up: a car coming down on its roof,
 *   crushed wherever the plane takes it, `reach` and `tall` Infinity)
 * @property {number} plane how far along `into` from the point the crushed face ends up: about
 *   as deep as the car is crushed
 * @property {number} reach half the width crushed, round the point
 * @property {number} tall half the height crushed, round the point (as high as the cars met)
 *
 * @typedef {import("./dents.js").Dent} Dent
 */

const { dents: sheet } = MINIGAME.crash;
/**
 * cos of the angles off the car's length: a side hit up to the first, a front's from the
 * second.
 */
export const ENDS = MINIGAME.crash.ends.map((angle) => Math.cos(THREE.MathUtils.degToRad(angle)));
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Crushes a car where it was hit (MINIGAME.crash.dents): whatever is in front of the crush plane,
 * within `reach` of the point across and `tall` of it up and down (as high as the cars met: a
 * small car dents the top of a tall one less), goes back onto the plane, running out beyond,
 * buckled a little deeper here and there, so two crushed fronts meet on one plane without
 * passing into each other. Behind it the sheet metal bends. The wheels (a node with
 * `userData.part` "wheel") are rigid, not crushed: pushed back as far as the crush reaches them,
 * they turn and lean (pushed up their springs, a car on its side hit underneath, they ride up
 * into their arches first, as far as their springs go). A wheel or a bumper (a node with
 * `userData.part`) crushed past by more than it takes (MINIGAME.crash.parts) is torn off, for
 * the crash to take away from where the crush pushes it (`by`, not into the other car): a wheel
 * as it is, a bumper bent as far as the crush had bent it when it went.
 *
 * The dents go on as the crash does (scene/dents.js); a car hit again (a pile-up) is crushed as
 * it will be after the earlier dents, and they keep going.
 *
 * The buckling is a function of the world position, so points that touch (a triangle's
 * corners, the seams between meshes) stay together.
 *
 * @param {THREE.Object3D} root
 * @param {Hit} hit
 * @returns {Dent & { torn: { node: THREE.Object3D, by: THREE.Vector3 }[], moved: import("./dents.js").Move[] }}
 *   starting at 0; the parts torn off (how far the crush pushes them, world), the wheels moved
 *   whole (where they end up)
 */
export function crumple(root, hit) {
  const { point, into, plane, reach } = hit;
  const depth = Math.max(0, plane);
  root.updateWorldMatrix(true, true);
  const measure = measurer(hit);
  const reachedAt = reachOf(hit);
  const side = new THREE.Vector3().crossVectors(UP, into); // level, across the car
  const p = new THREE.Vector3();
  const lateralOf = (/** @type {THREE.Vector3} */ q) => p.subVectors(q, point).dot(side);

  // every mesh's points in the world, crushed as they will be after the earlier dents
  const entries = dentable(root).map((entry) => ({
    ...entry,
    node: partOf(entry.mesh, root),
  }));

  // the car: how high, how wide round its middle line, how long behind the plane
  let [low, high, left, right] = [Infinity, -Infinity, Infinity, -Infinity];
  let [near, far] = [Infinity, -Infinity];
  const q = new THREE.Vector3();
  for (const { world } of entries) {
    for (let i = 0; i < world.length; i += 3) {
      q.set(world[i], world[i + 1], world[i + 2]); // not fromArray(): scene/dents.js
      low = Math.min(low, q.y);
      high = Math.max(high, q.y);
      const lateral = lateralOf(q);
      left = Math.min(left, lateral);
      right = Math.max(right, lateral);
      const { depth: at } = measure(q);
      near = Math.min(near, at);
      far = Math.max(far, at);
    }
  }
  const middle = (left + right) / 2;
  const halfWidth = (right - left) / 2 || 1;
  // how much of a front's or a rear's hit it is (1), not a side's (0): the car's length is its z
  const along = new THREE.Vector3(0, 0, 1).transformDirection(root.matrixWorld).setY(0).normalize();
  const end = THREE.MathUtils.smoothstep(Math.abs(along.dot(into)), ENDS[0], ENDS[1]);
  const offset = end * THREE.MathUtils.clamp(-middle / halfWidth, -1, 1); // where, across
  const band = Math.min(sheet.bend * depth, sheet.fold[0] * (far - near));
  const widthwise = new THREE.Vector3().crossVectors(UP, along); // the car's own, level
  const origin = root.getWorldPosition(new THREE.Vector3());
  const ridge = Math.min(depth, sheet.fold[1] * (high - low));
  const coverage = THREE.MathUtils.clamp((2 * reach) / (right - left || 1), 0, 1); // hit across
  const length = Math.max((far - plane) / 2, 1e-6);

  /** The fold at a depth (after the crush) and distance across. */
  const fold = (/** @type {number} */ at, /** @type {number} */ across) => {
    const u = (at - plane) / band;
    if (!(u > 0 && u < 1)) return 0;
    const spread =
      across <= reach ? 1 : Math.max(0, 1 - (across - reach) / Math.max(sheet.fade, reach));
    return ridge * (1 - Math.abs(2 * u - 1)) * spread;
  };
  /** How far the kink moves a point at a depth (after the crush) towards the side hit. */
  const kink = (/** @type {number} */ at) =>
    sheet.kink * depth * offset * (1 - THREE.MathUtils.clamp((at - plane) / length, 0, 1)) ** 2;

  // past the fold and the kink, behind the crush, the car stays as it is
  const untouched = plane + Math.max(band, length);
  /**
   * Moves a point of the body (world) where the crash takes it.
   *
   * @param {THREE.Vector3} v
   * @param {number} [limit] crushed no further than this (a part torn off, as it was when it went)
   */
  const bend = (v, limit = plane) => {
    const measured = measure(v);
    const { depth: at, across } = measured;
    if (at >= untouched) return;
    const lateral = lateralOf(v) - middle;
    const height = (v.y - low) / (high - low || 1);
    let crushed = at;
    const reached = reachedAt(measured);
    if (at < limit && reached) {
      const back = (limit - at) * reached;
      const buckle = noise(v, 1);
      const lift = noise(v, 2);
      v.addScaledVector(into, back * (1 + 0.2 * buckle));
      const wave = back * 0.3 * (lift - 0.5); // buckling up and down on a front, along a side
      v.addScaledVector(UP, wave * end).addScaledVector(side, wave * (1 - end));
      v.y = Math.max(v.y, low); // not into the road
      crushed += back * (1 + 0.2 * buckle);
    }
    const folded = end * fold(crushed, across);
    const deck =
      THREE.MathUtils.smoothstep(height, 0.3, 0.5) *
      (1 - THREE.MathUtils.smoothstep(height, 0.7, 0.85));
    const below = 1 - THREE.MathUtils.smoothstep(height, 0.6, 0.8);
    // the bonnet tents up in its middle; the wings at its sides stay down and splay out
    const middling = 1 - Math.min(1, Math.abs(lateral) / halfWidth) ** 2;
    v.y += sheet.tent * coverage * folded * deck * middling;
    v.addScaledVector(side, sheet.bulge * folded * below * (lateral / halfWidth) + kink(crushed));
  };

  // the wheels and the bumpers: torn off, or a wheel moved whole
  /** @type {Map<THREE.Object3D, { centre: THREE.Vector3, size: number, front: number, count: number, turn?: THREE.Quaternion, shift?: THREE.Vector3 }>} */
  const pieces = new Map();
  for (const { world, node } of entries) {
    if (!node) continue;
    const piece = pieces.get(node) ?? {
      centre: new THREE.Vector3(),
      size: 0,
      front: Infinity,
      count: 0,
    };
    for (let i = 0; i < world.length; i += 3) {
      piece.centre.add(q.set(world[i], world[i + 1], world[i + 2]));
      piece.front = Math.min(piece.front, measure(q).depth);
      piece.count++;
    }
    pieces.set(node, piece);
  }
  for (const piece of pieces.values()) piece.centre.divideScalar(piece.count);
  for (const { world, node } of entries) {
    const piece = node && pieces.get(node);
    if (!piece) continue;
    for (let i = 0; i < world.length; i += 3) {
      q.set(world[i], world[i + 1], world[i + 2]);
      piece.size = Math.max(piece.size, q.distanceTo(piece.centre));
    }
  }
  /** @type {{ node: THREE.Object3D, by: THREE.Vector3 }[]} */
  const torn = [];
  /** How far the crush had come when a part tore off (it bends that far, no further). */
  const tore = new Map();
  // how much of a push is up the car's springs (its up), which a wheel rides up as far as its
  // radius goes (game/crash/vehicle.js), only the rest bending it or tearing it off
  const sprung = Math.abs(into.dot(UP.clone().transformDirection(root.matrixWorld)));
  for (const [node, piece] of pieces) {
    const { centre } = piece;
    const push = Math.max(0, plane - piece.front) * reachedAt(measure(centre));
    /** @type {"wheel" | "bumper" | undefined} */
    const part = node.userData.part;
    const bent = part === "wheel" ? push - Math.min(push * sprung, node.userData.radius) : push;
    if (part && bent > MINIGAME.crash.parts[part].tear * piece.size) {
      const tear = MINIGAME.crash.parts[part].tear * piece.size;
      // a bumper bent as far as the crush had come when it went (`tore`), the rest of the way
      // pushed whole: not into the car behind the crush plane
      const by = part === "wheel" ? push : Math.max(0, push - tear);
      torn.push({ node, by: into.clone().multiplyScalar(by) });
      tore.set(node, piece.front + tear);
      continue;
    }
    if (part !== "wheel") continue;
    const turn = Math.min(1, bent / (piece.size || 1));
    // out of the car, across it (whichever way it was hit): the wheel leans about its length
    const out = widthwise
      .clone()
      .multiplyScalar(Math.sign(p.subVectors(centre, origin).dot(widthwise)) || 1);
    const toe = new THREE.Quaternion().setFromUnitVectors(
      out,
      out
        .clone()
        .multiplyScalar(Math.cos(sheet.toe * turn))
        .addScaledVector(into, Math.sin(sheet.toe * turn)),
    );
    const lean = sheet.camber * turn * (noise(centre, 3) < 0.5 ? -1 : 1);
    piece.turn = new THREE.Quaternion()
      .setFromUnitVectors(
        UP,
        UP.clone().multiplyScalar(Math.cos(lean)).addScaledVector(out, Math.sin(lean)),
      )
      .multiply(toe);
    const at = measure(centre).depth + push;
    piece.shift = into.clone().multiplyScalar(push).addScaledVector(side, kink(at));
  }

  // the wheels move whole, as nodes (they spin and steer in them); the rest bends, but what is torn
  /** @type {import("./dents.js").Move[]} */
  const moved = [];
  const world = new THREE.Matrix4();
  for (const [node, { turn, shift, centre }] of pieces) {
    if (!turn || !shift || !node.parent) continue;
    world
      .makeTranslation(centre.clone().add(shift))
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(turn))
      .multiply(new THREE.Matrix4().makeTranslation(centre.clone().negate()))
      .multiply(node.matrixWorld)
      .premultiply(node.parent.matrixWorld.clone().invert());
    const [position, quaternion] = [new THREE.Vector3(), new THREE.Quaternion()];
    world.decompose(position, quaternion, new THREE.Vector3());
    moved.push({ node, position, quaternion });
  }
  const nodeOf = new Map(entries.map(({ mesh, node }) => [mesh, node]));
  const meshes = dent(entries, ({ mesh }, v) => {
    const node = nodeOf.get(mesh);
    if (node?.userData.part === "wheel") return; // rigid: moved whole, or torn off as it is
    bend(v, tore.get(node)); // a bumper bends along
  });
  const nodes = moveNodes(moved);
  return {
    set(progress) {
      meshes.set(progress);
      nodes.set(progress);
    },
    undo() {
      nodes.undo();
      meshes.undo();
    },
    torn,
    moved,
  };
}

/**
 * Whether a hit crushes a world point (one not yet moved by it): a quarter as deep or more.
 *
 * @param {Hit} hit
 * @returns {(point: THREE.Vector3) => boolean}
 */
export function reaches(hit) {
  const measure = measurer(hit);
  const reachedAt = reachOf(hit);
  return (point) => {
    const measured = measure(point);
    return measured.depth < hit.plane && reachedAt(measured) > 0.25;
  };
}

/**
 * How much of a hit's crush there is across from its point and up or down: all of it within its
 * reach and its height, running out beyond, the deeper the wider (MINIGAME.crash.dents: fade,
 * taper).
 *
 * @param {Hit} hit
 */
function reachOf({ plane, reach, tall }) {
  const fade = Math.max(sheet.fade, sheet.taper * Math.max(0, plane));
  const share = (/** @type {number} */ off, /** @type {number} */ within) =>
    off <= within ? 1 : Math.max(0, 1 - (off - within) / fade) ** 2;
  return (/** @type {{ across: number, up: number }} */ { across, up }) =>
    share(across, reach) * share(up, tall);
}

/**
 * How far a world point is in from where a car was hit, how far across and how far up or down.
 *
 * @param {Hit} hit
 */
function measurer({ point, into }) {
  const offset = new THREE.Vector3();
  return (/** @type {THREE.Vector3} */ p) => {
    offset.subVectors(p, point);
    const depth = offset.dot(into);
    const up = Math.abs(offset.y);
    offset.addScaledVector(into, -depth).y = 0;
    return { depth, across: offset.length(), up };
  };
}

/**
 * The crush's buckles: folds rather than point by point, and points that touch (or lie on each
 * other's edges) move together.
 *
 * @param {THREE.Vector3} p
 * @param {number} seed
 */
const noise = (p, seed) => valueNoise(p, seed, sheet.buckle);
