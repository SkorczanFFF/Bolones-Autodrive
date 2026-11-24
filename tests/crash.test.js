import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { CAR, MINIGAME, TRAFFIC } from "../src/config.js";
import { mulberry32 } from "../src/core/noise.js";
import { createCrash as create, ready } from "../src/game/crash.js";
import { mountWheel } from "../src/scene/rig.js";
import { createTrafficModels } from "../src/scene/traffic.js";
import { testMaterials } from "./helpers.js";

/**
 * A crash whose drivers do the same every run.
 *
 * @param {Parameters<typeof create>} args
 */
const createCrash = (...[scene, cars, palms]) => create(scene, cars, palms, mulberry32(1));

/** How high a test car's body is off the road, on its wheels. */
const CLEARANCE = 0.4;

/**
 * A car standing on the road at (x, z), [width, height, length], driving with vz along the road:
 * a box mesh to dent, raised off the road on four wheels on their rig (scene/rig.js), the front
 * ones steering, and a lamp at each end, put out where a crash crushes it.
 *
 * @param {number} x
 * @param {number} z
 * @param {number[]} size
 * @param {number} mass
 * @param {number} vz
 */
function car(x, z, [width, height, length], mass, vz) {
  const body = new THREE.BoxGeometry(width, height - CLEARANCE, length, 4, 2, 8).toNonIndexed();
  body.translate(0, (height + CLEARANCE) / 2, 0);
  const object = new THREE.Group().add(new THREE.Mesh(body));
  object.position.set(x, CAR.lift, z);
  const ahead = Math.sign(vz) || 1;
  for (const [side, end] of [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ]) {
    const tyre = new THREE.CylinderGeometry(0.5, 0.5, 0.3, 12).rotateZ(Math.PI / 2);
    const at = new THREE.Vector3(
      side * (width / 2 - 0.15),
      0.5 - CAR.lift,
      end * (length / 2 - 1.1),
    );
    object.add(mountWheel(new THREE.Mesh(tyre.toNonIndexed()), at, 0.5, end === ahead));
  }
  const lamps = { front: true, rear: true };
  /** @param {(point: THREE.Vector3) => boolean} crushed */
  const onCrash = (crushed) => {
    object.updateWorldMatrix(true, false);
    for (const [end, sign] of /** @type {const} */ ([
      ["front", 1],
      ["rear", -1],
    ])) {
      const at = new THREE.Vector3(0, height / 2, (sign * ahead * length) / 2 - sign * ahead * 0.1);
      if (crushed(object.localToWorld(at))) lamps[end] = false;
    }
  };
  const box = new THREE.Box3(
    new THREE.Vector3(-width / 2, 0, -length / 2),
    new THREE.Vector3(width / 2, height, length / 2),
  );
  const velocity = new THREE.Vector3(0, 0, vz);
  return { object, box, mass, velocity, color: new THREE.Color(), lamps, onCrash, label: "car" };
}

const BOLONES = /** @type {number[]} */ ([3, 2.6, 7.8]);
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

/** Runs the crash for a while: the camera's speed then. @param {ReturnType<typeof createCrash>} crash */
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

/** A car's mesh's size now (dents shorten it). @param {THREE.Object3D} object */
function sizeOf(object) {
  const { geometry } = /** @type {THREE.Mesh} */ (object.children[0]);
  geometry.computeBoundingBox();
  return /** @type {THREE.Box3} */ (geometry.boundingBox).getSize(new THREE.Vector3());
}

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
  it("tears a front wheel off in a hard crash: it rolls away to a stop, the car sits down on that corner", () => {
    const scene = new THREE.Scene();
    const bolones = car(0, 0, BOLONES, 1160, -14.4 * 1.75);
    const other = car(0, -6.4, POLAKITO, 580, 18.9 * 1.75);
    scene.add(bolones.object, other.object);
    const crash = createCrash(scene, [bolones, other]);
    const wheels = other.object.children.filter(({ userData }) => userData.part);
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
    const [wheel] = torn;
    expect(wheel.position.distanceTo(other.object.position)).toBeGreaterThan(3); // away
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(other.object.quaternion);
    expect(THREE.MathUtils.radToDeg(up.angleTo(new THREE.Vector3(0, 1, 0)))).toBeGreaterThan(4);
    // it rolls to a stop, buckled
    run(crash, 5);
    const at = wheel.position.clone();
    run(crash, 1);
    expect(wheel.position.distanceTo(at)).toBeLessThan(0.05);
    crash.dispose();
    expect(wheels.every(({ parent }) => parent === other.object)).toBe(true); // back on
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
    const truck = car(0.3, -9, [2.9, 2.6, 7.6], 1010, 36);
    const small = car(0, 0, POLAKITO, 580, 0);
    small.object.rotation.y = THREE.MathUtils.degToRad(70); // its side to the truck, at an angle
    scene.add(truck.object, small.object);
    const crash = createCrash(scene, [truck, small]);
    let roll = 0;
    /** How far the small car leans, degrees. */
    const lean = () => {
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(small.object.quaternion);
      return THREE.MathUtils.radToDeg(up.angleTo(new THREE.Vector3(0, 1, 0)));
    };
    for (let t = 0; t < 4; t += 1 / 60) {
      crash.update(1 / 60);
      roll = Math.max(roll, lean());
    }
    expect(small.object.position.z).toBeGreaterThan(2); // pushed away
    expect(roll).toBeLessThan(30); // its tyres trip it, its springs lean it: not over
    expect(lean()).toBeLessThan(10); // back on its wheels (or a hub, a wheel torn off)
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
    crash.dispose();
    expect(palm.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
  });

  it("stops a car sliding off the road at a rock, low as it is: the rock does not move", () => {
    const scene = new THREE.Scene();
    const bolones = car(0, 0, BOLONES, 1160, 0);
    const sliding = car(-8, 20, POLAKITO, 580, 0);
    sliding.velocity.set(-20, 0, 0); // sideways, off the road
    const rock = new THREE.Object3D();
    const post = { object: rock, at: new THREE.Vector3(-14, 0, 20), radius: 1, height: 0.8 };
    scene.add(bolones.object, sliding.object, rock);
    const crash = createCrash(scene, [bolones, sliding], () => [
      { ...post, color: new THREE.Color() },
    ]);
    run(crash);
    expect(sliding.object.position.x).toBeGreaterThan(-13); // stopped at it, not over or through
    expect(rock.quaternion.angleTo(new THREE.Quaternion())).toBe(0); // a rock does not lean
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
    const count = () => debris.geometry.getAttribute("position")?.count ?? 0;
    let before = -1; // the shards there were when the third car was hit
    const { onCrash } = parked;
    parked.onCrash = (crushed) => {
      onCrash(crushed);
      before = count();
    };
    for (let t = 0; t < 4 && before < 0; t += 1 / 60) crash.update(1 / 60);
    crash.update(1 / 60); // the frame that shows the new shards

    const position = debris.geometry.getAttribute("position");
    debris.updateWorldMatrix(true, false);
    const p = new THREE.Vector3();
    expect(position.count).toBeGreaterThan(before);
    for (let i = before; i < position.count; i++) {
      const { z } = p.fromBufferAttribute(position, i).applyMatrix4(debris.matrixWorld);
      expect(Math.abs(z - parked.object.position.z)).toBeLessThan(5); // where it was hit
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
