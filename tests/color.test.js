import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import {
  contrast,
  hexToHsv,
  hsvToHex,
  luminance,
  oklch,
  oklchHue,
  oklchOf,
  parseHex,
} from "../src/ui/color.js";
import { PALETTE } from "../src/config.js";

const managed = THREE.ColorManagement.enabled;
afterEach(() => (THREE.ColorManagement.enabled = managed));

describe("color math", () => {
  // the app turns ColorManagement off (main.js, vitest.setup.js); the results must not depend on it
  for (const enabled of [true, false]) {
    it(`gives WCAG luminance and contrast with ColorManagement ${enabled ? "on" : "off"}`, () => {
      THREE.ColorManagement.enabled = enabled;
      expect(luminance("#ffffff")).toBeCloseTo(1);
      expect(luminance("#000000")).toBe(0);
      expect(luminance("#808080")).toBeCloseTo(0.2159, 3);
      expect(luminance(PALETTE.uiDeep)).toBeCloseTo(0.0555, 3);
      expect(contrast("#000000", "#ffffff")).toBeCloseTo(21);
    });

    it(`round-trips oklch as seen on screen with ColorManagement ${enabled ? "on" : "off"}`, () => {
      THREE.ColorManagement.enabled = enabled;
      for (const color of Object.values(PALETTE)) {
        const { l, c, h } = oklchOf(color);
        expect(oklch(l, c, h)).toBe(color);
      }
    });
  }

  it("gives the oklch hue, as CSS sees it", () => {
    expect(oklchHue("#ff0000")).toBeCloseTo(29.2, 0);
    expect(oklchHue("#00ff00")).toBeCloseTo(142.5, 0);
    expect(oklchHue("#0000ff")).toBeCloseTo(264.1, 0);
    expect(oklchOf("#ffffff").l).toBeCloseTo(1);
  });

  it("brings an oklch color too colorful for the screen into it, lightness and hue kept", () => {
    const asked = { l: 0.85, c: 0.4, h: 250 }; // no sky blue this light is this colorful
    const made = oklchOf(oklch(asked.l, asked.c, asked.h));
    expect(made.c).toBeLessThan(asked.c);
    expect(made.c).toBeGreaterThan(0.05); // as colorful as it goes, not gray
    expect(made.l).toBeCloseTo(asked.l, 2);
    expect(made.h).toBeCloseTo(asked.h, 0);
  });

  it("turns HSV into hex and back, for the color picker", () => {
    expect(hsvToHex(0, 1, 1)).toBe("#ff0000");
    expect(hsvToHex(1 / 3, 1, 1)).toBe("#00ff00");
    expect(hsvToHex(1, 1, 1)).toBe("#ff0000"); // the end of the hue strip is red again
    expect(hsvToHex(0.5, 0, 0.5)).toBe("#808080");
    expect(hexToHsv("#000000")).toEqual({ h: 0, s: 0, v: 0 });
    for (const color of Object.values(PALETTE)) {
      const { h, s, v } = hexToHsv(color);
      expect(hsvToHex(h, s, v)).toBe(color);
    }
  });

  it("reads typed hex colors, with or without the #", () => {
    expect(parseHex("#FF2A6D")).toBe("#ff2a6d");
    expect(parseHex(" ff2a6d ")).toBe("#ff2a6d");
    expect(parseHex("f2a")).toBe("#ff22aa");
    expect(parseHex("ff2a6")).toBeNull();
    expect(parseHex("#ggg")).toBeNull();
  });
});
