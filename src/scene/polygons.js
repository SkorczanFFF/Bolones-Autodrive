import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { counterClockwise, creaseRuns, densify, fillPoints } from "./outline.js";
import { triangulate } from "./triangulate.js";

/**
 * Flat-shaded geometry built polygon by polygon (the traffic: scene/sedan.js, scene/van.js,
 * scene/carParts.js, scene/decals.js; the Bolones' fuel cap; the dents' normals): each triangle
 * knows the polygon it belongs to, so lines are drawn along the polygons' outlines
 * (`userData.polygons`, as core/fbx.js), not along every triangle.
 *
 * @typedef {import("./outline.js").Point} Point
 * @typedef {{ geometry: THREE.BufferGeometry, polygon: number[], even?: boolean }} Part non-indexed
 *   geometry (position, normal) and the polygon of each triangle, numbered within the part; even:
 *   shaded as if flat, each polygon (evenNormals())
 */

/** Lamps and marks sit this far off the body, so they draw their own outline, metres. */
export const OFFSET = 0.005;

/** How far the glass sits in behind the pillars and frames, metres. */
const RECESS = 0.02;

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
 * Sets one normal for all the triangles of each polygon marked even (`userData.even`, a flag a
 * triangle): their average, as if flat. A decal's triangles follow the facets under it; shaded
 * each by its own, they would stripe. Called again after anything recomputes the normals (a
 * dent, scene/dents.js).
 *
 * @param {THREE.BufferGeometry} geometry with `userData.polygons`
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
  let next = 0; // the first number free
  for (const part of parts) {
    const offset = next;
    for (const id of part.polygon) {
      polygon.push(id + offset);
      next = Math.max(next, id + offset + 1);
    }
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
  const points = Array.from({ length: position.count }, (_, i) =>
    [position.getX(i), position.getY(i), position.getZ(i)].map((v) => Math.round(v * 1e5)).join(),
  );
  // each triangle's edges, the one opposite vertex k at 3 * t + k, by their ends
  const edges = Array.from({ length: 3 * polygon.length }, (_, e) => {
    const t = Math.floor(e / 3);
    const [a, b] = [points[3 * t + ((e + 1) % 3)], points[3 * t + ((e + 2) % 3)]];
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  });
  const edgeKey = (/** @type {number} */ t, /** @type {number} */ k) => edges[3 * t + k];
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
function plain(geometry) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  flat.deleteAttribute("uv");
  return flat;
}
