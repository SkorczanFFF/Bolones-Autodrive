import * as THREE from "three";
import { WIRE } from "../config.js";

/**
 * Triangle wireframe drawn by the fragment shader instead of GL lines. GL lines are always one
 * pixel wide, so a dense mesh far away (palms, the Bolones' nose) turns into a solid block of
 * line color. Here:
 * - lines have a width in world units, so they thin out with distance like the model (but stay
 *   at least a pixel wide, no shimmer);
 * - lines of triangles that are tiny on screen fade out (WIRE.fade, by the triangle's inradius
 *   in render pixels) down to a per-layer minimum, so dense meshes far away show their fill,
 *   while big triangles (mountains) keep their lines at any distance.
 *
 * `wireEdge` xyz: each vertex's distance to the opposite edge of its triangle (zero for the two
 * edges through it); interpolated, the distance of a fragment to the three edges. w: the
 * triangle's inradius (its polygon's size for polygonLineGeometry). All in object units.
 * Polygon lines also draw neighbouring edges: `wireNear`, `wireNearEnd`, `wireNearFar` (nearPlan).
 */

/** Shared by all line materials, so one GUI slider sets the width everywhere. */
export const lineWidth = { value: WIRE.width };

/**
 * Memoizes a per-geometry derivation: clones share geometries, so they share the result too.
 *
 * @template T
 * @param {(geometry: THREE.BufferGeometry) => T} derive
 * @returns {(geometry: THREE.BufferGeometry) => T}
 */
function memoByGeometry(derive) {
  /** @type {WeakMap<THREE.BufferGeometry, T>} */
  const cache = new WeakMap();
  return (geometry) => {
    let value = cache.get(geometry);
    if (value === undefined) cache.set(geometry, (value = derive(geometry)));
    return value;
  };
}

/**
 * Added to an edge distance to hide that edge: the distance stays linear (the shader needs its
 * screen-space derivatives) but never gets near a line.
 */
export const HIDDEN = 1e4;

/**
 * The geometry with the `wireEdge` attribute (non-indexed: each triangle needs its own vertices),
 * one per source geometry. A non-indexed geometry that already has `wireEdge` (written by its
 * generator, see writeWireEdges) is used as is.
 *
 * @type {(geometry: THREE.BufferGeometry) => THREE.BufferGeometry}
 */
export const lineGeometry = memoByGeometry((geometry) => {
  const prepared = geometry.index ? geometry.toNonIndexed() : geometry;
  if (geometry.index || !prepared.hasAttribute("wireEdge")) writeWireEdges(prepared);
  return prepared;
});

/**
 * (Re)computes `wireEdge` of a non-indexed geometry, e.g. after its generator moved vertices.
 * hideDiagonals: the edge opposite the second vertex of every triangle is not drawn, so a mesh
 * of quads split into two triangles shows a square grid (generators put the diagonal there).
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {{ hideDiagonals?: boolean }} [options]
 */
export function writeWireEdges(geometry, { hideDiagonals = false } = {}) {
  const position = /** @type {THREE.BufferAttribute} */ (geometry.getAttribute("position"));
  const existing = /** @type {THREE.BufferAttribute | undefined} */ (
    geometry.getAttribute("wireEdge")
  );
  const reuse = existing && existing.count === position.count;
  const distances = edgeDistances(
    position,
    { hidden: hideDiagonals ? 0b010 : 0 }, // edge c-a, opposite the 2nd vertex
    reuse ? /** @type {Float32Array} */ (existing.array) : undefined,
  );
  if (reuse) existing.needsUpdate = true;
  else geometry.setAttribute("wireEdge", new THREE.BufferAttribute(distances, 4));
}

/**
 * Point `i` of a position attribute, read off its array: fromBufferAttribute() reads any kind of
 * attribute, too slow for every point of a car dented (scene/dents.js). Positions here are plain
 * arrays, three numbers a point.
 *
 * @param {THREE.Vector3} v
 * @param {ArrayLike<number>} array
 * @param {number} i
 */
const pointAt = (v, array, i) => v.set(array[3 * i], array[3 * i + 1], array[3 * i + 2]);

/** A triangle's height over one of its edges: twice its area over the edge's length. */
const heightOver = (/** @type {number} */ doubleArea, /** @type {number} */ edge) =>
  edge > 0 ? doubleArea / edge : 0;

/**
 * @typedef {object} EdgeOptions
 * @property {number | ArrayLike<number>} [hidden] edges not drawn, for every triangle or per
 *   triangle: bit k is the edge opposite vertex k
 * @property {ArrayLike<number>} [sizes] per triangle, what line fading measures instead of the
 *   triangle's inradius
 */

/**
 * @param {THREE.BufferAttribute} position
 * @param {EdgeOptions} options
 * @param {Float32Array} [target] reused when the topology did not change
 */
function edgeDistances(position, { hidden = 0, sizes }, target) {
  const points = position.array;
  const distances = target ?? new Float32Array(position.count * 4);
  distances.fill(0);
  const [a, b, c, side, cross] = Array.from({ length: 5 }, () => new THREE.Vector3());

  for (let i = 0, t = 0; i + 2 < position.count; i += 3, t++) {
    pointAt(a, points, i);
    pointAt(b, points, i + 1);
    pointAt(c, points, i + 2);
    const doubleArea = cross.subVectors(b, a).cross(side.subVectors(c, a)).length();
    const ab = a.distanceTo(b);
    const bc = b.distanceTo(c);
    const ca = c.distanceTo(a);
    distances[i * 4] = heightOver(doubleArea, bc);
    distances[(i + 1) * 4 + 1] = heightOver(doubleArea, ca);
    distances[(i + 2) * 4 + 2] = heightOver(doubleArea, ab);
    const size = sizes ? sizes[t] : heightOver(doubleArea, ab + bc + ca); // the inradius
    const mask = typeof hidden === "number" ? hidden : hidden[t];
    for (let v = 0; v < 3; v++) {
      distances[(i + v) * 4 + 3] = size;
      for (let k = 0; k < 3; k++) if (mask & (1 << k)) distances[(i + v) * 4 + k] += HIDDEN;
    }
  }
  return distances;
}

/**
 * Lines along the modelled polygons (`userData.polygons`, core/fbx.js) instead of every
 * triangle; other geometries get every triangle edge, still with the wireNear attributes their
 * material reads. One per source geometry, sharing its attributes; one that has them already
 * (parts' lines put together, scene/traffic.js) is used as is.
 *
 * @type {(geometry: THREE.BufferGeometry) => THREE.BufferGeometry}
 */
export const polygonLineGeometry = memoByGeometry((geometry) =>
  geometry.hasAttribute("wireNear") ? geometry : measuredLines(geometry, planOf(geometry)),
);

/**
 * The polygon lines of a copy of `source` with its points moved (a dent): the lines `source`
 * draws, measured afresh. Working out which lines those are costs far more than measuring them.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.BufferGeometry} source the same triangles, in the same order
 */
export function movedLineGeometry(geometry, source) {
  return measuredLines(geometry, planOf(source));
}

/**
 * @typedef {object} LinePlan which lines a geometry's triangles draw
 * @property {Uint8Array} hidden per triangle, bit k: the edge opposite vertex k is not drawn
 * @property {Uint32Array} polygon per triangle
 * @property {Int32Array} near nearPlan()
 */

/** @type {(geometry: THREE.BufferGeometry) => LinePlan} */
const planOf = memoByGeometry((geometry) => {
  const position = geometry.getAttribute("position");
  const count = position.count / 3;
  const { inner: hidden, polygon } = geometry.userData.polygons ?? {
    inner: new Uint8Array(count),
    polygon: Uint32Array.from({ length: count }, (_, t) => t),
  };
  return { hidden, polygon, near: nearPlan(position, hidden, polygon) };
});

/**
 * The line geometry for a geometry's points as they are, drawing the lines of a plan.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {LinePlan} plan
 */
function measuredLines(geometry, { hidden, polygon, near: lines }) {
  const position = /** @type {THREE.BufferAttribute} */ (geometry.getAttribute("position"));
  const count = position.count / 3;
  // line fading measures the whole polygon: 2 * area / perimeter, as the inradius of a triangle
  const area = new Float64Array(count);
  const perimeter = new Float64Array(count);
  const points = position.array;
  const [a, b, c, ab, ac] = Array.from({ length: 5 }, () => new THREE.Vector3());
  for (let t = 0; t < count; t++) {
    pointAt(a, points, 3 * t);
    pointAt(b, points, 3 * t + 1);
    pointAt(c, points, 3 * t + 2);
    area[polygon[t]] += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2;
    // the edges drawn (bit k: the edge opposite vertex k hidden)
    if (!(hidden[t] & 1)) perimeter[polygon[t]] += b.distanceTo(c);
    if (!(hidden[t] & 2)) perimeter[polygon[t]] += c.distanceTo(a);
    if (!(hidden[t] & 4)) perimeter[polygon[t]] += a.distanceTo(b);
  }
  const sizes = new Float32Array(count);
  for (let t = 0; t < count; t++) sizes[t] = (2 * area[polygon[t]]) / perimeter[polygon[t]] || 0;

  const result = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (name !== "wireEdge") result.setAttribute(name, attribute);
  }
  const distances = edgeDistances(position, { hidden, sizes });
  result.setAttribute("wireEdge", new THREE.BufferAttribute(distances, 4));
  const { near, end, far } = nearDistances(position, lines);
  result.setAttribute("wireNear", new THREE.BufferAttribute(near, 3));
  result.setAttribute("wireNearEnd", new THREE.BufferAttribute(end, 3));
  result.setAttribute("wireNearFar", new THREE.BufferAttribute(far, 3));
  return result;
}

/** cos of the largest turn at which an outline still goes on straight (nearPlan). */
const STRAIGHT = Math.cos(THREE.MathUtils.degToRad(10));

/**
 * A polygon's outline edges through a triangle's corners, drawn by that triangle too: at a thin
 * corner (a quad's hidden diagonal leaves two) the line is wider than the triangle that owns the
 * edge. Up to 3 per triangle, those it lies alongside first. Each as three point indices (-1:
 * none): where it starts at the triangle's corner, its other end, and where the outline turns
 * after the edges in line with it past that end, so a long thin triangle along a short edge (a
 * cut corner) does not draw it on past the turn.
 *
 * @param {THREE.BufferAttribute | THREE.InterleavedBufferAttribute} position
 * @param {Uint8Array} hidden per triangle
 * @param {Uint32Array} polygon per triangle
 * @returns {Int32Array} per triangle and slot: from, to, the outline's turn
 */
function nearPlan(position, hidden, polygon) {
  const count = hidden.length;
  /** @param {number} i */
  const at = (i) => new THREE.Vector3().fromBufferAttribute(position, i);
  /** @param {number} t @param {number} v */
  const corner = (t, v) => `${polygon[t]} ${at(3 * t + v).toArray()}`;
  /** The end of an edge (by its first corner) that is not at `from`, as a point index. */
  const otherEnd = (/** @type {number} */ edge, /** @type {THREE.Vector3} */ from) => {
    const [i, j] = [1, 2].map((s) => edge - (edge % 3) + ((edge + s) % 3));
    return at(i).equals(from) ? j : i;
  };

  /** @type {Map<string, number[]>} polygon corner -> its visible edges (3 * triangle + k) */
  const through = new Map();
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      if (hidden[t] & (1 << k)) continue;
      for (const v of [(k + 1) % 3, (k + 2) % 3]) {
        const key = corner(t, v);
        let edges = through.get(key);
        if (!edges) through.set(key, (edges = []));
        edges.push(3 * t + k);
      }
    }
  }

  const plan = new Int32Array(count * 9).fill(-1);
  const normal = new THREE.Vector3();
  for (let t = 0; t < count; t++) {
    const points = [0, 1, 2].map((v) => at(3 * t + v));
    normal.subVectors(points[1], points[0]).cross(points[2].clone().sub(points[0]));
    if (normal.lengthSq() === 0) continue;
    normal.normalize();

    /** @type {Set<number>} */
    const seen = new Set();
    const lines = [];
    for (let v = 0; v < 3; v++) {
      for (const edge of through.get(corner(t, v)) ?? []) {
        // its own edges are in wireEdge
        if (Math.floor(edge / 3) === t || seen.has(edge)) continue;
        seen.add(edge);
        const from = points[v];
        const to = otherEnd(edge, from);
        const along = at(to).sub(from);
        const length = along.length();
        // where the outline goes on straight past the far end, its line may run on as far as it
        // does: along the edges in line with it, up to where it turns
        const ahead = along.clone().divideScalar(length);
        let [last, end] = [edge, to];
        for (let step = 0; step < 64; step++) {
          const here = at(end);
          let beyond = end;
          const next = (through.get(`${polygon[t]} ${here.toArray()}`) ?? []).find((n) => {
            if (n === last) return false;
            beyond = otherEnd(n, here);
            const onward = at(beyond).sub(here);
            return onward.dot(ahead) > STRAIGHT * onward.length();
          });
          if (next === undefined) break;
          [last, end] = [next, beyond];
        }
        along.addScaledVector(normal, -along.dot(normal)); // in the triangle's plane
        const span = along.length();
        if (span <= 0.7 * length) continue; // over 45° off this face: no line on it
        along.normalize();
        const past = Math.max(...points.map((p) => -p.clone().sub(from).dot(along)));
        const further = at(end).sub(at(to)).dot(ahead);
        lines.push({ ends: [3 * t + v, to, end], past, span: span + further, x: from.x });
      }
    }
    // those it lies alongside first, then the longer, then the nearer the middle across: the
    // same for a triangle and its mirror image, whichever way round its corners come
    lines.sort((p, q) => p.past - q.past || q.span - p.span || Math.abs(p.x) - Math.abs(q.x));
    lines.slice(0, 3).forEach(({ ends }, j) => plan.set(ends, (3 * t + j) * 3));
  }
  return plan;
}

/**
 * The lines of a plan (nearPlan) measured for each triangle as its points are now: per vertex
 * and line, `wireNear` the signed distance to the line in the triangle's plane, `wireNearEnd`
 * the distance past its end at the triangle's corner, so the line stops there, `wireNearFar`
 * the distance past where the outline turns. All linear in the triangle, so they interpolate
 * exactly. Spare slots, and lines on a triangle crushed flat or turned edge on, stay HIDDEN.
 *
 * @param {THREE.BufferAttribute} position
 * @param {Int32Array} plan
 */
function nearDistances(position, plan) {
  const count = position.count / 3;
  const near = new Float32Array(count * 9).fill(HIDDEN);
  const end = new Float32Array(count * 9);
  const far = new Float32Array(count * 9);
  const array = position.array;
  const points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const [from, along, ahead, across, normal, offset, turn] = Array.from(
    { length: 7 },
    () => new THREE.Vector3(),
  );
  for (let t = 0; t < count; t++) {
    if (plan[t * 9] < 0) continue;
    for (let v = 0; v < 3; v++) pointAt(points[v], array, 3 * t + v);
    normal.subVectors(points[1], points[0]).cross(offset.subVectors(points[2], points[0]));
    if (normal.lengthSq() === 0) continue;
    normal.normalize();
    for (let j = 0; j < 3; j++) {
      const slot = (3 * t + j) * 3;
      if (plan[slot] < 0) break;
      pointAt(from, array, plan[slot]);
      pointAt(ahead, array, plan[slot + 1]);
      pointAt(turn, array, plan[slot + 2]).sub(ahead);
      along.subVectors(ahead, from);
      ahead.copy(along).normalize();
      along.addScaledVector(normal, -along.dot(normal)); // in the triangle's plane
      const span = along.length();
      if (span === 0) continue;
      along.divideScalar(span);
      const reach = span + turn.dot(ahead);
      across.crossVectors(normal, along);
      for (let v = 0; v < 3; v++) {
        offset.subVectors(points[v], from);
        near[(3 * t + v) * 3 + j] = offset.dot(across);
        end[(3 * t + v) * 3 + j] = -offset.dot(along);
        far[(3 * t + v) * 3 + j] = offset.dot(along) - reach;
      }
    }
  }
  return { near, end, far };
}

/**
 * Per-layer line settings as uniform objects: fade threshold (render px) and the visibility
 * lines fade down to (0..1).
 *
 * @typedef {{ fade: { value: number }, min: { value: number } }} LineUniforms
 */

const LINE_VERTEX = /* glsl */ `
  attribute vec4 wireEdge;
  varying vec4 vWireEdge;
  #ifdef WIRE_NEAR
  attribute vec3 wireNear, wireNearEnd, wireNearFar;
  varying vec3 vWireNear, vWireNearEnd, vWireNearFar;
  #endif`;

// object space -> world units (objects and instances are scaled, e.g. rocks)
const LINE_VERTEX_MAIN = /* glsl */ `
  mat3 wireMatrix = mat3(modelMatrix);
  #ifdef USE_INSTANCING
  wireMatrix *= mat3(instanceMatrix);
  #endif
  float wireScale = pow(abs(determinant(wireMatrix)), 1.0 / 3.0);
  vWireEdge = wireEdge * wireScale;
  #ifdef WIRE_NEAR
  vWireNear = wireNear * wireScale;
  vWireNearEnd = wireNearEnd * wireScale;
  vWireNearFar = wireNearFar * wireScale;
  #endif`;

const LINE_FRAGMENT = /* glsl */ `
  uniform float uLineWidth;
  uniform float uLineFade;
  uniform float uLineMin;
  varying vec4 vWireEdge;
  #ifdef WIRE_NEAR
  varying vec3 vWireNear, vWireNearEnd, vWireNearFar;
  #endif

  // world units per pixel across each line (never 0: a spare nearDistances slot is constant)
  vec3 linePixel(vec3 distance) {
    vec3 dx = dFdx(distance);
    vec3 dy = dFdy(distance);
    return max(sqrt(dx * dx + dy * dy), vec3(1e-9));
  }

  // pixel coverage of the lines at these distances, at least a pixel wide
  vec3 lineAt(vec3 distance, vec3 pixel) {
    vec3 halfWidth = max(uLineWidth * 0.5 / pixel, vec3(0.5));
    return clamp(halfWidth + 0.5 - distance / pixel, 0.0, 1.0);
  }

  // Each triangle draws its half of its edges' lines; the neighbour draws the other half.
  float lineCoverage() {
    vec3 pixel = linePixel(vWireEdge.xyz);
    vec3 line = lineAt(vWireEdge.xyz, pixel);
    #ifdef WIRE_NEAR
    // the polygon's edges through this triangle's corners, up to half a line width past their ends
    vec3 near = lineAt(abs(vWireNear), linePixel(vWireNear));
    near *= lineAt(vWireNearEnd, linePixel(vWireNearEnd));
    near *= lineAt(vWireNearFar, linePixel(vWireNearFar));
    line = max(line, near);
    #endif
    float inradius = vWireEdge.w / max(pixel.x, max(pixel.y, pixel.z));
    float dense = uLineFade > 0.0 ? 1.0 - smoothstep(uLineFade * 0.25, uLineFade, inradius) : 0.0;
    float visible = 1.0 - dense * (1.0 - uLineMin);
    return max(line.x, max(line.y, line.z)) * visible;
  }`;

/**
 * @param {THREE.WebGLProgramParametersWithUniforms} shader
 * @param {LineUniforms} uniforms the material's own
 * @param {boolean} near polygon lines: the geometry has wireNear (polygonLineGeometry)
 */
function injectLines(shader, uniforms, near) {
  shader.uniforms.uLineWidth = lineWidth;
  shader.uniforms.uLineFade = uniforms.fade;
  shader.uniforms.uLineMin = uniforms.min;
  const define = near ? "#define WIRE_NEAR" : "";

  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `${define}\n#include <common>\n${LINE_VERTEX}`)
    .replace("#include <begin_vertex>", `#include <begin_vertex>\n${LINE_VERTEX_MAIN}`);

  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `${define}\n#include <common>\n${LINE_FRAGMENT}`)
    .replace(
      "#include <color_fragment>",
      `#include <color_fragment>
      diffuseColor.a *= lineCoverage();
      if (diffuseColor.a <= 0.0) discard;`,
    );
}

/**
 * Line overrides shared by both classes: see-through like GL lines, blended edges. One pass: three
 * draws a transparent double-sided material twice (back faces, then front) and rebuilds it before
 * each draw, for every mesh; lines of one colour blend alike in either order.
 */
const LINE_PARAMETERS = {
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  forceSinglePass: true,
};

/**
 * A material of `Base` drawing the triangle lines instead of its fill. `lineUniforms` (per
 * layer) are shared with clones, so fade-in copies follow the GUI; onBeforeCompile is a method,
 * so it survives clone() too.
 *
 * @template {new (...args: any[]) => THREE.Material} T
 * @param {T} Base
 */
function withLines(Base) {
  return class extends Base {
    /** @type {LineUniforms} */
    lineUniforms = { fade: { value: WIRE.fade }, min: { value: WIRE.min } };

    /** @param {any[]} args the base material's parameters */
    constructor(...args) {
      super({ ...args[0], ...LINE_PARAMETERS });
    }

    /** @param {THREE.WebGLProgramParametersWithUniforms} shader */
    onBeforeCompile(shader) {
      injectLines(shader, this.lineUniforms, Boolean(this.userData.wirePolygons));
    }

    /** Polygon lines (scene/wire.js) read wireNear too: a program of their own. */
    customProgramCacheKey() {
      return this.userData.wirePolygons ? "polygon lines" : "lines";
    }

    /** @param {this} source */
    copy(source) {
      super.copy(source);
      this.lineUniforms = source.lineUniforms;
      return this;
    }
  };
}

/** Unlit lines. */
export const BasicLineMaterial = withLines(THREE.MeshBasicMaterial);

/** Lit lines. */
export const PhongLineMaterial = withLines(THREE.MeshPhongMaterial);

/** @typedef {InstanceType<typeof BasicLineMaterial> | InstanceType<typeof PhongLineMaterial>} LineMaterial */

/**
 * @param {THREE.Material} material
 * @returns {material is LineMaterial}
 */
export const isLineMaterial = (material) =>
  material instanceof BasicLineMaterial || material instanceof PhongLineMaterial;
