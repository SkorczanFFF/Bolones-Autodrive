import { ACTIONS, MINIGAME, TEXT } from "../config.js";
import { ICONS } from "./icons.js";
import { withKey } from "./labels.js";

/** @typedef {import("../config.js").Action} Action */
/** @typedef {import("../game/game.js").Mode} Mode */

/**
 * Called every frame by the game, so it only touches the DOM when something changed.
 *
 * @param {HTMLElement} element
 * @param {string | null} text null hides the element
 * @returns {boolean} whether the text changed
 */
function show(element, text) {
  const hidden = text === null;
  if (element.hidden !== hidden) element.hidden = hidden;
  if (text === null || element.textContent === text) return false;
  element.textContent = text;
  return true;
}

/**
 * Restarts a one-shot CSS animation (class "is-pop"/"is-flash").
 *
 * @param {HTMLElement} element
 * @param {string} className
 */
function replay(element, className) {
  element.classList.remove(className);
  void element.offsetWidth; // force reflow so the animation starts again
  element.classList.add(className);
}

/**
 * Menu, in-game HUD and game-over panel. Visibility per state lives in CSS (`body[data-state]`);
 * texts and accessible names come from config.TEXT (`data-text`, `data-label`), keycaps from
 * config.ACTIONS (`data-key`) and icons from ui/icons.js (`data-icon`). Buttons carry a
 * `data-action` and feed the same actions as the keyboard; `data-hold` buttons are held like keys.
 *
 * Touch screens (`html[data-input="touch"]`, core/device.js) get no minigame for now and no key
 * hints; free ride shows on-screen steering and an exit button instead.
 *
 * @param {Pick<ReturnType<typeof import("../core/input.js").createInput>, "dispatch" | "hold">} input
 * @param {HTMLElement} [root]
 */
export function createHud(
  { dispatch, hold },
  root = /** @type {HTMLElement} */ (document.getElementById("hud")),
) {
  const $ = (/** @type {string} */ selector) =>
    /** @type {HTMLElement} */ (root.querySelector(selector));
  const $$ = (/** @type {string} */ selector) =>
    /** @type {HTMLElement[]} */ ([...root.querySelectorAll(selector)]);
  /** A text of config.TEXT by the key an element names. @param {string} [key] */
  const textOf = (key = "") => String(/** @type {Record<string, unknown>} */ (TEXT)[key]);

  for (const element of $$("[data-text]")) element.textContent = textOf(element.dataset.text);
  for (const element of $$("[data-label]")) {
    element.setAttribute("aria-label", textOf(element.dataset.label));
  }
  for (const element of $$("[data-icon]")) {
    element.innerHTML = ICONS[/** @type {keyof typeof ICONS} */ (element.dataset.icon)];
  }
  root.style.setProperty("--crash-lock", `${MINIGAME.crash.lock}s`); // game over score and buttons
  root.style.setProperty("--crash-shake", `${MINIGAME.crash.shake}s`); // the flash lasts as long
  for (const element of $$("[data-key]")) {
    const { label = "", icon } = ACTIONS[/** @type {Action} */ (element.dataset.key)];
    if (icon) {
      element.innerHTML = ICONS[icon];
      element.setAttribute("aria-label", label);
      element.title = label;
    } else {
      element.textContent = label;
    }
  }

  for (const button of $$("button[data-hold]")) {
    const action = /** @type {Action} */ (button.dataset.hold);
    button.setAttribute("aria-label", ACTIONS[action].label ?? "");
    button.addEventListener("pointerdown", (event) => {
      button.setPointerCapture(event.pointerId); // keeps steering while the finger slides off
      hold(action, true, event.pointerId);
    });
    for (const type of /** @type {const} */ ([
      "pointerup",
      "pointercancel",
      "lostpointercapture",
    ])) {
      button.addEventListener(type, (event) => hold(action, false, event.pointerId));
    }
    button.addEventListener("contextmenu", (event) => event.preventDefault()); // long press
  }

  for (const button of $$("button[data-action]")) {
    button.addEventListener("click", () => {
      button.blur(); // Enter must not "click" it again
      dispatch(/** @type {Action} */ (button.dataset.action));
    });
  }

  const countdown = $(".hud__countdown");
  const scoreboard = $(".hud__scoreboard");
  const score = $("[data-score]");
  const levels = $$("[data-level]");
  const finalScore = $("[data-final-score]");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const newBest = $(".hud__new-best");
  const finalBest = $(".hud__final-best");
  const menuBest = $(".hud__best");
  const bestValues = $$("[data-best]");
  const scoreLabel = $(".hud__scoreboard .stat--main .stat__label");
  const title = $(".hud__gameover-title");
  const finalLevel = $(".hud__final-level");
  const finalCars = $(".hud__final-cars");
  const cars = $("[data-cars]");
  const tally = $(".hud__tally");
  const games = $$(".hud__game");
  const driveOn = $(".hud__drive-on");
  const slower = $(".hud__slower");
  const speedometer = $(".hud__speed");
  const speed = $("[data-speed]");
  /** @type {Mode} */
  let mode = "dodge";
  const records = { dodge: 0, crash: 0, overtake: 0 };
  let record = 0; // game over's: to beat
  const menuToggle = $(".hud__toggle");
  const wreck = $("[data-wreck]");
  const wreckCount = $("[data-wreck-count]");
  wreck.parentElement?.setAttribute("title", withKey(TEXT.nextCar, "next"));

  /** The best scores: of the mode in the game and game over, of both in the menu. */
  function showBest() {
    for (const element of bestValues) show(element, String(records[mode]));
    for (const [of, value] of Object.entries(records)) {
      for (const entry of $$(`[data-record="${of}"]`)) {
        entry.hidden = value <= 0;
        show(/** @type {HTMLElement} */ (entry.querySelector("[data-value]")), String(value));
      }
    }
    menuBest.hidden = Object.values(records).every((value) => value <= 0);
  }

  /** @param {boolean} visible */
  function setMenuVisible(visible) {
    document.body.dataset.menu = visible ? "visible" : "hidden";
    const label = withKey(visible ? TEXT.menuHide : TEXT.menuShow, "menu");
    menuToggle.title = label;
    menuToggle.setAttribute("aria-label", label);
    menuToggle.setAttribute("aria-pressed", String(!visible));
  }
  setMenuVisible(true);

  return {
    /**
     * Hides or shows the menu or game over, all but the toggle: the scene and the scene GUI stay
     * usable. Every state starts with it shown.
     */
    toggleMenu() {
      setMenuVisible(document.body.dataset.menu === "hidden");
    },

    /** @param {import("../game/state.js").GameState} state */
    setState(state) {
      document.body.dataset.state = state;
      setMenuVisible(true);
    },

    /**
     * The car of the wreck the camera follows, of how many (game over).
     *
     * @param {string[]} labels the cars that crashed, in the order they did
     * @param {number} which
     */
    setWreck(labels, which) {
      show(wreck, labels[which]);
      show(wreckCount, `${which + 1}/${labels.length}`);
    },

    /** @param {string | null} text null hides the countdown */
    setCountdown(text) {
      if (show(countdown, text)) replay(countdown, "is-pop");
    },

    /**
     * The minigame chosen in their list: lit up.
     *
     * @param {Mode} chosen
     */
    setChoice(chosen) {
      for (const game of games) {
        const lit = game.dataset.action === chosen;
        game.classList.toggle("button--primary", lit);
        if (lit) game.setAttribute("aria-current", "true");
        else game.removeAttribute("aria-current"); // an empty one would read as false
      }
    },

    /**
     * The minigame's mode: what the scoreboard and game over show, the best score of which.
     *
     * @param {Mode} value
     */
    setMode(value) {
      mode = value;
      const crash = mode === "crash";
      scoreLabel.textContent = crash ? TEXT.speed : TEXT.score;
      title.textContent = crash ? TEXT.wrecked : TEXT.gameOver;
      finalLevel.hidden = crash;
      finalCars.hidden = !crash;
      tally.hidden = !crash;
      driveOn.hidden = !crash;
      slower.hidden = mode !== "overtake";
      speedometer.hidden = mode !== "overtake";
      showBest();
    },

    /**
     * @param {number | null} value null hides the scoreboard
     * @param {boolean} [pop] a count pops at every new number, a speed does not
     */
    setScore(value, pop = true) {
      scoreboard.hidden = value === null;
      if (value !== null && show(score, String(value)) && pop) replay(score, "is-pop");
    },

    /** @param {number} value */
    setLevel(value) {
      for (const level of levels) {
        if (show(level, String(value)) && value > 1) replay(level, "is-flash");
      }
    },

    /**
     * @param {Mode} of
     * @param {number} value 0 = no record yet
     */
    setBest(of, value) {
      records[of] = value;
      showBest();
    },

    /** @param {number} best the record to beat: NEW BEST! once the score counts past it */
    showGameOver(best) {
      record = best;
      finalScore.classList.remove("is-tick", "is-final");
      show(finalScore, "0");
      newBest.hidden = true;
      finalBest.hidden = false;
    },

    /**
     * Counts the game over score up, every new number ticking; once there, it flashes and keeps
     * pulsing (CSS), until the score grows again (crash mode). Past the record, NEW BEST! takes
     * the record's place. Called every frame by the game once the score is in.
     *
     * @param {number} counted how far the count has got
     * @param {number} total the score
     */
    countGameOver(counted, total) {
      const shown = reducedMotion.matches ? total : Math.floor(counted);
      if (show(finalScore, String(shown))) {
        finalScore.classList.remove("is-final");
        replay(finalScore, "is-tick");
      }
      if (shown >= total && !finalScore.classList.contains("is-final")) {
        finalScore.classList.remove("is-tick");
        finalScore.classList.add("is-final");
      }
      newBest.hidden = shown <= record;
      finalBest.hidden = shown > record; // the record is this score
    },

    /** The Bolones' speedometer (overtake), km/h. @param {number} value */
    setSpeed(value) {
      show(speed, String(value));
    },

    /**
     * The hint to drive the wreck on, while its engine runs (crash mode's game over).
     *
     * @param {boolean} running
     */
    setDriveOn(running) {
      driveOn.hidden = !running;
    },

    /**
     * What the crash wrecked (crash mode's game over).
     *
     * @param {import("../game/minigame.js").Damage} damage
     */
    setDamage({ kJ, parts, posts, others }) {
      show(cars, `×${others}`);
      const { crush, parts: off, posts: hit } = TEXT.tally;
      const items = [`${crush} ${kJ} kJ`];
      if (parts) items.push(`${off} ${parts}`);
      if (posts) items.push(`${hit} ${posts}`);
      show(tally, items.join(" · "));
    },
  };
}
