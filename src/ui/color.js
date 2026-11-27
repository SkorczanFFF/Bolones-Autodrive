import * as THREE from "three";

/**
 * Color math for the UI and the random palettes, in sRGB as seen on screen. It never reads a
 * THREE.Color's r/g/b as linear: the app turns three's ColorManagement off (main.js),
 * and then those hold sRGB values. Hex in, hex out, the same with ColorManagement on or off.
 */

/** @param {number} channel sRGB, 0..1 */
const toLinear = (channel) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

/** @param {number} channel linear, 0..1 */
const toSrgb = (channel) =>
  channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;

/**
 * A color's linear sRGB channels, 0..1.
 *
 * @param {THREE.ColorRepresentation} color
 */
function linearOf(color) {
  const hex = new THREE.Color(color).getHex();
  return [16, 8, 0].map((shift) => toLinear(((hex >> shift) & 255) / 255));
}

/** @param {number} channel 0..1 */
const byte = (channel) =>
  Math.round(channel * 255)
    .toString(16)
    .padStart(2, "0");

/**
 * Relative luminance (WCAG), 0 (black) to 1 (white).
 *
 * @param {THREE.ColorRepresentation} color
 */
export function luminance(color) {
  const [r, g, b] = linearOf(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio, 1 (same) to 21 (black on white).
 *
 * @param {THREE.ColorRepresentation} a
 * @param {THREE.ColorRepresentation} b
 */
export function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * @typedef {{ l: number, c: number, h: number }} Oklch a color as the eye sees it: lightness 0..1,
 *   chroma (0 gray, about 0.3 the most vivid), hue in degrees (0..360)
 */

/**
 * A color in oklch: lightness, chroma and hue as the eye sees them, which CSS `oklch(from …)`
 * turns (ui/theme.js) and the random palettes are made in (ui/randomPalette.js).
 *
 * @param {THREE.ColorRepresentation} color
 * @returns {Oklch}
 */
export function oklchOf(color) {
  const [r, g, b] = linearOf(color);
  // linear sRGB -> LMS (cube roots) -> oklab (Ottosson)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    c: Math.hypot(a, bb),
    h: (THREE.MathUtils.radToDeg(Math.atan2(bb, a)) + 360) % 360,
  };
}

/** Hue in oklch, degrees (0..360). @param {THREE.ColorRepresentation} color */
export const oklchHue = (color) => oklchOf(color).h;

/**
 * An oklch color as hex: as colorful as asked, or as colorful as sRGB goes at that lightness and
 * hue (its chroma lowered, its lightness and hue kept).
 *
 * @param {number} l lightness, 0..1
 * @param {number} c chroma
 * @param {number} h hue, degrees
 * @returns {string}
 */
export function oklch(l, c, h) {
  const lightness = THREE.MathUtils.clamp(l, 0, 1);
  const [cos, sin] = [Math.cos(THREE.MathUtils.degToRad(h)), Math.sin(THREE.MathUtils.degToRad(h))];
  /** Linear sRGB at a chroma (oklab -> LMS -> linear sRGB). @param {number} chroma */
  const rgb = (chroma) => {
    const [a, b] = [chroma * cos, chroma * sin];
    const l3 = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m3 = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s3 = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
      -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
      -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
    ];
  };
  const fits = (/** @type {number} */ chroma) => rgb(chroma).every((v) => v >= 0 && v <= 1);
  let chroma = Math.max(0, c);
  if (!fits(chroma)) {
    let low = 0;
    for (let i = 0; i < 16; i++) {
      const mid = (low + chroma) / 2;
      if (fits(mid)) low = mid;
      else chroma = mid;
    }
    chroma = low;
  }
  const channels = rgb(chroma).map((v) => byte(THREE.MathUtils.clamp(toSrgb(v), 0, 1)));
  return `#${channels.join("")}`;
}

/**
 * HSV to hex, sRGB: what the color picker's square (saturation, brightness) and hue strip show.
 *
 * @param {number} h hue, 0..1 (1 is red again)
 * @param {number} s saturation, 0..1
 * @param {number} v value (brightness), 0..1
 * @returns {string} hex
 */
export function hsvToHex(h, s, v) {
  /** @param {number} n */
  const channel = (n) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return `#${byte(channel(5))}${byte(channel(3))}${byte(channel(1))}`;
}

/**
 * Hex to HSV, sRGB; the inverse of hsvToHex. Grays and black have no hue: theirs is 0.
 *
 * @param {THREE.ColorRepresentation} color
 * @returns {{ h: number, s: number, v: number }} each 0..1
 */
export function hexToHsv(color) {
  const hex = new THREE.Color(color).getHex();
  const [r, g, b] = [16, 8, 0].map((shift) => ((hex >> shift) & 255) / 255);
  const max = Math.max(r, g, b);
  const range = max - Math.min(r, g, b);
  let h = 0;
  if (range) {
    if (max === r) h = ((g - b) / range + 6) % 6;
    else if (max === g) h = (b - r) / range + 2;
    else h = (r - g) / range + 4;
  }
  return { h: h / 6, s: max ? range / max : 0, v: max };
}

/**
 * A typed or pasted hex color, with or without the "#", 3 or 6 digits, as "#rrggbb"; null while
 * it is not one (yet).
 *
 * @param {string} text
 */
export function parseHex(text) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!match) return null;
  const digits = match[1].length === 3 ? match[1].replace(/./g, "$&$&") : match[1];
  return `#${digits.toLowerCase()}`;
}
