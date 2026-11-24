import { SCREEN } from "../config.js";

/**
 * What the device offers, decided once at start-up and reflected on <html> for the stylesheet:
 * - `touch` (data-input="touch" | "keys"): a coarse pointer that cannot hover, so no keyboard to
 *   hint at (phones, tablets without one);
 * - data-screen="narrow" | "wide" (kept up to date): narrower than SCREEN.phone, a phone held
 *   upright, where the HUD stacks its buttons;
 * - `small`: narrower or lower than SCREEN.phone, a phone either way round, where the scene panel
 *   starts folded (ui/gui.js);
 * - `upright`: held upright, as a minigame on a touch screen must not be (main.js).
 *
 * @param {HTMLElement} [root]
 */
export function detectDevice(root = document.documentElement) {
  const touch = matchMedia("(hover: none) and (pointer: coarse)").matches;
  root.dataset.input = touch ? "touch" : "keys";

  const phone = `${SCREEN.phone}px`;
  const narrow = matchMedia(`(max-width: ${phone})`);
  const reflect = () => (root.dataset.screen = narrow.matches ? "narrow" : "wide");
  narrow.addEventListener("change", reflect);
  reflect();

  const small = matchMedia(`(max-width: ${phone}), (max-height: ${phone})`);
  const upright = matchMedia("(orientation: portrait)");

  /**
   * Turns a touch screen sideways for the minigames: full screen, locked that way round, where
   * the browser lets it (not iOS: the HUD asks to turn the phone). Only on a tap.
   */
  function sideways() {
    if (!touch || document.fullscreenElement) return;
    root
      .requestFullscreen?.({ navigationUI: "hide" })
      .then(() => /** @type {any} */ (screen.orientation)?.lock?.("landscape"))
      .catch(() => {}); // refused: the HUD asks to turn it
  }

  return { touch, small, upright, sideways };
}
