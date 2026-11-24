import * as THREE from "three";
import { MINIGAME } from "../../config.js";
import { createRandom } from "../../core/random.js";
import { GRAVITY } from "./physics.js";

/**
 * A car's driver in a crash (MINIGAME.crash.reaction, drivers): they act once they react (at
 * random), braking hard, or swerving about a lane over braking gently; until then the wheels
 * roll. A hit on the car's side breaks a wheel there: it pulls the car that way for good.
 *
 * @param {ReturnType<typeof import("./vehicle.js").createVehicle>} vehicle what they drive
 * @param {boolean} swerves whether they may swerve (not the Bolones' driver: the player crashed)
 * @param {() => number} random in [0, 1)
 */
export function createDriver(vehicle, swerves, random) {
  const { friction, reaction, drivers } = MINIGAME.crash;
  const { randomIn } = createRandom(random);
  const reactAt = randomIn(reaction);
  const steer =
    swerves && random() < drivers.share
      ? THREE.MathUtils.degToRad(randomIn(drivers.angle)) * (random() < 0.5 ? -1 : 1)
      : 0;

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
     * What the driver does at a moment.
     *
     * @param {number} time game seconds since the crash
     */
    drive(time) {
      const since = time - reactAt;
      const braking = since < 0 ? friction.roll : friction.brake * (steer ? drivers.gently : 1);
      vehicle.brake(braking * GRAVITY);
      // a swerve one way, as long back, then straight on
      const swerve =
        since < 0 ? 0 : since < drivers.swerve ? 1 : since < 2 * drivers.swerve ? -1 : 0;
      vehicle.steer(steer * swerve);
    },
  };
}
