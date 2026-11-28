import * as THREE from "three";
import { densify, pieces as cut, rectangle, STATION } from "./outline.js";
import { face, facingPositions, flatGeometry, joined, triangleFacing } from "./polygons.js";

/**
 * Decals on the body of a car of the traffic (TrafficModel `decals`, scene/trafficModels.js;
 * scene/sedan.js puts them on): outlines drawn in a view, projected onto the body along it, just
 * off it, as fine as its curves need and for a crash to bend them with it; or blocks standing out
 * of it (a lamp).
 *
 * @typedef {import("./trafficModels.js").Decal} Decal
 * @typedef {import("./trafficModels.js").Mark} Mark
 * @typedef {import("./outline.js").Point} Point
 * @typedef {import("./polygons.js").Part} Part
 */

/** How often a decal samples the body under it, and how far off it it sits, metres. */
const [DECAL_STEP, DECAL_OFFSET] = [0.03, 0.01];
/** How far a decal may stray from the body under it between the points it keeps, metres. */
const DECAL_TOLERANCE = 0.002;

/**
 * Decals (TrafficModel `decals`): each outline drawn in a view, cut into bars or columns, one
 * polygon each, its corners (every DECAL_STEP, inside too) projected onto the body along the view
 * and DECAL_OFFSET off it.
 *
 * @param {Decal[]} decals
 * @param {THREE.BufferGeometry} body built from the rear (z = 0) forward
 * @returns {Part[]}
 */
export function decalParts(decals, body) {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const position = /** @type {THREE.BufferAttribute} */ (body.getAttribute("position")).array;
  // each triangle's smallest and largest x, y, z
  const triangles = position.length / 9;
  const [low, high] = [new Float32Array(triangles * 3), new Float32Array(triangles * 3)];
  for (let t = 0; t < triangles; t++) {
    for (let axis = 0; axis < 3; axis++) {
      const [a, b, c] = [0, 3, 6].map((k) => position[9 * t + k + axis]);
      low[3 * t + axis] = Math.min(a, b, c);
      high[3 * t + axis] = Math.max(a, b, c);
    }
  }
  /**
   * The body's triangles that lie (in the view) round the outline's box, a margin wider, as a
   * mesh to cast rays at: tested against every triangle of the body, the rays would be slow.
   *
   * @param {Point[]} outline
   * @param {[number, number, number, number]} axes the view's two coordinates: the scene axis
   *   (0 x, 1 y, 2 z) and the sign of each
   */
  const under = (outline, [axisA, signA, axisB, signB]) => {
    const margin = 0.05;
    const [as, bs] = [outline.map(([a]) => a), outline.map(([, b]) => b)];
    const [a0, a1, b0, b1] = [Math.min(...as), Math.max(...as), Math.min(...bs), Math.max(...bs)];
    /**
     * The triangle's range along an axis, signed.
     *
     * @param {number} t
     * @param {number} axis
     * @param {number} sign
     */
    const range = (t, axis, sign) =>
      sign > 0
        ? [low[3 * t + axis], high[3 * t + axis]]
        : [-high[3 * t + axis], -low[3 * t + axis]];
    /** @type {number[]} */
    const kept = [];
    for (let t = 0; t < triangles; t++) {
      const [[pa0, pa1], [pb0, pb1]] = [range(t, axisA, signA), range(t, axisB, signB)];
      if (pa1 < a0 - margin || pa0 > a1 + margin || pb1 < b0 - margin || pb0 > b1 + margin)
        continue;
      for (let k = 0; k < 9; k++) kept.push(position[9 * t + k]);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(kept, 3));
    return new THREE.Mesh(geometry, material);
  };
  const raycaster = new THREE.Raycaster();
  const far = 50;
  /** @type {Part[]} */
  const parts = [];
  for (const decal of decals) {
    const { view } = decal;
    const outline = decal.outline ?? rectangle(/** @type {Mark} */ (decal.shape));
    const across = view === "top" ? 1 : 0; // which coordinate runs across the car
    const offCentre = outline.every((p) => p[across] > 0);
    const sides = decal.side ? [decal.side] : view === "side" || offCentre ? [1, -1] : [1];
    const pieces = cut(outline, decal);
    for (const side of sides) {
      /** The ray towards the body through a point of the view. @param {Point} p */
      const ray = ([a, b]) => {
        if (view === "side")
          return [new THREE.Vector3(side * far, b, a), new THREE.Vector3(-side, 0, 0)];
        if (view === "front")
          return [new THREE.Vector3(side * a, b, far), new THREE.Vector3(0, 0, -1)];
        if (view === "rear")
          return [new THREE.Vector3(side * a, b, -far), new THREE.Vector3(0, 0, 1)];
        return [new THREE.Vector3(side * b, far, a), new THREE.Vector3(0, -1, 0)];
      };
      // the view's coordinates in the scene: side [z, y], top [z, ±x], front and rear [±x, y]
      /** @type {[number, number, number, number]} */
      const axes =
        view === "side" ? [2, 1, 1, 1] : view === "top" ? [2, 1, 0, side] : [0, side, 1, 1];
      const mesh = under(outline, axes);
      /** Where the ray through a point meets the body, and its normal. @param {Point} p */
      const hit = (p) => {
        const [origin, direction] = ray(p);
        raycaster.set(origin, direction);
        const [first] = raycaster.intersectObject(mesh);
        if (!first?.face) throw new Error(`a ${view} decal misses the body at ${p}`);
        return { point: first.point, normal: first.face.normal };
      };
      const facing = ray([0, 0])[1].negate();
      if (decal.raise) {
        parts.push(...block(outline, pieces, ray, hit, facing, decal.raise));
        continue;
      }
      const at = (/** @type {Point} */ p) => {
        const { point, normal } = hit(p);
        return point.clone().addScaledVector(normal, DECAL_OFFSET);
      };
      // a four-sided piece as a grid fine enough to follow a curved surface (a long side would
      // cut under it), anything else (small and round) as it is
      for (const piece of pieces) {
        const flat = piece.length === 4 ? grid(piece, at, facing) : face(piece, at, facing);
        parts.push({ ...flat, even: true });
      }
    }
  }
  return parts;
}

/**
 * A four-sided outline as a grid of quads (bilinear over its corners) on the body: sampled every
 * DECAL_STEP, then only the columns and rows kept where the body bends away from a straight line
 * through the ones kept by more than DECAL_TOLERANCE, and at least every STATION, for a crash to
 * bend it with the body. On a flat panel it is quads STATION long; on a curved one, as fine as the
 * curve needs. One polygon.
 *
 * @param {Point[]} quad corners in order round it
 * @param {(p: Point) => THREE.Vector3} at
 * @param {THREE.Vector3} facing
 * @returns {Part}
 */
function grid([p0, p1, p2, p3], at, facing) {
  const length = (/** @type {Point} */ a, /** @type {Point} */ b) =>
    Math.hypot(b[0] - a[0], b[1] - a[1]);
  const across = Math.max(1, Math.ceil(Math.max(length(p0, p1), length(p3, p2)) / DECAL_STEP));
  const up = Math.max(1, Math.ceil(Math.max(length(p0, p3), length(p1, p2)) / DECAL_STEP));
  /** @param {number} u @param {number} v */
  const point = (u, v) =>
    at(
      /** @type {Point} */ (
        [0, 1].map(
          (k) =>
            p0[k] * (1 - u) * (1 - v) + p1[k] * u * (1 - v) + p2[k] * u * v + p3[k] * (1 - u) * v,
        )
      ),
    );
  const fine = Array.from({ length: up + 1 }, (_, j) =>
    Array.from({ length: across + 1 }, (_, i) => point(i / across, j / up)),
  );
  const straight = (
    /** @type {THREE.Vector3} */ a,
    /** @type {THREE.Vector3} */ b,
    /** @type {THREE.Vector3} */ c,
    /** @type {number} */ t,
  ) => c.distanceTo(a.clone().lerp(b, t)) <= DECAL_TOLERANCE;
  /**
   * The indices kept of `count`: the ends, and each one where a straight line on to the next
   * would leave the body or run on further than `most` samples.
   *
   * @param {number} count
   * @param {number} most
   * @param {(a: number, b: number, c: number) => boolean} fits whether c lies on the line a-b
   */
  const keep = (count, most, fits) => {
    const kept = [0];
    let a = 0;
    for (let b = 2; b < count; b++) {
      if (b - a > most) {
        a = b - 1;
        kept.push(a);
        continue;
      }
      for (let c = a + 1; c < b; c++) {
        if (fits(a, b, c)) continue;
        a = b - 1;
        kept.push(a);
        break;
      }
    }
    kept.push(count - 1);
    return kept;
  };
  /** How many samples apart, at most, so that they stay a STATION apart. @param {number} long @param {number} count */
  const most = (long, count) => Math.max(1, Math.floor((STATION * count) / long));
  const columns = keep(
    across + 1,
    most(Math.max(length(p0, p1), length(p3, p2)), across),
    (a, b, c) => fine.every((row) => straight(row[a], row[b], row[c], (c - a) / (b - a))),
  );
  const rows = keep(up + 1, most(Math.max(length(p0, p3), length(p1, p2)), up), (a, b, c) =>
    fine[0].every((_, i) => straight(fine[a][i], fine[b][i], fine[c][i], (c - a) / (b - a))),
  );
  /** @type {number[]} */
  const positions = [];
  for (let j = 0; j + 1 < rows.length; j++) {
    for (let i = 0; i + 1 < columns.length; i++) {
      const [r0, r1, c0, c1] = [rows[j], rows[j + 1], columns[i], columns[i + 1]];
      const [a, b, c, d] = [fine[r0][c0], fine[r0][c1], fine[r1][c1], fine[r1][c0]];
      positions.push(...facingPositions([a, b, c], facing), ...facingPositions([a, c, d], facing));
    }
  }
  return { geometry: flatGeometry(positions), polygon: new Array(positions.length / 9).fill(0) };
}

/**
 * A decal standing out of the body as a block: its face flat, square to the view across the car
 * and tilted up or down as the body under it is, `raise` out past the body's farthest point
 * under it, cut into its pieces; its walls back to the body.
 *
 * @param {Point[]} outline
 * @param {Point[][]} pieces
 * @param {(p: Point) => THREE.Vector3[]} ray origin and direction through a point of the view
 * @param {(p: Point) => { point: THREE.Vector3, normal: THREE.Vector3 }} hit
 * @param {THREE.Vector3} facing towards the view
 * @param {number} raise
 * @returns {Part[]}
 */
function block(outline, pieces, ray, hit, facing, raise) {
  const rim = densify(outline, DECAL_STEP);
  const hits = rim.map(hit);
  const bottoms = hits.map(({ point }) => point);
  // the face's normal: the view's, tilted up or down as the body's normals are on average
  const up = new THREE.Vector3(0, 1, 0);
  const mean = hits.reduce((sum, { normal }) => sum.add(normal), new THREE.Vector3());
  const tilt = Math.abs(facing.dot(up)) > 0.5 ? 0 : mean.dot(up) / Math.max(mean.dot(facing), 1e-6);
  const n = facing.clone().addScaledVector(up, tilt).normalize();
  const level = Math.max(...bottoms.map((point) => point.dot(n))) + raise;
  /** On the face: along the ray, where it meets the face's plane. @param {Point} p */
  const onFace = (p) => {
    const [origin, direction] = ray(p);
    return origin.clone().addScaledVector(direction, (level - origin.dot(n)) / direction.dot(n));
  };
  const centre = rim.reduce((sum, p) => sum.add(onFace(p)), new THREE.Vector3());
  centre.divideScalar(rim.length);
  // the walls run on into the body, closed there by a back: their far edge draws no line where
  // the body curves away from it
  const sunk = bottoms.map((point) => point.clone().addScaledVector(facing, -3 * DECAL_OFFSET));
  const back = sunk.reduce((sum, point) => sum.add(point), new THREE.Vector3());
  back.divideScalar(sunk.length);
  const inwards = facing.clone().negate();
  const walls = rim.flatMap((p, i) => {
    const j = (i + 1) % rim.length;
    const [a, b] = [onFace(p), onFace(rim[j])];
    const out = a.clone().add(b).multiplyScalar(0.5).sub(centre);
    return [
      triangleFacing([a, b, sunk[j]], out),
      triangleFacing([a, sunk[j], sunk[i]], out),
      triangleFacing([back, sunk[i], sunk[j]], inwards),
    ];
  });
  return [
    ...pieces.map((piece) => face(piece, onFace, facing)),
    joined(
      walls,
      walls.map(() => 0),
    ),
  ];
}
