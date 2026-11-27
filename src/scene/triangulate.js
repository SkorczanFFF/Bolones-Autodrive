import * as THREE from "three";

/**
 * Outlines cut into triangles (scene/polygons.js, scene/sedan.js, scene/van.js): every point of
 * them a corner, so neighbouring shapes stay joined and their lines draw only the outlines.
 *
 * @typedef {import("./outline.js").Point} Point
 */

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
