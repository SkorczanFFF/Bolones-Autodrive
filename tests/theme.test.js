// @ts-expect-error no @types/node in this browser project; the tests run in node
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { LAYERS } from "../src/config.js";
import { oklchHue } from "../src/ui/color.js";
import { applyTheme, setSceneColor } from "../src/ui/theme.js";

/** A stand-in for <html>: records the custom properties set on it. */
function root() {
  /** @type {Map<string, string>} */
  const vars = new Map();
  const style = {
    setProperty: (/** @type {string} */ n, /** @type {string} */ v) => vars.set(n, v),
  };
  return { vars, element: /** @type {any} */ ({ style, dataset: {} }) };
}

describe("scene colors for CSS", () => {
  it("exposes the color and, at its default, no hue turn", () => {
    const { vars, element } = root();
    setSceneColor("terrainWire", LAYERS.terrain.wire, element);
    expect(vars.get("--scene-terrain-wire")).toBe(LAYERS.terrain.wire);
    expect(Number(vars.get("--scene-terrain-wire-turn"))).toBeCloseTo(0);
  });

  it("reports how far the hue turned from the default, in oklch degrees", () => {
    const { vars, element } = root();
    setSceneColor("terrainWire", "#ff2a6d", element);
    const turn = oklchHue("#ff2a6d") - oklchHue(LAYERS.terrain.wire);
    expect(Number(vars.get("--scene-terrain-wire-turn"))).toBeCloseTo(turn, 0);
  });

  it("writes what style.css reads of the colors, all of it and no more", () => {
    const css = fs.readFileSync("src/style.css", "utf8");
    const read = [...css.matchAll(/var\((--(?:palette|scene)-[a-z0-9-]+)/g)].map(
      ([, name]) => name,
    );
    const { vars, element } = root();
    vi.stubGlobal("document", { querySelector: () => null });
    try {
      applyTheme(element); // every scene color, at its default
    } finally {
      vi.unstubAllGlobals();
    }
    expect([...vars.keys()].sort()).toEqual([...new Set(read)].sort());
  });

  it("writes nothing for a color style.css does not read", () => {
    const { vars, element } = root();
    setSceneColor("palmWire", "#123456", element);
    expect(vars.size).toBe(0);
  });
});
