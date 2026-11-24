import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { CAR, MINIGAME, SPEED, WORLD } from "../src/config.js";
import { ready } from "../src/game/crash.js";
import { MOVING, createLanePicker, createMinigame } from "../src/game/minigame.js";
import { createTrafficModels, widestReach } from "../src/scene/traffic.js";
import { testCar, testMaterials } from "./helpers.js";

/** Deterministic pseudo-random sequence. @param {number} seed */
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

describe("lane picker", () => {
  const halfWidth = widestReach(createTrafficModels(testMaterials()));
  const reach = CAR.steer.maxOffset;

  it("keeps traffic inside the steering range and outside the centre safe zone", () => {
    const next = createLanePicker(halfWidth, rng(1));
    for (let i = 0; i < 500; i++) {
      const x = next();
      expect(Math.abs(x)).toBeLessThanOrEqual(reach - MINIGAME.outerMargin);
      expect(Math.abs(x)).toBeGreaterThanOrEqual(MINIGAME.safeZone + halfWidth + MINIGAME.innerGap);
    }
  });

  it("starts on the left and switches lanes after batches of 1-3 cars", () => {
    const next = createLanePicker(halfWidth, rng(7));
    const sides = Array.from({ length: 300 }, () => Math.sign(next()));
    expect(sides[0]).toBe(-1);

    let run = 1;
    for (let i = 1; i < sides.length; i++) {
      if (sides[i] === sides[i - 1]) run++;
      else {
        expect(run).toBeGreaterThanOrEqual(MINIGAME.batch[0]);
        expect(run).toBeLessThanOrEqual(MINIGAME.batch[1]);
        run = 1;
      }
    }
  });
});

describe("crash", () => {
  beforeAll(() => ready); // Rapier

  it("keeps the traffic coming a while after a crash, into the crash, then no more", () => {
    const scene = new THREE.Scene();
    const bolones = testCar(0, 0, [3, 2.6, 7.8], CAR.mass, 0);
    scene.add(bolones.object);
    const group = new THREE.Group();
    // the Bolones as wide as the road: the first car to come hits it
    const wide = new THREE.Vector3(40, 2, 4);
    const car = {
      group,
      wreck: bolones.object,
      box: bolones.box,
      sideways: 0,
      getBounds: (/** @type {THREE.Box3} */ box) =>
        box.setFromCenterAndSize(new THREE.Vector3(0, 1, 0), wide),
    };
    const minigame = createMinigame(
      /** @type {any} */ ({ scene, car, materials: testMaterials(), palms: [], rocks: [] }),
    );
    minigame.spawning = true;
    let crashed = false;
    for (let i = 0; i < 60 * 30 && !crashed; i++) crashed = minigame.update(1 / 60, 1).crashed;
    expect(crashed).toBe(true);
    const traffic = () => scene.children.filter(({ userData }) => userData.label);
    const seen = new Set(traffic());
    const run = (/** @type {number} */ seconds) => {
      for (let t = 0; t < seconds; t += 1 / 60) minigame.wreck(1 / 60, 0);
    };
    run(MINIGAME.crash.keepComing);
    const came = traffic().filter((other) => !seen.has(other));
    expect(came.length).toBeGreaterThan(0);
    // driven by the crash: they come on, then stop for the wreck
    const at = came[0].position.z;
    run(0.5);
    expect(came[0].position.z).toBeGreaterThan(at);
    // and on while the camera goes on along the road, then no more
    for (let t = 0; t < 10 && minigame.wreck(1 / 60, 0) > MOVING; t += 1 / 60);
    for (const other of traffic()) seen.add(other);
    run(3);
    expect(traffic().filter((other) => !seen.has(other))).toEqual([]);
    minigame.reset();
  });
});

describe("overtake", () => {
  beforeAll(() => ready);

  it("turns the cars going its way round, keeps the lanes, scores the cars overtaken", () => {
    const scene = new THREE.Scene();
    const bolones = testCar(0, 0, [3, 2.6, 7.8], CAR.mass, 0);
    scene.add(bolones.object);
    const car = {
      group: new THREE.Group(),
      wreck: bolones.object,
      box: bolones.box,
      sideways: 0,
      getBounds: (/** @type {THREE.Box3} */ box) => box.makeEmpty(), // nothing to hit
    };
    const minigame = createMinigame(
      /** @type {any} */ ({ scene, car, materials: testMaterials(), palms: [], rocks: [] }),
    );
    const cars = () => scene.children.filter(({ userData }) => userData.label);
    const { speed, platoon, window, group } = MINIGAME.modes.overtake;
    minigame.play("overtake");
    const lined = cars();
    expect(lined.length).toBeGreaterThan(0); // lined up ahead, going its way
    for (const other of lined) {
      expect(other.userData.sameWay).toBe(true);
      expect(other.rotation.y).toBe(Math.PI);
      expect(other.position.z).toBeLessThan(-MINIGAME.modes.overtake.ahead + 0.5 * SPEED.traffic);
    }
    // none of them reaches the Bolones (from z -4 to 4) in the countdown, at the start speed
    for (let t = 0; t < MINIGAME.countdown; t += 1 / 60) {
      minigame.update(1 / 60, speed.start / SPEED.kmh / WORLD.speed, 1);
    }
    for (const other of cars()) expect(other.position.z).toBeLessThan(-4 - 4);
    minigame.spawning = true;
    /** @type {Set<THREE.Object3D>} */
    const passed = new Set();
    /** @type {number[]} how far apart the cars towards it come, every second */
    const gaps = [];
    for (let frame = 0; frame < 60 * 30; frame++) {
      minigame.update(1 / 60, speed.top / SPEED.kmh / WORLD.speed, 1);
      for (const other of cars()) {
        expect(other.position.x > 0).toBe(other.userData.sameWay); // its way on the right
        if (other.position.z > 0) passed.add(other);
      }
      if (frame % 60) continue;
      const towards = cars()
        .filter(({ userData }) => !userData.sameWay)
        .map(({ position }) => position.z)
        .sort((a, b) => a - b);
      const apart = towards.slice(1).map((z, i) => z - towards[i]);
      gaps.push(...apart);
      // no group bigger than `group`: no more short gaps in a row than one less
      let row = 0;
      for (const gap of apart) {
        row = gap <= platoon[1] + 1 ? row + 1 : 0;
        expect(row).toBeLessThan(group[1]);
      }
    }
    // in groups, room to overtake between them
    for (const gap of gaps) expect(gap <= platoon[1] + 1 || gap >= window[0] - 1).toBe(true);
    expect(gaps.some((gap) => gap <= platoon[1] + 1)).toBe(true);
    expect(gaps.some((gap) => gap >= window[0] - 1)).toBe(true);
    const overtaken = [...passed].filter(({ userData }) => userData.sameWay).length;
    expect(overtaken).toBeGreaterThan(0);
    expect([...passed].length).toBeGreaterThan(overtaken); // the oncoming ones passed too
    expect(minigame.score).toBe(overtaken);
    minigame.reset();
  });
});
