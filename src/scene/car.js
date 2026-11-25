import * as THREE from "three";
import { CAR, SPEED, WORLD } from "../config.js";
import { easeInOutCubic, settle } from "../core/tween.js";
import { pruneEmpty, wheelCenter } from "./model.js";
import { mountWheel, wheelsOf } from "./rig.js";
import { withPolygons } from "./polygons.js";
import { HOLE_SEGMENTS } from "./traffic.js";
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
 * The Bolones. Each part of the motion lives on its own node, so nothing has to be synced:
 *
 *   group          lateral position (x) + yaw: the nose turns towards the lane change; CAR.lift (y)
 *   └ wreck        where a crash threw the car (game/crash.js), at rest otherwise
 *     ├ chassis    body roll around the axle line (CAR.rollCenterY)
 *     │ └ body     with the fuel cap on its mesh
 *     └ 4× wheel   on its rig (scene/rig.js): the mount on the axle, mid-width; front ones steer
 *       └ … spin → mirror → wheel model, offset so its axle and mid-width sit on the mount
 *
 * The wheels never roll with the body, which gives the suspension feel of v1. Speeds are per
 * second and easings time constants (settle), so 60 Hz and 144 Hz feel the same.
 *
 * @param {{ scene: THREE.Scene, models: Record<string, THREE.Group>, materials: import("./materials.js").Materials }} deps
 */
export function createCar({ scene, models, materials }) {
  const solid = materials.solid.bolones;
  const wire = materials.wire.bolones;

  const body = dress(models.bolones, solid, wire);
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

    // (x, y, z) is where v1 put the model origin; the mount sits in the middle of the width
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
  const box = new THREE.Box3().setFromObject(body).translate(group.position.clone().negate());

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
   * Lateral motion (v1 feel): hold to speed up, momentum after release.
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
    /** The body (wheels excluded) in the wreck node's frame. */
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
      const spin = SPEED.wheelSpin * speedMultiplier * dt;
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

    /** A steering key was released (v1: speed drops right away). */
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
     * World-space bounds of the body (wheels excluded, as in v1).
     *
     * @param {THREE.Box3} target
     */
    getBounds(target) {
      group.updateMatrixWorld(true);
      return target.setFromObject(body);
    },
  };
}
