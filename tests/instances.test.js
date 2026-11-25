import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { boundsOf, createInstances } from "../src/scene/instances.js";
import { dress } from "../src/scene/wire.js";
import { testMaterials } from "./helpers.js";

/**
 * A dressed model as the FBX ones are: its mesh moved, turned and scaled in its root; as a palm,
 * casting no shadow, taking them.
 */
function model() {
  const { solid, wire } = testMaterials();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3).toNonIndexed());
  mesh.position.set(0.5, 1, -0.2);
  mesh.rotation.set(-Math.PI / 2, 0, 0.1);
  mesh.scale.setScalar(0.6);
  const model = dress(new THREE.Group().add(mesh), solid.palm, wire.palm);
  mesh.castShadow = false;
  return model;
}

/** @param {THREE.Object3D} node @param {number} x @param {number} turn @param {number} scale */
const place = (node, x, turn, scale) => {
  node.position.set(x, 0, -20);
  node.rotation.set(0, turn, 0);
  node.scale.setScalar(scale);
  return node;
};

describe("copies of a model", () => {
  it("are drawn where their nodes are, as a clone would be, faded as set", () => {
    const parent = new THREE.Group();
    const palm = model();
    const copies = createInstances(parent, [palm]);
    const nodes = [place(copies.copy(palm), -11, 0.3, 1), place(copies.copy(palm), 11, 2, 1.5)];
    copies.set(nodes[1], 0.25);
    copies.update(nodes);

    const [solid, lines] = /** @type {THREE.InstancedMesh[]} */ (parent.children);
    expect([solid.count, lines.count]).toEqual([2, 2]);
    expect(lines.instanceMatrix).toBe(solid.instanceMatrix); // one matrix a copy
    // shadows as the model's
    expect([solid.castShadow, solid.receiveShadow, lines.receiveShadow]).toEqual([
      false,
      true,
      true,
    ]);
    expect(solid.geometry.getAttribute("instanceFade").array.slice(0, 2)).toEqual(
      new Float32Array([1, 0.25]),
    );
    nodes.forEach((node, i) => {
      const clone = place(palm.clone(), node.position.x, node.rotation.y, node.scale.x);
      clone.updateMatrixWorld(true);
      const mesh = clone.children[0];
      const drawn = new THREE.Matrix4();
      solid.getMatrixAt(i, drawn);
      drawn.elements.forEach((value, k) =>
        expect(value).toBeCloseTo(mesh.matrixWorld.elements[k], 5),
      );
      // the crash measures a rock where it is: as a clone's bounds
      const bounds = boundsOf(node);
      const expected = new THREE.Box3().setFromObject(clone);
      expect(bounds.min.distanceTo(expected.min)).toBeLessThan(1e-5);
      expect(bounds.max.distanceTo(expected.max)).toBeLessThan(1e-5);
    });
  });
});
