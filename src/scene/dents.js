import * as THREE from "three";
import { wireGeometry } from "./wire.js";

/**
 * @typedef {object} Dent
 * @property {(progress: number) => void} set how far the crush has gone, 0..1
 * @property {() => void} undo puts the original geometries back (every dent's)
 *
 * @typedef {object} Dents a mesh's dents: each moves its points, as far as it has gone
 * @property {THREE.BufferGeometry} original
 * @property {THREE.BufferGeometry | undefined} originalWire
 * @property {Float32Array} base the original points
 * @property {{ by: Float32Array, progress: number }[]} moves each dent's full move per point
 *
 * @typedef {object} Move a node moved whole by a dent: where it ends up, in its parent
 * @property {THREE.Object3D} node
 * @property {THREE.Vector3} position
 * @property {THREE.Quaternion} quaternion
 *
 * @typedef {object} Dentable a mesh to dent, its points as they will be after its dents so far
 * @property {THREE.Mesh} mesh
 * @property {Float32Array} world its points in the world
 * @property {Float32Array} full its points in its own frame
 * @property {Dents} dents
 */

/** @type {WeakMap<THREE.Mesh, Dents>} */
const dentsOf = new WeakMap();
/** @type {WeakMap<THREE.Object3D, object>} the dent that moves a node now: the latest */
const moverOf = new WeakMap();

/**
 * The meshes under a root (not their wireframe twins), each with its points as they will be once
 * its dents so far have gone all the way: a new dent goes on top of them.
 *
 * @param {THREE.Object3D} root its world matrices up to date
 * @returns {Dentable[]}
 */
export function dentable(root) {
  /** @type {THREE.Mesh[]} */
  const meshes = [];
  root.traverse((object) => {
    if (object instanceof THREE.Mesh && !object.userData.isWire) meshes.push(object);
  });
  const p = new THREE.Vector3();
  return meshes.map((mesh) => {
    const dents = dentsOf.get(mesh) ?? {
      original: mesh.geometry,
      originalWire: wireOf(mesh)?.geometry,
      base: Float32Array.from(mesh.geometry.getAttribute("position").array),
      moves: [],
    };
    const full = shape(dents, true);
    const world = new Float32Array(full.length);
    for (let i = 0; i < full.length; i += 3) {
      p.fromArray(full, i).applyMatrix4(mesh.matrixWorld).toArray(world, i);
    }
    return { mesh, dents, full, world };
  });
}

/**
 * Dents meshes: each point goes where `move` takes it (in the world), as far as set() says. Every
 * mesh that moves gets a dented copy of its geometry, and its wireframe twin new lines, drawn for
 * the full dent; set() moves the points part of the way. Dents stack: a mesh dented again keeps
 * its earlier dents going.
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
    const { mesh, dents, full, world } = entry;
    const by = new Float32Array(full.length);
    inverse.copy(mesh.matrixWorld).invert();
    let moved = false;
    for (let i = 0; i < full.length; i += 3) {
      move(entry, v.fromArray(world, i));
      v.applyMatrix4(inverse);
      for (let k = 0; k < 3; k++) by[i + k] = v.getComponent(k) - full[i + k];
      moved ||= Math.abs(by[i]) + Math.abs(by[i + 1]) + Math.abs(by[i + 2]) > 1e-6;
    }
    if (!moved) continue;
    const step = { by, progress: 0 };
    dents.moves.push(step);
    dentsOf.set(mesh, dents);
    dented.push({ mesh, dents, move: step });

    // a new copy, its normals and lines for the full dent (scene/lines.js measures the shape
    // afresh: not the edges the original came with)
    const geometry = dents.original.clone();
    geometry.deleteAttribute("wireEdge");
    const position = /** @type {THREE.BufferAttribute} */ (geometry.getAttribute("position"));
    position.copyArray(shape(dents, true));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const wire = wireOf(mesh);
    if (wire) {
      const lines = wireGeometry(geometry, /** @type {THREE.Material} */ (wire.material));
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
 * where it got to.
 *
 * @param {Move[]} moves
 * @returns {Dent} starting at 0
 */
export function moveNodes(moves) {
  const token = {};
  const from = moves.map(({ node }) => {
    moverOf.set(node, token);
    return { position: node.position.clone(), quaternion: node.quaternion.clone() };
  });
  return {
    set(progress) {
      moves.forEach(({ node, position, quaternion }, i) => {
        if (moverOf.get(node) !== token) return;
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

/** @param {THREE.Mesh} mesh */
const wireOf = (mesh) =>
  /** @type {THREE.Mesh | undefined} */ (mesh.children.find((child) => child.userData.isWire));

/**
 * A mesh's points with its dents as far as they have gone, or in full.
 *
 * @param {Dents} dents
 * @param {boolean} [full]
 */
function shape({ base, moves }, full = false) {
  const points = Float32Array.from(base);
  for (const { by, progress } of moves) {
    const share = full ? 1 : progress;
    if (share) for (let i = 0; i < points.length; i++) points[i] += by[i] * share;
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
  position.copyArray(shape(dents));
  position.needsUpdate = true;
}
