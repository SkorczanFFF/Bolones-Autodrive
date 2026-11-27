/**
 * Game states and the only allowed transitions between them. Pure: no three.js, no DOM.
 *
 * idle      - menu, car parked, orbit camera
 * select    - what to play: the minigames and free ride, as in the menu
 * free      - free ride: steering without obstacles
 * countdown - 3-2-1 before the minigame
 * playing   - minigame running
 * gameover  - crash summary, stays until the player picks what next
 *
 * @typedef {"idle" | "select" | "free" | "countdown" | "playing" | "gameover"} GameState
 * @typedef {"start" | "free" | "exit" | "timeout" | "crash"} GameEvent
 */

/** @type {Record<GameState, Partial<Record<GameEvent, GameState>>>} */
const TRANSITIONS = {
  idle: { start: "select", free: "free" },
  select: { start: "countdown", free: "free", exit: "idle" },
  free: { start: "select", exit: "idle" },
  countdown: { exit: "idle", timeout: "playing" },
  playing: { exit: "idle", crash: "gameover" }, // start is ignored on purpose: it would reset mid-game
  gameover: { start: "countdown", free: "free", exit: "idle" }, // start: the same minigame again
};

/**
 * @param {GameState} state
 * @param {GameEvent} event
 * @returns {GameState | null} null when the event is not allowed in this state
 */
export function nextState(state, event) {
  return TRANSITIONS[state][event] ?? null;
}

/**
 * @param {GameState} initial
 * @param {(next: GameState, previous: GameState, event: GameEvent) => void} onChange
 */
export function createStateMachine(initial, onChange) {
  let state = initial;

  return {
    get state() {
      return state;
    },

    /**
     * @param {GameEvent} event
     * @returns {boolean} whether the transition happened
     */
    send(event) {
      const next = nextState(state, event);
      if (!next) return false;
      const previous = state;
      state = next;
      onChange(next, previous, event);
      return true;
    },
  };
}
