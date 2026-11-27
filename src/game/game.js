import * as THREE from "three";
import { MINIGAME, SCENE, SPEED, STORAGE, TEXT, WORLD } from "../config.js";
import { loadNumber, saveNumber } from "../core/storage.js";
import { settle } from "../core/tween.js";
import { createStateMachine } from "./state.js";

/** @typedef {import("./state.js").GameState} GameState */
/** @typedef {import("../config.js").Mode} Mode */
/** The minigames, in their list's order. */
const MODES = /** @type {Mode[]} */ (Object.keys(MINIGAME.modes));
/** The list's cards (index.html), in order: the minigames, then free ride. */
const CHOICES = /** @type {(Mode | "free")[]} */ ([...MODES, "free"]);

/** The world's speed multiplier for the Bolones going this fast. @param {number} kmh */
const worldAt = (kmh) => kmh / SPEED.kmh / WORLD.speed;

/**
 * The speed level a score has reached, from 0: one every MINIGAME.modes' `every` cars.
 *
 * @param {number} score
 * @param {Mode} mode
 */
const tierOf = (score, mode) => Math.floor(score / MINIGAME.modes[mode].every);

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
 * back to full speed, slower on a frame too long to play in full (MINIGAME.crash.slowMotion).
 *
 * @param {number} time real seconds since the crash
 * @param {number} dt real seconds of this frame
 */
function slowMotion(time, dt) {
  const { freeze, scale, recover, frame } = MINIGAME.crash.slowMotion;
  if (time < freeze) return 0;
  const { lerp, smootherstep } = THREE.MathUtils;
  return Math.min(lerp(scale, 1, smootherstep(time - freeze, 0, recover)), frame / dt);
}

/**
 * Orchestrates the game: maps input to state events (and gates the menu key; glow and randomize work always),
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
  let mode = "dodge"; // the one played
  /** @type {Mode | "free"} the card lit in the list: what was played last, or picked */
  let choice = mode;
  const best = Object.fromEntries(MODES.map((of) => [of, loadNumber(STORAGE.best[of])]));
  let own = 0; // overtake: the Bolones' own speed, km/h (MINIGAME.modes.overtake)
  let counted = 0; // how far game over has counted its score up

  /** This game's score: the cars passed (dodged or overtaken), or what the crash wrecked. */
  const scoreOf = () => (mode === "crash" ? (minigame.damage?.score ?? 0) : minigame.score);

  /**
   * Sets the Bolones' speed, up to MINIGAME.top, and returns the traffic's: in overtake ↑ ↓ drive
   * the Bolones (from the mode's `start`) and the score the traffic, otherwise both go from the
   * Bolones at `start`, faster with the score, ↑ speeding them up (MINIGAME.boost).
   *
   * @param {number} dt 0 to set it as it is (the countdown)
   */
  function pace(dt) {
    const faster = tierOf(minigame.score, mode) * SPEED.tierStep;
    if (mode === "overtake") {
      // ↑ gas, ↓ brake, down to the cars going its way at the least; let go it holds
      const { slow, speed } = MINIGAME.modes.overtake;
      const gas = input.isHeld("faster") ? speed.gas : 0;
      const brake = input.isHeld("slower") ? speed.brake : 0;
      own = THREE.MathUtils.clamp(own + (gas - brake) * dt, slow, MINIGAME.top);
      world.speedMultiplier = worldAt(own);
      return 1 + faster;
    }
    const { factor, rise, fall } = MINIGAME.boost;
    const target = input.isHeld("faster") ? factor : 1;
    boost += (target - boost) * settle(target > boost ? rise : fall, dt);
    const level = worldAt(MINIGAME.modes[mode].start) + faster;
    return (world.speedMultiplier = Math.min(level * boost, worldAt(MINIGAME.top)));
  }

  /** The Bolones' speed, km/h, for the speedometer. */
  const kmh = () => Math.round(WORLD.speed * world.speedMultiplier * SPEED.kmh);

  /** Keeps the mode's best score (also when leaving mid-game with ESC). */
  function recordScore() {
    const score = scoreOf();
    if (score <= best[mode]) return;
    best[mode] = score;
    saveNumber(STORAGE.best[mode], score);
  }

  /**
   * Controls stay disabled during the move; controls.update() applies the orbit limits, so the
   * game camera ends up clamped. The orbit target eases back to the home target too (it is off
   * it after free ride or a crash); a move into free ride ends pinned to the car.
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
    controls.maxPolarAngle = SCENE.controls.maxPolarAngle;
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
    aim.multiplyScalar(settle(follow, dt));
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
    pinned = next === "free" || (pinned && (next === "idle" || next === "select"));
    input.arm("next", false); // Tab is the browser's again, but over a wreck

    switch (next) {
      case "countdown":
        choice = mode;
        boost = 1;
        car.reset(tweens);
        minigame.play(mode);
        own = MINIGAME.modes.overtake.start;
        pace(0);
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
        counted = 0;
        hud.showGameOver(best[mode]);
        // the road stops with the crash: the palms stay where it found them
        world.speedMultiplier = 0;
        wreckFocus = 0;
        shakeOffset.set(0, 0, 0);
        cameraTween?.cancel();
        controls.maxDistance = MINIGAME.crash.orbit;
        // around a wreck the camera stays above its middle, so never under the road
        controls.maxPolarAngle = Math.PI / 2;
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
        hud.setChoice(choice);
        break;

      case "free":
        choice = "free";
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
    const chosen = MODES.find((of) => of === action);
    if (chosen) {
      if (machine.state !== "select") return; // a minigame clicked in the list
      mode = chosen;
      machine.send("start");
      return;
    }
    switch (action) {
      case "start":
        // the menu, free ride: the list; there: the card lit; game over: the same minigame again
        if (locked()) return;
        if (machine.state === "select") {
          if (choice === "free") {
            machine.send("free");
            break;
          }
          mode = choice;
        }
        machine.send("start");
        break;
      case "left":
      case "right": {
        if (machine.state !== "select") return; // otherwise held, steering
        const i = CHOICES.indexOf(choice) + (action === "left" ? -1 : 1);
        choice = CHOICES[(i + CHOICES.length) % CHOICES.length];
        hud.setChoice(choice);
        break;
      }
      case "free":
      case "exit":
        if (locked()) return;
        if (action === "exit" && hud.reveal()) return; // ESC brings back what H hid, then leaves
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
      // a wreck is the crash's: it poses the car and turns its wheels (game/crash.js)
      if (machine.state !== "gameover") car.update(dt, world.speedMultiplier, steerInput());
      followCar();

      switch (machine.state) {
        case "countdown": {
          minigame.spawning = stateTime >= MINIGAME.trafficStartsAt;
          minigame.update(dt, world.speedMultiplier, pace(0));
          hud.setSpeed(kmh());
          if (stateTime >= MINIGAME.countdown) {
            machine.send("timeout");
            break;
          }
          hud.setCountdown(String(MINIGAME.countdown - Math.floor(stateTime)));
          break;
        }

        case "playing": {
          const level = pace(dt);
          hud.setSpeed(kmh());
          const { crashed, scored } = minigame.update(dt, world.speedMultiplier, level);
          if (crashed) {
            machine.send("crash");
            break;
          }
          if (scored) hud.setLevel(tierOf(minigame.score, mode) + 1);
          if (stateTime < MINIGAME.startLabelDuration) break;
          hud.setCountdown(null);
          // crash mode: how fast the traffic comes at the Bolones, as hard as the crash will be
          if (mode === "crash") {
            hud.setScore(Math.round(SPEED.traffic * world.speedMultiplier * SPEED.kmh), false);
          } else hud.setScore(minigame.score);

          break;
        }

        case "gameover": {
          // the Bolones is still the player's, a little, until its engine stalls
          minigame.control(steerInput(), input.isHeld("faster"));
          hud.setDriveOn(minigame.engine > 0);
          const scale = slowMotion(stateTime, dt);
          // the road under the camera, which rides along with the car in view
          world.speedMultiplier = minigame.wreck(dt * scale, wreckFocus, camera.position) * scale;
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
