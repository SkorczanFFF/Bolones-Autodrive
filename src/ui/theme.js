import { LAYERS, PALETTE, SUN } from "../config.js";
import { oklchHue } from "./color.js";

/** @param {string} name camelCase */
const toCssName = (name) => `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/**
 * The scene colors' defaults, by the name setSceneColor gets: `<layer>Solid`, `<layer>Wire`
 * (config.LAYERS), `sunTop`, `sunBottom` (config.SUN).
 *
 * @type {Record<string, string>}
 */
const SCENE_DEFAULTS = Object.fromEntries([
  ...Object.entries(LAYERS).flatMap(([key, layer]) => [
    [`${key}Solid`, layer.solid],
    [`${key}Wire`, layer.wire],
  ]),
  ["sunTop", SUN.top],
  ["sunBottom", SUN.bottom],
]);

/**
 * The colors style.css reads (`var(--palette-…)`, `var(--scene-…)`, `var(--scene-…-turn)`), by
 * their names in PALETTE and SCENE_DEFAULTS: only they are written, as each write restyles the
 * whole page (tests/theme.test.js keeps them to what style.css reads).
 */
const READ = {
  palette: /** @type {Set<keyof typeof PALETTE>} */ (
    new Set(["pink", "aqua", "yellow", "red", "white", "uiDeep", "uiLoaderBg"])
  ),
  scene: new Set([
    "bolonesSolid",
    "bolonesWire",
    "hillsWire",
    "sideWire",
    "terrainSolid",
    "terrainWire",
    "sunTop",
    "sunBottom",
  ]),
  turns: new Set(["bolonesWire", "terrainWire", "sunTop"]),
};

/** The default hues (oklch degrees) of the scene colors whose turn style.css reads. */
const HUES = Object.fromEntries(
  [...READ.turns].map((name) => [name, oklchHue(SCENE_DEFAULTS[name])]),
);

/**
 * Exposes a scene color to CSS (`bolonesWire` -> `--scene-bolones-wire`), with how far its hue
 * has turned from its default (`--scene-bolones-wire-turn`, oklch degrees), so the UI can wear
 * the scene's current colors: the logo, and the UI tints that take a scene color's hue while
 * keeping their own lightness and chroma (`oklch(from …)` in style.css); what style.css reads
 * (READ), no more. The scene GUI calls it on every color change.
 *
 * @param {string} name camelCase, see SCENE_DEFAULTS
 * @param {string} value CSS color
 * @param {HTMLElement} [root]
 */
export function setSceneColor(name, value, root = document.documentElement) {
  if (READ.scene.has(name)) root.style.setProperty(toCssName(`scene-${name}`), value);
  if (!READ.turns.has(name)) return;
  const turn = oklchHue(value) - HUES[name];
  root.style.setProperty(toCssName(`scene-${name}-turn`), turn.toFixed(1));
}

/**
 * Exposes PALETTE (`uiDeep` -> `--palette-ui-deep`) and the starting scene colors (see
 * setSceneColor) as CSS custom properties, what style.css reads of them (READ), so stylesheets
 * never hardcode colors. UI stays hidden until this ran (see the inline style in index.html).
 *
 * @param {HTMLElement} [root]
 */
export function applyTheme(root = document.documentElement) {
  for (const name of READ.palette) {
    root.style.setProperty(toCssName(`palette-${name}`), PALETTE[name]);
  }
  for (const [name, value] of Object.entries(SCENE_DEFAULTS)) setSceneColor(name, value, root);

  const meta = /** @type {HTMLMetaElement | null} */ (
    document.querySelector('meta[name="theme-color"]')
  );
  if (meta) meta.content = PALETTE.pink;

  root.dataset.theme = "ready";
}
