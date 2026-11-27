import { describe, expect, it } from "vitest";
import { LAYERS, SUN } from "../src/config.js";
import { mulberry32 } from "../src/core/noise.js";
import { contrast, oklchOf } from "../src/ui/color.js";
import { MIN_LINE_CONTRAST, createRandomPalette } from "../src/ui/randomPalette.js";

/** Many palettes from a fixed seed. */
const palettes = (count = 300) => {
  const random = mulberry32(42);
  return Array.from({ length: count }, () => createRandomPalette(random));
};

/** How far apart two oklch hues are, degrees (0 to 180). */
const apart = (/** @type {number} */ a, /** @type {number} */ b) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

/** Whether a layer was made by day (a pastel fill under deep lines) or by night. */
const byDay = (/** @type {{ solid: string }} */ { solid }) => oklchOf(solid).l > 0.5;

describe("random palette", () => {
  it("gives a hex color for every control", () => {
    const { mood, layers, ...sky } = createRandomPalette(mulberry32(1));
    const colors = [...Object.values(layers).flatMap(({ solid, wire }) => [solid, wire])];
    colors.push(...Object.values(sky));
    expect(Object.keys(layers).sort()).toEqual(Object.keys(LAYERS).sort());
    for (const color of colors) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("keeps every line readable against its fill", () => {
    for (const { layers } of palettes()) {
      for (const { solid, wire } of Object.values(layers)) {
        expect(contrast(wire, solid)).toBeGreaterThanOrEqual(MIN_LINE_CONTRAST);
      }
    }
  });

  it("by night: dark fills under colorful light lines; by day: pastel fills, not white", () => {
    for (const { layers } of palettes()) {
      for (const layer of Object.values(layers)) {
        const [fill, line] = [oklchOf(layer.solid), oklchOf(layer.wire)];
        if (byDay(layer)) {
          expect(fill.c).toBeGreaterThan(0.03); // a pastel, not white
          expect(fill.l).toBeLessThan(0.86); // lit, it comes out up to 2.5 times as bright
          expect(line.l).toBeLessThan(fill.l);
        } else {
          expect(fill.l).toBeLessThan(0.4);
          expect(line.l).toBeGreaterThan(0.55);
          expect(line.c).toBeGreaterThan(0.05);
        }
      }
    }
  });

  it("keeps the Bolones apart from the traffic, the rocks and the palms, as by default", () => {
    for (const { layers } of palettes()) {
      const { bolones, traffic, rock, palm } = layers;
      // by night the lines tell them apart, by day the fills
      const tell = (/** @type {{ solid: string, wire: string }} */ layer) =>
        oklchOf(byDay(layer) ? layer.solid : layer.wire).h;
      for (const other of [traffic, rock, palm]) {
        expect(apart(tell(bolones), tell(other))).toBeGreaterThan(20);
      }
    }
  });

  it("keeps the rocks apart from the ground they lie on, by day too", () => {
    for (const { layers } of palettes()) {
      const { rock, terrain } = layers;
      if (!byDay(rock) || !byDay(terrain)) continue;
      expect(apart(oklchOf(rock.solid).h, oklchOf(terrain.solid).h)).toBeGreaterThan(25);
    }
  });

  it("gives the things on the road one mood, the world the other, when mixed", () => {
    let mixed = 0;
    for (const { mood, layers } of palettes()) {
      const things = [layers.bolones, layers.traffic, layers.palm, layers.rock].map(byDay);
      const world = [layers.hills, layers.side, layers.road, layers.terrain].map(byDay);
      expect(new Set(things).size).toBe(1);
      expect(new Set(world).size).toBe(1);
      expect(things[0] !== world[0]).toBe(mood === "mixed");
      if (mood === "mixed") mixed++;
    }
    expect(mixed).toBeGreaterThan(0);
  });

  it("keeps the sun from one end of it to the other as far round as the default's", () => {
    const [top, bottom] = [oklchOf(SUN.top).h, oklchOf(SUN.bottom).h];
    for (const palette of palettes()) {
      const turned = apart(oklchOf(palette.sunTop).h, oklchOf(palette.sunBottom).h);
      expect(Math.abs(turned - apart(top, bottom))).toBeLessThan(15);
    }
  });

  it("keeps the sky dark at night, glowing at the horizon, and light by day", () => {
    for (const { layers, sky, fog } of palettes()) {
      if (byDay(layers.terrain)) {
        expect(oklchOf(sky).l).toBeGreaterThan(0.8);
      } else {
        expect(contrast(fog, "#000")).toBeGreaterThan(contrast(sky, "#000"));
      }
    }
  });

  it("never turns the landscape's family a muddy olive", () => {
    for (const { sky } of palettes()) {
      const { h } = oklchOf(sky);
      expect(h > 40 && h < 140).toBe(false);
    }
  });

  it("is reproducible with a seeded random", () => {
    expect(createRandomPalette(mulberry32(7))).toEqual(createRandomPalette(mulberry32(7)));
  });
});
