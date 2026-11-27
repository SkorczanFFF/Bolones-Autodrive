// @ts-expect-error no @types/node in this browser project; the tests run in node
import fs from "node:fs";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { ASSETS, CAR, MINIGAME, MOUNTAINS, PALETTE, TRAFFIC } from "../src/config.js";
import { FanFBXLoader } from "../src/core/fbx.js";
import { mulberry32 } from "../src/core/noise.js";
import { createCrash as create, ready } from "../src/game/crash.js";
import { meeting, penetration } from "../src/game/crash/boxes.js";
import { facesOf, roofOf } from "../src/game/crash/shape.js";
import { createCar } from "../src/scene/car.js";
import { createTrafficModels } from "../src/scene/traffic.js";
import { wheelsOf } from "../src/scene/rig.js";
import { testCar as car, testMaterials } from "./helpers.js";

/**
 * A crash whose drivers do the same every run.
 *
 * @param {Parameters<typeof create>} args
 */
const createCrash = (...[scene, cars, palms]) => create(scene, cars, palms, mulberry32(1));

const BOLONES = /** @type {number[]} */ ([3, 2.6, 7.8]);
/** How far a car leans from upright, degrees. @param {THREE.Object3D} object */
const leanOf = (object) =>
  THREE.MathUtils.radToDeg(
    new THREE.Vector3(0, 1, 0)
      .applyQuaternion(object.quaternion)
      .angleTo(new THREE.Vector3(0, 1, 0)),
  );
const POLAKITO = /** @type {number[]} */ ([2.5, 2.4, 5.5]);

/**
 * The Bolones driving forward (-z), hit by an oncoming Polakito `offset` to the side, a little into
 * its front; `speed` multiplies both speeds (the game's levels).
 */
function headOn(offset = 0, speed = 1, others = /** @type {ReturnType<typeof car>[]} */ ([])) {
  const scene = new THREE.Scene();
  const bolones = car(0, 0, BOLONES, 1160, -14.4 * speed);
  const other = car(offset, -6.4, POLAKITO, 580, 18.9 * speed);
  const cars = [bolones, other, ...others];
  scene.add(...cars.map(({ object }) => object));
  return { scene, bolones, other, crash: createCrash(scene, cars) };
}

/**
 * Runs the crash for a while: the camera's speed then.
 *
 * @param {ReturnType<typeof createCrash>} crash
 */
function run(crash, seconds = 4) {
  let speed = 0;
  for (let t = 0; t < seconds; t += 1 / 60) speed = crash.update(1 / 60);
  return speed;
}

/**
 * How far the middle of a car's mesh (a metre either side) reaches along z now, world space
 * (dents shorten it).
 *
 * @param {THREE.Object3D} object
 */
function reachOf(object) {
  const position = /** @type {THREE.Mesh} */ (object.children[0]).geometry.getAttribute("position");
  object.updateWorldMatrix(true, false);
  const p = new THREE.Vector3();
  let [min, max] = [Infinity, -Infinity];
  for (let i = 0; i < position.count; i++) {
    if (Math.abs(position.getX(i)) > 1) continue;
    const { z } = p.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
    [min, max] = [Math.min(min, z), Math.max(max, z)];
  }
  return { min, max };
}

/** How low the box round a car comes now, world space. @param {THREE.Object3D} object */
const lowestOf = (object) => new THREE.Box3().setFromObject(object).min.y;

/**
 * How deep a car's mesh goes into another's at most: into the box round the other one's mesh, as
 * far as from that box's nearest face.
 *
 * @param {{ object: THREE.Object3D }} car
 * @param {{ object: THREE.Object3D }} other
 */
function depthIn({ object }, other) {
  const mesh = /** @type {THREE.Mesh} */ (object.children[0]);
  const into = /** @type {THREE.Mesh} */ (other.object.children[0]);
  into.geometry.computeBoundingBox();
  const { min, max } = /** @type {THREE.Box3} */ (into.geometry.boundingBox);
  object.updateWorldMatrix(true, true);
  other.object.updateWorldMatrix(true, true);
  const back = into.matrixWorld.clone().invert();
  const position = mesh.geometry.getAttribute("position");
  const p = new THREE.Vector3();
  let deepest = 0;
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).applyMatrix4(back);
    const depth = Math.min(...p.clone().sub(min).toArray(), ...max.clone().sub(p).toArray());
    deepest = Math.max(deepest, depth);
  }
  return deepest;
}

/** A car's mesh's size now (dents shorten it). @param {THREE.Object3D} object */
function sizeOf(object) {
  const { geometry } = /** @type {THREE.Mesh} */ (object.children[0]);
  geometry.computeBoundingBox();
  return /** @type {THREE.Box3} */ (geometry.boundingBox).getSize(new THREE.Vector3());
}

/** A model as the game loads it. @param {keyof typeof ASSETS.models} name */
const load = (name) => {
  const file = fs.readFileSync(`public/${ASSETS.models[name]}`);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  return new FanFBXLoader().parse(buffer, "");
};

beforeAll(() => ready); // Rapier

describe("crash", () => {
  it("takes up the closing speed in the crumple zones: the cars go on together, barely apart", () => {
    const { bolones, other, crash } = headOn();
    const gap = () => bolones.object.position.z - other.object.position.z;
    const before = gap();
    run(crash, 0.7); // the crush is over, the drivers have not acted yet
    expect(before - gap()).toBeGreaterThan(0.5); // they ended up in each other
    const after = gap();
    run(crash, 0.1);
    // and go on together, coming apart at a small share of the speed they closed at at most
    const closing = 14.4 + 18.9;
    expect(Math.abs(gap() - after) / 0.1).toBeLessThan(0.15 * closing);
    // what the crumple zones took up: about all the closing energy (the cars barely bounce)
    const mass = (1160 * 580) / (1160 + 580);
    const energy = 0.5 * mass * (closing / TRAFFIC.scale) ** 2;
    const { tally } = crash;
    expect(tally.energy / energy).toBeGreaterThan(0.9);
    expect(tally.energy / energy).toBeLessThanOrEqual(1);
    expect(tally).toMatchObject({ cars: 2, parts: 0, posts: 0 });
  });

  it("the faster the crash, the deeper the dents; the lighter car takes more", () => {
    const length = (/** @type {number} */ speed) => {
      const { bolones, other, crash } = headOn(0, speed);
      run(crash, 1);
      return [bolones, other].map(({ object }) => sizeOf(object).z);
    };
    const [slow, fast] = [length(1), length(1.75)];
    const crushSlow = [BOLONES[2] - slow[0], POLAKITO[2] - slow[1]];
    const crushFast = [BOLONES[2] - fast[0], POLAKITO[2] - fast[1]];
    expect(crushSlow[1]).toBeGreaterThan(crushSlow[0]); // the Polakito is crushed more
    expect(crushFast[1] / crushSlow[1]).toBeGreaterThan(1.4); // deeper with the speed
  });

  it("keeps an offset crash from spinning the cars round: the fronts lock, the tyres hold", () => {
    const { bolones, other, crash } = headOn(-2, 1.75);
    let turn = 0;
    for (let t = 0; t < 4; t += 1 / 60) {
      crash.update(1 / 60);
      for (const { object } of [bolones, other]) {
        const yaw = new THREE.Euler().setFromQuaternion(object.quaternion, "YXZ").y;
        turn = Math.max(turn, Math.abs(yaw));
      }
    }
    expect(turn).toBeGreaterThan(0.05); // an offset hit does turn them
    expect(turn).toBeLessThan(Math.PI / 2);
  });

  it("keeps fronts that met wide in each other however fast: a deep crush throws neither aside", () => {
    // some 200 km/h closing: the crush goes deeper than the fronts are wide
    const { bolones, other, crash } = headOn(0, 3);
    run(crash, 0.6);
    expect(Math.abs(other.object.position.x - bolones.object.position.x)).toBeLessThan(0.3);
    expect(other.object.position.z).toBeLessThan(bolones.object.position.z); // not through it
  });

  it("catches fronts that meet wide in each other for a while: they turn as one", () => {
    const { bolones, other, crash } = headOn(-0.5);
    const yaw = (/** @type {THREE.Object3D} */ object) =>
      new THREE.Euler().setFromQuaternion(object.quaternion, "YXZ").y;
    const relative = () => yaw(bolones.object) - yaw(other.object);
    run(crash, 0.25); // met and crushed
    const from = relative();
    run(crash, 0.3);
    expect(Math.abs(relative() - from)).toBeLessThan(0.01);
  });

  it("stops a car thrown off the road at the side hills, not in them", () => {
    const scene = new THREE.Scene();
    const bolones = car(0, 0, BOLONES, 1160, 0);
    // far out and fast sideways, as if thrown
    const thrown = { ...car(MOUNTAINS.start - 10, -60, POLAKITO, 580, 0) };
    thrown.velocity = new THREE.Vector3(60, 0, 0);
    scene.add(bolones.object, thrown.object);
    run(createCrash(scene, [bolones, thrown]), 3);
    expect(thrown.object.position.x).toBeLessThan(MOUNTAINS.start);
  });

  it("crumples one car a frame: the two of a crash in turn", () => {
    const { bolones, other, crash } = headOn();
    const bodies = [bolones, other].map(
      ({ object }) => /** @type {THREE.Mesh} */ (object.children[0]),
    );
    const originals = bodies.map(({ geometry }) => geometry);
    const dented = () => bodies.map((mesh, i) => mesh.geometry !== originals[i]);
    for (let frame = 0; frame < 120 && !dented().includes(true); frame++) crash.update(1 / 60);
    expect(dented().filter(Boolean)).toHaveLength(1);
    crash.update(1 / 60);
    expect(dented()).toEqual([true, true]);
  });

  it("crumples a crush still going in first: a car running into the wreck dents as it hits", () => {
    const scene = new THREE.Scene();
    // the corners meet: they slide along each other, the dents following where they overlap
    // (each all the way in at once, in turn); the car behind runs into them meanwhile
    const cars = [
      car(0, 0, BOLONES, 1160, -14.4 * 1.5),
      car(2.5, -6.4, POLAKITO, 580, 18.9 * 1.5),
      car(1.5, -18, POLAKITO, 580, 18.9 * 1.5),
    ];
    scene.add(...cars.map(({ object }) => object));
    const crash = createCrash(scene, cars);
    const late = cars[2];
    const body = /** @type {THREE.Mesh} */ (late.object.children[0]);
    const original = body.geometry;
    let frame = 0;
    let hit = -1;
    const { onCrash } = late;
    late.onCrash = (crushed) => {
      onCrash(crushed);
      if (hit < 0) hit = frame;
    };
    for (; frame < 60 && body.geometry === original; frame++) crash.update(1 / 60);
    expect(hit).toBeGreaterThan(2); // after the first crash
    expect(frame - 1 - hit).toBeLessThanOrEqual(1); // the frame it is hit, or the next
  });

  it("puts out the lamps where the cars were hit, not the others", () => {
    const { bolones, other, crash } = headOn();
    run(crash, 0.2);
    expect(bolones.lamps).toEqual({ front: false, rear: true });
    expect(other.lamps).toEqual({ front: false, rear: true });
  });

  it("runs a car that cannot stop in time into the wreck, not through it", () => {
    const close = car(0, -20, POLAKITO, 580, 18.9); // right behind the car that crashed
    const { bolones, other, crash } = headOn(0, 1, [close]);
    run(crash);
    expect(close.lamps.front).toBe(false); // it crashed too
    expect(other.lamps.rear).toBe(false);
    // the wrecks in the order they crashed
    expect(crash.wrecks).toEqual([bolones, other, close]);
    expect(crash.centre(new THREE.Vector3(), 2).distanceTo(close.object.position)).toBeLessThan(2);
    // the crushed ends meet, neither passes into the other
    const [first, middle, last] = [bolones, other, close].map(({ object }) => reachOf(object));
    expect(middle.max).toBeLessThan(first.min + 0.03); // the dents follow the crush to a few cm
    expect(last.max).toBeLessThan(middle.min + 0.03);
  });

  it("stops a car far enough away before the wreck, once its driver reacts", () => {
    const far = car(0, -150, POLAKITO, 580, 18.9);
    const { bolones, other, crash } = headOn(0, 1, [far]);
    run(crash, 8);
    expect(far.lamps.front).toBe(true);
    expect(crash.wrecks).toEqual([bolones, other]); // not among the wrecks
    const z = far.object.position.z;
    run(crash, 0.5);
    expect(far.object.position.z).toBeCloseTo(z, 2); // standing
    expect(z).toBeLessThan(other.object.position.z - 5);
  });

  it("stands the traffic on its springs where it stood: neither sinking, nor bouncing, nor nodding", () => {
    const scene = new THREE.Scene();
    // the real cars, their axles off their middles, at the height the traffic drives at
    const standing = createTrafficModels(testMaterials()).map((model, i) => {
      const object = model.clone();
      object.position.set(10 * i, TRAFFIC.y, 0);
      scene.add(object);
      const box = new THREE.Box3(
        new THREE.Vector3().fromArray(object.userData.hitbox.min),
        new THREE.Vector3().fromArray(object.userData.hitbox.max),
      );
      const velocity = new THREE.Vector3();
      return {
        object,
        box,
        mass: object.userData.mass,
        velocity,
        color: new THREE.Color(),
        label: "",
      };
    });
    const crash = createCrash(scene, standing);
    for (let t = 0; t < 2; t += 1 / 60) {
      crash.update(1 / 60);
      for (const { object } of standing) {
        expect(Math.abs(object.position.y - TRAFFIC.y)).toBeLessThan(0.01);
        expect(object.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(0.005); // 0.3°
      }
    }
  });
  it("shows a wheel with nothing under it hanging a little out of its arch, no further", () => {
    const scene = new THREE.Scene();
    const thrown = car(0, 0, POLAKITO, 580, 0);
    thrown.velocity.set(0, 14, 0); // up off the road
    const far = car(0, -400, BOLONES, CAR.mass, 0); // a crash takes two: this one stays out of it
    scene.add(thrown.object, far.object);
    const crash = createCrash(scene, [thrown, far]);
    run(crash, 0.4); // in the air
    const { droop } = MINIGAME.crash.car;
    for (const { steer, radius } of wheelsOf(thrown.object)) {
      expect(steer.position.y).toBeLessThan(-0.5 * droop * radius); // let out
      expect(steer.position.y).toBeGreaterThan(-1.1 * droop * radius); // a little only
    }
  });

  it("tears a front wheel off in a hard crash: it rolls away to a stop, the car sits down on that corner", () => {
    const scene = new THREE.Scene();
    const bolones = car(0, 0, BOLONES, 1160, -14.4 * 1.75);
    const other = car(0, -6.4, POLAKITO, 580, 18.9 * 1.75);
    scene.add(bolones.object, other.object);
    const crash = createCrash(scene, [bolones, other]);
    const wheels = other.object.children.filter(({ userData }) => userData.part);
    const mounts = new Map(wheels.map((wheel) => [wheel, wheel.position.clone()]));
    let lowest = Infinity; // of the wheels torn off: never under the road
    for (let t = 0; t < 3; t += 1 / 60) {
      crash.update(1 / 60);
      for (const wheel of wheels.filter(({ parent }) => parent === scene)) {
        lowest = Math.min(lowest, new THREE.Box3().setFromObject(wheel, true).min.y);
      }
    }
    expect(lowest).toBeGreaterThan(-0.05);
    const torn = wheels.filter((wheel) => wheel.parent === scene);
    expect(torn.length).toBeGreaterThan(0);
    expect(crash.tally.parts).toBeGreaterThanOrEqual(torn.length);
    const [wheel] = torn;
    expect(wheel.position.distanceTo(other.object.position)).toBeGreaterThan(3); // away
    const [{ spin }] = wheelsOf(wheel);
    const { camber } = MINIGAME.crash.dents;
    const buckled = camber * MINIGAME.crash.parts.wheel.tear; // as far as it leant when it went
    expect(Math.abs(spin.rotation.y)).toBeCloseTo(buckled, 9);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(other.object.quaternion);
    expect(THREE.MathUtils.radToDeg(up.angleTo(new THREE.Vector3(0, 1, 0)))).toBeGreaterThan(4);
    // it rolls to a stop, buckled
    run(crash, 5);
    const at = wheel.position.clone();
    run(crash, 1);
    expect(wheel.position.distanceTo(at)).toBeLessThan(0.05);
    // on the road, not floating: as round as it is, however it was spun when it went
    expect(Math.abs(wheel.position.y - 0.5)).toBeLessThan(0.05); // its middle a radius up
    // its corner down on its hub, its middle a hub's radius over the road (not on the body)
    const hub = MINIGAME.crash.car.hub * 0.5; // of the test car's wheel
    const corner = other.object.localToWorld(
      /** @type {THREE.Vector3} */ (mounts.get(wheel)).clone(),
    );
    expect(corner.y).toBeGreaterThan(0.9 * hub);
    expect(corner.y).toBeLessThan(1.1 * hub);
    crash.dispose();
    expect(wheels.every(({ parent }) => parent === other.object)).toBe(true); // back on
    expect(spin.rotation.y).toBe(0); // straight again
  });

  it("hands the Bolones to the player: ↑ drives it on, ← turns it left, let go it stops", () => {
    const scene = new THREE.Scene();
    const bolones = car(0, 0, BOLONES, 1160, -10);
    const parked = car(30, -300, POLAKITO, 580, 0); // far off, never met
    scene.add(bolones.object, parked.object);
    const crash = createCrash(scene, [bolones, parked]);
    const drive = (/** @type {number} */ steer, /** @type {boolean} */ gas, seconds = 1) => {
      let speed = 0;
      for (let t = 0; t < seconds; t += 1 / 60) {
        crash.control(steer, gas);
        speed = crash.update(1 / 60);
      }
      return speed; // along the road, the camera's
    };
    expect(drive(0, true, 2)).toBeGreaterThan(15); // faster than it came
    drive(-1, true);
    const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(bolones.object.quaternion);
    expect(nose.x).toBeLessThan(-0.2); // turned to its left
    expect(bolones.object.position.x).toBeLessThan(-0.5);
    drive(0, false, 8);
    const at = bolones.object.position.clone();
    drive(0, false);
    expect(bolones.object.position.distanceTo(at)).toBeLessThan(0.05); // braked to a stop
  });

  it("takes in a car coming along later: its driver, who saw the wreck coming, brakes at once and calmly", () => {
    const { scene, crash } = headOn();
    run(crash, 3);
    const late = car(0, -100, POLAKITO, 580, 18.9);
    scene.add(late.object);
    crash.join(late);
    const from = late.object.position.z;
    run(crash, 8);
    const at = late.object.position.z;
    // hard it would stop after about 20, gently after about 50, reacting first after 65 or more
    expect(at - from).toBeGreaterThan(30);
    expect(at - from).toBeLessThan(60);
    expect(late.lamps.front).toBe(true); // short of the wreck
    run(crash, 0.5);
    expect(late.object.position.z).toBeCloseTo(at, 2); // stopped
  });

  it("runs a car coming along later into the wreck when its driver is slow to see it", () => {
    const ends = (/** @type {number} */ seen) => {
      const scene = new THREE.Scene();
      const bolones = car(0, 0, BOLONES, 1160, 0);
      const other = car(0, -8, POLAKITO, 580, 0); // the wreck, standing
      scene.add(bolones.object, other.object);
      const crash = create(scene, [bolones, other], undefined, () => 0.99);
      run(crash, 1);
      const late = { ...car(0, -60, POLAKITO, 580, 20), driving: { seen } };
      scene.add(late.object);
      crash.join(late);
      run(crash, 6);
      return crash.wrecks.includes(late);
    };
    expect(ends(0)).toBe(false); // sees it at once
    expect(ends(3)).toBe(true);
  });

  it("counts a car that only touched the wreck in it, not in its tally", () => {
    const scene = new THREE.Scene();
    const bolones = car(0, 0, BOLONES, 1160, 0);
    const other = car(0, -8, POLAKITO, 580, 0);
    const touching = car(0, -14, POLAKITO, 580, 1.8); // 1 m/s: a touch, no crash
    scene.add(bolones.object, other.object, touching.object);
    const crash = createCrash(scene, [bolones, other, touching]);
    run(crash, 2);
    expect(crash.wrecks).toContain(touching);
    expect(crash.tally.cars).toBe(2); // the two that crashed
  });

  it("has a slow driver run into the wreck a quick one stops short of", () => {
    const ends = (/** @type {import("../src/game/crash/drivers.js").Driving} */ driving) => {
      const scene = new THREE.Scene();
      const bolones = car(0, 0, BOLONES, 1160, 0);
      const other = car(0, -8, POLAKITO, 580, 0); // the wreck, standing
      const behind = { ...car(0, -60, POLAKITO, 580, 20), driving };
      scene.add(bolones.object, other.object, behind.object);
      const crash = create(scene, [bolones, other, behind], undefined, mulberry32(3));
      run(crash, 6);
      return crash.wrecks.includes(behind);
    };
    expect(ends({})).toBe(false);
    expect(ends(MINIGAME.modes.overtake.drivers)).toBe(true);
  });

  it("has no room for a car coming along right behind the jam, room far enough back", () => {
    const { scene, crash } = headOn();
    run(crash, 3);
    const coming = (/** @type {number} */ z) => {
      const late = car(0, z, POLAKITO, 580, 28);
      scene.add(late.object);
      return crash.room(late);
    };
    expect(coming(-40)).toBe(false); // it could not stop for the wreck
    expect(coming(-200)).toBe(true);
    // one who will not see the wreck in time: room just clear of it
    const blind = (/** @type {number} */ z) => {
      const late = { ...car(0, z, POLAKITO, 580, 28), driving: { seen: 3 } };
      scene.add(late.object);
      return crash.room(late);
    };
    expect(blind(-40)).toBe(true);
    expect(blind(-14)).toBe(false); // on top of the wreck
  });

  it("has a driver who sees the wreck from afar stop well short of it, braking calmly, straight on", () => {
    for (const seed of [1, 2, 3, 4]) {
      const scene = new THREE.Scene();
      const bolones = car(0, 0, BOLONES, 1160, 0);
      const other = car(0, -8, POLAKITO, 580, 0); // the wreck, standing
      const far = car(0, -200, POLAKITO, 580, 28);
      scene.add(bolones.object, other.object, far.object);
      const crash = create(scene, [bolones, other, far], undefined, mulberry32(seed));
      run(crash, 12);
      const { x, z } = far.object.position;
      expect(Math.abs(x)).toBeLessThan(0.05); // no swerve
      expect(z).toBeLessThan(-8 - 5.5 - 3); // short of the wreck, a few metres off
      expect(z).toBeGreaterThan(-80); // braking no harder than it takes
      expect(far.lamps.front).toBe(true);
      crash.dispose();
    }
  });

  it("stalls the Bolones' engine a while after the crash: ↑ still held, it stops", () => {
    const scene = new THREE.Scene();
    const bolones = car(0, 0, BOLONES, 1160, -10);
    const parked = car(30, -300, POLAKITO, 580, 0); // far off, never met
    scene.add(bolones.object, parked.object);
    const crash = createCrash(scene, [bolones, parked]);
    const { stall } = MINIGAME.crash.player;
    let speed = 0;
    for (let t = 0; t < stall - 1.5; t += 1 / 60) {
      crash.control(0, true);
      speed = crash.update(1 / 60);
    }
    expect(crash.engine).toBe(1);
    expect(speed).toBeGreaterThan(15); // driven on
    for (let t = 0; t < 10; t += 1 / 60) {
      crash.control(0, true);
      speed = crash.update(1 / 60);
    }
    expect(crash.engine).toBe(0);
    expect(speed).toBeLessThan(0.1);
  });

  it("stops the Bolones after a mere graze too: the drivers brake, the camera comes to rest", () => {
    const scene = new THREE.Scene();
    const bolones = car(0, 0, BOLONES, 1160, -20);
    bolones.velocity.x = -1; // steering into the car alongside, closing at half a metre a second
    const other = car(-2.7, 0, POLAKITO, 580, -18);
    scene.add(bolones.object, other.object);
    const crash = createCrash(scene, [bolones, other]);
    expect(run(crash, 8)).toBeCloseTo(0, 3);
    expect(crash.wrecks).toEqual([bolones, other]);
  });

  it("throws the Bolones back when the other car comes harder: the camera stops riding on", () => {
    const scene = new THREE.Scene();
    const bolones = car(0, 0, BOLONES, 1160, -14.4);
    const truck = car(0, -8, [3, 3, 8], 4000, 18.9);
    scene.add(bolones.object, truck.object);
    const crash = createCrash(scene, [bolones, truck]);
    expect(run(crash)).toBeLessThan(0.1); // it barely creeps, about to sleep
    expect(crash.centre(new THREE.Vector3(), 0).z).toBeGreaterThan(0.5); // back past the camera
  });

  it("glances off when only the corners meet: a corner never sinks into the other car's side", () => {
    for (const speed of [1, 1.75]) {
      // the Polakito's corner a quarter of a unit into the Bolones' front corner
      const { bolones, other, crash } = headOn(BOLONES[0] / 2 + POLAKITO[0] / 2 - 0.25, speed);
      const [w, l] = [BOLONES[0] / 2, BOLONES[2] / 2];
      let deepest = 0;
      for (let t = 0; t < 4; t += 1 / 60) {
        crash.update(1 / 60);
        const toBolones = bolones.object.matrixWorld.clone().invert();
        for (const [x, z] of [-1, 1].flatMap((sx) => [-1, 1].map((sz) => [sx, sz]))) {
          const corner = new THREE.Vector3((x * POLAKITO[0]) / 2, 1, (z * POLAKITO[2]) / 2)
            .applyMatrix4(other.object.matrixWorld)
            .applyMatrix4(toBolones);
          const inside = Math.min(w - Math.abs(corner.x), l - Math.abs(corner.z));
          deepest = Math.max(deepest, inside);
        }
      }
      expect(deepest, `speed ${speed}`).toBeLessThan(0.45);
    }
  });

  it("pushes a small car hit on its side away sideways: it leans, but stays on its wheels", () => {
    const scene = new THREE.Scene();
    const truck = car(0.3, -9, [2.9, 2.6, 7.6], 1010, 12);
    const small = car(0, 0, POLAKITO, 580, 0);
    small.object.rotation.y = THREE.MathUtils.degToRad(70); // its side to the truck, at an angle
    scene.add(truck.object, small.object);
    const crash = createCrash(scene, [truck, small]);
    let roll = 0;
    for (let t = 0; t < 4; t += 1 / 60) {
      crash.update(1 / 60);
      roll = Math.max(roll, leanOf(small.object));
    }
    expect(small.object.position.z).toBeGreaterThan(2); // pushed away
    expect(roll).toBeLessThan(30); // its tyres trip it, its springs lean it: not over
    expect(leanOf(small.object)).toBeLessThan(10); // back on its wheels (or a hub, one torn off)
  });

  it("does not throw a car hit on its side off: a crush gives back what it may, no more", () => {
    const scene = new THREE.Scene();
    const hitting = car(0, 0, BOLONES, CAR.mass, -27); // 15 m/s
    const hit = car(0, -14, POLAKITO, 580, 0);
    hit.object.rotation.y = THREE.MathUtils.degToRad(70); // its side to it, at an angle
    scene.add(hitting.object, hit.object);
    const crash = createCrash(scene, [hitting, hit]);
    const gap = () => hitting.object.position.z - hit.object.position.z;
    let [last, parting] = [gap(), 0];
    for (let t = 0; t < 2; t += 1 / 60) {
      crash.update(1 / 60);
      parting = Math.max(parting, (gap() - last) * 60);
      last = gap();
    }
    expect(parting / 27).toBeLessThan(0.5); // it flew off faster than it was hit, like a pinball
  });

  it("crushes fronts met a little askew as deep as straight: caught only once they stop", () => {
    /** How deep the first car's front dents in a head-on, the other car turned `degrees`. */
    const dent = (/** @type {number} */ degrees) => {
      const scene = new THREE.Scene();
      const hitting = car(0, 0, BOLONES, CAR.mass, -45); // 25 m/s
      const hit = car(0, -14, [3, 3.6, 7.5], 1400, 27); // a van, 15 m/s, coming
      hit.object.rotation.y = THREE.MathUtils.degToRad(degrees);
      scene.add(hitting.object, hit.object);
      const crash = createCrash(scene, [hitting, hit]);
      const shell = /** @type {THREE.Mesh} */ (hitting.object.children[0]);
      const before = shell.geometry.getAttribute("position").clone();
      for (let t = 0; t < 1; t += 1 / 60) crash.update(1 / 60);
      const after = shell.geometry.getAttribute("position");
      let most = 0;
      for (let i = 0; i < before.count; i++) {
        const moved = new THREE.Vector3().fromBufferAttribute(after, i);
        most = Math.max(most, moved.distanceTo(new THREE.Vector3().fromBufferAttribute(before, i)));
      }
      return most;
    };
    const straight = dent(0);
    expect(straight).toBeGreaterThan(0.5);
    for (const degrees of [2, 5, 10]) {
      expect(dent(degrees), `${degrees}°`).toBeGreaterThan(0.7 * straight); // not caught at once
    }
  });

  it("dents cars meeting at 5 km/h a little already, not at a touch", () => {
    /** How far the Bolones going `kmh` crushes a Polakito standing in its way. @param {number} kmh */
    const crushOf = (kmh) => {
      const scene = new THREE.Scene();
      const bolones = car(0, 0, BOLONES, 1160, -(kmh / 3.6) * TRAFFIC.scale);
      const other = car(0, -7.2, POLAKITO, 580, 0);
      scene.add(bolones.object, other.object);
      run(createCrash(scene, [bolones, other]), 1);
      return POLAKITO[2] - sizeOf(other.object).z;
    };
    expect(crushOf(3)).toBe(0); // a touch
    expect(crushOf(5)).toBeGreaterThan(0.02 * TRAFFIC.scale); // 2 cm and more
    expect(crushOf(10)).toBeGreaterThan(1.5 * crushOf(5));
  });

  it("throws a bumper torn off out of the other car at once: never caught in its body", () => {
    // the Bolones at 90 km/h into a Kredens standing: the Kredens' front bumper comes off
    const scene = new THREE.Scene();
    const models = { bolones: load("bolones"), wheel: load("wheel") };
    const bolones = createCar({ scene, models, materials: testMaterials() });
    bolones.group.updateMatrixWorld(true);
    const kredens = /** @type {THREE.Object3D} */ (
      createTrafficModels(testMaterials()).find((model) => model.userData.label === "Kredens")
    ).clone();
    kredens.position.set(0, TRAFFIC.y, -10);
    scene.add(kredens);
    kredens.updateMatrixWorld(true);
    const { min, max } = kredens.userData.hitbox;
    const hitbox = new THREE.Box3(
      new THREE.Vector3().fromArray(min),
      new THREE.Vector3().fromArray(max),
    );
    const [color, still] = [new THREE.Color(), new THREE.Vector3()];
    const velocity = new THREE.Vector3(0, 0, -25 * TRAFFIC.scale);
    const crash = createCrash(scene, [
      {
        object: bolones.wreck,
        box: bolones.box,
        mass: CAR.mass,
        velocity,
        color,
        label: "Bolones",
      },
      {
        object: kredens,
        box: hitbox,
        mass: kredens.userData.mass,
        velocity: still,
        color,
        label: "Kredens",
      },
    ]);
    let caught = 0; // frames a bumper torn off is in the Bolones' box
    for (let t = 0; t < 2; t += 1 / 60) {
      crash.update(1 / 60);
      const back = bolones.wreck.matrixWorld.clone().invert();
      for (const node of scene.children) {
        if (node.userData.part !== "bumper") continue;
        const middle = new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3());
        if (bolones.box.containsPoint(middle.applyMatrix4(back))) caught++;
      }
    }
    expect(crash.tally.parts).toBeGreaterThan(0);
    expect(caught).toBeLessThan(10); // a frame or a few, not riding in it
  });

  it("does not bounce a car off at a touch: it parts no faster than it came", () => {
    const scene = new THREE.Scene();
    const hit = car(0, 0, BOLONES, CAR.mass, 0);
    const touching = car(0, -(BOLONES[2] + POLAKITO[2]) / 2 - 0.3, POLAKITO, 580, 1.8); // 1 m/s
    scene.add(hit.object, touching.object);
    const crash = createCrash(scene, [hit, touching]);
    const gap = () => hit.object.position.z - touching.object.position.z;
    let [last, parting] = [gap(), 0];
    for (let t = 0; t < 1; t += 1 / 240) {
      crash.update(1 / 240);
      parting = Math.max(parting, (gap() - last) * 240);
      last = gap();
    }
    expect(parting).toBeLessThan(0.36 * 1.8); // e of 1 m/s (MINIGAME.crash.restitution)
  });

  it("tips a car sliding sideways towards where it slides: a small one, fast, rolls over", () => {
    /**
     * A car sliding sideways (+x) on its own: the most it leans, which way, how it ends up.
     *
     * @param {number[]} size @param {number} mass @param {number} speed units/s
     */
    const slide = (size, mass, speed) => {
      const scene = new THREE.Scene();
      const sliding = car(0, 0, size, mass, 0);
      sliding.velocity.set(speed, 0, 0);
      const far = car(0, -400, BOLONES, CAR.mass, 0); // a crash takes two: this one stays out of it
      scene.add(sliding.object, far.object);
      const crash = createCrash(scene, [sliding, far]);
      const most = { lean: 0, towards: 0 };
      for (let t = 0; t < 4; t += 1 / 60) {
        crash.update(1 / 60);
        const lean = leanOf(sliding.object);
        if (lean <= most.lean) continue;
        most.lean = lean;
        most.towards = new THREE.Vector3(0, 1, 0).applyQuaternion(sliding.object.quaternion).x;
      }
      return { ...most, end: leanOf(sliding.object) };
    };
    const slow = slide(POLAKITO, 580, 9);
    expect(slow.towards).toBeGreaterThan(0); // its tyres grip at the road, below its weight
    expect(slow.lean).toBeLessThan(45);
    expect(slow.end).toBeLessThan(5); // back on its wheels
    expect(slide(POLAKITO, 580, 36).end).toBeGreaterThan(80); // on its side or its roof
    expect(slide(BOLONES, CAR.mass, 36).lean).toBeLessThan(30); // low and wide, it only leans
  });
  it("pulls a car hit on its side towards it: a wheel there is broken", () => {
    const { drivers } = MINIGAME.crash;
    const saved = { ...drivers };
    /** The hit car's course after a hit on its left, its broken wheel toed `broken` degrees. */
    const course = (/** @type {number} */ broken) => {
      Object.assign(drivers, { share: 0, broken: [broken, broken] }); // nobody steers
      const scene = new THREE.Scene();
      const hit = car(0, 0, POLAKITO, 580, 12);
      const striker = car(-4.5, 1.5, POLAKITO, 580, 4);
      striker.velocity.x = 10; // from its left, at an angle
      striker.object.rotation.y = Math.PI / 2 - 0.3;
      scene.add(hit.object, striker.object);
      const crash = createCrash(scene, [hit, striker]);
      let way = 0;
      for (let t = 0; t < 2; t += 1 / 60) {
        const before = hit.object.position.clone();
        crash.update(1 / 60);
        const { x, z } = hit.object.position.clone().sub(before);
        way = Math.atan2(x, z); // + to its right (+x), - to its left
      }
      return THREE.MathUtils.radToDeg(way);
    };
    const [whole, broken] = [course(0), course(6)];
    Object.assign(drivers, saved);
    expect(broken).toBeLessThan(whole - 1.5); // further to its left, the side it was hit on
  });
  it("comes to rest on its wheels", () => {
    const { bolones, other, crash } = headOn(-1.5);
    run(crash, 6);
    const pose = () =>
      [bolones, other].map(({ object }) => [...object.position.toArray(), object.quaternion.x]);
    const before = pose();
    run(crash, 0.5);
    pose().forEach((values, i) => values.forEach((v, k) => expect(v).toBeCloseTo(before[i][k], 3)));
    for (const { object } of [bolones, other]) {
      expect(new THREE.Vector3(0, 1, 0).applyQuaternion(object.quaternion).y).toBeGreaterThan(0.95);
    }
  });

  it("runs a car into a palm, not through it: the car takes the dent, the palm leans", () => {
    const scene = new THREE.Scene();
    const bolones = car(0, 0, BOLONES, 1160, 0);
    const sliding = car(-8, 20, POLAKITO, 580, 0);
    sliding.velocity.set(-20, 0, 0); // sideways, off the road
    const palm = new THREE.Object3D();
    const post = {
      object: palm,
      at: new THREE.Vector3(-14, 0, 20),
      radius: 0.5,
      sways: true,
      color: new THREE.Color(),
    };
    scene.add(bolones.object, sliding.object, palm);
    const mesh = /** @type {THREE.Mesh} */ (sliding.object.children[0]);
    const geometry = mesh.geometry;
    const crash = createCrash(scene, [bolones, sliding], () => [post]);
    run(crash);
    // stopped at the trunk, its side crushed round it, on its wheels: not through, not thrown off
    expect(sliding.object.position.x).toBeGreaterThan(-14);
    expect(sliding.object.position.x).toBeLessThan(-11);
    expect(sliding.object.position.y).toBeLessThan(0.5);
    expect(mesh.geometry).not.toBe(geometry);
    const lean = palm.quaternion.angleTo(new THREE.Quaternion());
    expect(lean).toBeGreaterThan(0.02);
    expect(new THREE.Vector3(0, 1, 0).applyQuaternion(palm.quaternion).x).toBeLessThan(0); // away
    expect(crash.tally.posts).toBe(1);
    // about the foot of its trunk: that stays where it stands, on the road
    const foot = new THREE.Vector3(-14, 0, 20); // in the palm's frame (it stands at the origin)
    palm.updateMatrixWorld();
    expect(palm.localToWorld(foot.clone()).distanceTo(post.at)).toBeLessThan(1e-6);
    // the crash over, it stands leaning as it settled, about its foot
    crash.dispose();
    expect(palm.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(lean, 2);
    palm.updateMatrixWorld();
    expect(palm.localToWorld(foot.clone()).distanceTo(post.at)).toBeLessThan(1e-6);
  });

  it("stops a car sliding off the road at a rock, low as it is: the rock stands, unbroken", () => {
    const scene = new THREE.Scene();
    const bolones = car(0, 0, BOLONES, 1160, 0);
    const sliding = car(-8, 20, POLAKITO, 580, 0);
    sliding.velocity.set(-20, 0, 0); // sideways, off the road
    const red = new THREE.Color(1, 0, 0);
    sliding.color = red;
    const rock = new THREE.Object3D();
    const post = { object: rock, at: new THREE.Vector3(-14, 0, 20), radius: 1, height: 0.8 };
    scene.add(bolones.object, sliding.object, rock);
    const crash = createCrash(scene, [bolones, sliding], () => [post]);
    run(crash, 1);
    expect(sliding.object.position.x).toBeGreaterThan(-13); // stopped at it, not over or through
    expect(rock.quaternion.angleTo(new THREE.Quaternion())).toBe(0); // a rock does not lean
    // shards of the car and sparks only, either fading: the rock sheds none
    const debris = /** @type {THREE.Mesh} */ (
      scene.children.find((child) => child instanceof THREE.Mesh)
    );
    const colors = debris.geometry.getAttribute("color");
    const spark = new THREE.Color(PALETTE.headlight);
    const of = new THREE.Color();
    /** Whether a colour is this one, dimmed. @param {THREE.Color} like */
    const dimmed = (like) => {
      const k = Math.max(of.r, of.g, of.b) / Math.max(like.r, like.g, like.b);
      return of.clone().sub(like.clone().multiplyScalar(k)).getHex() === 0;
    };
    let shards = 0;
    for (let i = 0; i < colors.count; i++) {
      of.fromBufferAttribute(colors, i);
      if (of.equals(red)) shards++;
      else expect(dimmed(red) || dimmed(spark)).toBe(true);
    }
    expect(shards).toBeGreaterThan(0);
  });

  it("runs a car sliding off the road into a long rock where the rock is, along its way or across", () => {
    /**
     * Where the sliding car meets a rock 4 long, 1 wide, lying along its way or across it.
     *
     * @param {boolean} along
     */
    const meets = (along) => {
      const scene = new THREE.Scene();
      const bolones = car(0, 0, BOLONES, 1160, 0);
      const sliding = car(-8, 20, POLAKITO, 580, 0);
      sliding.velocity.set(-20, 0, 0); // sideways, off the road
      let x = 0;
      sliding.onCrash = () => (x ||= sliding.object.position.x);
      const rock = new THREE.Object3D();
      const [hx, hz] = along ? [2, 0.5] : [0.5, 2];
      const outline = [
        [-hx, -hz],
        [hx, -hz],
        [hx, hz],
        [-hx, hz],
      ].map(([px, pz]) => new THREE.Vector2(px, pz));
      const at = new THREE.Vector3(-14, 0, 20);
      const post = { object: rock, at, radius: Math.hypot(hx, hz), outline, height: 0.8 };
      scene.add(bolones.object, sliding.object, rock);
      const crash = createCrash(scene, [bolones, sliding], () => [post]);
      run(crash, 1);
      crash.dispose();
      return x;
    };
    // its side (1.25 from its middle) at the rock's end (-12) or flank (-13.5), a frame's way on
    // at most
    expect(meets(true)).toBeCloseTo(-12 + 1.25, 0);
    expect(meets(false)).toBeCloseTo(-13.5 + 1.25, 0);
  });

  it("stands up the palms that come along as the camera goes on, where they are", () => {
    const scene = new THREE.Scene();
    // the Bolones going on, the camera riding along; the other car sliding off the road, sideways
    const bolones = car(0, 0, BOLONES, 1160, -20);
    const sliding = car(-8, -10, POLAKITO, 580, 0);
    sliding.velocity.x = -12;
    const palm = new THREE.Object3D();
    /** @type {import("../src/game/crash.js").Post[]} */
    const palms = [];
    scene.add(bolones.object, sliding.object, palm);
    const crash = createCrash(scene, [bolones, sliding], () => palms);
    run(crash, 0.3); // the camera 6 units along
    // a palm comes along, in the scene right by the sliding car's side, in its way
    const { x, z } = sliding.object.position;
    const at = new THREE.Vector3(x - POLAKITO[0] / 2 - 1, 0, z);
    palms.push({ object: palm, at, radius: 0.4, sways: true, color: new THREE.Color() });
    run(crash, 2);
    expect(sliding.object.position.x).toBeGreaterThan(at.x); // stopped at it, not through it
    expect(palm.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.01); // and hit it
  });

  it("sheds the debris where the cars meet, however far the camera has gone along", () => {
    const scene = new THREE.Scene();
    // a heavy car pushing a light one into a third far ahead, the camera riding along with it
    const truck = car(0, 0, [3, 3, 8], 4000, -30);
    const pushed = car(0, -6.9, POLAKITO, 580, 0);
    const parked = car(0, -30, POLAKITO, 580, 0);
    const cars = [truck, pushed, parked];
    scene.add(...cars.map(({ object }) => object));
    const crash = createCrash(scene, cars);
    const debris = /** @type {THREE.Mesh} */ (scene.children.at(-1));
    // the points drawn (the buffers hold more, room for the bursts to come)
    const count = () =>
      debris.geometry.getAttribute("position") ? debris.geometry.drawRange.count : 0;
    let before = -1; // the shards there were when the third car was hit
    const { onCrash } = parked;
    parked.onCrash = (crushed) => {
      onCrash(crushed);
      before = count();
    };
    for (let t = 0; t < 4 && before < 0; t += 1 / 60) crash.update(1 / 60);
    expect(before).toBeGreaterThanOrEqual(0); // the third car was hit
    crash.update(1 / 60); // the frame that shows the new shards

    const position = debris.geometry.getAttribute("position");
    debris.updateWorldMatrix(true, false);
    const p = new THREE.Vector3();
    expect(count()).toBeGreaterThan(before);
    for (let i = before; i < count(); i++) {
      const { z } = p.fromBufferAttribute(position, i).applyMatrix4(debris.matrixWorld);
      expect(Math.abs(z - parked.object.position.z)).toBeLessThan(5); // where it was hit
    }
  });

  it("puts every wheel back as it was after a pile-up, however its dents came in turn", () => {
    for (const offset of [-1.5, -0.5, 0.5, 1.5]) {
      // the Bolones hit head on, cars behind running into the wreck: dents on dents
      const others = [car(offset, -16, POLAKITO, 580, 22), car(-offset, -26, BOLONES, 1160, 26)];
      const { scene, crash } = headOn(offset, 2, others);
      /** @type {Map<THREE.Object3D, THREE.Matrix4>} */
      const mounts = new Map();
      for (const object of scene.children) {
        for (const { mount } of wheelsOf(object)) mounts.set(mount, mount.matrix.clone());
      }
      run(crash, 3);
      crash.dispose();
      for (const [mount, matrix] of mounts) {
        mount.updateMatrix();
        const off = mount.matrix.elements.reduce(
          (most, v, i) => Math.max(most, Math.abs(v - matrix.elements[i])),
          0,
        );
        expect(off, `${offset}`).toBeLessThan(1e-9);
      }
    }
  });

  it("leaves its debris on the road until it goes, and takes the dents out", () => {
    const { scene, bolones, crash } = headOn();
    const mesh = /** @type {THREE.Mesh} */ (bolones.object.children[0]);
    const geometry = mesh.geometry;
    run(crash, 1);
    expect(mesh.geometry).not.toBe(geometry);
    expect(scene.children).toHaveLength(3); // the two cars and the debris
    crash.dispose();
    expect(scene.children).toHaveLength(2);
    expect(mesh.geometry).toBe(geometry);
  });
});

describe("where two cars meet", () => {
  /** A car's box, level, its front along `ahead` (x, z). @param {number[]} centre @param {number[]} ahead */
  const carBox = ([x, z], [fx, fz]) => {
    const front = new THREE.Vector3(fx, 0, fz).normalize();
    return {
      centre: new THREE.Vector3(x, 0, z),
      axes: [new THREE.Vector3(front.z, 0, -front.x), new THREE.Vector3(0, 1, 0), front],
      half: [1.45, 0.75, 3.8],
    };
  };

  it("is as wide as a front driven straight into a side", () => {
    const side = carBox([0, 0], [0, 1]);
    const front = carBox([1.35 + 3.8, 0.5], [-1, 0]); // its front 10 cm into the side
    const met = /** @type {{ middle: number, half: number }} */ (
      meeting(front, side, new THREE.Vector3(-1, 0, 0), 0.5)
    );
    expect(met.half).toBeCloseTo(1.45, 5);
    expect(-met.middle).toBeCloseTo(0.5, 5); // across is (-normal.z, normal.x): -z here
  });

  it("is short where a corner goes into a side at an angle, not the side's whole length", () => {
    const side = carBox([0, 0], [0, 1]);
    const front = [-1, 1].map((v) => v / Math.SQRT2);
    // 45° off: its front's middle 10 cm into the side, at z 0
    const corner = carBox([1.35 - front[0] * 3.8, -front[1] * 3.8], front);
    const normal = new THREE.Vector3(-1, 0, 0);
    const met = /** @type {{ middle: number, half: number }} */ (
      meeting(corner, side, normal, 0.5)
    );
    const across = new THREE.Vector3(0, 0, 1);
    expect(met.half).toBeLessThan(0.75 * (penetration(corner, side, across) / 2));
    expect(met.half).toBeLessThan(2);
  });

  it("sees a car on its side from above as all of it: its roof stands out to the side", () => {
    const side = carBox([0, 0], [0, 1]);
    // rolled onto its side next to the other car, its roof 10 cm into the other's side
    const rolled = carBox([1.35 + 0.75, 0], [0, 1]);
    rolled.axes = [
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 0, 1),
    ];
    const met = meeting(rolled, side, new THREE.Vector3(-1, 0, 0), 0);
    expect(met).not.toBeNull();
    expect(met?.half).toBeCloseTo(3.8, 5); // along the length of both
    expect(met?.middle).toBeCloseTo(0, 5);
  });
});

describe("a car's ends", () => {
  it("stand as high as its model: a car's bonnet and boot low, a van's flat end all of it", () => {
    for (const model of createTrafficModels(testMaterials())) {
      const car = model.clone();
      car.position.y = TRAFFIC.y;
      car.updateMatrixWorld(true);
      const { hitbox, label } = model.userData;
      const height = hitbox.max[1] + TRAFFIC.y;
      const { ends, step } = facesOf(car, -TRAFFIC.y);
      const at = (/** @type {Float32Array} */ end, /** @type {number} */ metres) =>
        end[Math.min(end.length - 1, Math.floor((metres * TRAFFIC.scale) / step))] / height;
      const fronts = ends.map((end) => at(end, 0.2)); // 20 cm in
      if (label === "Ramses") expect(Math.max(...fronts), label).toBeGreaterThan(0.9);
      else expect(Math.max(...fronts), label).toBeLessThan(0.7);
      for (const end of ends) expect(at(end, 2), label).toBeGreaterThan(0.9); // the roof, by then
      expect(facesOf(model.clone(), -TRAFFIC.y), label).toBe(facesOf(car, -TRAFFIC.y)); // once
    }
  });
});

describe("a car rolled over", () => {
  it("crushes its roof where it comes down on it, and lies on it as crushed", () => {
    const scene = new THREE.Scene();
    const sliding = car(0, 0, POLAKITO, 580, 0);
    sliding.velocity.set(36, 0, 0); // 20 m/s sideways: it rolls over (above)
    const far = car(0, -400, BOLONES, CAR.mass, 0);
    scene.add(sliding.object, far.object);
    const crash = createCrash(scene, [sliding, far]);
    const shell = /** @type {THREE.Mesh} */ (sliding.object.children[0]);
    const before = shell.geometry.getAttribute("position").clone();
    for (let t = 0; t < 4; t += 1 / 60) crash.update(1 / 60);
    expect(leanOf(sliding.object)).toBeGreaterThan(135); // on its roof
    const after = shell.geometry.getAttribute("position");
    let dent = 0;
    for (let i = 0; i < before.count; i++) {
      if (before.getY(i) < POLAKITO[1] - 0.1) continue; // the roof
      const moved = new THREE.Vector3().fromBufferAttribute(after, i);
      dent = Math.max(dent, moved.distanceTo(new THREE.Vector3().fromBufferAttribute(before, i)));
    }
    expect(dent).toBeGreaterThan(0.05);
    expect(dent).toBeLessThan(0.5); // dented, not flattened
    sliding.object.updateWorldMatrix(true, true);
    const lowest = new THREE.Box3().setFromObject(shell, true).min.y;
    expect(Math.abs(lowest)).toBeLessThan(0.05); // on the road: not in it, not above it
  });

  it("rolling over into another meets it up to its roof: it stops at it, mostly not in it", () => {
    // rolled right over the other, crushed deep in the first hit, it may still sink in a way
    /** @type {number[]} how deep they went into each other at most, at each gap */
    const depths = [];
    for (const gap of [27, 29, 31, 33, 35]) {
      const scene = new THREE.Scene();
      const rolling = car(0, 0, POLAKITO, 580, 0);
      rolling.velocity.set(36, 0, 0); // 20 m/s sideways: it rolls over (above), into the other
      const parked = car(gap, 0, POLAKITO, 900, 0);
      scene.add(rolling.object, parked.object);
      const crash = createCrash(scene, [rolling, parked]);
      let deepest = 0;
      for (let t = 0; t < 4; t += 1 / 60) {
        crash.update(1 / 60);
        deepest = Math.max(deepest, depthIn(rolling, parked), depthIn(parked, rolling));
      }
      depths.push(deepest);
    }
    // a crush deep, not a roof through (as deep as they are high, up to 1, every time before)
    expect(depths.filter((depth) => depth < 0.6).length, `${depths}`).toBeGreaterThanOrEqual(3);
  });

  it("lands on its roof: the body above its box, from it up to the top, not its mirrors", () => {
    const models = createTrafficModels(testMaterials());
    for (const model of models) {
      model.updateMatrixWorld(true);
      const { hitbox } = model.userData;
      const from = hitbox.min[1] + 0.7 * (hitbox.max[1] - hitbox.min[1]);
      const hull = roofOf(model, from);
      const roof = new THREE.Box3().setFromPoints(hull.corners);
      const label = model.userData.label;
      expect(roof.max.y, label).toBeCloseTo(hitbox.max[1], 5);
      expect(roof.min.y, label).toBeCloseTo(from, 5); // down to the box: it has a floor
      // as wide as the body there at most: not out to the mirrors
      expect(roof.max.x, label).toBeLessThanOrEqual(hitbox.max[0] + 1e-6);
      expect(roofOf(model.clone(), from), label).toBe(hull); // once per model
    }
  });
});

describe("the Bolones in the player's hands", () => {
  /**
   * The Bolones as the game builds it, going `kmh` when the crash ends, steered as `steer` says
   * for `seconds`: how far it leant at most and in the end, and how high its body came off the road
   * at most; and the car.
   *
   * @param {number} kmh
   * @param {boolean} gas
   * @param {(t: number) => number} steer -1 (left) to 1 (right), at game seconds since the crash
   */
  const drive = (kmh, gas, steer, seconds = 6) => {
    const scene = new THREE.Scene();
    const models = { bolones: load("bolones"), wheel: load("wheel") };
    const bolones = createCar({ scene, models, materials: testMaterials() });
    bolones.group.updateMatrixWorld(true);
    const parked = car(30, -300, POLAKITO, 580, 0); // far off, never met
    scene.add(parked.object);
    const velocity = new THREE.Vector3(0, 0, -(kmh / 3.6) * TRAFFIC.scale);
    const { wreck: object, box } = bolones;
    const crash = createCrash(scene, [
      { ...parked, object, box, mass: CAR.mass, velocity },
      parked,
    ]);
    let [most, high] = [0, 0];
    for (let t = 0; t < seconds; t += 1 / 60) {
      crash.control(steer(t), gas);
      crash.update(1 / 60);
      most = Math.max(most, leanOf(object));
      high = Math.max(high, lowestOf(object));
    }
    return { most, end: leanOf(object), high, object };
  };

  it("rolls over in a full turn held fast, ↑ held or not; slower, low and wide, it only leans", () => {
    const left = () => -1;
    expect(drive(100, false, left).most).toBeGreaterThan(90); // over its side, onto its roof or on
    const slow = drive(45, true, left);
    expect(slow.most).toBeLessThan(10); // low and wide, it only leans
    expect(slow.end).toBeLessThan(5);
    // fast, left, right, let go: it leans hard one way and the other, and back on its wheels
    const flick = drive(90, false, (t) => (t < 0.5 ? -1 : t < 1 ? 1 : 0));
    expect(flick.most).toBeGreaterThan(15);
    expect(flick.end).toBeLessThan(5);
  });

  it("lies over on its side leaning onto its roof, on its body: the mirror it went over on comes off", () => {
    // full left at 80 km/h a second or so: over onto its side
    const { end, object } = drive(80, false, (t) => (t < 1.1 ? -1 : 0), 8);
    expect(end).toBeGreaterThan(95); // past its side, onto its roof
    expect(end).toBeLessThan(135);
    /** @type {THREE.Object3D[]} */
    const mirrors = [];
    object.traverse((node) => node.userData.part === "mirror" && mirrors.push(node));
    expect(mirrors.length).toBeLessThan(2); // torn off where it touched the road
  });

  it("tumbles over its roof, rolled over fast, never thrown up high off the road", () => {
    // full left at 100 and 120 km/h a second: over its side onto its roof, on and on
    for (const kmh of [100, 120]) {
      const { most, high } = drive(kmh, false, (t) => (t < 1 ? -1 : 0), 4);
      expect(high, `${kmh} km/h`).toBeLessThan(1); // units: its body off the road, half a metre
      expect(most, `${kmh} km/h`).toBeGreaterThan(150);
    }
  });
});
