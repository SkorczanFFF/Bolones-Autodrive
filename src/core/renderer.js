import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SCENE } from "../config.js";
import { createBloom } from "./bloom.js";

/**
 * Renderer, scene, camera and orbit controls. The canvas is rendered at SCENE.renderScale
 * of its CSS size and stretched back up by the browser. Expects THREE.ColorManagement off
 * (main.js): the output stays linear.
 *
 * @param {HTMLElement} [container]
 */
export function createView(container = document.body) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false; // one frame can be several passes (bloom); reset per frame

  const canvas = renderer.domElement;
  container.appendChild(canvas);

  const scene = new THREE.Scene();

  const { camera: cam, controls: limits } = SCENE;
  const camera = new THREE.PerspectiveCamera(cam.fov, 1, cam.near, cam.far);
  camera.position.fromArray(cam.position);

  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.minDistance = limits.minDistance;
  controls.maxDistance = limits.maxDistance;
  controls.minPolarAngle = limits.minPolarAngle;
  controls.maxPolarAngle = limits.maxPolarAngle;
  controls.target.fromArray(cam.target);
  controls.update();

  // The cursors are style.css's: OrbitControls leaves an inline `cursor: auto` on the canvas (its
  // constructor connects, and connecting disconnects first), which would always win. Grabbing is
  // set here while the left button holds the orbit, as :active is unreliable under the pointer
  // capture of OrbitControls.
  canvas.style.removeProperty("cursor");
  canvas.addEventListener("pointerdown", (event) => {
    if (controls.enabled && event.button === 0) canvas.dataset.grabbing = "";
  });
  for (const type of ["pointerup", "pointercancel"]) {
    window.addEventListener(type, () => delete canvas.dataset.grabbing);
  }

  const bloom = createBloom(renderer, scene, camera);

  // measured when the canvas's size changes (and at first), not every frame: measured then, the
  // browser lays the page out anew whenever the HUD changed since
  let resized = true;
  new ResizeObserver(() => (resized = true)).observe(canvas);

  function resize() {
    if (!resized) return;
    resized = false;
    const width = Math.floor(canvas.clientWidth * SCENE.renderScale);
    const height = Math.floor(canvas.clientHeight * SCENE.renderScale);
    if (canvas.width === width && canvas.height === height) return;

    renderer.setSize(width, height, false);
    bloom.setSize(width, height);
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.fov = fitFov(camera.aspect);
    camera.updateProjectionMatrix();
  }

  function render() {
    resize();
    renderer.info.reset();
    if (bloom.enabled) bloom.render();
    else renderer.render(scene, camera);
  }

  /**
   * Draws the whole scene once, in view or not, so every shader compiles now, behind the loader,
   * not the first time the camera turns to it (the city behind the car).
   */
  function warmUp() {
    /** @type {THREE.Object3D[]} */
    const culled = [];
    scene.traverse((object) => {
      if (!object.frustumCulled) return;
      object.frustumCulled = false;
      culled.push(object);
    });
    render();
    for (const object of culled) object.frustumCulled = true;
  }

  return { renderer, scene, camera, controls, bloom, render, warmUp };
}

/**
 * Vertical fov for an aspect ratio: SCENE.camera.fov, widened on narrow (portrait) screens so the
 * horizontal fov never drops below SCENE.camera.minHorizontalFov.
 *
 * @param {number} aspect width / height
 */
export function fitFov(aspect) {
  const { fov, minHorizontalFov } = SCENE.camera;
  const halfWidth = Math.tan(THREE.MathUtils.degToRad(minHorizontalFov) / 2);
  const needed = THREE.MathUtils.radToDeg(2 * Math.atan(halfWidth / aspect));
  return Math.max(fov, needed);
}
