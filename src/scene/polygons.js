import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { WIRE } from "../config.js";

/**
 * Flat-shaded geometry built polygon by polygon, for the minigame traffic (scene/traffic.js,
 * scene/van.js): each triangle knows the polygon it belongs to, so lines are drawn along the
 * polygons' outlines (`userData.polygons`, as core/fbx.js), not along every triangle.
 *
 * @typedef {[number, number]} Point
 * @typedef {{ geometry: THREE.BufferGeometry, polygon: number[], even?: boolean }} Part non-indexed
 *   geometry (position, normal) and the polygon of each triangle, numbered within the part; even:
 *   shaded as if flat, each polygon (evenNormals())
 */

/** Segments of a rounded corner (a window's, a screen's). */
export const CORNER_STEPS = 4;
/** Stations along and round a car's body at least this close, metres (a crash bends them). */
export const STATION = 0.15;
/** Windows, lamps and marks sit this far off the body, so they draw their own outline, metres. */
export const OFFSET = 0.005;
/** Segments of a round lamp (rectangle() with `round` 0.5). */
const LAMP_SEGMENTS = 12;
/** How far the glass sits in behind the pillars and frames, metres. */
const RECESS = 0.02;

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
 * A closed solid over a side profile: the profile's x runs along the car (+z), its y up; the
 * left and right sides sit at x = ∓halfWidth(y), joined by a strip around the outline. Each side
 * is one polygon; the strip is one polygon per run of outline between creases (a turn of
 * WIRE.edgeAngle or more), so lines draw the outline and its sharp corners only. Faces point
 * outwards.
 *
 * @param {Point[]} profile simple polygon, any winding
 * @param {(y: number) => number} halfWidth
 * @returns {Part}
 */
export function prism(profile, halfWidth) {
  const outline = counterClockwise(profile);
  const at =
    (/** @type {number} */ side) =>
    (/** @type {Point} */ [x, y]) =>
      new THREE.Vector3(side * halfWidth(y), y, x);
  const parts = [
    face(outline, at(-1), new THREE.Vector3(-1, 0, 0)),
    face(outline, at(1), new THREE.Vector3(1, 0, 0)),
  ];

  // The strip, counter-clockwise: quad i joins point i to the next, one polygon per run.
  const n = outline.length;
  /** @type {number[]} */
  const positions = [];
  /** @type {number[]} */
  const polygon = [];
  for (const { i, run } of creaseRuns(outline)) {
    const [a, b] = [at(-1)(outline[i]), at(-1)(outline[(i + 1) % n])];
    const [a1, b1] = [at(1)(outline[i]), at(1)(outline[(i + 1) % n])];
    positions.push(...a.toArray(), ...b1.toArray(), ...b.toArray());
    positions.push(...a.toArray(), ...a1.toArray(), ...b1.toArray());
    polygon.push(run, run);
  }
  parts.push({ geometry: flatGeometry(positions), polygon });
  return mergeParts(parts);
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
 * A flat polygon from a 2D outline (and the holes in it) mapped into 3D, its triangles facing
 * `facing`.
 *
 * @param {Point[]} outline
 * @param {(point: Point) => THREE.Vector3} at
 * @param {THREE.Vector3} facing
 * @param {Point[][]} [holes]
 * @returns {Part}
 */
export function face(outline, at, facing, holes = []) {
  const points = [outline, ...holes].flat();
  /** @type {number[]} */
  const positions = [];
  for (const triangle of triangulate(outline, holes)) {
    const corners = triangle.map((i) => at(points[i]));
    positions.push(...facingPositions(corners, facing));
  }
  return { geometry: flatGeometry(positions), polygon: new Array(positions.length / 9).fill(0) };
}

/**
 * An outline and its holes cut into triangles: corners by index into the outline and the holes
 * after it. Earcut, mended: the outline's points in line kept, then edges flipped towards a
 * Delaunay triangulation (the sides of the outline and of the holes kept), as earcut leaves
 * slivers whose lines spike and whose shading stripes.
 *
 * @param {Point[]} outline
 * @param {Point[][]} [holes]
 * @returns {number[][]}
 */
export function triangulate(outline, holes = []) {
  const vectors = (/** @type {Point[]} */ points) =>
    points.map(([x, y]) => new THREE.Vector2(x, y));
  const points = [outline, ...holes].flat();
  // earcut drops the outline's points that lie in line; nudged in a hair, they stay corners and
  // the neighbours sharing them stay joined. A run of them is nudged in by turns one and two
  // hairs: nudged alike, they would still lie in line.
  const turn = THREE.ShapeUtils.isClockWise(vectors(outline)) ? -1 : 1;
  const contour = outline.map(([x, y], i) => {
    const [p, q] = [
      outline[(i + outline.length - 1) % outline.length],
      outline[(i + 1) % outline.length],
    ];
    const cross = (x - p[0]) * (q[1] - y) - (y - p[1]) * (q[0] - x);
    if (Math.abs(cross) > 1e-12) return new THREE.Vector2(x, y);
    const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
    const nudge = (turn * (1 + (i % 2)) * 1e-6) / Math.hypot(dx, dy);
    return new THREE.Vector2(x - dy * nudge, y + dx * nudge);
  });
  const triangles = THREE.ShapeUtils.triangulateShape(contour, holes.map(vectors));
  // earcut can still leave out a point of the outline that lies in line (bridging to the holes);
  // each goes back in, the triangle whose side it lies on split at it, so that a neighbour
  // sharing the point stays joined instead of drawing a line along the side
  const used = new Set(triangles.flat());
  outline.forEach((p, i) => {
    if (used.has(i)) return;
    for (let k = 0; k < triangles.length; k++) {
      for (let e = 0; e < 3; e++) {
        const [a, b, c] = [0, 1, 2].map((s) => triangles[k][(e + s) % 3]);
        if (!between(points[a], points[b], p)) continue;
        triangles.splice(k, 1, [a, i, c], [i, b, c]);
        used.add(i);
        return;
      }
    }
  });
  /** The sides that stay: the outline's and the holes'. @type {Set<string>} */
  const fixed = new Set();
  const key = (/** @type {number} */ i, /** @type {number} */ j) =>
    i < j ? `${i},${j}` : `${j},${i}`;
  let first = 0;
  for (const ring of [outline, ...holes]) {
    if (ring.length > 1)
      ring.forEach((_, i) => fixed.add(key(first + i, first + ((i + 1) % ring.length))));
    first += ring.length;
  }
  return delaunay([...contour, ...holes.flatMap(vectors)], triangles, fixed, key);
}

/**
 * How far past on one circle four corners must be to flip (delaunay()), radians: past what the
 * outline's nudge can tip, so that the same corners either side of a car's middle flip alike.
 */
const TIE = 1e-3;

/**
 * Triangles with their shared edges flipped while the opposite corner lies inside the other's
 * circumcircle (Lawson), but for the `fixed` edges.
 *
 * @param {THREE.Vector2[]} vertices
 * @param {number[][]} triangles
 * @param {Set<string>} fixed
 * @param {(i: number, j: number) => string} key
 */
function delaunay(vertices, triangles, fixed, key) {
  const orient = (/** @type {number[]} */ [a, b, c]) => {
    const [p, q, r] = [vertices[a], vertices[b], vertices[c]];
    return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  };
  const ccw = (/** @type {number[]} */ t) => (orient(t) < 0 ? [t[0], t[2], t[1]] : t);
  let mesh = triangles.map(ccw);
  /**
   * Whether d lies inside the circle through a, b, c, by more than TIE: by the angles side a-b
   * spans at c and d, together past a half turn. By angles, not a determinant: the huge circle
   * of a sliver's corners nearly in line is not a near miss.
   */
  const inside = (
    /** @type {number} */ a,
    /** @type {number} */ b,
    /** @type {number} */ c,
    /** @type {number} */ d,
  ) => {
    const angle = (/** @type {number} */ o) => {
      const [u, v] = [a, b].map((i) => vertices[i].clone().sub(vertices[o]));
      return Math.atan2(Math.abs(u.cross(v)), u.dot(v));
    };
    return angle(c) + angle(d) > Math.PI + TIE;
  };
  for (let pass = 0; pass < 100; pass++) {
    /** @type {Map<string, number[]>} */
    const owners = new Map();
    mesh.forEach((t, n) => {
      for (let k = 0; k < 3; k++) {
        const e = key(t[k], t[(k + 1) % 3]);
        const list = owners.get(e) ?? [];
        list.push(n);
        owners.set(e, list);
      }
    });
    /** @type {Set<number>} */
    const changed = new Set();
    for (const [e, list] of owners) {
      if (list.length !== 2 || fixed.has(e) || list.some((n) => changed.has(n))) continue;
      const [a, b] = e.split(",").map(Number);
      const [t1, t2] = [mesh[list[0]], mesh[list[1]]];
      const c = /** @type {number} */ (t1.find((i) => i !== a && i !== b));
      const d = /** @type {number} */ (t2.find((i) => i !== a && i !== b));
      if (!inside(a, b, c, d)) continue;
      // only across a convex quad: a and b on either side of c-d
      const [sa, sb] = [orient([c, d, a]), orient([c, d, b])];
      if (!(sa * sb < 0) || Math.abs(sa) < 1e-14 || Math.abs(sb) < 1e-14) continue;
      mesh[list[0]] = ccw([c, d, a]);
      mesh[list[1]] = ccw([d, c, b]);
      changed.add(list[0]).add(list[1]);
    }
    if (!changed.size) break;
  }
  return mesh;
}

/**
 * Whether p lies on the segment from a to b, short of its ends.
 *
 * @param {Point} a
 * @param {Point} b
 * @param {Point} p
 */
function between([ax, ay], [bx, by], [px, py]) {
  const [dx, dy] = [bx - ax, by - ay];
  const length2 = dx * dx + dy * dy;
  const t = ((px - ax) * dx + (py - ay) * dy) / length2;
  const off = Math.abs((px - ax) * dy - (py - ay) * dx) / Math.sqrt(length2);
  return t > 1e-9 && t < 1 - 1e-9 && off < 1e-7;
}

/**
 * A glass set in an opening, RECESS behind it: the glass (its triangles) and the opening's sides
 * round its rim, facing into the opening; one polygon, its line round the rim.
 *
 * @param {Point[]} rim the opening's outline
 * @param {Point[][]} triangles the glass
 * @param {(p: Point) => THREE.Vector3} at
 * @param {THREE.Vector3} out unit, out of the surface the opening is in
 * @returns {Part[]} the glass with the sides
 */
export function recessed(rim, triangles, at, out) {
  const inner = (/** @type {Point} */ p) => at(p).addScaledVector(out, -RECESS);
  const centre = rim.reduce((sum, p) => sum.add(inner(p)), new THREE.Vector3());
  centre.divideScalar(rim.length);
  const sides = rim.flatMap((p, i) => {
    const q = rim[(i + 1) % rim.length];
    const facing = centre.clone().sub(at(p).add(at(q)).multiplyScalar(0.5)); // into the opening
    return [
      triangleFacing([at(p), at(q), inner(q)], facing),
      triangleFacing([at(p), inner(q), inner(p)], facing),
    ];
  });
  return [joined([surface(triangles, inner, out), ...sides], sides.map(() => 0).concat(0))];
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
 * @param {THREE.BufferGeometry} geometry a built-in shape
 * @param {(triangle: number) => number} polygonOf
 * @returns {Part}
 */
export function builtIn(geometry, polygonOf) {
  const flat = plain(geometry);
  const count = flat.getAttribute("position").count / 3;
  return { geometry: flat, polygon: Array.from({ length: count }, (_, t) => polygonOf(t)) };
}

/**
 * A built-in shape whose groups are its faces (a box): one polygon a face, however finely cut.
 *
 * @param {THREE.BufferGeometry} geometry
 * @returns {Part}
 */
export function byFaces(geometry) {
  const { groups } = geometry;
  return builtIn(geometry, (t) =>
    groups.findIndex(({ start, count }) => 3 * t >= start && 3 * t < start + count),
  );
}

/**
 * A flat outline as a polygon with corners at most `step` apart along its sides, and inside
 * every `step` along its first coordinate, every other one along its second, for a crash to bend
 * it with the body under it (a mark, a panel standing off the body).
 *
 * @param {Point[]} outline
 * @param {(point: Point) => THREE.Vector3} at
 * @param {THREE.Vector3} facing
 * @param {number} step
 * @returns {Part}
 */
export function fineFace(outline, at, facing, step) {
  const fine = densify(outline, step);
  return face(fine, at, facing, fillPoints(fine, [], step, step / 4, 2 * step));
}

/**
 * A window's glass inside its rim (as densify() cut it), with points inside every `step` along
 * its first coordinate and every other one along its second: its triangles, as points.
 *
 * @param {Point[]} rim
 * @param {number} step
 * @returns {Point[][]}
 */
export function glassTriangles(rim, step) {
  const inside = fillPoints(rim, [], step, step / 4, 2 * step);
  const points = [rim, ...inside].flat();
  return triangulate(rim, inside).map((t) => t.map((i) => points[i]));
}

/**
 * Sets one normal for all the triangles of each polygon marked even (\`userData.even\`, a flag a
 * triangle): their average, as if flat. A decal's triangles follow the facets under it; shaded
 * each by its own, they would stripe. Called again after anything recomputes the normals (a
 * dent, scene/dents.js).
 *
 * @param {THREE.BufferGeometry} geometry with \`userData.polygons\`
 */
export function evenNormals(geometry) {
  /** @type {Uint8Array | undefined} */
  const even = geometry.userData.even;
  if (!even) return;
  const { polygon } = geometry.userData.polygons;
  const normal = geometry.getAttribute("normal");
  /** @type {Map<number, THREE.Vector3>} */
  const sums = new Map();
  const n = new THREE.Vector3();
  for (let t = 0; t < even.length; t++) {
    if (!even[t]) continue;
    const sum = sums.get(polygon[t]) ?? new THREE.Vector3();
    for (let k = 0; k < 3; k++) sum.add(n.fromBufferAttribute(normal, 3 * t + k));
    sums.set(polygon[t], sum);
  }
  for (const sum of sums.values()) sum.normalize();
  for (let t = 0; t < even.length; t++) {
    if (!even[t]) continue;
    const sum = /** @type {THREE.Vector3} */ (sums.get(polygon[t]));
    for (let k = 0; k < 3; k++) normal.setXYZ(3 * t + k, sum.x, sum.y, sum.z);
  }
  normal.needsUpdate = true;
}

/**
 * Parts as one, their polygons by `ids` (parts with the same id are one polygon).
 *
 * @param {Part[]} parts
 * @param {number[]} ids
 * @returns {Part}
 */
export function joined(parts, ids) {
  const geometry = /** @type {THREE.BufferGeometry} */ (
    mergeGeometries(parts.map((part) => part.geometry))
  );
  return { geometry, polygon: parts.flatMap((part, k) => part.polygon.map(() => ids[k])) };
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
  return polygon.flatMap((p, i) => {
    const q = polygon[(i + 1) % polygon.length];
    const pieces = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / step));
    return Array.from({ length: pieces }, (_, j) => {
      const t = j / pieces;
      return /** @type {Point} */ ([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    });
  });
}

/** @param {Point[]} polygon @param {Point} p */
export function contains(polygon, [x, y]) {
  let inside = false;
  polygon.forEach(([ax, ay], i) => {
    const [bx, by] = polygon[(i + 1) % polygon.length];
    if (ay > y !== by > y && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside;
  });
  return inside;
}

/** How far a point is from a polygon's sides. @param {Point[]} polygon @param {Point} p */
export function distanceTo(polygon, [x, y]) {
  return Math.min(
    ...polygon.map(([ax, ay], i) => {
      const [bx, by] = polygon[(i + 1) % polygon.length];
      const [dx, dy] = [bx - ax, by - ay];
      const t = THREE.MathUtils.clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0, 1);
      return Math.hypot(ax + dx * t - x, ay + dy * t - y);
    }),
  );
}

/**
 * Triangles between two closed loops, one round the other (the frame round a window): both go
 * the same way round, each point a corner, zipped by the angle `angle` gives them.
 *
 * @param {Point[]} outer
 * @param {Point[]} inner
 * @param {(p: Point) => number} angle
 * @returns {Point[][]}
 */
export function zip(outer, inner, angle) {
  /** The loop from its smallest angle, the angles unwrapped, closed. @param {Point[]} loop */
  const unwrap = (loop) => {
    const angles = loop.map(angle);
    const start = angles.indexOf(Math.min(...angles));
    const points = [...loop.slice(start), ...loop.slice(0, start)];
    const turned = points.map(angle);
    for (let k = 1; k < turned.length; k++) {
      while (turned[k] < turned[k - 1]) turned[k] += 2 * Math.PI;
    }
    return { points: [...points, points[0]], angles: [...turned, turned[0] + 2 * Math.PI] };
  };
  const [o, w] = [unwrap(outer), unwrap(inner)];
  return mirroredHalves(zipBy(o.points, w.points, o.angles, w.angles));
}

/**
 * Triangles between two chains of points from one end to the other, every point a corner, zipped
 * in the order of their keys (how far along, or round, each is).
 *
 * @template T
 * @param {T[]} a
 * @param {T[]} b
 * @param {number[]} ka a's keys, rising
 * @param {number[]} kb b's keys, rising
 * @returns {T[][]}
 */
export function zipBy(a, b, ka, kb) {
  /** @type {T[][]} */
  const triangles = [];
  let [i, j] = [0, 0];
  while (i < a.length - 1 || j < b.length - 1) {
    if (j === b.length - 1 || (i < a.length - 1 && ka[i + 1] <= kb[j + 1])) {
      triangles.push([a[i], a[++i], b[j]]);
    } else triangles.push([a[i], b[j + 1], b[j++]]);
  }
  return triangles;
}

/**
 * Triangles between two rows of points, each from left to right (along the first coordinate):
 * every point is a corner, so what the rows share with their neighbours stays joined (earcut
 * would drop the points in line, THREE.ShapeUtils.triangulateShape).
 *
 * @param {Point[]} bottom
 * @param {Point[]} top
 * @returns {Point[][]}
 */
export function ladder(bottom, top) {
  const along = (/** @type {Point[]} */ row) => row.map(([x]) => x);
  return mirroredHalves(zipBy(bottom, top, along(bottom), along(top)));
}

/**
 * Triangles of a shape the same either side of x = 0 (a car's middle), the same either side:
 * those left of it and the same mirrored. A sweep from one end (ladder(), zip()) cuts the two
 * halves differently, and lines along thin triangles show it. Other shapes, or one with a
 * triangle across the middle, stay as they are.
 *
 * @param {Point[][]} triangles
 * @returns {Point[][]}
 */
function mirroredHalves(triangles) {
  const key = (/** @type {Point} */ [x, y]) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;
  const corners = triangles.flat();
  const keys = new Set(corners.map(key));
  const across = triangles.some((t) => t.some(([x]) => x < -1e-9) && t.some(([x]) => x > 1e-9));
  if (across || !corners.every(([x, y]) => keys.has(key([-x, y])))) return triangles;
  const left = triangles.filter((t) => t.every(([x]) => x <= 1e-9));
  const mirrored = left.map(([a, b, c]) =>
    [c, b, a].map(([x, y]) => /** @type {Point} */ ([-x, y])),
  );
  return [...left, ...mirrored];
}

/**
 * Triangles (2D) mapped into 3D, facing `facing`: one polygon.
 *
 * @param {Point[][]} triangles
 * @param {(point: Point) => THREE.Vector3} at
 * @param {THREE.Vector3} facing
 * @returns {Part}
 */
export function surface(triangles, at, facing) {
  const parts = triangles.map((triangle) => triangleFacing(triangle.map(at), facing));
  return joined(
    parts,
    parts.map(() => 0),
  );
}

/**
 * A triangle turned to face `facing`.
 *
 * @param {THREE.Vector3[]} corners
 * @param {THREE.Vector3} facing
 * @returns {Part}
 */
export function triangleFacing(corners, facing) {
  return { geometry: flatGeometry(facingPositions(corners, facing)), polygon: [0] };
}

/**
 * A triangle's positions (x, y, z of each corner), wound to face `facing`.
 *
 * @param {THREE.Vector3[]} corners
 * @param {THREE.Vector3} facing
 * @returns {number[]}
 */
export function facingPositions([a, b, c], facing) {
  const normal = new THREE.Vector3().subVectors(b, a).cross(c.clone().sub(a));
  const [p, q] = normal.dot(facing) >= 0 ? [b, c] : [c, b];
  return [...a.toArray(), ...p.toArray(), ...q.toArray()];
}

/**
 * One geometry of parts, with `userData.polygons` (as core/fbx.js), so its lines follow them.
 *
 * @param {Part[]} parts
 */
export function withPolygons(parts) {
  const { geometry, polygon } = mergeParts(parts);
  geometry.userData.polygons = {
    inner: innerEdges(geometry, polygon),
    polygon: Uint32Array.from(polygon),
  };
  return geometry;
}

/**
 * One part of many; each part's polygons keep numbers of their own.
 *
 * @param {Part[]} parts
 * @returns {Part}
 */
export function mergeParts(parts) {
  const geometry = /** @type {THREE.BufferGeometry} */ (
    mergeGeometries(parts.map((part) => part.geometry))
  );
  /** @type {number[]} */
  const polygon = [];
  for (const part of parts) {
    const offset = polygon.length ? Math.max(...polygon) + 1 : 0;
    polygon.push(...part.polygon.map((id) => id + offset));
  }
  return { geometry, polygon };
}

/**
 * Per triangle, the edges it shares with a triangle of its own polygon (bit k: the edge opposite
 * vertex k, as core/fbx.js): lines are drawn along the others.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {number[]} polygon
 */
export function innerEdges(geometry, polygon) {
  const position = geometry.getAttribute("position");
  const point = (/** @type {number} */ i) =>
    [position.getX(i), position.getY(i), position.getZ(i)].map((v) => Math.round(v * 1e5)).join();
  const edgeKey = (/** @type {number} */ t, /** @type {number} */ k) => {
    const [a, b] = [point(3 * t + ((k + 1) % 3)), point(3 * t + ((k + 2) % 3))];
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  };
  /** @type {Map<string, number[]>} */
  const owners = new Map();
  for (let t = 0; t < polygon.length; t++) {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(t, k);
      let triangles = owners.get(key);
      if (!triangles) owners.set(key, (triangles = []));
      triangles.push(t);
    }
  }
  return Uint8Array.from(polygon, (id, t) => {
    let mask = 0;
    for (let k = 0; k < 3; k++) {
      const shared = /** @type {number[]} */ (owners.get(edgeKey(t, k)));
      if (shared.some((u) => u !== t && polygon[u] === id)) mask |= 1 << k;
    }
    return mask;
  });
}

/** @param {number[]} positions non-indexed triangles */
export function flatGeometry(positions) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Non-indexed, position + normal only, so built-in shapes merge with the rest.
 *
 * @param {THREE.BufferGeometry} geometry
 */
export function plain(geometry) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  flat.deleteAttribute("uv");
  return flat;
}
