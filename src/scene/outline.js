import * as THREE from "three";
import { WIRE } from "../config.js";

/**
 * Outlines in a plane (x, y in metres) that the traffic's shapes are drawn from (scene/sedan.js,
 * scene/van.js, scene/carParts.js, scene/decals.js): sampled, rounded, cut finer, cut into bars,
 * filled with points for a crash to bend them at. polygons.js turns them into geometry,
 * triangulate.js into triangles.
 *
 * @typedef {[number, number]} Point
 */

/** Segments of a rounded corner (a window's, a screen's). */
export const CORNER_STEPS = 4;
/** Stations along and round a car's body at least this close, metres (a crash bends them). */
export const STATION = 0.15;

/**
 * Segments round something round a few centimetres across (a hole in a rim, the Bolones' fuel cap,
 * scene/car.js): an octagon is round enough.
 */
export const HOLE_SEGMENTS = 8;
/**
 * Points inside a flat panel for a crash to bend it (fillPoints): every STATION along, every
 * other one up; the stations round it do the rest.
 */
export const SPARSE = /** @type {const} */ ([STATION, 0.03, 2 * STATION]);

/** Segments of a round lamp (rectangle() with `round` 0.5). */
const LAMP_SEGMENTS = 12;

/**
 * y of a polyline sorted by x, at x (clamped at its ends).
 *
 * @param {Point[]} curve
 * @param {number} x
 */
export function sample(curve, x) {
  if (x <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [[ax, ay], [bx, by]] = [curve[i - 1], curve[i]];
    if (x <= bx) return ay + ((by - ay) * (x - ax)) / (bx - ax);
  }
  return curve[curve.length - 1][1];
}

/**
 * The polygon going counter-clockwise: itself, or reversed.
 *
 * @param {Point[]} polygon
 * @returns {Point[]}
 */
export function counterClockwise(polygon) {
  const clockwise = THREE.ShapeUtils.isClockWise(polygon.map(([x, y]) => new THREE.Vector2(x, y)));
  return clockwise ? [...polygon].reverse() : polygon;
}

/**
 * The sides of a closed outline (side i from point i to the next) in the order to walk them, each
 * with its run: a crease (a turn of WIRE.edgeAngle or more) at a point starts a new run. The walk
 * starts at a crease, so a run never wraps around.
 *
 * @param {Point[]} outline
 * @returns {{ i: number, run: number }[]}
 */
export function creaseRuns(outline) {
  const n = outline.length;
  const crease = Math.cos(THREE.MathUtils.degToRad(WIRE.edgeAngle));
  const direction = (/** @type {number} */ i) => {
    const [a, b] = [outline[i % n], outline[(i + 1) % n]];
    return new THREE.Vector2(b[0] - a[0], b[1] - a[1]).normalize();
  };
  const creases = (/** @type {number} */ i) => direction(i + n - 1).dot(direction(i)) < crease;
  const first = Math.max(
    0,
    outline.findIndex((_, i) => creases(i)),
  );
  let run = -1;
  return outline.map((_, s) => {
    const i = (first + s) % n;
    if (s === 0 || creases(i)) run++;
    return { i, run };
  });
}

/**
 * Points inside an outline and outside its holes, on a grid `step` apart along the first
 * coordinate and `across` along the second, each at least `clear` from every side: corners for
 * a crash to bend a big polygon at (face() takes them as one-point holes). Each is shifted a
 * little off the grid, the same every time: earcut drops the copies it makes of points that lie
 * in line, leaving edges without a neighbour, drawn as lines.
 *
 * @param {Point[]} outline
 * @param {Point[][]} holes
 * @param {number} step
 * @param {number} [clear]
 * @param {number} [across]
 * @returns {Point[][]}
 */
export function fillPoints(outline, holes, step, clear = 0.03, across = step) {
  const [xs, ys] = [outline.map(([x]) => x), outline.map(([, y]) => y)];
  /** A fixed share in -0.5..0.5 for grid point i, j. @param {number} i @param {number} j */
  const shift = (i, j) => {
    const s = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
    return s - Math.floor(s) - 0.5;
  };
  // columns half a step either side of the middle and on out, shifted alike either side
  // (mirrored): a shape the same either side of a car's middle gets the same points either side
  const high = Math.max(...xs);
  const middle = (Math.min(...xs) + high) / 2;
  /** @type {Point[][]} */
  const points = [];
  for (let i = 0; middle + (i + 0.5) * step < high; i++) {
    let j = 0;
    for (let gy = Math.min(...ys) + across / 2; gy < Math.max(...ys); gy += across, j++) {
      for (const side of [-1, 1]) {
        const x = middle + side * ((i + 0.5) * step + 0.3 * step * shift(i, j));
        const p = /** @type {Point} */ ([x, gy + 0.3 * across * shift(j + 7, i + 3)]);
        const inside = contains(outline, p) && !holes.some((hole) => contains(hole, p));
        if (inside && [outline, ...holes].every((polygon) => distanceTo(polygon, p) > clear)) {
          points.push([p]);
        }
      }
    }
  }
  return points;
}

/**
 * A convex outline cut into `count` horizontal bars (one bar: the outline itself).
 *
 * @param {Point[]} outline
 * @param {number} count
 * @returns {Point[][]}
 */
export function bars(outline, count) {
  if (count === 1) return [outline];
  const ys = outline.map(([, y]) => y);
  const [bottom, top] = [Math.min(...ys), Math.max(...ys)];
  /** The outline's left and right x at height y. @param {number} y */
  const across = (y) => {
    const xs = outline.flatMap(([ax, ay], i) => {
      const [bx, by] = outline[(i + 1) % outline.length];
      if (y < Math.min(ay, by) || y > Math.max(ay, by) || ay === by) return ay === y ? [ax] : [];
      return [ax + ((bx - ax) * (y - ay)) / (by - ay)];
    });
    return [Math.min(...xs), Math.max(...xs)];
  };
  return Array.from({ length: count }, (_, b) => {
    const [y0, y1] = [b, b + 1].map((k) => THREE.MathUtils.lerp(bottom, top, k / count));
    const [[l0, r0], [l1, r1]] = [across(y0), across(y1)];
    return /** @type {Point[]} */ ([
      [l0, y0],
      [r0, y0],
      [r1, y1],
      [l1, y1],
    ]);
  });
}

/**
 * Marks with an offset x are mirrored to the other side.
 *
 * @template {{ x: number }} T
 * @param {T[]} marks
 * @returns {T[]}
 */
export const mirrored = (marks) =>
  marks.flatMap((mark) => (mark.x ? [mark, { ...mark, x: -mark.x }] : [mark]));

/**
 * A front view outline: a rectangle with its corners cut by `round` (0..0.5 of the smaller side),
 * or an ellipse with `round` 0.5, `segments` round.
 *
 * @param {{ x: number, y: number, w: number, h: number, round?: number }} mark
 * @param {number} [segments]
 * @returns {Point[]}
 */
export function rectangle({ x, y, w, h, round = 0 }, segments = LAMP_SEGMENTS) {
  if (round >= 0.5) return ellipse(x, y, w / 2, h / 2, segments);
  const [hw, hh, c] = [w / 2, h / 2, round * Math.min(w, h)];
  return /** @type {Point[]} */ ([
    [x - hw + c, y - hh],
    [x + hw - c, y - hh],
    [x + hw, y - hh + c],
    [x + hw, y + hh - c],
    [x + hw - c, y + hh],
    [x - hw + c, y + hh],
    [x - hw, y + hh - c],
    [x - hw, y - hh + c],
  ]).filter((p, i, all) => {
    const [px, py] = all[(i + all.length - 1) % all.length]; // uncut corners repeat points
    return p[0] !== px || p[1] !== py;
  });
}

/**
 * Points round an ellipse, counter-clockwise from its right end.
 *
 * @param {number} x centre
 * @param {number} y
 * @param {number} rx half width
 * @param {number} ry half height
 * @param {number} segments
 * @returns {Point[]}
 */
export function ellipse(x, y, rx, ry, segments) {
  return Array.from({ length: segments }, (_, k) => {
    const angle = (2 * Math.PI * k) / segments;
    return [x + rx * Math.cos(angle), y + ry * Math.sin(angle)];
  });
}

/**
 * A polygon with its corners rounded off (a quadratic curve through each, `steps` long; one
 * step: cut off), by `radius` each or all; a corner never takes more than 45 % of its sides.
 *
 * @param {Point[]} polygon
 * @param {number | number[]} radius
 * @param {number} [steps]
 * @returns {Point[]}
 */
export function rounded(polygon, radius, steps = CORNER_STEPS) {
  return polygon.flatMap((v, i) => {
    const r = typeof radius === "number" ? radius : radius[i];
    const [p, q] = [
      polygon[(i + polygon.length - 1) % polygon.length],
      polygon[(i + 1) % polygon.length],
    ];
    const [lp, lq] = [Math.hypot(p[0] - v[0], p[1] - v[1]), Math.hypot(q[0] - v[0], q[1] - v[1])];
    const cos = ((p[0] - v[0]) * (q[0] - v[0]) + (p[1] - v[1]) * (q[1] - v[1])) / (lp * lq);
    const cut = Math.min(
      r / Math.tan(Math.acos(THREE.MathUtils.clamp(cos, -1, 1)) / 2),
      0.45 * lp,
      0.45 * lq,
    );
    if (!(cut > 1e-4)) return [v];
    const [a, b] = [
      [v[0] + ((p[0] - v[0]) * cut) / lp, v[1] + ((p[1] - v[1]) * cut) / lp],
      [v[0] + ((q[0] - v[0]) * cut) / lq, v[1] + ((q[1] - v[1]) * cut) / lq],
    ];
    return Array.from({ length: steps + 1 }, (_, k) => {
      const t = k / steps;
      const [u, w, z] = [(1 - t) ** 2, 2 * (1 - t) * t, t ** 2];
      return /** @type {Point} */ ([
        u * a[0] + w * v[0] + z * b[0],
        u * a[1] + w * v[1] + z * b[1],
      ]);
    });
  });
}

/**
 * An open line with its pieces cut at most `step` long.
 *
 * @param {Point[]} line
 * @param {number} step
 * @returns {Point[]}
 */
export function densifyLine(line, step) {
  return [
    ...line.slice(0, -1).flatMap((p, i) => {
      const q = line[i + 1];
      const pieces = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / step));
      return Array.from({ length: pieces }, (_, j) => {
        const t = j / pieces;
        return /** @type {Point} */ ([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      });
    }),
    line[line.length - 1],
  ];
}

/**
 * A closed polygon with its sides cut at most `step` long.
 *
 * @param {Point[]} polygon
 * @param {number} step
 * @returns {Point[]}
 */
export function densify(polygon, step) {
  return densifyLine([...polygon, polygon[0]], step).slice(0, -1);
}

/** @param {Point[]} polygon @param {Point} p */
function contains(polygon, [x, y]) {
  let inside = false;
  polygon.forEach(([ax, ay], i) => {
    const [bx, by] = polygon[(i + 1) % polygon.length];
    if (ay > y !== by > y && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside;
  });
  return inside;
}

/** How far a point is from a polygon's sides. @param {Point[]} polygon @param {Point} p */
function distanceTo(polygon, [x, y]) {
  return Math.min(
    ...polygon.map(([ax, ay], i) => {
      const [bx, by] = polygon[(i + 1) % polygon.length];
      const [dx, dy] = [bx - ax, by - ay];
      const t = THREE.MathUtils.clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0, 1);
      return Math.hypot(ax + dx * t - x, ay + dy * t - y);
    }),
  );
}
