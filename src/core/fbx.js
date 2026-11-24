import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { unzlibSync } from "three/addons/libs/fflate.module.js";

/**
 * The modelled polygons, which the triangulation loses: per triangle of a loaded mesh, in
 * FBXLoader's order.
 *
 * @typedef {object} Polygons
 * @property {Uint8Array} inner edges inside its polygon, bit k = the edge opposite vertex k: fan
 *   diagonals and edges hidden in 3ds Max (an Editable Mesh exports triangles, its quads survive
 *   as edge visibility)
 * @property {Uint32Array} polygon its polygon
 */

/**
 * FBXLoader that splits n-gons into triangle fans, like the loader the models were made with
 * (three r116). Since r15x FBXLoader flattens each n-gon and runs earcut on it, which drops and
 * flips triangles of non-planar quads (the v1 hills lost 37 of their 252), leaving holes with
 * back faces and wire edges showing through. GeometryParser is not exported, so the
 * triangulation is swapped for the duration of the (synchronous) parse. Mesh geometries get
 * `userData.polygons` (Polygons).
 */
export class FanFBXLoader extends FBXLoader {
  /** @type {FBXLoader["parse"]} */
  parse(buffer, path) {
    const earcut = THREE.ShapeUtils.triangulateShape;
    THREE.ShapeUtils.triangulateShape = (contour) => fan(contour.length);
    let model;
    try {
      model = super.parse(buffer, path);
    } finally {
      THREE.ShapeUtils.triangulateShape = earcut;
    }
    if (typeof buffer !== "string") addPolygons(model, readPolygons(buffer));
    return model;
  }
}

/**
 * Corners of an n-gon's triangles. Both the loader and polygonsOf use it, so the polygon data
 * lines up with the loaded triangles.
 *
 * @param {number} size
 */
const fan = (size) => Array.from({ length: size - 2 }, (_, i) => [0, i + 1, i + 2]);

/**
 * @param {THREE.Group} model
 * @param {Map<string, Polygons>} polygons by model name
 */
function addPolygons(model, polygons) {
  model.traverse((object) => {
    const data = object instanceof THREE.Mesh && polygons.get(object.userData.originalName);
    if (!data) return;
    const geometry = /** @type {THREE.BufferGeometry} */ (object.geometry);
    if (data.inner.length * 3 === geometry.getAttribute("position").count) {
      geometry.userData.polygons = data;
    } else {
      console.warn(`FanFBXLoader: the polygons of "${object.name}" do not match its triangles`);
    }
  });
}

/**
 * @param {ArrayLike<number>} polygonVertices FBX PolygonVertexIndex: control points, the last of
 *   each polygon stored as ~index
 * @param {ArrayLike<number>} [edges] FBX Edges: each edge once, as the polygon vertex it starts at
 * @param {ArrayLike<number>} [visibility] per edge, 0 = hidden
 * @returns {Polygons}
 */
export function polygonsOf(polygonVertices, edges = [], visibility = []) {
  /** @param {number} i */
  const vertex = (i) => (polygonVertices[i] < 0 ? ~polygonVertices[i] : polygonVertices[i]);
  /** @param {number} a @param {number} b */
  const key = (a, b) => (a < b ? a * 2 ** 26 + b : b * 2 ** 26 + a);

  /** @type {number[]} */
  const starts = []; // each FBX polygon's first polygon vertex
  const owner = new Int32Array(polygonVertices.length); // polygon vertex -> FBX polygon
  for (let i = 0; i < polygonVertices.length; i++) {
    if (i === 0 || polygonVertices[i - 1] < 0) starts.push(i);
    owner[i] = starts.length - 1;
  }
  /** @param {number} f */
  const sizeOf = (f) => (starts[f + 1] ?? polygonVertices.length) - starts[f];
  /** @param {number} i */
  const next = (i) => starts[owner[i]] + ((i - starts[owner[i]] + 1) % sizeOf(owner[i]));

  const hidden = new Set();
  for (let e = 0; e < edges.length; e++) {
    if (visibility[e] === 0) hidden.add(key(vertex(edges[e]), vertex(next(edges[e]))));
  }

  // polygons: FBX polygons joined over hidden edges
  const polygons = unionFind(starts.length);
  /** @type {Map<number, number>} hidden edge -> the first FBX polygon on it */
  const across = new Map();
  for (let i = 0; i < polygonVertices.length; i++) {
    const edge = key(vertex(i), vertex(next(i)));
    if (!hidden.has(edge)) continue;
    const other = across.get(edge);
    if (other === undefined) across.set(edge, owner[i]);
    else polygons.union(owner[i], other);
  }

  /** @type {{ inner: number[], polygon: number[] }} */
  const triangles = { inner: [], polygon: [] };
  starts.forEach((start, f) => {
    const size = sizeOf(f);
    for (const corners of fan(size)) {
      let inner = 0;
      for (let k = 0; k < 3; k++) {
        const [p, q] = [corners[(k + 1) % 3], corners[(k + 2) % 3]];
        const side = Math.abs(p - q) === 1 || Math.abs(p - q) === size - 1;
        if (!side || hidden.has(key(vertex(start + p), vertex(start + q)))) inner |= 1 << k;
      }
      triangles.inner.push(inner);
      triangles.polygon.push(polygons.find(f));
    }
  });
  return { inner: Uint8Array.from(triangles.inner), polygon: Uint32Array.from(triangles.polygon) };
}

/** @param {number} size */
function unionFind(size) {
  const parent = Int32Array.from({ length: size }, (_, i) => i);
  /** @param {number} i */
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  /** @param {number} a @param {number} b */
  const union = (a, b) => {
    parent[find(a)] = find(b);
  };
  return { find, union };
}

/**
 * FBXLoader keeps its parse tree to itself, so the polygon data is read from the file again.
 *
 * @param {ArrayBuffer} buffer
 * @returns {Map<string, Polygons>} by model name (userData.originalName); empty for ASCII files
 */
function readPolygons(buffer) {
  /** @type {Map<string, Polygons>} */
  const polygons = new Map();
  if (!isBinary(buffer)) return polygons;

  const nodes = parseBinary(buffer);
  const objects = nodes.find((node) => node.name === "Objects")?.children ?? [];
  const connections = nodes.find((node) => node.name === "Connections")?.children ?? [];
  const models = new Map(
    objects.filter((node) => node.name === "Model").map(({ props }) => [props[0], props[1]]),
  );
  for (const geometry of objects) {
    const polygonVertices = geometry.name === "Geometry" && arrayOf(geometry, "PolygonVertexIndex");
    if (!polygonVertices) continue;
    const layer = geometry.children.find((node) => node.name === "LayerElementVisibility");
    const data = polygonsOf(
      polygonVertices,
      arrayOf(geometry, "Edges"),
      layer && arrayOf(layer, "Visibility"),
    );
    for (const { props } of connections) {
      const model = models.get(props[2]);
      if (props[1] === geometry.props[0] && typeof model === "string") polygons.set(model, data);
    }
  }
  return polygons;
}

/** @param {ArrayBuffer} buffer */
const isBinary = (buffer) =>
  buffer.byteLength > 27 &&
  new TextDecoder().decode(new Uint8Array(buffer, 0, 18)) === "Kaydara FBX Binary";

/**
 * @typedef {{ name: string, props: (number | string | FbxArray | null)[], children: FbxNode[] }} FbxNode
 * @typedef {{ decode(): Int32Array | Uint8Array }} FbxArray an int or bool array, decoded on read
 */

/** @type {Record<string, number>} byte sizes of the scalar properties nothing here reads */
const SKIPPED = { C: 1, Y: 2, I: 4, F: 4, D: 8 };

/**
 * The node tree of a binary FBX 7.x file.
 *
 * @param {ArrayBuffer} buffer
 */
function parseBinary(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const latin1 = new TextDecoder("latin1");
  const wide = view.getUint32(23, true) >= 7500; // 64-bit record headers since FBX 7.5
  let offset = 27;

  /** @param {number} at */
  const uint32 = (at) => view.getUint32(at, true);
  const header = () => {
    const value = wide ? Number(view.getBigUint64(offset, true)) : uint32(offset);
    offset += wide ? 8 : 4;
    return value;
  };
  /** @param {number} length */
  const text = (length) => {
    const value = latin1.decode(bytes.subarray(offset, offset + length));
    offset += length;
    return value.split("\0")[0]; // names are stored as "name\0\1Class"
  };

  /** @returns {FbxNode | null} null for the empty record that closes a node list */
  function node() {
    const end = header();
    const count = header();
    header(); // byte length of the properties
    const nameLength = bytes[offset++];
    if (end === 0) return null;
    const name = text(nameLength);
    const props = Array.from({ length: count }, property);
    /** @type {FbxNode[]} */
    const children = [];
    while (offset < end) {
      const child = node();
      if (!child) break;
      children.push(child);
    }
    offset = end;
    return { name, props, children };
  }

  /** @returns {number | string | FbxArray | null} */
  function property() {
    const type = String.fromCharCode(bytes[offset++]);
    const at = offset;
    if (type === "L") {
      offset += 8;
      return Number(view.getBigInt64(at, true));
    }
    if (type === "S" || type === "R") {
      offset += 4;
      return text(uint32(at));
    }
    if (type in SKIPPED) {
      offset += SKIPPED[type];
      return null;
    }
    // array: length, encoding (1 = zlib), byte size, data
    const [length, encoding, size] = [uint32(at), uint32(at + 4), uint32(at + 8)];
    const data = bytes.subarray(at + 12, at + 12 + size);
    offset = at + 12 + size;
    return {
      decode() {
        const raw = encoding === 1 ? unzlibSync(data) : data.slice();
        return type === "i" ? new Int32Array(raw.buffer, 0, length) : raw;
      },
    };
  }

  /** @type {FbxNode[]} */
  const nodes = [];
  while (offset < bytes.length) {
    const top = node();
    if (!top) break;
    nodes.push(top);
  }
  return nodes;
}

/**
 * @param {FbxNode} node
 * @param {string} name
 */
function arrayOf(node, name) {
  const value = node.children.find((child) => child.name === name)?.props[0];
  return value && typeof value === "object" ? value.decode() : undefined;
}
