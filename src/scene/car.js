import * as THREE from "three";
import { CAR, WORLD } from "../config.js";
import { unionFind } from "../core/fbx.js";
import { easeInOutCubic, settle } from "../core/tween.js";
import { pruneEmpty, wheelCenter } from "./model.js";
import { mountWheel, partOf, wheelsOf } from "./rig.js";
import { HOLE_SEGMENTS, withPolygons } from "./polygons.js";
import { dress, solidMeshes } from "./wire.js";

/** @typedef {-1 | 0 | 1} SteerInput left, none, right */

const UP = new THREE.Vector3(0, 1, 0);
const ORIGIN = new THREE.Vector3();
const UPRIGHT = new THREE.Quaternion();
const PROUD = 0.01; // units the fuel cap stands off the wing

/**
 * The fuel cap (CAR.fuelCap): a round lid (an octagon) where a ray from the right meets the body,
 * a little proud of it, outlined. A part of the body's mesh, so it dents with it.
 *
 * @param {THREE.Object3D} car its world matrices up to date
 * @param {THREE.Object3D} body
 * @param {THREE.Material} solid
 * @param {THREE.Material} wire
 */
function addFuelCap(car, body, solid, wire) {
  const { at, radius } = CAR.fuelCap;
  const meshes = solidMeshes(body);
  const from = car.localToWorld(new THREE.Vector3(10, at[1], at[0]));
  const left = new THREE.Vector3(-1, 0, 0).transformDirection(car.matrixWorld);
  const [hit] = new THREE.Raycaster(from, left).intersectObjects(meshes, false);
  if (!hit?.face) {
    console.warn("CAR.fuelCap is off the body: no fuel cap");
    return;
  }
  const mesh = hit.object;
  const normal = hit.face.normal.clone();
  if (normal.clone().transformDirection(mesh.matrixWorld).dot(left) > 0) normal.negate();
  const scale = mesh.getWorldScale(new THREE.Vector3()).x;
  const segments = HOLE_SEGMENTS; // low poly, as the traffic's round holes
  // turned half a segment: a flat side up (the turn onto the normal keeps the disc's y up)
  const disc = new THREE.CircleGeometry(radius / scale, segments, Math.PI / segments);
  const polygon = Array(segments).fill(0);
  const cap = new THREE.Mesh(withPolygons([{ geometry: disc.toNonIndexed(), polygon }]));
  cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  cap.position.copy(mesh.worldToLocal(hit.point.clone())).addScaledVector(normal, PROUD / scale);
  mesh.add(dress(cap, solid, wire));
  cap.castShadow = false; // only the body casts a shadow (see the wheels)
}

/**
 * Takes a body modelled as one mesh apart into it and its outside mirrors, a node each
 * (`userData.part` "mirror", scene/rig.js) that a crash tears off: the islands of its triangles
 * (joined at their corners) that stand out of the rest of it across the car.
 *
 * @param {THREE.Object3D} model the body, x across
 */
function mirrorsApart(model) {
  model.updateWorldMatrix(true, true);
  const toModel = model.matrixWorld.clone().invert();
  for (const mesh of solidMeshes(model)) {
    const { geometry, parent } = mesh;
    if (geometry.index) continue; // a model's are FBXLoader's: not indexed
    const position = geometry.getAttribute("position");
    const count = position.count / 3; // triangles
    const islands = unionFind(count);
    /** @type {Map<string, number>} a triangle at each corner */
    const at = new Map();
    for (let i = 0; i < position.count; i++) {
      const key = `${position.getX(i)},${position.getY(i)},${position.getZ(i)}`;
      const other = at.get(key);
      if (other === undefined) at.set(key, Math.floor(i / 3));
      else islands.union(Math.floor(i / 3), other);
    }
    // each island's triangles, and how far across it reaches
    const matrix = toModel.clone().multiply(mesh.matrixWorld);
    const p = new THREE.Vector3();
    /** @type {Map<number, { triangles: number[], low: number, high: number }>} */
    const of = new Map();
    for (let t = 0; t < count; t++) {
      const root = islands.find(t);
      let island = of.get(root);
      if (!island) of.set(root, (island = { triangles: [], low: Infinity, high: -Infinity }));
      island.triangles.push(t);
      for (let k = 0; k < 3; k++) {
        const { x } = p.fromBufferAttribute(position, 3 * t + k).applyMatrix4(matrix);
        island.low = Math.min(island.low, x);
        island.high = Math.max(island.high, x);
      }
    }
    const [body, ...rest] = [...of.values()].sort(
      (a, b) => b.triangles.length - a.triangles.length,
    );
    const mirrors = rest.filter(({ low, high }) => low < body.low || high > body.high);
    if (!parent || !mirrors.length) continue;
    for (const side of [-1, 1]) {
      const triangles = mirrors
        .filter(({ low, high }) => (low + high) * side > 0)
        .flatMap((mirror) => mirror.triangles);
      if (!triangles.length) continue; // a mirror on one side only
      const mirror = new THREE.Mesh(trianglesOf(geometry, triangles), mesh.material);
      mirror.position.copy(mesh.position);
      mirror.quaternion.copy(mesh.quaternion);
      mirror.scale.copy(mesh.scale);
      const node = new THREE.Group().add(mirror);
      node.userData.part = "mirror";
      parent.add(node);
    }
    const off = new Set(mirrors.flatMap((mirror) => mirror.triangles));
    mesh.geometry = trianglesOf(
      geometry,
      Array.from({ length: count }, (_, t) => t).filter((t) => !off.has(t)),
    );
  }
  return model;
}

/**
 * Some of the triangles of a geometry not indexed (FBXLoader's), its polygons with them.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {number[]} triangles
 */
function trianglesOf(geometry, triangles) {
  const part = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const { array, itemSize } = /** @type {THREE.BufferAttribute} */ (attribute);
    const size = 3 * itemSize; // a triangle's
    const values = new Float32Array(triangles.length * size);
    triangles.forEach((t, i) => values.set(array.subarray(t * size, (t + 1) * size), i * size));
    part.setAttribute(name, new THREE.BufferAttribute(values, itemSize));
  }
  /** @type {import("../core/fbx.js").Polygons | undefined} */
  const polygons = geometry.userData.polygons;
  if (polygons) {
    part.userData.polygons = {
      inner: Uint8Array.from(triangles, (t) => polygons.inner[t]),
      polygon: Uint32Array.from(triangles, (t) => polygons.polygon[t]),
    };
  }
  return part;
}

/**
 * The Bolones. Each part of the motion lives on its own node, so nothing has to be synced:
 *
 *   group          lateral position (x) + yaw: the nose turns towards the lane change; CAR.lift (y)
 *   └ wreck        where a crash threw the car (game/crash.js), at rest otherwise
 *     ├ chassis    body roll around the axle line (CAR.rollCenterY)
 *     │ └ body     with the fuel cap on its mesh, its mirrors nodes of their own (they come off)
 *     └ 4× wheel   on its rig (scene/rig.js): the mount on the axle, mid-width; front ones steer
 *       └ … spin → mirror → wheel model, offset so its axle and mid-width sit on the mount
 *
 * The wheels never roll with the body: a feel of suspension. Speeds are per
 * second and easings time constants (settle), so 60 Hz and 144 Hz feel the same.
 *
 * @param {{ scene: THREE.Scene, models: Record<string, THREE.Group>, materials: import("./materials.js").Materials }} deps
 */
export function createCar({ scene, models, materials }) {
  const solid = materials.solid.bolones;
  const wire = materials.wire.bolones;

  const body = dress(mirrorsApart(models.bolones), solid, wire);
  // only the body casts a shadow (see the wheels): its mirrors' fall in it
  for (const mesh of solidMeshes(body)) if (partOf(mesh, body)) mesh.castShadow = false;
  body.position.set(CAR.bodyX, -CAR.rollCenterY, 0);

  const chassis = new THREE.Group();
  chassis.position.y = CAR.rollCenterY;
  chassis.add(body);

  // Spin around the modelled axle (through the model origin) and steer around the middle of
  // the wheel's width, which is off the origin in wheel.fbx.
  const wheelModel = dress(pruneEmpty(models.wheel), solid, wire);
  // only the body casts a shadow: the wheels' fall in its (five sun shadow passes each saved)
  for (const mesh of solidMeshes(wheelModel)) mesh.castShadow = false;
  const center = wheelCenter(wheelModel);
  const radius = new THREE.Box3().setFromObject(wheelModel).getSize(new THREE.Vector3()).y / 2;

  /** @type {THREE.Object3D[]} */
  const spins = [];
  /** @type {THREE.Object3D[]} the front wheels' steer nodes */
  const frontWheels = [];

  const wheels = CAR.wheels.map(([x, y, z]) => {
    const mirrored = x > 0;
    const wheel = wheelModel.clone();
    wheel.position.copy(center).negate();

    const mirror = new THREE.Group();
    if (mirrored) mirror.rotation.y = Math.PI;
    mirror.add(wheel);

    // (x, y, z) is the model origin; the mount sits in the middle of the width
    const centerOffset = center.clone().applyAxisAngle(UP, mirrored ? Math.PI : 0);
    const at = new THREE.Vector3(x, y, z).add(centerOffset);
    const mount = mountWheel(mirror, at, radius, z < 0); // the nose is towards -z
    const [{ steer, spin }] = wheelsOf(mount);
    spins.push(spin);
    if (z < 0) frontWheels.push(steer);
    return mount;
  });

  const wreck = new THREE.Group().add(chassis, ...wheels);
  const group = new THREE.Group().add(wreck);
  group.position.y = CAR.lift;
  scene.add(group);
  group.updateMatrixWorld(true);
  addFuelCap(group, body, solid, wire);
  // the crash's box: the body's, not its mirrors' (they come off)
  const box = new THREE.Box3();
  for (const mesh of solidMeshes(body)) if (!partOf(mesh, body)) box.expandByObject(mesh);
  box.translate(group.position.clone().negate());

  const s = CAR.steer;
  const { roll, yaw, wheelSteer } = CAR.handling;
  const rollSign = roll.outward ? 1 : -1;

  let speed = 0; // lateral speed, units/s
  let sideways = 0; // how fast the car went across the road last frame, units/s (+x)
  let direction = 0; // last steering direction, used for momentum
  let holdTime = 0; // seconds the current direction has been held
  /** @type {SteerInput} */
  let lastInput = 0;
  let steerAngle = 0;
  /** @type {import("../core/tween.js").TweenHandle | null} */
  let resetTween = null;

  /** @param {number} dx */
  function moveBy(dx) {
    group.position.x = THREE.MathUtils.clamp(group.position.x + dx, -s.maxOffset, s.maxOffset);
  }

  /**
   * Lateral motion: hold to speed up, momentum after release.
   *
   * Soft edges (free ride, where the camera rides along and every jolt shakes the whole view): the
   * car brakes into the road edge instead of stopping dead there, comes to a standstill before it
   * turns back, and pushing against the edge builds up no speed.
   *
   * @param {number} dt
   * @param {SteerInput} input
   * @param {boolean} soft
   * @returns {boolean} the input pushes the car against the edge (soft edges only)
   */
  function steer(dt, input, soft) {
    if (input !== 0) {
      if (input !== lastInput) holdTime = 0;
      if (soft && input !== direction && speed > 0) {
        speed = Math.max(0, speed - s.decel * dt); // still sliding the other way
      } else {
        holdTime += dt;
        direction = input;
        const target = Math.min(s.baseSpeed + s.holdAccel * holdTime, s.maxSpeed);
        speed += (target - speed) * settle(s.speedEasing, dt);
      }
    } else {
      speed = Math.max(0, speed - s.decel * dt);
    }
    if (soft) {
      const room = s.maxOffset - direction * group.position.x;
      speed = Math.min(speed, Math.sqrt(2 * s.edgeBrake * room)); // stops right at the edge
    }
    if (speed > 0) moveBy(direction * speed * dt);

    lastInput = input;
    const blocked = soft && input * group.position.x >= s.maxOffset;
    if (blocked) stop();
    return blocked;
  }

  /**
   * Body roll, yaw and front wheel angle (CAR.handling). Runs every frame, so everything settles
   * back to neutral on its own (also while the reset tween moves the car).
   *
   * @param {number} dt
   * @param {SteerInput} input
   * @param {number} lateralVelocity units/s, measured this frame
   * @param {number} speedMultiplier
   */
  function handle(dt, input, lateralVelocity, speedMultiplier) {
    const { clamp } = THREE.MathUtils;
    const heading = Math.atan2(lateralVelocity, WORLD.speed * speedMultiplier); // 0 when standing
    const yawTarget = -yaw.max * Math.tanh((heading * yaw.share) / yaw.max);
    const lastYaw = group.rotation.y;
    group.rotation.y += (yawTarget - lastYaw) * settle(yaw.easing, dt);
    const yawRate = dt > 0 ? (group.rotation.y - lastYaw) / dt : 0; // < 0 while the nose swings right

    const rollTarget = clamp(-yawRate * roll.perYawRate * rollSign, -roll.max, roll.max);
    chassis.rotation.z += (rollTarget - chassis.rotation.z) * settle(roll.easing, dt);

    const { max } = wheelSteer;
    const steerTarget = clamp(-input * max + yawRate * wheelSteer.perYawRate, -max, max);
    steerAngle += (steerTarget - steerAngle) * settle(wheelSteer.easing, dt);
    for (const steer of frontWheels) steer.rotation.y = steerAngle;
  }

  function stop() {
    speed = 0;
    sideways = 0;
    holdTime = 0;
    lastInput = 0;
  }

  return {
    group,
    wreck,
    /** The body (wheels and mirrors excluded) in the wreck node's frame. */
    box,
    chassis,
    frontWheels,
    /** Steering is only active in free ride and while playing. */
    steering: false,
    /** Free ride: soft road edges (see steer), and no steering shown against them. */
    softEdges: false,

    /**
     * @param {number} dt
     * @param {number} speedMultiplier
     * @param {SteerInput} input
     */
    update(dt, speedMultiplier, input) {
      const spin = (-WORLD.speed * speedMultiplier * dt) / radius; // as far as the road goes by
      for (const wheel of spins) wheel.rotation.x += spin;

      const active = this.steering && !resetTween?.isActive();
      const startX = group.position.x;
      const blocked = active && steer(dt, input, this.softEdges);

      sideways = dt > 0 ? (group.position.x - startX) / dt : 0;
      handle(dt, active && !blocked ? input : 0, sideways, speedMultiplier);
    },

    /** How fast the car went across the road last frame, units/s (+x): it crashes at that. */
    get sideways() {
      return sideways;
    },

    /** A steering key was released: the speed drops right away. */
    release() {
      speed *= s.releaseDamp;
    },

    /**
     * Eases the car back to the start position (also from where a crash pushed it, blinking, as an
     * arcade car comes back); roll, yaw and wheels settle on their own.
     *
     * @param {import("../core/tween.js").Tweens} tweens
     */
    reset(tweens) {
      resetTween?.cancel();
      const fromX = group.position.x;
      const [fromPosition, fromTurn] = [wreck.position.clone(), wreck.quaternion.clone()];
      const wrecked = !fromPosition.equals(ORIGIN) || !fromTurn.equals(UPRIGHT);
      resetTween = tweens.add({
        duration: CAR.resetDuration,
        ease: (t) => t, // the blinking keeps time, the move eases
        onUpdate: (t) => {
          const eased = easeInOutCubic(t);
          group.position.x = fromX * (1 - eased);
          wreck.position.lerpVectors(fromPosition, ORIGIN, eased);
          wreck.quaternion.slerpQuaternions(fromTurn, UPRIGHT, eased);
          const blink = Math.floor(2 * t * CAR.resetDuration * CAR.resetBlink) % 2 === 1;
          wreck.visible = !(wrecked && blink && t < 1);
        },
        onComplete: stop,
      });
    },

    /**
     * World-space bounds of the body (wheels excluded).
     *
     * @param {THREE.Box3} target
     */
    getBounds(target) {
      group.updateMatrixWorld(true);
      return target.setFromObject(body);
    },
  };
}
