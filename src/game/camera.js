import * as THREE from "three";
import { MINIGAME, SCENE } from "../config.js";
import { settle } from "../core/tween.js";

/** @typedef {import("./state.js").GameState} GameState */

/**
 * The game's camera on its orbit (core/renderer.js view): moved between the menu's view and the
 * minigame's, keeping the car in frame (in free ride riding along with it), after a crash
 * following the car of the wreck in view, shaking at first.
 *
 * @param {object} deps
 * @param {ReturnType<typeof import("../core/renderer.js").createView>} deps.view
 * @param {ReturnType<typeof import("../scene/car.js").createCar>} deps.car
 * @param {import("../core/tween.js").Tweens} deps.tweens
 */
export function createGameCamera({ view, car, tweens }) {
  const { camera, controls } = view;
  const cameraTarget = new THREE.Vector3().fromArray(SCENE.camera.target);
  const homePosition = new THREE.Vector3().fromArray(SCENE.camera.position);
  const gamePosition = new THREE.Vector3().fromArray(SCENE.camera.gamePosition);

  /** @type {import("../core/tween.js").TweenHandle | null} */
  let cameraTween = null;
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

  /**
   * Moves the camera to a view. Controls stay disabled during the move; controls.update() applies
   * the orbit limits, so the game camera ends up clamped. The orbit target eases back to the home
   * target too (it is off it after free ride or a crash); a move into free ride ends pinned to the
   * car.
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

  return {
    /**
     * A state of the game begins: free ride pins the orbit to the car; leaving it for the menu
     * keeps the pin while the car eases back (followCar).
     *
     * @param {GameState} next
     */
    enter(next) {
      pinned = next === "free" || (pinned && (next === "idle" || next === "select"));
    },

    /** Back to the menu's view, the controls the player's again once there. */
    toHome() {
      moveCamera(homePosition, () => (controls.enabled = true));
    },

    /** Over to the minigame's view. */
    toGame() {
      moveCamera(gamePosition);
    },

    /**
     * The camera handed over at once for a wreck: it can be turned round it and pulled back
     * further (MINIGAME.crash.orbit), and stays above its middle, so never under the road.
     */
    overWreck() {
      shakeOffset.set(0, 0, 0);
      cameraTween?.cancel();
      controls.maxDistance = MINIGAME.crash.orbit;
      controls.maxPolarAngle = Math.PI / 2;
      controls.enabled = true;
    },

    /**
     * On portrait screens the steering range is wider than the view: the camera slides sideways,
     * together with its orbit target, only as far as needed to keep the car inside. Landscape
     * screens keep the fixed camera of the desktop version.
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
     *
     * @param {GameState} state the game's
     */
    followCar(state) {
      // the move sets followX itself; after a crash the camera follows the wreck (followWreck)
      if (cameraTween?.isActive() || state === "gameover") return;
      if (pinned && state !== "free" && car.group.position.x === 0) pinned = false;
      const portrait = camera.aspect < 1;
      // landscape: nothing to measure every frame
      if (!pinned && !portrait && followX === 0) return;
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
        // half the view's width per unit of depth
        const halfWidth = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect;
        const room = depth * halfWidth - SCENE.camera.followMargin; // half the view at the corner
        offset = side * Math.max(0, side * (corner.x - base.x) - room);
      }
      const dx = offset - followX;
      if (dx === 0) return;
      camera.position.x += dx;
      controls.target.x += dx;
      followX = offset;
    },

    /**
     * After a crash the orbit follows the car in view (the Bolones first, Tab: the next one),
     * easing over to it (MINIGAME.crash.follow) with the camera keeping its place around it; at
     * first the whole of it shakes, fading out, the harder the hit the more.
     *
     * @param {number} dt real seconds
     * @param {THREE.Vector3} centre the car in view's, in the scene
     * @param {number} impact how hard the crash was (minigame impact)
     * @param {number} time real seconds since the crash
     */
    followWreck(dt, centre, impact, time) {
      const { follow, shake, shakeAmount } = MINIGAME.crash;
      controls.target.sub(shakeOffset);
      camera.position.sub(shakeOffset);
      aim.subVectors(centre, controls.target).multiplyScalar(settle(follow, dt));
      const left = Math.max(0, 1 - time / shake);
      const random = () => Math.random() * 2 - 1;
      shakeOffset.set(random(), random(), 0).multiplyScalar(shakeAmount * impact * left ** 2);
      aim.add(shakeOffset);
      controls.target.add(aim);
      camera.position.add(aim);
      controls.update();
    },
  };
}
