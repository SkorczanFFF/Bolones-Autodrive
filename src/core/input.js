import { ACTIONS, SCREEN } from "../config.js";

/** @typedef {import("../config.js").Action} Action */
/** @typedef {(action: Action) => void} ActionListener */
/** @typedef {string | number} Holder a key code or a pointer id */

/**
 * Keyboard -> actions (config.ACTIONS). Everything else (HUD buttons, touch controls) feeds the
 * same actions through `dispatch` and `hold`, so game logic never looks at raw keys.
 *
 * @param {EventTarget} [target]
 */
export function createInput(target = window) {
  /** @type {Map<string, Action>} */
  const actionByCode = new Map();
  for (const [action, { keys }] of Object.entries(ACTIONS)) {
    for (const code of keys) actionByCode.set(code, /** @type {Action} */ (action));
  }

  /**
   * Who holds each action: key codes and pointer ids. An action is held while its set is not
   * empty, so two keys for one action, two fingers on one button, or a finger and a key release
   * it only when the last one lets go.
   *
   * @type {Map<Action, Set<Holder>>}
   */
  const holders = new Map();
  /** @type {Set<ActionListener>} */
  const pressListeners = new Set();
  /** @type {Set<ActionListener>} */
  const releaseListeners = new Set();
  /** @type {Set<Action>} optional actions (ACTIONS) whose keys the game takes at the moment */
  const armed = new Set();

  /** @param {Action} action */
  function dispatch(action) {
    for (const listener of pressListeners) listener(action);
  }

  /** @param {Action} action */
  function dispatchRelease(action) {
    for (const listener of releaseListeners) listener(action);
  }

  /**
   * @param {Action} action
   * @param {Holder} holder
   */
  function press(action, holder) {
    let set = holders.get(action);
    if (!set) holders.set(action, (set = new Set()));
    const first = set.size === 0;
    set.add(holder);
    if (first) dispatch(action);
  }

  /**
   * @param {Action} action
   * @param {Holder} holder
   */
  function release(action, holder) {
    const set = holders.get(action);
    if (!set?.delete(holder) || set.size > 0) return;
    dispatchRelease(action);
  }

  target.addEventListener("keydown", (event) => {
    const { code, repeat } = /** @type {KeyboardEvent} */ (event);
    const action = actionByCode.get(code);
    if (!action || (ACTIONS[action].optional && !armed.has(action))) return;
    event.preventDefault();
    if (repeat) return; // OS auto-repeat must not restart presses
    press(action, code);
  });

  target.addEventListener("keyup", (event) => {
    const { code } = /** @type {KeyboardEvent} */ (event);
    const action = actionByCode.get(code);
    if (action) release(action, code);
  });

  // Keys released while the window had no focus would otherwise stay "held".
  target.addEventListener("blur", () => {
    for (const [action, set] of holders) {
      if (set.size === 0) continue;
      set.clear();
      dispatchRelease(action);
    }
  });

  return {
    dispatch,
    /**
     * An on-screen button held like a key (touch steering).
     *
     * @param {Action} action
     * @param {boolean} down
     * @param {Holder} [holder] the pointer id; tells fingers on the same button apart
     */
    hold(action, down, holder = "pointer") {
      if (down) press(action, holder);
      else release(action, holder);
    },
    /**
     * Two quick taps of one finger on `element` press `action` (a drag, a pinch or a long press
     * do not count): on a touch screen, what a key does.
     *
     * @param {HTMLElement} element
     * @param {Action} action
     */
    doubleTap(element, action) {
      const { within, slop } = SCREEN.doubleTap;
      let fingers = 0;
      /** @type {{ x: number, y: number, time: number } | null} this tap's start */
      let down = null;
      let last = { x: 0, y: 0, time: -Infinity }; // the last tap's end
      const near = (/** @type {PointerEvent} */ e, /** @type {{ x: number, y: number }} */ p) =>
        Math.hypot(e.clientX - p.x, e.clientY - p.y) <= slop;
      element.addEventListener("pointerdown", (e) => {
        if (e.pointerType !== "touch") return;
        fingers++;
        down = fingers === 1 ? { x: e.clientX, y: e.clientY, time: e.timeStamp } : null;
      });
      element.addEventListener("pointercancel", (e) => {
        if (e.pointerType !== "touch") return;
        fingers = Math.max(0, fingers - 1);
        down = null;
      });
      element.addEventListener("pointerup", (e) => {
        if (e.pointerType !== "touch") return;
        fingers = Math.max(0, fingers - 1);
        const tap = down && near(e, down) && e.timeStamp - down.time <= within * 1000;
        down = null;
        if (!tap) return void (last.time = -Infinity);
        if (e.timeStamp - last.time <= within * 1000 && near(e, last)) {
          last.time = -Infinity;
          dispatch(action);
        } else last = { x: e.clientX, y: e.clientY, time: e.timeStamp };
      });
    },
    /** @param {Action} action */
    isHeld: (action) => (holders.get(action)?.size ?? 0) > 0,
    /**
     * Takes the keys of an optional action from the browser, or gives them back.
     *
     * @param {Action} action
     * @param {boolean} on
     */
    arm(action, on) {
      if (on) armed.add(action);
      else armed.delete(action);
    },
    /** @param {ActionListener} listener */
    onPress: (listener) => pressListeners.add(listener),
    /** @param {ActionListener} listener */
    onRelease: (listener) => releaseListeners.add(listener),
  };
}
