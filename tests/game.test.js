import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { MINIGAME, SCENE, CAR } from "../src/config.js";
import { createInput } from "../src/core/input.js";
import { createTweens } from "../src/core/tween.js";
import { createGame } from "../src/game/game.js";

/** A game with stand-ins for the scene, HUD and GUI; `crashNext` makes the next update crash. */
function setup() {
  const camera = new THREE.PerspectiveCamera();
  const controls = {
    enabled: true,
    target: new THREE.Vector3(),
    maxDistance: SCENE.controls.maxDistance,
    update() {},
  };
  const world = { speedMultiplier: 1 };
  const calls = { minigameReset: 0, menuShow: 0, menuRandomize: 0, hudToggle: 0, carUpdate: 0 };
  // the wreck: three cars 5 apart, the Bolones (moved by `at`) where the orbit is at the crash
  const state = { crashNext: false, wreckSpeed: 0.4, at: new THREE.Vector3(0, 1.8, 0) };
  const minigame = {
    score: 7,
    spawning: false,
    reset: () => calls.minigameReset++,
    update: () => ({ crashed: state.crashNext, scored: false }),
    wreck: () => state.wreckSpeed,
    wrecks: ["Bolones", "Polakito", "Kredens"],
    wreckCentre: (/** @type {THREE.Vector3} */ target, /** @type {number} */ which) =>
      target.copy(state.at).setX(state.at.x + 5 * which),
    impact: 1,
  };
  const group = new THREE.Group();
  const car = {
    steering: false,
    softEdges: false,
    group,
    reset() {},
    update: () => calls.carUpdate++,
    release() {},
    // a body 1.8 wide, 1.4 high and 4.2 long, centred on the group
    getBounds: (/** @type {THREE.Box3} */ box) =>
      box.setFromCenterAndSize(group.position, new THREE.Vector3(1.8, 1.4, 4.2)),
  };
  /** @type {number[]} progress of every countGameOver call */
  const counts = [];
  // every HUD call is a no-op, but the game over count and the toggle are recorded
  const hud = new Proxy(
    {},
    {
      get: (_, name) =>
        name === "countGameOver"
          ? (/** @type {number} */ p) => counts.push(p)
          : name === "toggleMenu"
            ? () => calls.hudToggle++
            : () => {},
    },
  );
  const menu = { show: () => calls.menuShow++, hide() {}, randomize: () => calls.menuRandomize++ };
  const tweens = createTweens();
  const input = createInput(new EventTarget());
  const view = { camera, controls };
  const game = createGame(
    /** @type {any} */ ({ view, world, car, minigame, tweens, input, hud, menu }),
  );

  /** @param {number} seconds */
  const run = (seconds, dt = 1 / 60) => {
    for (let t = 0; t < seconds - 1e-9; t += dt) {
      tweens.update(dt);
      game.update(dt);
    }
  };

  const crash = () => {
    input.dispatch("start");
    run(MINIGAME.countdown + 0.1);
    state.crashNext = true;
    run(1 / 60);
    state.crashNext = false;
  };

  return { game, input, world, camera, controls, car, calls, counts, minigame, run, crash, state };
}

describe("keys outside the state machine", () => {
  it("R randomizes the scene colors through the scene GUI, in any state", () => {
    const { input, calls, run } = setup();
    input.dispatch("randomize");
    expect(calls.menuRandomize).toBe(1);
    input.dispatch("start");
    run(1 / 60);
    input.dispatch("randomize");
    expect(calls.menuRandomize).toBe(2);
  });
});

describe("portrait follow", () => {
  const target = new THREE.Vector3().fromArray(SCENE.camera.target);

  /** A portrait view (aspect 1:2, 90° vertical fov) from `position`, looking at the orbit target. */
  function portrait(/** @type {number[]} */ position) {
    const s = setup();
    s.camera.aspect = 0.5;
    s.camera.fov = 90;
    s.camera.updateProjectionMatrix();
    s.camera.position.fromArray(position);
    s.camera.lookAt(target);
    s.controls.target.copy(target);
    return s;
  }

  it("stays put while the centred car is looked at from any side", () => {
    for (const x of [-5, 0, 5]) {
      const { camera, controls, run } = portrait([x, 3, 5]);
      const at = camera.position.clone();
      run(0.5);
      expect(camera.position.distanceTo(at)).toBeCloseTo(0);
      expect(controls.target.distanceTo(target)).toBeCloseTo(0);
    }
  });

  it("slides the orbit sideways just enough to keep a steered car in view, and back", () => {
    const { camera, controls, car, run } = portrait(SCENE.camera.position);
    car.group.position.x = CAR.steer.maxOffset;
    run(1 / 60);
    expect(camera.position.x).toBeGreaterThan(0);
    expect(camera.position.y).toBeCloseTo(3);
    expect(camera.position.z).toBeCloseTo(7);
    expect(controls.target.x).toBeCloseTo(camera.position.x); // the orbit moves as a whole
    // the outer top corner nearest the camera ends up just inside the right edge
    camera.updateMatrixWorld();
    const corner = new THREE.Vector3(6.9, 0.7, 2.1).project(camera);
    expect(corner.x).toBeLessThan(1);
    expect(corner.x).toBeGreaterThan(0.7);

    car.group.position.x = 0;
    run(1 / 60);
    expect(camera.position.x).toBeCloseTo(0);
    expect(controls.target.x).toBeCloseTo(0);
  });

  it("slides the same for a steered car however the orbit is turned, and not while turning", () => {
    const { camera, controls, car, run } = portrait(SCENE.camera.position);
    car.group.position.x = CAR.steer.maxOffset;
    run(1 / 60);
    const slide = controls.target.x;
    expect(slide).toBeGreaterThan(0);

    // turn the orbit around its (slid) target, as OrbitControls does, then keep running
    const orbit = camera.position.clone().sub(controls.target);
    for (const angle of [0.3, 1, -1, Math.PI / 2]) {
      camera.position.copy(orbit).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
      camera.position.add(controls.target);
      camera.lookAt(controls.target);
      const at = camera.position.clone();
      run(0.5);
      expect(camera.position.distanceTo(at)).toBeCloseTo(0);
      expect(controls.target.x).toBeCloseTo(slide);
    }
  });
});

describe("free ride camera", () => {
  const home = new THREE.Vector3().fromArray(SCENE.camera.position);
  const target = new THREE.Vector3().fromArray(SCENE.camera.target);

  it("rides along with the car, however the orbit is turned", () => {
    const { input, camera, controls, car, run } = setup();
    camera.position.set(-4, 3, 5); // a turned orbit
    controls.target.copy(target);
    input.dispatch("free");
    for (const x of [2, -3, CAR.steer.maxOffset]) {
      car.group.position.x = x;
      run(1 / 60);
      expect(controls.target.x).toBeCloseTo(x);
      expect(camera.position.x).toBeCloseTo(x - 4);
      expect(camera.position.z).toBeCloseTo(5);
    }
  });

  it("softens the road edges in free ride only", () => {
    const { input, car, run } = setup();
    input.dispatch("free");
    expect(car.softEdges).toBe(true);
    input.dispatch("start");
    expect(car.softEdges).toBe(false);
    run(MINIGAME.countdown + 0.1);
    expect(car.softEdges).toBe(false);
  });

  it("brings the camera back with the car on ESC, then lets it be", () => {
    const { game, input, camera, controls, car, run } = setup();
    camera.position.copy(home);
    controls.target.copy(target);
    input.dispatch("free");
    car.group.position.x = 3;
    run(1 / 60);
    input.dispatch("exit");
    expect(game.state).toBe("idle");
    car.group.position.x = 1; // the car easing back
    run(1 / 60);
    expect(camera.position.x).toBeCloseTo(1);
    car.group.position.x = 0;
    run(1 / 60);
    expect(camera.position.x).toBeCloseTo(0);
    car.group.position.x = 2; // no longer pinned
    run(1 / 60);
    expect(camera.position.x).toBeCloseTo(0);
  });

  it("eases the orbit target back to the middle when the minigame starts", () => {
    const { input, camera, controls, car, run } = setup();
    camera.position.copy(home);
    controls.target.copy(target);
    input.dispatch("free");
    car.group.position.x = 3;
    run(1 / 60);
    input.dispatch("start");
    car.group.position.x = 0;
    run(1 / 60);
    expect(controls.target.x).toBeGreaterThan(2.9); // no jump on the first frame
    run(SCENE.camera.transition);
    expect(controls.target.distanceTo(target)).toBeCloseTo(0);
    expect(camera.position.x).toBeCloseTo(0);
  });

  it("ends the move from game over pinned to the car", () => {
    const { input, camera, controls, car, run, crash } = setup();
    crash();
    run(MINIGAME.crash.lock + 1 / 60);
    car.group.position.x = 2.5; // where it crashed
    input.dispatch("free");
    run(SCENE.camera.transition + 1 / 60);
    expect(controls.target.x).toBeCloseTo(2.5);
    expect(camera.position.x).toBeCloseTo(2.5);
    car.group.position.x = -1;
    run(1 / 60);
    expect(camera.position.x).toBeCloseTo(-1);
  });
});

describe("crash", () => {
  it("speeds the minigame up by half while ↑ is held, easing in and back out", () => {
    const { input, world, run } = setup();
    input.dispatch("start");
    run(MINIGAME.countdown + 0.1);
    expect(world.speedMultiplier).toBe(1);
    input.hold("faster", true);
    run(0.3);
    const early = world.speedMultiplier;
    expect(early).toBeGreaterThan(1.05); // seen at once
    expect(early).toBeLessThan(1.3); // but eased in
    run(4);
    expect(world.speedMultiplier).toBeCloseTo(MINIGAME.boost.factor, 2);
    input.hold("faster", false);
    run(0.3);
    expect(world.speedMultiplier).toBeGreaterThan(1.3); // easing back
    run(6);
    expect(world.speedMultiplier).toBeCloseTo(1, 2);
  });

  it("follows the car in view, from the Bolones on Tab to each car of the wreck and round", () => {
    const { input, controls, camera, run, crash, state } = setup();
    crash();
    run(MINIGAME.crash.shake);
    const view = camera.position.clone().sub(controls.target);
    for (const x of [5, 10, 0]) {
      input.dispatch("next"); // at once, as the camera is
      run(2);
      expect(controls.target.distanceTo(new THREE.Vector3(x, 1.8, 0))).toBeLessThan(0.01);
      expect(camera.position.clone().sub(controls.target).distanceTo(view)).toBeLessThan(1e-9);
    }
    state.at.set(2, 1.8, 3); // the Bolones going on, or thrown back
    run(2);
    expect(controls.target.distanceTo(state.at)).toBeLessThan(0.01);
    expect(camera.position.clone().sub(controls.target).distanceTo(view)).toBeLessThan(1e-9);
  });

  it("freezes the impact, then plays the wreck in slow motion back to full speed", () => {
    const { game, world, calls, run, crash, state } = setup();
    crash();
    expect(game.state).toBe("gameover");
    expect(world.speedMultiplier).toBe(0); // the road stops with the crash, not a frame later
    const resets = calls.minigameReset;
    const shows = calls.menuShow;
    const { freeze, scale, recover } = MINIGAME.crash.slowMotion;

    run(freeze / 2);
    expect(world.speedMultiplier).toBe(0); // frozen
    run(freeze / 2 + 1 / 60);
    expect(world.speedMultiplier).toBeCloseTo(state.wreckSpeed * scale, 2); // slow motion
    run(recover);
    expect(world.speedMultiplier).toBe(state.wreckSpeed); // the road under the camera, full speed
    expect(calls.minigameReset).toBe(resets); // the wreck stays on the road
    expect(calls.menuShow).toBe(shows); // the scene GUI waits
  });

  it("hands the camera over at once: turn it round and pull it back, H hides the HUD", () => {
    const { input, controls, run, crash, calls } = setup();
    crash();
    expect(controls.enabled).toBe(true);
    expect(controls.maxDistance).toBe(MINIGAME.crash.orbit);
    input.dispatch("menu");
    expect(calls.hudToggle).toBe(1);
    run(MINIGAME.crash.lock + 1 / 60);
    input.dispatch("start");
    run(SCENE.camera.transition + 1 / 60);
    expect(controls.maxDistance).toBe(SCENE.controls.maxDistance);
  });

  it("shakes the camera with its target, fading out", () => {
    const { camera, controls, run, crash } = setup();
    crash();
    const [cameraAt, targetAt] = [camera.position.clone(), controls.target.clone()];
    run(0.05);
    const moved = camera.position.clone().sub(cameraAt);
    expect(moved.length()).toBeGreaterThan(0);
    expect(moved.length()).toBeLessThan(MINIGAME.crash.shakeAmount * 2);
    expect(controls.target.clone().sub(targetAt).distanceTo(moved)).toBeLessThan(1e-9);
    run(MINIGAME.crash.shake);
    expect(camera.position.distanceTo(cameraAt)).toBeLessThan(1e-9);
  });

  it("leaves the Bolones to the crash: its wheels stand still, dented as they are", () => {
    const { calls, run, crash } = setup();
    crash();
    const updates = calls.carUpdate;
    run(1);
    expect(calls.carUpdate).toBe(updates);
  });

  it("ignores keys and buttons until the lock is over", () => {
    const { game, input, run, crash } = setup();
    crash();
    input.dispatch("start");
    input.dispatch("exit");
    expect(game.state).toBe("gameover");
    run(MINIGAME.crash.lock + 1 / 60);
    input.dispatch("start");
    expect(game.state).toBe("countdown");
  });

  it("brings the camera, speed and scene GUI back on leaving to the menu", () => {
    const { game, input, world, calls, run, crash } = setup();
    crash();
    run(MINIGAME.crash.lock + 1 / 60);
    const resets = calls.minigameReset;
    input.dispatch("exit");
    expect(game.state).toBe("idle");
    expect(world.speedMultiplier).toBe(1);
    expect(calls.minigameReset).toBe(resets + 1);
    expect(calls.menuShow).toBe(1);
  });

  it("counts the score up once it is in, then holds it", () => {
    const { counts, minigame, run, crash } = setup();
    crash();
    counts.length = 0;
    run(MINIGAME.crash.lock - 0.05);
    expect(Math.max(...counts)).toBe(0); // the panel is not in yet
    const duration = Math.min(
      minigame.score * MINIGAME.scoreCount.perPoint,
      MINIGAME.scoreCount.max,
    );
    run(0.05 + duration / 2);
    expect(counts.at(-1)).toBeGreaterThan(0.3);
    expect(counts.at(-1)).toBeLessThan(0.7);
    run(duration);
    expect(counts.at(-1)).toBe(1);
  });

  it("leaves the minigame for free ride too", () => {
    const { game, input, world, calls, run, crash } = setup();
    crash();
    run(MINIGAME.crash.lock + 1 / 60);
    input.dispatch("free");
    expect(game.state).toBe("free");
    expect(world.speedMultiplier).toBe(1);
    expect(calls.menuShow).toBe(1);
  });
});
