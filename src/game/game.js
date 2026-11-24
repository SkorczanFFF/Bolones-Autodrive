import * as THREE from "three";
import { MINIGAME, SCENE, SPEED, STORAGE, TEXT, TRAFFIC } from "../config.js";
import { loadNumber, saveNumber } from "../core/storage.js";
import { createStateMachine } from "./state.js";

/** @typedef {import("./state.js").GameState} GameState */
/** The minigames, as their list in the menu shows them (index.html). */
const MODES = /** @type {const} */ (["dodge", "crash"]);
/**
 * @typedef {(typeof MODES)[number]} Mode the minigame: dodge the oncoming traffic, or crash into
 *   it for the damage (MINIGAME.crashMode)
 */

const KMH = 3.6 / TRAFFIC.scale; // units/s -> km/h

/**
 * The speed level a score has reached, from 0: every SPEED.tierEvery cars passed, in crash mode
 * every MINIGAME.crashMode.every.
 *
 * @param {number} score
 * @param {Mode} mode
 */
const tierOf = (score, mode) =>
  Math.floor(score / (mode === "crash" ? MINIGAME.crashMode.every : SPEED.tierEvery));

/**
 * The world's speed multiplier at a score: crash mode starts as fast as MINIGAME.crashMode.start.
 *
 * @param {number} score
 * @param {Mode} mode
 */
const speedOf = (score, mode) =>
  (mode === "crash" ? MINIGAME.crashMode.start / (SPEED.traffic * KMH) : 1) +
  tierOf(score, mode) * SPEED.tierStep;

/**
 * @typedef {object} Menu
 * @property {() => void} show
 * @property {() => void} hide
 * @property {() => void} randomize "Randomize all" (R)
 */

/**
 * @typedef {object} GameDeps
 * @property {ReturnType<typeof import("../core/renderer.js").createView>} view
 * @property {ReturnType<typeof import("../scene/world.js").createWorld>} world
 * @property {ReturnType<typeof import("../scene/car.js").createCar>} car
 * @property {ReturnType<typeof import("./minigame.js").createMinigame>} minigame
 * @property {import("../core/tween.js").Tweens} tweens
 * @property {ReturnType<typeof import("../core/input.js").createInput>} input
 * @property {ReturnType<typeof import("../ui/hud.js").createHud>} hud
 * @property {Menu} [menu] scene GUI, hidden during the minigame
 */

/**
 * Game time per real second after a crash: a moment frozen at the impact, then slow motion easing
 * back to full speed (MINIGAME.crash.slowMotion).
 *
 * @param {number} time real seconds since the crash
 */
function slowMotion(time) {
  const { freeze, scale, recover } = MINIGAME.crash.slowMotion;
  if (time < freeze) return 0;
  return THREE.MathUtils.lerp(scale, 1, THREE.MathUtils.smootherstep(time - freeze, 0, recover));
}

/**
 * Orchestrates the game: maps input to state events (and gates the menu, glow and randomize keys),
 * runs per-state timers inside update(dt) and performs the enter actions of each state (camera,
 * car, minigame, HUD, menu).
 *
 * @param {GameDeps} deps
 */
export function createGame({ view, world, car, minigame, tweens, input, hud, menu }) {
  const { camera, controls } = view;
  const cameraTarget = new THREE.Vector3().fromArray(SCENE.camera.target);
  const homePosition = new THREE.Vector3().fromArray(SCENE.camera.position);
  const gamePosition = new THREE.Vector3().fromArray(SCENE.camera.gamePosition);

  /** @type {import("../core/tween.js").TweenHandle | null} */
  let cameraTween = null;
  /** Which car of the wreck the orbit follows, by the order they crashed (0: the Bolones). */
  let wreckFocus = 0;
  const shakeOffset = new THREE.Vector3();
  const aim = new THREE.Vector3();
  let followX = 0; // sideways camera offset that keeps the car in frame
  let pinned = false; // free ride: the orbit rides along with the car (followX = car x)
  const carBounds = new THREE.Box3();
  const base = new THREE.Vector3();
  const corner = new THREE.Vector3();
  const toCorner = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const moveTo = new THREE.Vector3();
  const moveTarget = new THREE.Vector3();
  let stateTime = 0;
  let boost = 1; // the minigame sped up while ↑ is held (MINIGAME.boost), eased
  /** @type {Mode} */
  let mode = "dodge"; // the one played, or chosen in the list
  const best = { dodge: loadNumber(STORAGE.best.dodge), crash: loadNumber(STORAGE.best.crash) };
  let record = 0; // the mode's best before this game over: to beat
  let counted = 0; // how far game over has counted its score up

  /** This game's score: the cars dodged, or what the crash wrecked. */
  const scoreOf = () => (mode === "crash" ? (minigame.damage?.score ?? 0) : minigame.score);

  /** Keeps the mode's best score (also when leaving mid-game with ESC). */
  function recordScore() {
    const score = scoreOf();
    if (score <= best[mode]) return;
    best[mode] = score;
    saveNumber(STORAGE.best[mode], score);
  }

  /**
   * Controls stay disabled during the move; controls.update() applies the orbit limits, so the
   * game camera ends up clamped exactly like in v1. The orbit target eases back to the home
   * target too (it is off it after free ride); a move into free ride ends pinned to the car.
   *
   * @param {THREE.Vector3} to
   * @param {() => void} [onDone]
   */
  function moveCamera(to, onDone) {
    cameraTween?.cancel();
    controls.enabled = false;
    const from = camera.position.clone();
    const fromTarget = controls.target.clone();
    const fromMax = controls.maxDistance; // a wreck's, pulled back further
    cameraTween = tweens.add({
      duration: SCENE.camera.transition,
      onUpdate: (t) => {
        followX = pinned ? car.group.position.x : 0; // the offset the move ends with, for followCar
        moveTo.copy(to).x += followX;
        moveTarget.copy(cameraTarget).x += followX;
        camera.position.lerpVectors(from, moveTo, t);
        controls.target.lerpVectors(fromTarget, moveTarget, t);
        controls.maxDistance = THREE.MathUtils.lerp(fromMax, SCENE.controls.maxDistance, t);
        controls.update();
      },
      onComplete: onDone,
    });
  }

  /**
   * After a crash the orbit follows the car in view (the Bolones first, Tab: the next one),
   * easing over to it (MINIGAME.crash.follow) with the camera keeping its place around it; at
   * first the whole of it shakes, fading out, the harder the hit the more.
   *
   * @param {number} dt real seconds
   */
  function followWreck(dt) {
    const { follow, shake, shakeAmount } = MINIGAME.crash;
    controls.target.sub(shakeOffset);
    camera.position.sub(shakeOffset);
    minigame.wreckCentre(aim, wreckFocus).sub(controls.target);
    aim.multiplyScalar(1 - Math.exp(-dt / follow));
    const left = Math.max(0, 1 - stateTime / shake);
    const random = () => Math.random() * 2 - 1;
    shakeOffset
      .set(random(), random(), 0)
      .multiplyScalar(shakeAmount * minigame.impact * left ** 2);
    aim.add(shakeOffset);
    controls.target.add(aim);
    camera.position.add(aim);
    controls.update();
  }

  /**
   * On portrait screens the steering range is wider than the view: the camera slides sideways,
   * together with its orbit target, only as far as needed to keep the car inside. Landscape screens
   * keep the fixed camera of the desktop version.
   *
   * The slide is measured against a stand-in camera that looks straight down the road from the
   * real orbit's distance and tilt. The orbit can be turned, and the real camera is then useless
   * as a reference: measured against it, a centred car looked out of frame once the view was
   * turned to the right (the camera ran away), and a car driving past the lens asked for wild
   * slides that could not bring it back anyway. Against the stand-in, turning the orbit
   * changes nothing; the car is simply kept near the orbit centre.
   *
   * Free ride pins the orbit to the car instead, on any screen: the camera and its target follow
   * the car's x one to one, and keep doing so on the way back to the menu until the car is back
   * in the middle of the road.
   */
  function followCar() {
    // the move sets followX itself; after a crash the camera follows the wreck (followWreck)
    if (cameraTween?.isActive() || machine.state === "gameover") return;
    if (pinned && machine.state !== "free" && car.group.position.x === 0) pinned = false;
    const portrait = camera.aspect < 1;
    if (!pinned && !portrait && followX === 0) return; // landscape: nothing to measure every frame
    let offset = 0;
    if (pinned) {
      offset = car.group.position.x;
    } else if (portrait) {
      // the orbit (same with or without the slide) with its turn undone, around the home target
      base.subVectors(camera.position, controls.target);
      base.set(0, base.y, Math.hypot(base.x, base.z)).add(cameraTarget);
      forward.subVectors(cameraTarget, base).normalize();
      // The outer corner of the body nearest the camera is the first to leave the frame.
      const side = car.group.position.x >= cameraTarget.x ? 1 : -1;
      car.getBounds(carBounds);
      const { min, max } = carBounds;
      corner.set(side > 0 ? max.x : min.x, max.y, max.z);
      const depth = toCorner.subVectors(corner, base).dot(forward);
      const halfWidth = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect; // per unit of depth
      const room = depth * halfWidth - SCENE.camera.followMargin; // half the view at the corner
      offset = side * Math.max(0, side * (corner.x - base.x) - room);
    }
    const dx = offset - followX;
    if (dx === 0) return;
    camera.position.x += dx;
    controls.target.x += dx;
    followX = offset;
  }

  function leaveMinigame() {
    minigame.reset();
    world.speedMultiplier = 1;
    moveCamera(homePosition, () => (controls.enabled = true));
    menu?.show();
  }

  /**
   * @param {GameState} next
   * @param {GameState} previous
   */
  function enter(next, previous) {
    stateTime = 0;
    hud.setState(next);
    car.steering = next === "free" || next === "playing";
    car.softEdges = next === "free";
    // leaving free ride for the menu keeps the pin while the car eases back (see followCar)
    pinned = next === "free" || (previous === "free" && (next === "idle" || next === "select"));
    input.arm("next", false); // Tab is the browser's again, but over a wreck

    switch (next) {
      case "countdown":
        boost = 1;
        car.reset(tweens);
        minigame.reset();
        minigame.density = mode === "crash" ? MINIGAME.crashMode.density : 1;
        world.speedMultiplier = speedOf(0, mode);
        menu?.hide();
        moveCamera(gamePosition);
        hud.setMode(mode);
        hud.setScore(null);
        hud.setLevel(1);
        hud.setCountdown(String(MINIGAME.countdown));
        break;

      case "playing":
        hud.setCountdown(TEXT.countdownGo);
        break;

      case "gameover":
        // the wreck stays on the road, the camera can be turned round it and pulled back at
        // once; the camera and the scene GUI return on leaving
        record = best[mode];
        counted = 0;
        hud.showGameOver(record);
        world.speedMultiplier = 0; // the road stops with the crash: the palms stay where it found them
        wreckFocus = 0;
        shakeOffset.set(0, 0, 0);
        cameraTween?.cancel();
        controls.maxDistance = MINIGAME.crash.orbit;
        controls.enabled = true;
        input.arm("next", true);
        break;

      case "idle":
        car.reset(tweens);
        if (previous === "countdown" || previous === "playing") recordScore();
        if (previous !== "free" && previous !== "select") leaveMinigame();
        break;

      case "select":
        car.reset(tweens);
        hud.setChoice(mode);
        break;

      case "free":
        if (previous === "gameover") {
          car.reset(tweens);
          leaveMinigame();
        }
        break;
    }
    hud.setBest(mode, best[mode]); // game over's record only once it is left: the count beats it
  }

  const machine = createStateMachine("idle", enter);

  /** Game over takes no keys or clicks at first (MINIGAME.crash.lock). */
  const locked = () => machine.state === "gameover" && stateTime < MINIGAME.crash.lock;

  input.onPress((action) => {
    switch (action) {
      case "start":
        // the menu, free ride: the minigames; their list: the one chosen; game over: again
        if (locked()) return;
        machine.send("start");
        break;
      case "dodge":
      case "crash":
        if (machine.state !== "select") return; // a minigame clicked in the list
        mode = action;
        machine.send("start");
        break;
      case "left":
      case "right": {
        if (machine.state !== "select") return; // otherwise held, steering
        const i = MODES.indexOf(mode) + (action === "left" ? -1 : 1);
        mode = MODES[(i + MODES.length) % MODES.length];
        hud.setChoice(mode);
        break;
      }
      case "free":
      case "exit":
        if (locked()) return;
        machine.send(action);
        break;
      case "menu":
        if (["idle", "select", "gameover"].includes(machine.state)) hud.toggleMenu(); // shown there
        break;
      case "next":
        if (machine.state === "gameover") {
          wreckFocus = (wreckFocus + 1) % minigame.wrecks.length;
        }
        break;
      case "glow":
        view.bloom.enabled = !view.bloom.enabled;
        break;
      case "randomize":
        menu?.randomize();
        break;
    }
  });
  input.onRelease((action) => {
    if (action === "left" || action === "right") car.release();
  });

  /** @returns {import("../scene/car.js").SteerInput} */
  function steerInput() {
    if (input.isHeld("left")) return -1;
    if (input.isHeld("right")) return 1;
    return 0;
  }

  hud.setState(machine.state);
  for (const of of MODES) hud.setBest(of, best[of]);

  return {
    get state() {
      return machine.state;
    },

    /** @param {number} dt */
    update(dt) {
      stateTime += dt;
      // a wreck is the crash's: its wheels stand still, dented as they are (scene/crumple.js)
      if (machine.state !== "gameover") car.update(dt, world.speedMultiplier, steerInput());
      followCar();

      switch (machine.state) {
        case "countdown": {
          minigame.spawning = stateTime >= MINIGAME.trafficStartsAt;
          minigame.update(dt, world.speedMultiplier);
          if (stateTime >= MINIGAME.countdown) {
            machine.send("timeout");
            break;
          }
          hud.setCountdown(String(MINIGAME.countdown - Math.floor(stateTime)));
          break;
        }

        case "playing": {
          const { factor, rise, fall } = MINIGAME.boost;
          const target = input.isHeld("faster") ? factor : 1;
          boost += (target - boost) * (1 - Math.exp(-dt / (target > boost ? rise : fall)));
          world.speedMultiplier = speedOf(minigame.score, mode) * boost;
          const { crashed, scored } = minigame.update(dt, world.speedMultiplier);
          if (crashed) {
            machine.send("crash");
            break;
          }
          if (scored) hud.setLevel(tierOf(minigame.score, mode) + 1);
          if (stateTime < MINIGAME.startLabelDuration) break;
          hud.setCountdown(null);
          if (mode === "dodge") hud.setScore(minigame.score);
          // how fast the traffic comes at the Bolones: as hard as the crash will be
          else hud.setScore(Math.round(SPEED.traffic * world.speedMultiplier * KMH), false);
          break;
        }

        case "gameover": {
          // crash mode: the Bolones is still the player's, a little, until its engine stalls
          if (mode === "crash") {
            minigame.control(steerInput(), input.isHeld("faster"));
            hud.setDriveOn(minigame.engine > 0);
          }
          const scale = slowMotion(stateTime);
          // the road under the camera, which rides along with the car in view
          world.speedMultiplier = minigame.wreck(dt * scale, wreckFocus) * scale;
          followWreck(dt);
          hud.setWreck(minigame.wrecks, wreckFocus);
          const { damage } = minigame;
          if (mode === "crash" && damage) hud.setDamage(damage);
          recordScore();
          if (locked()) break;
          // the score counts up once it is in, and on as the crash adds to it (crash mode)
          const score = scoreOf();
          const { perPoint, max } = MINIGAME.scoreCount;
          counted = Math.min(score, counted + Math.max(1 / perPoint, score / max) * dt);
          hud.countGameOver(counted, score);
          break;
        }
      }
    },
  };
}
