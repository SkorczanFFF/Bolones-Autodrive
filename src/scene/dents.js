import * as THREE from "three";
import { evenNormals } from "./polygons.js";
import { solidMeshes, wireGeometry, wireOf } from "./wire.js";

/**
 * @typedef {object} Dent
 * @property {(progress: number) => void} set how far the crush has gone, 0..1
 * @property {() => void} undo puts the original geometries back (every dent's)
 *
 * @typedef {object} Dents a mesh's dents: each moves its points, as far as it has gone
 * @property {THREE.BufferGeometry} original
 * @property {THREE.BufferGeometry | undefined} originalWire
 * @property {Float32Array} base the original points
 * @property {{ by: Float32Array, progress: number, reach: number }[]} moves each dent's full move
 *   per point, as far as it has gone, and the farthest it moves a point
 *
 * @typedef {object} Move a node moved whole by a dent: where it ends up, in its parent
 * @property {THREE.Object3D} node
 * @property {THREE.Vector3} position
 * @property {THREE.Quaternion} quaternion
 *
 * @typedef {object} Dentable a mesh to dent, its points as they are shown, its dents so far as far
 *   as they have gone
 * @property {THREE.Mesh} mesh
 * @property {Float32Array} world its points in the world
 * @property {Float32Array} shown its points in its own frame
 * @property {Dents} dents
 */

/** @type {WeakMap<THREE.Mesh, Dents>} */
const dentsOf = new WeakMap();
/** @type {WeakMap<THREE.Object3D, object>} the dent that moves a node now: the latest */
const moverOf = new WeakMap();

/**
 * The meshes under a root (not their wireframe twins), each with its points as they are shown, its
 * dents so far as far as they have gone: a new dent goes on top of them as they are, where it meets
 * the other car (as they will be in full, a crush that stopped short would leave it off by the
 * rest).
 *
 * @param {THREE.Object3D} root its world matrices up to date
 * @returns {Dentable[]}
 */
export function dentable(root) {
  const p = new THREE.Vector3();
  return solidMeshes(root).map((mesh) => {
    const dents = dentsOf.get(mesh) ?? {
      original: mesh.geometry,
      originalWire: wireOf(mesh)?.geometry,
      base: Float32Array.from(mesh.geometry.getAttribute("position").array),
      moves: [],
    };
    const shown = shape(dents);
    const world = new Float32Array(shown.length);
    for (let i = 0; i < shown.length; i += 3) {
      // not fromArray() / toArray(): three calls them with every kind of array, too slow for
      // every point of a car (crumple.js too)
      p.set(shown[i], shown[i + 1], shown[i + 2]).applyMatrix4(mesh.matrixWorld);
      world[i] = p.x;
      world[i + 1] = p.y;
      world[i + 2] = p.z;
    }
    return { mesh, dents, shown, world };
  });
}

/**
 * Dents meshes: each point goes where `move` takes it (in the world), as far as set() says. Every
 * mesh that moves gets a dented copy of its geometry, and its wireframe twin new lines, drawn for
 * the full dent on the mesh as shown; set() moves the points part of the way. Dents stack: a mesh
 * dented again keeps its earlier dents going.
 *
 * @param {Dentable[]} meshes
 * @param {(mesh: Dentable, point: THREE.Vector3) => void} move
 * @returns {Dent} starting at 0
 */
export function dent(meshes, move) {
  /** @type {{ mesh: THREE.Mesh, dents: Dents, move: Dents["moves"][number] }[]} */
  const dented = [];
  const inverse = new THREE.Matrix4();
  const v = new THREE.Vector3();
  for (const entry of meshes) {
    const { mesh, dents, shown, world } = entry;
    const by = new Float32Array(shown.length);
    inverse.copy(mesh.matrixWorld).invert();
    let farthest = 0; // squared
    for (let i = 0; i < shown.length; i += 3) {
      const [x, y, z] = [world[i], world[i + 1], world[i + 2]];
      move(entry, v.set(x, y, z));
      if (v.x === x && v.y === y && v.z === z) continue; // not moved (rounding back would)
      v.applyMatrix4(inverse);
      by[i] = v.x - shown[i];
      by[i + 1] = v.y - shown[i + 1];
      by[i + 2] = v.z - shown[i + 2];
      farthest = Math.max(farthest, by[i] ** 2 + by[i + 1] ** 2 + by[i + 2] ** 2);
    }
    if (farthest < 1e-12) continue;
    const step = { by, progress: 0, reach: Math.sqrt(farthest) };
    dents.moves.push(step);
    dentsOf.set(mesh, dents);
    dented.push({ mesh, dents, move: step });

    // a new copy, its normals and lines for the full dent (the original's lines, measured
    // afresh: scene/lines.js), its bounds the original's grown by as far as the dents move a
    // point (cheaper than measuring them)
    if (!dents.original.boundingSphere) dents.original.computeBoundingSphere();
    const geometry = dents.original.clone();
    geometry.deleteAttribute("wireEdge");
    const points = /** @type {Float32Array} */ (geometry.getAttribute("position").array);
    for (let i = 0; i < points.length; i++) points[i] = shown[i] + by[i];
    flatNormals(geometry);
    evenNormals(geometry); // decals keep their even shading (scene/sedan.js)
    /** @type {THREE.Sphere} */ (geometry.boundingSphere).radius += dents.moves.reduce(
      (sum, { reach }) => sum + reach,
      0,
    );
    const wire = wireOf(mesh);
    if (wire) {
      const material = /** @type {THREE.Material} */ (wire.material);
      const lines = wireGeometry(geometry, material, dents.original);
      // the lines' bounds as the solid's: measured now, the dent not in yet, they would cull early
      if (lines !== geometry) lines.boundingSphere = geometry.boundingSphere?.clone() ?? null;
      if (wire.geometry !== dents.originalWire && wire.geometry !== mesh.geometry) {
        wire.geometry.dispose();
      }
      wire.geometry = lines;
    }
    if (mesh.geometry !== dents.original) mesh.geometry.dispose();
    mesh.geometry = geometry;
    show(mesh, dents);
  }

  return {
    set(progress) {
      for (const { mesh, dents, move } of dented) {
        move.progress = progress;
        if (dentsOf.get(mesh) === dents) show(mesh, dents);
      }
    },
    undo() {
      for (const { mesh, dents } of dented) {
        if (dentsOf.get(mesh) !== dents) continue; // put back already
        dentsOf.delete(mesh);
        const wire = wireOf(mesh);
        if (wire && dents.originalWire) {
          if (wire.geometry !== mesh.geometry) wire.geometry.dispose();
          wire.geometry = dents.originalWire;
        }
        mesh.geometry.dispose();
        mesh.geometry = dents.original;
      }
    },
  };
}

/**
 * Moves nodes whole, as far as set() says, from where they are; a node moved again goes on from
 * where it got to, one torn off since (in another parent) stays where it is.
 *
 * @param {Move[]} moves
 * @returns {Dent} starting at 0
 */
export function moveNodes(moves) {
  const token = {};
  const from = moves.map(({ node }) => {
    moverOf.set(node, token);
    return {
      parent: node.parent,
      position: node.position.clone(),
      quaternion: node.quaternion.clone(),
    };
  });
  return {
    set(progress) {
      moves.forEach(({ node, position, quaternion }, i) => {
        if (moverOf.get(node) !== token || node.parent !== from[i].parent) return;
        node.position.lerpVectors(from[i].position, position, progress);
        node.quaternion.slerpQuaternions(from[i].quaternion, quaternion, progress);
      });
    },
    undo() {
      moves.forEach(({ node }, i) => {
        node.position.copy(from[i].position);
        node.quaternion.copy(from[i].quaternion);
      });
    },
  };
}

/**
 * A non-indexed geometry's normals, one a triangle, worked out from its points' array (as
 * computeVertexNormals() does, reading any kind of attribute: slower for every point of a car).
 *
 * @param {THREE.BufferGeometry} geometry
 */
function flatNormals(geometry) {
  const points = geometry.getAttribute("position").array;
  const normal = /** @type {THREE.BufferAttribute} */ (geometry.getAttribute("normal"));
  const normals = normal.array;
  for (let i = 0; i < points.length; i += 9) {
    // plain numbers, no arrays: every triangle of a car
    const ux = points[i + 3] - points[i];
    const uy = points[i + 4] - points[i + 1];
    const uz = points[i + 5] - points[i + 2];
    const vx = points[i + 6] - points[i];
    const vy = points[i + 7] - points[i + 1];
    const vz = points[i + 8] - points[i + 2];
    const x = uy * vz - uz * vy;
    const y = uz * vx - ux * vz;
    const z = ux * vy - uy * vx;
    const length = Math.hypot(x, y, z) || 1;
    for (let k = 0; k < 9; k += 3) {
      normals[i + k] = x / length;
      normals[i + k + 1] = y / length;
      normals[i + k + 2] = z / length;
    }
  }
  normal.needsUpdate = true;
}

/**
 * A mesh's points with its dents as far as they have gone.
 *
 * @param {Dents} dents
 * @param {Float32Array} [points] written into (a geometry's own, every frame of a dent)
 */
function shape({ base, moves }, points = new Float32Array(base.length)) {
  points.set(base);
  for (const { by, progress } of moves) {
    if (progress) for (let i = 0; i < points.length; i++) points[i] += by[i] * progress;
  }
  return points;
}

/**
 * Moves a mesh's points as far as its dents have gone; the lines share them (scene/lines.js).
 *
 * @param {THREE.Mesh} mesh
 * @param {Dents} dents
 */
function show(mesh, dents) {
  const position = /** @type {THREE.BufferAttribute} */ (mesh.geometry.getAttribute("position"));
  shape(dents, /** @type {Float32Array} */ (position.array));
  position.needsUpdate = true;
}
