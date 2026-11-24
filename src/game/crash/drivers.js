import * as THREE from "three";
import { MINIGAME } from "../../config.js";
import { createRandom } from "../../core/random.js";
import { GRAVITY, METRE, STEP } from "./physics.js";

/**
 * A car's driver in a crash (MINIGAME.crash.reaction, drivers): they act once they react (at
 * random), braking hard, or swerving about a lane over braking gently; until then the wheels
 * roll. A hit on the car's side breaks a wheel there: it pulls the car that way for good. The
 * player may take the wheel (MINIGAME.crash.player): steering, driving on, braking gently.
 *
 * @param {ReturnType<typeof import("./vehicle.js").createVehicle>} vehicle what they drive
 * @param {boolean} swerves whether they may swerve (not the Bolones' driver: the player crashed)
 * @param {() => number} random in [0, 1)
 */
export function createDriver(vehicle, swerves, random) {
  const { friction, reaction, drivers, player } = MINIGAME.crash;
  const { randomIn } = createRandom(random);
  const reactAt = randomIn(reaction);
  const steer =
    swerves && random() < drivers.share
      ? THREE.MathUtils.degToRad(randomIn(drivers.angle)) * (random() < 0.5 ? -1 : 1)
      : 0;
  /** @type {{ steer: number, gas: boolean } | undefined} the player's, once they take the wheel */
  let hands;
  let wheel = 0; // how far the player has turned the wheels, radians to the left

  return {
    /**
     * Hit on its side: a wheel there is broken.
     *
     * @param {THREE.Vector3} towards in the car's frame, level: where it was hit from
     */
    breakWheel(towards) {
      vehicle.breakWheel(towards, THREE.MathUtils.degToRad(randomIn(drivers.broken)));
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
      const since = time - reactAt;
      const gas = hands?.gas ?? false;
      const braking =
        since < 0 || gas ? friction.roll : friction.brake * (steer || hands ? drivers.gently : 1);
      vehicle.brake(braking * GRAVITY);
      vehicle.accelerate(gas && vehicle.speed < player.top * METRE ? player.gas * METRE : 0);
      if (hands) {
        const lock = THREE.MathUtils.degToRad(player.steer);
        const turn = (lock / player.turn) * STEP;
        wheel += THREE.MathUtils.clamp(-hands.steer * lock - wheel, -turn, turn);
        vehicle.steer(wheel);
        return;
      }
      // a swerve one way, as long back, then straight on
      const swerve =
        since < 0 ? 0 : since < drivers.swerve ? 1 : since < 2 * drivers.swerve ? -1 : 0;
      vehicle.steer(steer * swerve);
    },
  };
}
