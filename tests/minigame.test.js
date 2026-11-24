import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { CAR, MINIGAME } from "../src/config.js";
import { ready } from "../src/game/crash.js";
import { createLanePicker, createMinigame } from "../src/game/minigame.js";
import { trafficHalfWidth } from "../src/scene/traffic.js";
import { testCar, testMaterials } from "./helpers.js";

/** Deterministic pseudo-random sequence. @param {number} seed */
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

describe("lane picker", () => {
  const halfWidth = trafficHalfWidth();
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
    for (const other of traffic()) seen.add(other);
    run(3);
    expect(traffic().filter((other) => !seen.has(other))).toEqual([]); // no more
    minigame.reset();
  });
});
