import * as THREE from "three";
import { MINIGAME } from "../../config.js";
import { createRandom } from "../../core/random.js";
import { GRAVITY, METRE, STEP } from "./physics.js";

/**
 * @typedef {object} Seen the nearest car in a car's way
 * @property {number} gap how far off it is, units
 * @property {number} speed how fast the car goes, units/s
 * @property {number} leading how fast that one goes the same way, units/s
 *
 * @typedef {object} Looking a car as the drivers see it, on the road
 * @property {THREE.Vector3} at
 * @property {THREE.Vector3} velocity
 * @property {number[]} half its box's half size: across, up, along
 */

/**
 * What a driver sees ahead, the way the car goes: the nearest car in its way (across no further
 * than the two are wide), how far off, how fast either goes.
 *
 * @param {Looking} car
 * @param {Looking[]} others
 * @returns {Seen | undefined} nothing in its way
 */
export function lookAhead(car, others) {
  const speed = Math.hypot(car.velocity.x, car.velocity.z);
  if (speed < 1e-3) return undefined;
  const [x, z] = [car.velocity.x / speed, car.velocity.z / speed];
  /** @type {Seen | undefined} */
  let seen;
  for (const other of others) {
    if (other === car) continue;
    const [dx, dz] = [other.at.x - car.at.x, other.at.z - car.at.z];
    const along = dx * x + dz * z;
    const size = Math.max(other.half[0], other.half[2]); // however it stands
    if (along <= 0 || Math.abs(dx * z - dz * x) > car.half[0] + size) continue;
    const gap = along - car.half[2] - size;
    if (seen && gap >= seen.gap) continue;
    seen = { gap, speed, leading: other.velocity.x * x + other.velocity.z * z };
  }
  return seen;
}

/**
 * @typedef {object} Driving how a car's driver reacts and brakes, if not as MINIGAME.crash
 * @property {number[]} [reaction] seconds, at random
 * @property {number} [brake] the most they brake, of friction.brake
 * @property {number} [seen] coming along after the crash, the seconds they take to see the wreck
 *   (none: at once)
 */

/**
 * How hard a driver can brake, units/s².
 *
 * @param {Driving} [driving]
 */
export const hardest = (driving) => MINIGAME.crash.friction.brake * (driving?.brake ?? 1) * GRAVITY;

/**
 * How hard a car must brake to stop short of the car ahead (MINIGAME.crash.drivers gap), should
 * that one brake as hard as it can: units/s².
 *
 * @param {Seen | undefined} seen
 * @param {number} [hard] how hard the car ahead can brake, units/s² (as they reckon: as they can)
 */
export function stopping(seen, hard = hardest()) {
  if (!seen) return 0;
  const { drivers } = MINIGAME.crash;
  const room = seen.gap - drivers.gap * METRE + Math.max(seen.leading, 0) ** 2 / (2 * hard);
  return seen.speed ** 2 / (2 * Math.max(room, 1e-3));
}

/**
 * A car's driver in a crash (MINIGAME.crash.reaction, drivers): once they react (at random) they
 * brake as hard as it takes to stop short of the car ahead, at least gently; who cannot stop in
 * time panics, braking hard, swerving about a lane over or not; until then the wheels roll. A hit
 * on the car's side breaks a wheel there: it pulls the car that way for good. The player may take
 * the wheel (MINIGAME.crash.player): steering, driving on, braking gently.
 *
 * @param {ReturnType<typeof import("./vehicle.js").createVehicle>} vehicle what they drive
 * @param {boolean} swerves whether they may swerve (not the Bolones' driver: the player crashed)
 * @param {() => number} random in [0, 1)
 * @param {number} [joined] game seconds since the crash they came along at, having seen it ahead
 *   (driving.seen)
 * @param {Driving} [driving] how they react and brake, if not as MINIGAME.crash
 */
export function createDriver(vehicle, swerves, random, joined, driving) {
  const { friction, reaction, drivers, player } = MINIGAME.crash;
  const { randomIn } = createRandom(random);
  const reactAt =
    joined === undefined ? randomIn(driving?.reaction ?? reaction) : joined + (driving?.seen ?? 0);
  const hard = hardest(driving);
  const steer =
    swerves && random() < drivers.share
      ? THREE.MathUtils.degToRad(randomIn(drivers.angle)) * (random() < 0.5 ? -1 : 1)
      : 0;
  /** @type {{ steer: number, gas: boolean } | undefined} the player's, once they take the wheel */
  let hands;
  /** @type {Seen | undefined} */
  let ahead;
  let panicked = Infinity; // game seconds since the crash they found they could not stop at
  let wheel = 0; // how far the player has turned the wheels, radians to the left

  /**
   * The share of its power the engine has, the player's: it stalls MINIGAME.crash.player.stall
   * seconds after the crash, sputtering out over its last one.
   *
   * @param {number} time game seconds since the crash
   */
  const engine = (time) => (hands ? THREE.MathUtils.clamp(player.stall - time, 0, 1) : 0);

  return {
    engine,

    /**
     * Hit on its side: a wheel there is broken.
     *
     * @param {THREE.Vector3} towards in the car's frame, level: where it was hit from
     */
    breakWheel(towards) {
      vehicle.breakWheel(towards, THREE.MathUtils.degToRad(randomIn(drivers.broken)));
    },

    /**
     * What they see ahead now (lookAhead).
     *
     * @param {Seen | undefined} seen
     */
    see(seen) {
      ahead = seen;
    },

    /**
     * The player at the wheel, from now on.
     *
     * @param {number} steer -1 (left) to 1 (right)
     * @param {boolean} gas
     */
    take(steer, gas) {
      hands = { steer, gas };
    },

    /**
     * What the driver does at a moment.
     *
     * @param {number} time game seconds since the crash
     */
    drive(time) {
      if (!hands && vehicle.resting) return; // nothing to do, the player's may drive on
      const power = engine(time);
      const gas = (hands?.gas ?? false) && power > 0;
      let braking = friction.roll * GRAVITY; // rolling, until they react
      if (time < reactAt || gas) {
        // on
      } else if (hands) {
        braking = drivers.gently * hard;
      } else {
        // as hard as it takes to stop short of the car ahead, but past what the tyres can, panic
        const stop = stopping(ahead, hard);
        if (stop > hard) panicked = Math.min(panicked, time);
        braking =
          time >= panicked
            ? hard
            : THREE.MathUtils.clamp(stop * drivers.margin, drivers.gently * hard, hard);
      }
      vehicle.brake(braking);
      const fast = vehicle.speed >= player.top * METRE;
      vehicle.accelerate(gas && !fast ? player.gas * METRE * power : 0);
      if (hands) {
        const lock = THREE.MathUtils.degToRad(player.steer);
        const turn = (lock / player.turn) * STEP;
        wheel += THREE.MathUtils.clamp(-hands.steer * lock - wheel, -turn, turn);
        vehicle.steer(wheel);
        return;
      }
      // panicking: a swerve one way, as long back, then straight on
      const since = time - panicked;
      const swerve =
        since < 0 ? 0 : since < drivers.swerve ? 1 : since < 2 * drivers.swerve ? -1 : 0;
      vehicle.steer(steer * swerve);
    },
  };
}
