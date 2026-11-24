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
 * Polygon lines also draw neighbouring edges: `wireNear`, `wireNearEnd` (nearDistances).
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
export function memoByGeometry(derive) {
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
  const position = geometry.getAttribute("position");
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
 * @typedef {object} EdgeOptions
 * @property {number | ArrayLike<number>} [hidden] edges not drawn, for every triangle or per
 *   triangle: bit k is the edge opposite vertex k
 * @property {ArrayLike<number>} [sizes] per triangle, what line fading measures instead of the
 *   triangle's inradius
 */

/**
 * @param {THREE.BufferAttribute | THREE.InterleavedBufferAttribute} position
 * @param {EdgeOptions} options
 * @param {Float32Array} [target] reused when the topology did not change
 */
function edgeDistances(position, { hidden = 0, sizes }, target) {
  const distances = target ?? new Float32Array(position.count * 4);
  distances.fill(0);
  const [a, b, c] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const cross = new THREE.Vector3();

  for (let i = 0, t = 0; i + 2 < position.count; i += 3, t++) {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    c.fromBufferAttribute(position, i + 2);
    const doubleArea = cross.subVectors(b, a).cross(c.clone().sub(a)).length();
    // height over the opposite edge = 2 * area / edge length
    const height = (/** @type {number} */ edge) => (edge > 0 ? doubleArea / edge : 0);
    const [ab, bc, ca] = [a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)];
    distances[i * 4] = height(bc);
    distances[(i + 1) * 4 + 1] = height(ca);
    distances[(i + 2) * 4 + 2] = height(ab);
    const size = sizes ? sizes[t] : height(ab + bc + ca); // inradius: 2 * area / perimeter
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
 * material reads. One per source geometry, sharing its attributes.
 *
 * @type {(geometry: THREE.BufferGeometry) => THREE.BufferGeometry}
 */
export const polygonLineGeometry = memoByGeometry((geometry) => {
  const position = geometry.getAttribute("position");
  const count = position.count / 3;
  /** @type {import("../core/fbx.js").Polygons} */
  const { inner: hidden, polygon } = geometry.userData.polygons ?? {
    inner: new Uint8Array(count),
    polygon: Uint32Array.from({ length: count }, (_, t) => t),
  };

  // line fading measures the whole polygon: 2 * area / perimeter, as the inradius of a triangle
  const area = new Float64Array(count);
  const perimeter = new Float64Array(count);
  const [a, b, c] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (let t = 0; t < count; t++) {
    a.fromBufferAttribute(position, 3 * t);
    b.fromBufferAttribute(position, 3 * t + 1);
    c.fromBufferAttribute(position, 3 * t + 2);
    area[polygon[t]] += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
    [b.distanceTo(c), c.distanceTo(a), a.distanceTo(b)].forEach((edge, k) => {
      if (!(hidden[t] & (1 << k))) perimeter[polygon[t]] += edge;
    });
  }
  const sizes = Float32Array.from(
    { length: count },
    (_, t) => (2 * area[polygon[t]]) / perimeter[polygon[t]] || 0,
  );

  const lines = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (name !== "wireEdge") lines.setAttribute(name, attribute);
  }
  const distances = edgeDistances(position, { hidden, sizes });
  lines.setAttribute("wireEdge", new THREE.BufferAttribute(distances, 4));
  const { near, end, far } = nearDistances(position, hidden, polygon);
  lines.setAttribute("wireNear", new THREE.BufferAttribute(near, 3));
  lines.setAttribute("wireNearEnd", new THREE.BufferAttribute(end, 3));
  lines.setAttribute("wireNearFar", new THREE.BufferAttribute(far, 3));
  return lines;
});

/** cos of the largest turn at which an outline still goes on straight (nearDistances). */
const STRAIGHT = Math.cos(THREE.MathUtils.degToRad(10));

/**
 * A polygon's outline edges through a triangle's corners, drawn by that triangle too: at a thin
 * corner (a quad's hidden diagonal leaves two) the line is wider than the triangle that owns the
 * edge. Up to 3 per triangle, those it lies alongside first. Per vertex and edge, `wireNear`: the
 * signed distance to the edge's line in the triangle's plane; `wireNearEnd`: the distance past
 * the edge's end at that corner, so the line stops there; `wireNearFar`: the distance past its
 * other end, or past where the outline turns after edges in line with it, so a long thin triangle
 * along a short edge (a cut corner) does not draw it on past the turn. All are
 * linear in the triangle, so they interpolate exactly. Spare slots stay HIDDEN.
 *
 * @param {THREE.BufferAttribute | THREE.InterleavedBufferAttribute} position
 * @param {Uint8Array} hidden per triangle
 * @param {Uint32Array} polygon per triangle
 */
function nearDistances(position, hidden, polygon) {
  const count = hidden.length;
  /** @param {number} i */
  const at = (i) => new THREE.Vector3().fromBufferAttribute(position, i);
  /** @param {number} t @param {number} v */
  const corner = (t, v) => `${polygon[t]} ${at(3 * t + v).toArray()}`;

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

  const near = new Float32Array(count * 9).fill(HIDDEN);
  const end = new Float32Array(count * 9);
  const far = new Float32Array(count * 9);
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
        const [a, b] = [1, 2].map((s) => at(edge - (edge % 3) + ((edge + s) % 3)));
        const to = a.equals(from) ? b : a;
        const along = to.clone().sub(from);
        const length = along.length();
        // where the outline goes on straight past the far end, its line may run on as far as it
        // does: along the edges in line with it, up to where it turns
        const ahead = along.clone().divideScalar(length);
        let [last, end, further] = [edge, to, 0];
        for (let step = 0; step < 64; step++) {
          const next = (through.get(`${polygon[t]} ${end.toArray()}`) ?? []).find((n) => {
            if (n === last) return false;
            const [c, d] = [1, 2].map((s) => at(n - (n % 3) + ((n + s) % 3)));
            const onward = (c.equals(end) ? d : c).sub(end);
            return onward.dot(ahead) > STRAIGHT * onward.length();
          });
          if (next === undefined) break;
          const [c, d] = [1, 2].map((s) => at(next - (next % 3) + ((next + s) % 3)));
          const beyond = c.equals(end) ? d : c;
          further += beyond.clone().sub(end).dot(ahead);
          [last, end] = [next, beyond];
        }
        along.addScaledVector(normal, -along.dot(normal)); // in the triangle's plane
        const span = along.length();
        if (span <= 0.7 * length) continue; // over 45° off this face: no line on it
        along.normalize();
        const across = normal.clone().cross(along);
        const past = Math.max(...points.map((p) => -p.clone().sub(from).dot(along)));
        lines.push({ from, along, across, past, span: span + further });
      }
    }
    // those it lies alongside first, then the longer, then the nearer the middle across: the
    // same for a triangle and its mirror image, whichever way round its corners come
    lines.sort(
      (p, q) => p.past - q.past || q.span - p.span || Math.abs(p.from.x) - Math.abs(q.from.x),
    );
    lines.slice(0, 3).forEach(({ from, along, across, span }, j) => {
      points.forEach((p, v) => {
        const offset = p.clone().sub(from);
        near[(3 * t + v) * 3 + j] = offset.dot(across);
        end[(3 * t + v) * 3 + j] = -offset.dot(along);
        far[(3 * t + v) * 3 + j] = offset.dot(along) - span;
      });
    });
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

// object space -> world units (instances are scaled, e.g. rocks)
const LINE_VERTEX_MAIN = /* glsl */ `
  float wireScale = pow(abs(determinant(mat3(modelMatrix))), 1.0 / 3.0);
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

/** Line overrides shared by both classes: see-through like GL lines, blended edges. */
const LINE_PARAMETERS = { transparent: true, depthWrite: false, side: THREE.DoubleSide };

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

/** Lit lines (v1 wireframes were Phong). */
export const PhongLineMaterial = withLines(THREE.MeshPhongMaterial);

/** @typedef {InstanceType<typeof BasicLineMaterial> | InstanceType<typeof PhongLineMaterial>} LineMaterial */

/**
 * @param {THREE.Material} material
 * @returns {material is LineMaterial}
 */
export const isLineMaterial = (material) =>
  material instanceof BasicLineMaterial || material instanceof PhongLineMaterial;
