import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { MINIGAME } from "../../config.js";
import { GRAVITY, STEP, UP } from "./physics.js";

/** A wheel's suspension and axle, in the car's frame (Rapier's ray-cast vehicle). */
const [DOWN, AXLE] = [
  { x: 0, y: -1, z: 0 },
  new THREE.Vector3(-1, 0, 0), // its rotation grows rolling towards +z, as the rig's spin does
];

/**
 * A car on its wheels (Rapier's ray-cast vehicle): each wheel a spring holding its share of the
 * car's weight (the nearer the centre of mass, the more), so the car stands where it stood, and a
 * tyre gripping the road (MINIGAME.crash.friction.side), braking and steering, its grip tipping
 * the car from down there (MINIGAME.crash.car.tip: sliding sideways it can roll over); an
 * anti-roll bar across each axle (MINIGAME.crash.car.springs). The rig's wheels follow: they
 * roll, steer and ride their springs.
 *
 * @param {RAPIER.World} world
 * @param {RAPIER.RigidBody} body its middle at the centre of mass, turned as the car is
 * @param {import("../../scene/rig.js").Wheel[]} rig mounts in the car's own frame
 * @param {THREE.Vector3} centre the centre of mass, in the car's frame
 * @param {number} groups the colliders the wheels stand on (Rapier interaction groups)
 */
export function createVehicle(world, body, rig, centre, groups) {
  const { friction, car } = MINIGAME.crash;
  const controller = world.createVehicleController(body);
  controller.indexUpAxis = 1;
  controller.setIndexForwardAxis = 2; // Rapier names the setter so
  const mass = body.mass();
  const bounce = 2 * Math.PI * car.springs.bounce;
  const stiffness = bounce ** 2 / rig.length; // per kg of car (Rapier's), all together `bounce`
  const damping = (2 * car.springs.damping * bounce) / rig.length;

  // the weight on each axle, the nearer the centre of mass the more; shared by its wheels
  const along = rig.map(({ mount }) => mount.position.z - centre.z);
  const axles = [...new Set(along.map((z) => Math.round(z * 1e3) / 1e3))];
  const share = (/** @type {number} */ z) => {
    const on = along.filter((other) => Math.abs(other - z) < 1e-3).length;
    if (axles.length !== 2) return 1 / rig.length;
    const [a, b] = axles.map(Math.abs);
    const near = Math.abs(Math.abs(z) - a) < 1e-3 ? b : a; // the other axle's distance
    return near / (a + b) / on;
  };

  // which way its nose points along z: where the steered wheels are
  const ahead = Math.sign(along[rig.findIndex(({ mount }) => mount.userData.steers)] ?? 1) || 1;
  const driven = rig.filter(({ mount }) => !mount.userData.steers).length; // rear-wheel drive

  const height = body.translation().y; // of the centre of mass, the car upright
  const wheels = rig.map((wheel, i) => {
    const { mount, steer, spin, radius } = wheel;
    const load = share(along[i]);
    const travel = radius; // how far the wheel can rise to where its spring is fixed
    const at = mount.position.clone().sub(centre);
    // the wheel's bottom over the road, the car upright: its spring takes that up
    const above = height + at.y - radius;
    const point = new THREE.Vector3(at.x, at.y + travel, at.z); // where its spring is fixed
    const axle = AXLE.clone(); // in the car's frame, not steered
    const rest = travel + above + (load * GRAVITY) / stiffness; // its spring's length, unloaded
    controller.addWheel(point, DOWN, axle, rest, radius);
    controller.setWheelSuspensionStiffness(i, stiffness);
    controller.setWheelSuspensionCompression(i, damping);
    controller.setWheelSuspensionRelaxation(i, damping);
    controller.setWheelMaxSuspensionForce(i, mass * GRAVITY * rig.length);
    controller.setWheelMaxSuspensionTravel(i, travel);
    controller.setWheelFrictionSlip(i, friction.side);
    return {
      ...wheel,
      load,
      travel,
      point,
      axle,
      rest,
      toe: 0, // radians: a wheel broken or pushed askew
      lost: false,
      from: { spin: spin.rotation.x, steer: steer.rotation.y },
    };
  });
  let steering = 0;
  // the anti-roll bars: the wheels of an axle, left and right
  const bars = wheels.flatMap((left, i) =>
    wheels
      .map((right, j) => /** @type {const} */ ([i, j, right]))
      .filter(([, j, right]) => j > i && Math.abs(along[j] - along[i]) < 1e-3)
      .filter(([, , right]) => right.mount.position.x * left.mount.position.x < 0)
      .map(([, j]) => /** @type {const} */ ([i, j])),
  );
  const { tip } = car;
  const { antiRoll } = car.springs;
  /** How far a wheel's spring is out (in full, a wheel off the road). @param {number} i */
  const length = (i) => controller.wheelSuspensionLength(i) ?? wheels[i].travel;
  /**
   * How far a wheel's spring is pressed in, as its load: none off the road (Rapier then gives its
   * length as its rest length, the bar's) or lost.
   *
   * @param {number} i
   */
  const pressed = (i) =>
    wheels[i].lost || !controller.wheelIsInContact(i) ? 0 : Math.max(0, wheels[i].rest - length(i));
  const turn = new THREE.Quaternion();
  const [rise, side, torque] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  return {
    /**
     * Brakes, every wheel by its share of the car's weight.
     *
     * @param {number} deceleration units/s², as far as the tyres grip
     */
    brake(deceleration) {
      wheels.forEach(({ load }, i) =>
        controller.setWheelBrake(i, load * mass * deceleration * STEP),
      );
    },

    /**
     * Turns the steered wheels (the front ones, as they stood when the crash began, and on).
     *
     * @param {number} angle radians, to the car's left (to its right below 0)
     */
    steer(angle) {
      if (angle !== steering) body.wakeUp();
      steering = angle;
    },

    /**
     * Drives the car on, nose first, by the wheels that do not steer (rear-wheel drive, as the
     * Bolones'), as far as their tyres grip.
     *
     * @param {number} acceleration units/s², 0 to coast
     */
    accelerate(acceleration) {
      if (acceleration > 0) body.wakeUp();
      const force = (ahead * mass * acceleration) / driven;
      wheels.forEach(({ mount }, i) =>
        controller.setWheelEngineForce(i, mount.userData.steers ? 0 : force),
      );
    },

    /** Whether it has come to rest (Rapier put it to sleep). */
    get resting() {
      return body.isSleeping();
    },

    /** How fast it goes nose first, units/s. */
    get speed() {
      return ahead * controller.currentVehicleSpeed();
    },

    /**
     * A wheel on that side of the car broken (once): toed that way, it pulls the car there.
     *
     * @param {THREE.Vector3} towards in the car's frame, level
     * @param {number} angle radians
     */
    breakWheel(towards, angle) {
      if (wheels.some(({ toe }) => toe)) return;
      // the wheel on that side nearest the hit, toed to turn the car that way whichever way it
      // goes (a rear one turned the other way to do it)
      const side = wheels.filter(({ mount, lost }) => !lost && mount.position.x * towards.x > 0);
      const nearest = (/** @type {(typeof wheels)[number]} */ { mount }) =>
        mount.position.z * towards.z;
      const [wheel] = side.sort((a, b) => nearest(b) - nearest(a));
      if (!wheel) return;
      const going = Math.sign(controller.currentVehicleSpeed()) || 1;
      const leading = Math.sign(wheel.mount.position.z - centre.z) * going || 1;
      wheel.toe = angle * Math.sign(towards.x) * going * leading;
    },

    /**
     * A wheel pushed askew by a crash: its spring where its mount ends up, its axle turned as the
     * mount is.
     *
     * @param {THREE.Object3D} mount
     * @param {THREE.Vector3} position where it ends up, in the car's frame
     * @param {THREE.Quaternion} quaternion
     */
    skew(mount, position, quaternion) {
      const i = wheels.findIndex((wheel) => wheel.mount === mount);
      if (i < 0) return;
      const { point, travel, axle } = wheels[i];
      point.copy(position).sub(centre);
      point.y += travel;
      controller.setWheelChassisConnectionPointCs(i, point);
      controller.setWheelAxleCs(i, axle.copy(AXLE).applyQuaternion(quaternion));
    },

    /**
     * A wheel torn off: it holds nothing up, grips nothing.
     *
     * @param {THREE.Object3D} mount
     * @returns {{ at: THREE.Vector3, radius: number } | undefined} where it was, in the
     *   body's frame
     */
    lose(mount) {
      const i = wheels.findIndex((wheel) => wheel.mount === mount);
      if (i < 0) return undefined;
      wheels[i].lost = true;
      controller.setWheelMaxSuspensionForce(i, 0);
      controller.setWheelFrictionSlip(i, 0);
      body.wakeUp();
      return { at: mount.position.clone().sub(centre), radius: wheels[i].radius };
    },

    /** One physics step of the wheels, before the world's: none for a car at rest (asleep). */
    update() {
      if (body.isSleeping()) return;
      wheels.forEach(({ mount, toe, from }, i) => {
        const steered = mount.userData.steers ? from.steer + steering : 0;
        controller.setWheelSteering(i, steered + toe);
      });
      // an anti-roll bar moves weight onto the wheel pressed further in, through the springs: no
      // more than the other one carries (none once it is off the road)
      for (const [i, j] of bars) {
        const a = pressed(i);
        const b = pressed(j);
        const shift = THREE.MathUtils.clamp(antiRoll * (a - b), -a, b);
        controller.setWheelSuspensionRestLength(i, wheels[i].rest + shift);
        controller.setWheelSuspensionRestLength(j, wheels[j].rest - shift);
      }
      controller.updateVehicle(STEP, undefined, groups);
      // a tyre's side force tips the car from the road, under the centre of mass: Rapier puts it
      // about level with the centre (a ray-cast vehicle's guard against rolling over), so `tip`
      // of the turn it leaves out is added, all the wheels' in one
      body.rotation(turn);
      rise.copy(UP).applyQuaternion(turn); // the car's up
      torque.set(0, 0, 0);
      wheels.forEach(({ point, radius, axle }, i) => {
        const impulse = controller.wheelSideImpulse(i);
        if (!impulse) return;
        const below = point.y - length(i) - radius; // where it grips, from the centre of mass
        // its force: along its axle, steered, level with the (flat) road; its turn: up × force
        side
          .copy(axle)
          .applyAxisAngle(UP, controller.wheelSteering(i) ?? 0)
          .applyQuaternion(turn)
          .setY(0)
          .normalize();
        torque.addScaledVector(side.crossVectors(rise, side), (below * tip * impulse) / STEP);
      });
      body.addTorque(torque, false);
    },

    /** The rig's wheels where the vehicle's are: rolled, steered, up or down on their springs. */
    show() {
      wheels.forEach(({ spin, steer, travel, lost, from }, i) => {
        if (lost) return;
        spin.rotation.x = from.spin + (controller.wheelRotation(i) ?? 0);
        steer.rotation.y = controller.wheelSteering(i) ?? 0;
        steer.position.y = travel - (controller.wheelSuspensionLength(i) ?? travel);
      });
    },

    /** Puts the rig's wheels back on their springs as they stood. */
    dispose() {
      for (const { steer, from } of wheels) {
        steer.position.y = 0;
        steer.rotation.y = from.steer;
      }
      world.removeVehicleController(controller);
    },
  };
}
