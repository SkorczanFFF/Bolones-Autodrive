import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { densify, fillPoints, ladder, rounded, triangulate } from "../src/scene/polygons.js";

/** @typedef {[number, number]} Point */

/** The smallest angle of each triangle, degrees. @param {Point[]} points @param {number[][]} triangles */
const smallestAngles = (points, triangles) =>
  triangles.map((t) => {
    const [a, b, c] = t.map((i) => new THREE.Vector2(...points[i]));
    return Math.min(
      ...[
        [a, b, c],
        [b, c, a],
        [c, a, b],
      ].map(([p, q, r]) => THREE.MathUtils.radToDeg(q.clone().sub(p).angleTo(r.clone().sub(p)))),
    );
  });

/**
 * Whether triangles (as points) are the same either side of x = 0: each one to one side its
 * mirror image one of them (one across the middle has none to have).
 *
 * @param {Point[][]} triangles
 */
const mirrorsItself = (triangles) => {
  const key = (/** @type {Point[]} */ t) =>
    t
      .map(([x, y]) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`)
      .sort()
      .join(" ");
  const all = new Set(triangles.map(key));
  return triangles
    .filter((t) => t.every(([x]) => x < 1e-9) || t.every(([x]) => x > -1e-9))
    .every((t) => all.has(key(t.map(([x, y]) => [-x || 0, y]))));
};

describe("triangulate", () => {
  it("cuts a strip with points in line along both sides into a ladder, no slivers", () => {
    // a band 10 cm tall and 2 m long, a point every 15 cm along both sides (as a van's ribs)
    const xs = Array.from({ length: 14 }, (_, k) => (k * 2) / 13);
    /** @type {Point[]} */
    const outline = [
      ...xs.map((x) => /** @type {Point} */ ([x, 0])),
      ...[...xs].reverse().map((x) => /** @type {Point} */ ([x, 0.1])),
    ];
    const triangles = triangulate(outline);
    expect(triangles).toHaveLength(outline.length - 2);
    expect(Math.min(...smallestAngles(outline, triangles))).toBeGreaterThan(10);
  });

  it("keeps the outline's and the holes' sides, with points inside", () => {
    /** @type {Point[]} */
    const outline = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    /** @type {Point[][]} */
    const holes = [
      [
        [0.3, 0.3],
        [0.7, 0.3],
        [0.7, 0.7],
        [0.3, 0.7],
      ],
      [[0.15, 0.85]],
    ];
    const triangles = triangulate(outline, holes);
    const edges = new Set(
      triangles.flatMap((t) => t.map((i, k) => [i, t[(k + 1) % 3]].sort((a, b) => a - b).join())),
    );
    for (const ring of [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ]) {
      ring.forEach((i, k) =>
        expect(edges.has([i, ring[(k + 1) % 4]].sort((a, b) => a - b).join())).toBe(true),
      );
    }
    expect(triangles.flat()).toContain(8); // the point inside is a corner
    // the hole stays empty: no triangle's middle inside it
    const points = [outline, ...holes].flat();
    for (const t of triangles) {
      const [x, y] = [0, 1].map((c) => t.reduce((sum, i) => sum + points[i][c], 0) / 3);
      expect(x > 0.3 && x < 0.7 && y > 0.3 && y < 0.7).toBe(false);
    }
  });
});

describe("a shape the same either side of a car's middle", () => {
  // as a car's rear face round its window: lines along thin triangles show a difference
  /** @type {Point[]} */
  const outline = densify(
    [
      [-0.8, 0],
      [0.8, 0],
      [0.7, 0.6],
      [-0.7, 0.6],
    ],
    0.15,
  );
  /** @type {Point[]} */
  const window = densify(
    rounded(
      [
        [-0.5, 0.2],
        [0.5, 0.2],
        [0.45, 0.45],
        [-0.45, 0.45],
      ],
      0.05,
      1,
    ),
    0.15,
  );

  it("gets points inside the same either side", () => {
    const inside = fillPoints(outline, [window], 0.15, 0.03, 0.3).flat();
    expect(inside.length).toBeGreaterThan(0);
    const keys = new Set(inside.map(([x, y]) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`));
    for (const [x, y] of inside)
      expect(keys.has(`${Math.round(-x * 1e6)},${Math.round(y * 1e6)}`)).toBe(true);
  });

  it("is cut into the same triangles either side", () => {
    const holes = [window, ...fillPoints(outline, [window], 0.15, 0.03, 0.3)];
    const points = [outline, ...holes].flat();
    const triangles = triangulate(outline, holes).map((t) => t.map((i) => points[i]));
    expect(mirrorsItself(triangles)).toBe(true);
  });

  it("is laddered into the same triangles either side", () => {
    const row = (/** @type {number[]} */ xs, /** @type {number} */ y) =>
      xs.map((x) => /** @type {Point} */ ([x, y]));
    const triangles = ladder(
      row([-1, -0.7, -0.2, 0, 0.2, 0.7, 1], 0),
      row([-0.9, -0.4, 0, 0.4, 0.9], 1),
    );
    expect(mirrorsItself(triangles)).toBe(true);
  });
});
