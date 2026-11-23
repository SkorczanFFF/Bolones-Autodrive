import * as THREE from "three";
import { WIRE } from "../config.js";

/**
 * Triangle wireframe drawn by the fragment shader instead of GL lines. GL lines are always one
 * pixel wide, so a dense mesh far away (palms, the Polonez' nose) turns into a solid block of
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
 * Layer.wirePolygons: polygon outlines on the whole mesh, or on these connected parts of it
 * (numbered in file order; the rest keeps every triangle edge).
 *
 * @typedef {true | { parts: number[] }} WirePolygons
 */

/** @type {Map<string, (geometry: THREE.BufferGeometry) => THREE.BufferGeometry>} */
const polygonLines = new Map();

/**
 * Lines along the modelled polygons (`userData.polygons`, core/fbx.js) instead of every
 * triangle; other geometries get triangle lines. One per source geometry and options, sharing
 * the source's attributes.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {WirePolygons} [options]
 */
export function polygonLineGeometry(geometry, options = true) {
  const key = options === true ? "all" : options.parts.join();
  let lines = polygonLines.get(key);
  if (!lines) {
    polygonLines.set(key, (lines = memoByGeometry((source) => buildPolygonLines(source, options))));
  }
  return lines(geometry);
}

/**
 * @param {THREE.BufferGeometry} geometry
 * @param {WirePolygons} options
 */
function buildPolygonLines(geometry, options) {
  /** @type {import("../core/fbx.js").Polygons | undefined} */
  const polygons = geometry.userData.polygons;
  if (!polygons) return lineGeometry(geometry);

  const { inner, polygon, part } = polygons;
  const count = inner.length;
  // a triangle outside the listed parts keeps its edges and is a polygon of its own
  /** @param {number} t */
  const own = (t) => options !== true && !options.parts.includes(part[t]);
  const hidden = inner.map((mask, t) => (own(t) ? 0 : mask));
  /** @param {number} t */
  const id = (t) => (own(t) ? count + t : polygon[t]);

  // line fading measures the whole polygon: 2 * area / perimeter, as the inradius of a triangle
  const position = geometry.getAttribute("position");
  const area = new Float64Array(2 * count);
  const perimeter = new Float64Array(2 * count);
  const [a, b, c] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (let t = 0; t < count; t++) {
    a.fromBufferAttribute(position, 3 * t);
    b.fromBufferAttribute(position, 3 * t + 1);
    c.fromBufferAttribute(position, 3 * t + 2);
    area[id(t)] += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
    [b.distanceTo(c), c.distanceTo(a), a.distanceTo(b)].forEach((edge, k) => {
      if (!(hidden[t] & (1 << k))) perimeter[id(t)] += edge;
    });
  }
  const sizes = Float32Array.from(
    { length: count },
    (_, t) => (2 * area[id(t)]) / perimeter[id(t)] || 0,
  );

  const lines = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (name !== "wireEdge") lines.setAttribute(name, attribute);
  }
  const distances = edgeDistances(position, { hidden, sizes });
  lines.setAttribute("wireEdge", new THREE.BufferAttribute(distances, 4));
  return lines;
}

/**
 * Per-layer line settings as uniform objects: fade threshold (render px) and the visibility
 * lines fade down to (0..1).
 *
 * @typedef {{ fade: { value: number }, min: { value: number } }} LineUniforms
 */

/**
 * @param {THREE.WebGLProgramParametersWithUniforms} shader
 * @param {LineUniforms} uniforms the material's own
 */
function injectLines(shader, uniforms) {
  shader.uniforms.uLineWidth = lineWidth;
  shader.uniforms.uLineFade = uniforms.fade;
  shader.uniforms.uLineMin = uniforms.min;

  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
      attribute vec4 wireEdge;
      varying vec4 vWireEdge;`,
    )
    .replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      // object space -> world units (instances are scaled, e.g. rocks)
      vWireEdge = wireEdge * pow(abs(determinant(mat3(modelMatrix))), 1.0 / 3.0);`,
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
      uniform float uLineWidth;
      uniform float uLineFade;
      uniform float uLineMin;
      varying vec4 vWireEdge;

      // Each triangle draws its half of the line; the neighbour draws the other half.
      float lineCoverage() {
        vec3 dx = dFdx(vWireEdge.xyz);
        vec3 dy = dFdy(vWireEdge.xyz);
        vec3 pixel = sqrt(dx * dx + dy * dy); // world units per pixel across each edge
        vec3 distance = vWireEdge.xyz / pixel; // to each edge, in pixels
        vec3 halfWidth = max(uLineWidth * 0.5 / pixel, vec3(0.5)); // at least a pixel wide
        vec3 line = clamp(halfWidth + 0.5 - distance, 0.0, 1.0); // pixel coverage
        float inradius = vWireEdge.w / max(pixel.x, max(pixel.y, pixel.z));
        float dense = uLineFade > 0.0 ? 1.0 - smoothstep(uLineFade * 0.25, uLineFade, inradius) : 0.0;
        float visible = 1.0 - dense * (1.0 - uLineMin);
        return max(line.x, max(line.y, line.z)) * visible;
      }`,
    )
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
      injectLines(shader, this.lineUniforms);
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
