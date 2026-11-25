import * as THREE from "three";
import { solidMeshes } from "./wire.js";

/** Copies of one model drawn at most: far more than the road holds at the densest (GUI). */
const CAPACITY = 256;

const FADE_VERTEX = /* glsl */ `
  attribute float instanceFade;
  varying float vInstanceFade;`;
const FADE_FRAGMENT = /* glsl */ `
  varying float vInstanceFade;`;

/** @type {WeakSet<THREE.Material>} */
const fading = new WeakSet();

/**
 * Fades a material per copy (the `instanceFade` attribute), on top of its own shader changes.
 * Its copies are drawn see-through, so its fill is too, and before every line (renderOrder).
 *
 * @param {THREE.Material} material
 */
function fadeCopies(material) {
  if (fading.has(material)) return;
  fading.add(material);
  material.transparent = true;
  const compile = material.onBeforeCompile.bind(material); // e.g. the lines (scene/lines.js)
  material.onBeforeCompile = (shader, renderer) => {
    compile(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${FADE_VERTEX}`)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvInstanceFade = instanceFade;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FADE_FRAGMENT}`)
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\ndiffuseColor.a *= vInstanceFade;",
      );
  };
}

/**
 * Many copies of dressed models (scene/wire.js) as instances: one InstancedMesh per mesh of a
 * model and one per its lines, so every copy of it is one draw call (and its lines one more),
 * however many there are. A copy is a node (an Object3D without meshes) that whatever moves it
 * moves (a spawner, a crash swaying a palm); update() draws the copies where their nodes are, each
 * faded as set() says: this is a spawner's fader (scene/spawner.js).
 *
 * @param {THREE.Object3D} parent where the instances are drawn
 * @param {THREE.Object3D[]} models dressed
 */
export function createInstances(parent, models) {
  const matrix = new THREE.Matrix4();
  /** @type {WeakMap<THREE.Object3D, number>} */
  const opacities = new WeakMap();

  const parts = models.map((model) => {
    model.updateWorldMatrix(true, true);
    const toModel = model.matrixWorld.clone().invert();
    return solidMeshes(model).map((mesh) => {
      const wire = /** @type {THREE.Mesh} */ (
        mesh.children.find(({ userData }) => userData.isWire)
      );
      const fade = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
      const solid = new THREE.InstancedMesh(mesh.geometry, mesh.material, CAPACITY);
      const lines = new THREE.InstancedMesh(wire.geometry, wire.material, CAPACITY);
      lines.instanceMatrix = solid.instanceMatrix;
      lines.layers.mask = wire.layers.mask; // glows (core/bloom.js)
      // shadows as the model's meshes (scene/wire.js)
      solid.castShadow = mesh.castShadow;
      solid.receiveShadow = mesh.receiveShadow;
      lines.receiveShadow = wire.receiveShadow;
      solid.renderOrder = -1; // see-through, yet hiding the lines behind it as a solid would
      for (const instanced of [solid, lines]) {
        instanced.geometry.setAttribute("instanceFade", fade);
        fadeCopies(/** @type {THREE.Material} */ (instanced.material));
        instanced.frustumCulled = false; // along the whole road
        parent.add(instanced);
      }
      return { solid, lines, fade, offset: toModel.clone().multiply(mesh.matrixWorld) };
    });
  });

  return {
    /**
     * A copy of one of the models: place its node, the spawner adds it.
     *
     * @param {THREE.Object3D} model
     */
    copy(model) {
      const node = new THREE.Object3D();
      node.userData.model = model;
      return node;
    },

    /**
     * Draws the copies where their nodes are (their parent at the scene's origin).
     *
     * @param {THREE.Object3D[]} nodes
     */
    update(nodes) {
      const counts = models.map(() => 0);
      for (const node of nodes) {
        const m = models.indexOf(node.userData.model);
        const i = counts[m]++;
        if (i >= CAPACITY) continue;
        node.updateMatrix();
        for (const { solid, fade, offset } of parts[m]) {
          solid.setMatrixAt(i, matrix.multiplyMatrices(node.matrix, offset));
          fade.setX(i, opacities.get(node) ?? 1);
        }
      }
      parts.forEach((meshes, m) => {
        for (const { solid, lines, fade } of meshes) {
          solid.count = lines.count = Math.min(counts[m], CAPACITY);
          solid.instanceMatrix.needsUpdate = fade.needsUpdate = true;
        }
      });
    },

    /** @param {THREE.Object3D} node @param {number} opacity 0..1 */
    set(node, opacity) {
      opacities.set(node, opacity);
    },

    /** @param {THREE.Object3D} node */
    release(node) {
      opacities.delete(node);
    },

    clear() {},
  };
}

/**
 * Where a copy's meshes would be in the scene: its model's, at the node (as Box3.setFromObject).
 *
 * @param {THREE.Object3D} node a copy (createInstances)
 * @param {THREE.Box3} [target]
 */
export function boundsOf(node, target = new THREE.Box3()) {
  /** @type {THREE.Object3D} */
  const model = node.userData.model;
  model.updateWorldMatrix(true, true);
  node.updateWorldMatrix(true, false);
  const toNode = node.matrixWorld.clone().multiply(model.matrixWorld.clone().invert());
  const box = new THREE.Box3();
  target.makeEmpty();
  for (const mesh of solidMeshes(model)) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    box.copy(/** @type {THREE.Box3} */ (mesh.geometry.boundingBox));
    target.union(box.applyMatrix4(toNode.clone().multiply(mesh.matrixWorld)));
  }
  return target;
}
