import { CRT, LAYERS, NIGHT, SCENE, SUN } from "../config.js";
import { createRandom } from "../core/random.js";
import { contrast, luminance, oklch, oklchOf } from "./color.js";

/** @typedef {import("./color.js").Oklch} Oklch */

/**
 * The default palette (config.LAYERS, SCENE, SUN, NIGHT, CRT) in oklch: every random palette is
 * made from it, keeping what each color does in it. The fills are a family (the landscape's
 * violets, the rocks' and the traffic's blues, the Bolones the most colorful of them); every
 * layer's lines have a hue of their own (the Bolones' pink apart from the traffic's lavender, the
 * rocks' cyan and the palms' orange); the sun goes from the road's yellow to the Bolones' pink,
 * the fog glows in the Bolones' hue.
 */
const TEMPLATE = {
  layers: Object.fromEntries(
    Object.entries(LAYERS).map(([key, { solid, wire }]) => [
      key,
      { solid: oklchOf(solid), wire: oklchOf(wire) },
    ]),
  ),
  sky: oklchOf(SCENE.background),
  fog: oklchOf(SCENE.fog.color),
  sunTop: oklchOf(SUN.top),
  sunBottom: oklchOf(SUN.bottom),
  night: oklchOf(NIGHT.color),
  stars: oklchOf(NIGHT.starColor),
  moon: oklchOf(NIGHT.moon.color),
  crt: oklchOf(CRT.lineColor),
};

/** The things on the road; the other layers and the sky are the world they are in. */
const THINGS = new Set(["bolones", "traffic", "palm", "rock"]);

/**
 * Contrast (WCAG ratio) a line needs against its fill to stand out: the coloring-book look. 3:1
 * is the WCAG minimum for graphics; it leaves the lines colorful instead of pushing them
 * towards white (on dark fills) or black (on light ones).
 */
export const MIN_LINE_CONTRAST = 3;

/** Fills at least this bright (relative luminance) get lines darker than them, not lighter. */
const LIGHT_FILL = 0.18;

/**
 * Palette moods, with their odds: "night" is the default look (dark fills, neon lines, a dark sky
 * glowing at the horizon); "day" turns it pastel (soft colorful fills, deep lines, a light sky);
 * "mixed" gives the things on the road one of them, the world the other.
 *
 * @typedef {"night" | "day" | "mixed"} PaletteMood
 * @type {[PaletteMood, number][]}
 */
const MOODS = [
  ["night", 0.45],
  ["day", 0.35],
  ["mixed", 0.2],
];

/**
 * How much lighter a pastel of a hue (oklch degrees) is picked: the most at yellow, none from 45°
 * either side of it.
 *
 * @param {number} hue
 */
const yellow = (hue) => 0.12 * Math.max(0, Math.cos(((hue - 105) * Math.PI) / 90));

/**
 * How light and how colorful a color of the template comes out by night and by day (oklch
 * lightness, chroma). By night as it is. By day inside out: a layer's fill is its lines' color made
 * pastel (every layer a hue of its own, as colorful as its lines were; turned as far from it as
 * its fill is from the landscape's, as the rocks' from the ground they lie on, whose lines are
 * alike), its lines its fill's made deep (the coloring book's outlines); the sky and the fog a light haze, the sun pastel from its
 * top to its bottom, the scan lines dark. Lit, a fill comes out up to about 2.5 times as bright
 * (SCENE.lights): a pastel picked as it should look would come out white. A yellow one is picked
 * lighter (`yellow`): as light as the others, it would come out mustard. The night behind the
 * car, its stars and moon stay as they are.
 *
 * @type {Record<"night" | "day", Record<string, (color: Oklch, hue: number) => { l: number, c: number }>>}
 */
const LOOKS = {
  night: {},
  day: {
    solid: ({ l, c }, hue) => ({ l: 0.68 + 0.15 * (l - 0.75) + yellow(hue), c: 0.55 * c }),
    wire: ({ l, c }) => ({ l: 0.3 + 0.5 * (l - 0.14), c: 0.1 + 0.5 * c }),
    sky: () => ({ l: 0.86, c: 0.07 }),
    fog: ({ c }) => ({ l: 0.88, c: 0.5 * c }),
    sunTop: ({ c }) => ({ l: 0.9, c: 0.8 * c }),
    sunBottom: ({ c }) => ({ l: 0.74, c: 0.8 * c }),
    crt: ({ c }) => ({ l: 0.45, c }),
  },
};

/**
 * A random palette made from the default one: its hues turned round together (mirrored or not),
 * so every color keeps its part (the landscape one family, every layer's lines their own hue, the
 * Bolones apart from the rest), in one of the MOODS; lines always readable against their fill.
 * The fills' family (by day the lines') stays mint to red through blue: lit, a dark olive or a
 * yellow-green pastel comes out muddy.
 *
 * @param {() => number} [random] numbers in [0, 1), e.g. seeded in tests
 */
export function createRandomPalette(random = Math.random) {
  const { between } = createRandom(random);
  let roll = random();
  const [mood] = /** @type {[PaletteMood, number]} */ (
    MOODS.find(([, odds]) => (roll -= odds) < 0) ?? MOODS[0]
  );
  const world = mood === "mixed" ? (random() < 0.5 ? "night" : "day") : mood;
  const things = mood === "mixed" ? (world === "night" ? "day" : "night") : mood;
  // the turn: the landscape's hue goes there, the others along (or mirrored about it)
  const anchor = TEMPLATE.sky.h;
  const to = between(150, 390);
  const mirror = random() < 0.5 ? -1 : 1;
  const vivid = between(0.85, 1.15); // all of it a little more or less colorful

  /**
   * A color of the template in this palette: its hue turned (a few degrees either way), as light
   * and as colorful as the mood makes its role.
   *
   * @param {Oklch} color
   * @param {string} role
   * @param {"night" | "day"} look
   */
  const made = (color, role, look) => {
    const turned = mirror * (color.h - anchor) + to + between(-4, 4);
    const h = ((turned % 360) + 360) % 360;
    const { l, c } = LOOKS[look][role]?.(color, h) ?? color;
    return { l: l + between(-0.03, 0.03), c: c * vivid * between(0.9, 1.1), h };
  };
  const hex = (/** @type {Oklch} */ { l, c, h }) => oklch(l, c, h);

  /**
   * A line for a fill: lighter on a dark fill, darker on a light one, until it stands out.
   *
   * @param {Oklch} line
   * @param {string} fill
   */
  const readable = (line, fill) => {
    const step = luminance(fill) >= LIGHT_FILL ? -0.03 : 0.03;
    let { l } = line;
    let color = hex(line);
    while (contrast(color, fill) < MIN_LINE_CONTRAST && l > 0.15 && l < 0.97) {
      l += step;
      color = oklch(l, line.c, line.h);
    }
    return color;
  };

  const layers = Object.fromEntries(
    Object.entries(TEMPLATE.layers).map(([key, { solid, wire }]) => {
      const look = THINGS.has(key) ? things : world;
      const [filled, lined] =
        look === "day" ? [{ ...wire, h: wire.h + solid.h - anchor }, solid] : [solid, wire];
      const fill = hex(made(filled, "solid", look));
      return [key, { solid: fill, wire: readable(made(lined, "wire", look), fill) }];
    }),
  );
  /** @param {"sky" | "fog" | "sunTop" | "sunBottom" | "crt"} role */
  const sky = (role) => hex(made(TEMPLATE[role], role, world));
  return {
    mood,
    /** @type {Record<string, { solid: string, wire: string }>} each layer's fill and lines */
    layers,
    sky: sky("sky"),
    fog: sky("fog"),
    sunTop: sky("sunTop"),
    sunBottom: sky("sunBottom"),
    crt: sky("crt"),
    // the night behind the car stays night in every mood, with pale stars and moon
    night: hex(made(TEMPLATE.night, "night", "night")),
    stars: hex(made(TEMPLATE.stars, "stars", "night")),
    moon: hex(made(TEMPLATE.moon, "moon", "night")),
  };
}

/** @typedef {ReturnType<typeof createRandomPalette>} Palette */
/**
 * What "Randomize all" gives a color control: a layer's fill or lines, or a color of the sky.
 *
 * @typedef {"solid" | "wire" | Exclude<keyof Palette, "mood" | "layers">} PaletteRole
 */
