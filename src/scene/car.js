import * as THREE from "three";
import { CAR, WORLD } from "../config.js";
import { easeInOutCubic, settle } from "../core/tween.js";
import { buildBolones } from "./bolones.js";

/** @typedef {-1 | 0 | 1} SteerInput left, none, right */

const ORIGIN = new THREE.Vector3();
const UPRIGHT = new THREE.Quaternion();

/**
 * The Bolones (scene/bolones.js builds it) and how it moves: across the road as it is steered,
 * yawing and rolling into it, the front wheels turned, the wheels rolling as far as the road goes
 * by. Each part of the motion has a node of its own, so nothing has to be synced. The wheels never
 * roll with the body: a feel of suspension. Speeds are per second and easings time constants
 * (settle), so 60 Hz and 144 Hz feel the same.
 *
 * @param {{ scene: THREE.Scene, models: Record<string, THREE.Group>, materials: import("./materials.js").Materials }} deps
 */
export function createCar({ scene, models, materials }) {
  const { group, wreck, chassis, body, box, spins, frontWheels, radius } = buildBolones(
    models,
    materials,
  );
  scene.add(group);

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
