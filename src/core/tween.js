/**
 * The share of the way to a target covered in dt when approaching it exponentially with time
 * constant tau: `value += (target - value) * settle(tau, dt)` draws the same curve at any frame
 * rate.
 *
 * @param {number} tau seconds
 * @param {number} dt seconds
 */
export const settle = (tau, dt) => 1 - Math.exp(-dt / tau);

/**
 * @param {number} t progress 0..1
 */
export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * @typedef {object} TweenOptions
 * @property {number} duration seconds
 * @property {(eased: number) => void} onUpdate called every update with the eased progress
 * @property {() => void} [onComplete]
 * @property {(t: number) => number} [ease]
 */

/**
 * @typedef {object} TweenHandle
 * @property {() => void} cancel stops the tween without calling onComplete
 * @property {() => boolean} isActive
 */

/** @typedef {ReturnType<typeof createTweens>} Tweens */

/**
 * Tweens driven by the main loop.
 */
export function createTweens() {
  /** @type {Set<{ options: TweenOptions, elapsed: number }>} */
  const active = new Set();

  return {
    /**
     * @param {TweenOptions} options
     * @returns {TweenHandle}
     */
    add(options) {
      const tween = { options, elapsed: 0 };
      active.add(tween);
      return {
        cancel: () => active.delete(tween),
        isActive: () => active.has(tween),
      };
    },

    /** @param {number} dt */
    update(dt) {
      for (const tween of active) {
        const { duration, onUpdate, onComplete, ease = easeInOutCubic } = tween.options;
        tween.elapsed += dt;
        const progress = duration > 0 ? Math.min(tween.elapsed / duration, 1) : 1;
        onUpdate(ease(progress));
        if (progress === 1) {
          active.delete(tween);
          onComplete?.();
        }
      }
    },
  };
}
