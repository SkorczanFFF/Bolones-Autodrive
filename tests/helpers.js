import * as THREE from "three";
import { CAR, LAYERS } from "../src/config.js";
import { createMaterials } from "../src/scene/materials.js";
import { mountWheel } from "../src/scene/rig.js";

/** The app's materials, with a stand-in for the road-line texture. */
export const testMaterials = () =>
  createMaterials({ [String(LAYERS.road.wireMap)]: new THREE.Texture() }, 1);

/** How high a test car's body is off the road, on its wheels. */
const CLEARANCE = 0.4;

/**
 * A test car standing on the road at (x, z), [width, height, length], driving with vz along the
 * road:
 * a box mesh to dent, raised off the road on four wheels on their rig (scene/rig.js), the front
 * ones steering, and a lamp at each end, put out where a crash crushes it.
 *
 * @param {number} x
 * @param {number} z
 * @param {number[]} size
 * @param {number} mass
 * @param {number} vz
 */
export function testCar(x, z, [width, height, length], mass, vz) {
  const body = new THREE.BoxGeometry(width, height - CLEARANCE, length, 4, 2, 8).toNonIndexed();
  body.translate(0, (height + CLEARANCE) / 2, 0);
  const object = new THREE.Group().add(new THREE.Mesh(body));
  object.position.set(x, CAR.lift, z);
  const ahead = Math.sign(vz) || 1;
  for (const [side, end] of [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ]) {
    const tyre = new THREE.CylinderGeometry(0.5, 0.5, 0.3, 12).rotateZ(Math.PI / 2);
    const at = new THREE.Vector3(
      side * (width / 2 - 0.15),
      0.5 - CAR.lift,
      end * (length / 2 - 1.1),
    );
    object.add(mountWheel(new THREE.Mesh(tyre.toNonIndexed()), at, 0.5, end === ahead));
  }
  const lamps = { front: true, rear: true };
  /** @param {(point: THREE.Vector3) => boolean} crushed */
  const onCrash = (crushed) => {
    object.updateWorldMatrix(true, false);
    for (const [end, sign] of /** @type {const} */ ([
      ["front", 1],
      ["rear", -1],
    ])) {
      const at = new THREE.Vector3(0, height / 2, (sign * ahead * length) / 2 - sign * ahead * 0.1);
      if (crushed(object.localToWorld(at))) lamps[end] = false;
    }
  };
  const box = new THREE.Box3(
    new THREE.Vector3(-width / 2, 0, -length / 2),
    new THREE.Vector3(width / 2, height, length / 2),
  );
  const velocity = new THREE.Vector3(0, 0, vz);
  return { object, box, mass, velocity, color: new THREE.Color(), lamps, onCrash, label: "car" };
}
