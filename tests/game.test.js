import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { MINIGAME, SCENE, CAR, SPEED, TRAFFIC, WORLD } from "../src/config.js";
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
    maxPolarAngle: SCENE.controls.maxPolarAngle,
    update() {},
  };
  const world = { speedMultiplier: 1 };
  const calls = { minigameReset: 0, menuShow: 0, menuRandomize: 0, carUpdate: 0 };
  // the wreck: three cars 5 apart, the Bolones (moved by `at`) where the orbit is at the crash
  const state = { crashNext: false, wreckSpeed: 0.4, at: new THREE.Vector3(0, 1.8, 0) };
  const minigame = {
    score: 7,
    /** @type {import("../src/game/minigame.js").Damage | null} */
    damage: null,
    /** @type {string | null} the minigame got ready last */
    played: null,
    play(/** @type {string} */ mode) {
      this.played = mode;
    },
    engine: 1,
    /** @type {[number, boolean][]} what the player did with the Bolones after the crash */
    controls: [],
    control(/** @type {number} */ steer, /** @type {boolean} */ gas) {
      this.controls.push([steer, gas]);
    },
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
  /** @type {Record<string, any[][]>} the arguments of every HUD call, by its name */
  const hudCalls = {};
  let hidden = false; // H hid the HUD, as ui/hud.js keeps it
  const hud = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (/** @type {any[]} */ ...args) => {
          (hudCalls[String(name)] ??= []).push(args);
          if (name === "toggleMenu") hidden = !hidden;
          if (name !== "reveal" && name !== "setState") return undefined;
          const was = hidden;
          hidden = false;
          return was;
        },
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

  /** ENTER, then a minigame clicked in their list. */
  const play = (/** @type {import("../src/game/game.js").Mode} */ mode = "dodge") => {
    input.dispatch("start");
    input.dispatch(mode);
  };

  /** Plays a minigame and crashes as soon as it is on. */
  const crash = (/** @type {import("../src/game/game.js").Mode} */ mode = "dodge") => {
    play(mode);
    run(MINIGAME.countdown + 0.1);
    state.crashNext = true;
    run(1 / 60);
    state.crashNext = false;
  };

  return {
    game,
    input,
    world,
    camera,
    controls,
    car,
    calls,
    hudCalls,
    minigame,
    run,
    play,
    crash,
    state,
  };
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
    const { input, car, run, play } = setup();
    input.dispatch("free");
    expect(car.softEdges).toBe(true);
    play();
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
    const { input, camera, controls, car, run, play } = setup();
    camera.position.copy(home);
    controls.target.copy(target);
    input.dispatch("free");
    car.group.position.x = 3;
    run(1 / 60);
    play();
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
    const { input, world, run, play } = setup();
    play();
    run(MINIGAME.countdown + 0.1);
    const start = world.speedMultiplier;
    const boost = () => world.speedMultiplier / start;
    input.hold("faster", true);
    run(0.3);
    expect(boost()).toBeGreaterThan(1.05); // seen at once
    expect(boost()).toBeLessThan(1.3); // but eased in
    run(4);
    expect(boost()).toBeCloseTo(MINIGAME.boost.factor, 2);
    input.hold("faster", false);
    run(0.3);
    expect(boost()).toBeGreaterThan(1.3); // easing back
    run(6);
    expect(boost()).toBeCloseTo(1, 2);
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
    // a frame too long plays only `frame` of the crash: slower, not more physics steps a frame
    const { frame } = MINIGAME.crash.slowMotion;
    run(3 * frame, 3 * frame);
    expect(world.speedMultiplier).toBeCloseTo(state.wreckSpeed / 3, 9);
    expect(calls.minigameReset).toBe(resets); // the wreck stays on the road
    expect(calls.menuShow).toBe(shows); // the scene GUI waits
  });

  it("has ESC bring back the HUD H hid first, then leave", () => {
    const { game, input, run, crash } = setup();
    crash();
    run(MINIGAME.crash.lock + 1 / 60);
    input.dispatch("menu");
    input.dispatch("exit");
    expect(game.state).toBe("gameover");
    input.dispatch("exit");
    expect(game.state).toBe("idle");
  });

  it("hands the camera over at once: turn it round and pull it back, H hides the HUD", () => {
    const { input, controls, run, crash, hudCalls } = setup();
    crash();
    expect(controls.enabled).toBe(true);
    expect(controls.maxDistance).toBe(MINIGAME.crash.orbit);
    expect(controls.maxPolarAngle).toBeLessThanOrEqual(Math.PI / 2); // never under the road
    input.dispatch("menu");
    expect(hudCalls.toggleMenu).toHaveLength(1);
    run(MINIGAME.crash.lock + 1 / 60);
    input.dispatch("start");
    run(SCENE.camera.transition + 1 / 60);
    expect(controls.maxDistance).toBe(SCENE.controls.maxDistance);
    expect(controls.maxPolarAngle).toBe(SCENE.controls.maxPolarAngle);
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

  it("leaves the Bolones to the crash: it poses the car and turns its wheels", () => {
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
    const { hudCalls, minigame, run, crash } = setup();
    crash();
    run(MINIGAME.crash.lock - 0.05);
    expect(hudCalls.countGameOver).toBeUndefined(); // the panel is not in yet
    expect(hudCalls.showGameOver.at(-1)).toEqual([0]); // no record to beat yet
    const duration = Math.min(
      minigame.score * MINIGAME.scoreCount.perPoint,
      MINIGAME.scoreCount.max,
    );
    run(0.05 + duration / 2);
    const [counted, score] = hudCalls.countGameOver.at(-1) ?? [];
    expect(score).toBe(minigame.score);
    expect(counted / score).toBeGreaterThan(0.3);
    expect(counted / score).toBeLessThan(0.7);
    run(duration);
    expect(hudCalls.countGameOver.at(-1)).toEqual([score, score]);
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

describe("minigames", () => {
  it("ENTER lists them, ← → choose one, ENTER plays it, again from game over", () => {
    const { game, input, minigame, run, hudCalls } = setup();
    input.dispatch("start");
    expect(game.state).toBe("select");
    expect(hudCalls.setChoice.at(-1)).toEqual(["dodge"]);
    input.dispatch("left"); // round to the last: free ride
    expect(hudCalls.setChoice.at(-1)).toEqual(["free"]);
    input.dispatch("left");
    expect(hudCalls.setChoice.at(-1)).toEqual(["overtake"]);
    input.dispatch("right");
    input.dispatch("right");
    input.dispatch("right");
    expect(hudCalls.setChoice.at(-1)).toEqual(["crash"]);
    input.dispatch("start");
    expect(game.state).toBe("countdown");
    expect(minigame.played).toBe("crash");
    expect(hudCalls.setMode.at(-1)).toEqual(["crash"]);
    run(MINIGAME.countdown + 0.1);
    input.dispatch("start"); // not mid-game
    input.dispatch("dodge");
    expect(game.state).toBe("playing");
    input.dispatch("exit");
    input.dispatch("start"); // the list remembers the last one
    expect(hudCalls.setChoice.at(-1)).toEqual(["crash"]);
  });

  it("has free ride last in the list: ENTER on it rides, the list lights it next time", () => {
    const { game, input, hudCalls } = setup();
    input.dispatch("start");
    input.dispatch("left");
    input.dispatch("start");
    expect(game.state).toBe("free");
    input.dispatch("exit");
    input.dispatch("start");
    expect(hudCalls.setChoice.at(-1)).toEqual(["free"]);
    input.dispatch("free"); // its card clicked
    expect(game.state).toBe("free");
  });

  it("plays one clicked in the list at once; ESC goes back, the camera left be", () => {
    const { game, input, minigame, calls, controls } = setup();
    input.dispatch("dodge"); // not in the menu itself
    expect(game.state).toBe("idle");
    input.dispatch("start");
    input.dispatch("exit");
    expect(game.state).toBe("idle");
    expect(calls.minigameReset).toBe(0);
    expect(controls.enabled).toBe(true);
    input.dispatch("start");
    input.dispatch("dodge");
    expect(game.state).toBe("countdown");
    expect(minigame.played).toBe("dodge");
  });

  it("plays the same one again from game over", () => {
    const { game, input, minigame, run, crash } = setup();
    crash("crash");
    run(MINIGAME.crash.lock + 1 / 60);
    input.dispatch("start"); // AGAIN
    expect(game.state).toBe("countdown");
    expect(minigame.played).toBe("crash");
  });
});

describe("crash mode", () => {
  it("shows how fast the traffic comes at the Bolones on the way, not a score", () => {
    const { world, run, play, hudCalls } = setup();
    play("crash");
    run(MINIGAME.countdown + MINIGAME.startLabelDuration + 0.1);
    const kmh = Math.round(((SPEED.traffic * world.speedMultiplier) / TRAFFIC.scale) * 3.6);
    expect(hudCalls.setScore.at(-1)).toEqual([kmh, false]); // a speed does not pop
  });

  it("scores what the crash wrecks, counting on as it grows, for a record of its own", () => {
    const { input, minigame, run, crash, hudCalls } = setup();
    const damage = { kJ: 90, parts: 1, posts: 0, others: 2, score: 220 };
    minigame.damage = damage;
    crash("crash");
    run(MINIGAME.crash.lock + MINIGAME.scoreCount.max + 0.1);
    expect(hudCalls.countGameOver.at(-1)).toEqual([220, 220]);
    expect(hudCalls.setDamage.at(-1)).toEqual([damage]);
    minigame.damage = { ...damage, others: 3, score: 330 }; // another car runs into the wreck
    run(0.05);
    const [counted] = hudCalls.countGameOver.at(-1) ?? [];
    expect(counted).toBeGreaterThan(220); // counting on
    expect(counted).toBeLessThan(330);
    run(MINIGAME.scoreCount.max);
    expect(hudCalls.countGameOver.at(-1)).toEqual([330, 330]);
    input.dispatch("exit");
    expect(hudCalls.setBest.at(-1)).toEqual(["crash", 330]);
    expect(
      hudCalls.setBest.filter(([mode]) => mode === "dodge").every(([, value]) => value === 0),
    ).toBe(true);
  });

  it("leaves the Bolones in the player's hands after a crash, every minigame: ← → steer, ↑ on", () => {
    for (const mode of /** @type {const} */ (["dodge", "crash", "overtake"])) {
      const { input, minigame, run, crash } = setup();
      crash(mode);
      input.hold("left", true);
      input.hold("faster", true);
      run(0.1);
      expect(minigame.controls.at(-1), mode).toEqual([-1, true]);
      input.hold("left", false);
      input.hold("faster", false);
      run(0.1);
      expect(minigame.controls.at(-1), mode).toEqual([0, false]);
    }
  });

  it("starts the Bolones at the mode's speed from the countdown on, faster every few cars", () => {
    const { world, minigame, run, play, hudCalls } = setup();
    const kmh = () => world.speedMultiplier * WORLD.speed * SPEED.kmh;
    for (const mode of /** @type {const} */ (["dodge", "overtake"])) {
      const other = setup();
      other.play(mode);
      const speed = other.world.speedMultiplier * WORLD.speed * SPEED.kmh;
      expect(speed, mode).toBeCloseTo(MINIGAME.modes[mode].start);
    }
    play("crash");
    expect(kmh()).toBeCloseTo(MINIGAME.modes.crash.start);
    run(MINIGAME.countdown + 0.1);
    expect(kmh()).toBeCloseTo(MINIGAME.modes.crash.start);
    const start = world.speedMultiplier;
    minigame.score = MINIGAME.modes.crash.every - 1;
    run(1 / 60);
    expect(world.speedMultiplier).toBe(start);
    minigame.score = MINIGAME.modes.crash.every;
    minigame.update = () => ({ crashed: false, scored: true });
    run(1 / 60);
    expect(world.speedMultiplier).toBeCloseTo(start + SPEED.tierStep);
    expect(hudCalls.setLevel.at(-1)).toEqual([2]);
  });

  it("lets the Bolones go MINIGAME.top at most, however far the game has gone, ↑ held too", () => {
    const { world, minigame, run, play, input, hudCalls } = setup();
    play("dodge");
    run(MINIGAME.countdown + 0.1);
    minigame.score = 10000;
    minigame.update = () => ({ crashed: false, scored: true });
    input.hold("faster", true);
    run(3);
    const kmh = WORLD.speed * world.speedMultiplier * SPEED.kmh;
    expect(kmh).toBeCloseTo(MINIGAME.top, 5);
    expect(hudCalls.setSpeed.at(-1)).toEqual([MINIGAME.top]); // the speedometer, in every mode
  });

  it("hides the hint to drive the wreck on once its engine stalls", () => {
    const { minigame, run, crash, hudCalls } = setup();
    crash("crash");
    run(0.1);
    expect(hudCalls.setDriveOn.at(-1)).toEqual([true]);
    minigame.engine = 0;
    run(0.1);
    expect(hudCalls.setDriveOn.at(-1)).toEqual([false]);
  });
});

describe("overtake", () => {
  it("goes as fast as the player says: ↑ up to the top, ↓ down to the slow cars, else it holds", () => {
    const { world, input, run, play, hudCalls } = setup();
    const { slow, speed, start } = MINIGAME.modes.overtake;
    const kmh = () => world.speedMultiplier * WORLD.speed * SPEED.kmh;
    play("overtake");
    expect(kmh()).toBeCloseTo(start, 5);
    run(MINIGAME.countdown + MINIGAME.startLabelDuration + 0.1);
    expect(kmh()).toBeCloseTo(start, 5);
    expect(hudCalls.setSpeed.at(-1)).toEqual([start]); // the speedometer
    input.hold("faster", true);
    run(0.5);
    input.hold("faster", false);
    expect(kmh()).toBeCloseTo(start + 0.5 * speed.gas, 5);
    const held = kmh();
    run(1);
    expect(kmh()).toBe(held);
    input.hold("faster", true);
    run(10);
    input.hold("faster", false);
    expect(kmh()).toBeCloseTo(MINIGAME.top, 5);
    expect(hudCalls.setSpeed.at(-1)).toEqual([MINIGAME.top]);
    input.hold("slower", true);
    run(10);
    input.hold("slower", false);
    expect(kmh()).toBeCloseTo(slow, 5);
  });

  it("speeds the traffic up every few cars overtaken, not the Bolones", () => {
    const { world, minigame, run, play } = setup();
    /** @type {number[]} */
    const levels = [];
    const recording = (/** @type {number} */ dt, /** @type {number} */ speed, level = speed) => {
      levels.push(level);
      return { crashed: false, scored: false };
    };
    minigame.update = /** @type {any} */ (recording);
    play("overtake");
    run(MINIGAME.countdown + 0.1);
    expect(levels.at(-1)).toBe(1);
    minigame.score = MINIGAME.modes.overtake.every;
    run(1 / 60);
    expect(levels.at(-1)).toBeCloseTo(1 + SPEED.tierStep);
    const kmh = world.speedMultiplier * WORLD.speed * SPEED.kmh;
    expect(kmh).toBeCloseTo(MINIGAME.modes.overtake.start, 5); // the Bolones: as the player says
  });
});
