import * as THREE from "three";
import { LOADER, TEXT } from "../config.js";

/**
 * Text progress bar, e.g. `LOADING: [=====               ] 25%`.
 *
 * @param {number} loaded
 * @param {number} total
 * @param {number} [barLength]
 */
export function formatProgress(loaded, total, barLength = LOADER.barLength) {
  const ratio = total > 0 ? Math.min(loaded / total, 1) : 0;
  const filled = Math.floor(ratio * barLength);
  const bar = "=".repeat(filled) + " ".repeat(barLength - filled);
  return `${TEXT.loading}: [${bar}] ${Math.floor(ratio * 100)}%`;
}

/** @param {string} url */
const fileName = (url) => (url.split("/").pop() ?? url).toUpperCase();

/** @typedef {keyof typeof TEXT.loaderSteps} LoaderStep */

/** The steps of the startup after the files, in the order they run (TEXT.loaderSteps). */
const STEPS = /** @type {LoaderStep[]} */ (Object.keys(TEXT.loaderSteps));

/**
 * Once the browser has painted what was just set. A hidden page paints nothing: after 100 ms then
 * (a second, where the browser slows a hidden page's timers down).
 */
const painted = () =>
  new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve));
    setTimeout(resolve, 100);
  });

/**
 * 80s terminal loading screen: what is being done (the files loading through a
 * THREE.LoadingManager, then each step of the startup, step()) and a bar over all of it. The steps
 * hold the main thread, so each is shown before it runs. Removal runs on the main loop (`update`),
 * so there is no reliance on CSS events.
 *
 * @param {HTMLElement} [root]
 */
export function createLoader(
  root = /** @type {HTMLElement} */ (document.getElementById("loader")),
) {
  const $ = (/** @type {string} */ selector) =>
    /** @type {HTMLElement} */ (root.querySelector(selector));
  const text = $(".loader__text");
  const progress = $(".loader__progress");
  const status = $(".loader__status");

  $(".loader__header").textContent = TEXT.loaderHeader;
  text.textContent = TEXT.loaderIntro;
  root.style.setProperty("--loader-fade-delay", `${LOADER.fadeDelay}s`);
  root.style.setProperty("--loader-fade-duration", `${LOADER.fadeDuration}s`);
  root.style.setProperty("--loader-line-opacity", String(LOADER.lineOpacity));

  let files = { loaded: 0, total: 0 };
  let done = 0; // steps
  const draw = () => {
    progress.textContent = formatProgress(files.loaded + done, files.total + STEPS.length);
  };
  draw();

  const manager = new THREE.LoadingManager();
  manager.onProgress = (url, loaded, total) => {
    files = { loaded, total };
    draw();
    status.textContent = `${TEXT.loading}: ${fileName(url)}`;
  };
  manager.onError = (url) => {
    status.textContent = `${TEXT.loaderError}: ${fileName(url)}`;
  };

  /** @type {"loading" | "fading" | "removed" | "failed"} */
  let state = "loading";
  let fadeLeft = 0;

  return {
    manager,

    /**
     * Shows a step of the startup about to run (the ones before it are done), once it is on the
     * screen.
     *
     * @param {LoaderStep} step
     */
    step(step) {
      done = STEPS.indexOf(step);
      draw();
      text.textContent = TEXT.loaderSteps[step];
      status.textContent = "";
      return painted();
    },

    /** @param {number} dt */
    update(dt) {
      if (state !== "fading") return;
      fadeLeft -= dt;
      if (fadeLeft > 0) return;
      root.remove();
      state = "removed";
    },

    /** Shows "ready", fades out (CSS transition) and removes itself once the fade is over. */
    finish() {
      state = "fading";
      fadeLeft = LOADER.fadeDelay + LOADER.fadeDuration;
      done = STEPS.length;
      draw();
      status.textContent = TEXT.loaderReady;
      root.classList.add("is-done");
    },

    /** @param {string} message */
    fail(message) {
      state = "failed";
      status.textContent = message;
    },
  };
}
