import * as THREE from "three";

/**
 * A vehicle's rig, the same for every car (scene/car.js, scene/traffic.js): each wheel hangs on a
 * mount (`userData.part` "wheel", `userData.radius`, `userData.steers` for the front ones, at the
 * middle of the wheel, its axle along x), which a crash moves whole or tears off; in it a steer
 * node turns about y, in that a spin node rolls about x. Bumpers, mirrors and a spare wheel are
 * nodes of their own (`userData.part` "bumper", "mirror", "spare"), each headlamp a mesh named
 * "lamp". The rig lives in the scene graph and its userData, so clones keep it.
 *
 * @typedef {{ mount: THREE.Object3D, steer: THREE.Object3D, spin: THREE.Object3D, radius: number }} Wheel
 * @typedef {"wheel" | "bumper" | "mirror" | "spare"} PartName
 */

/**
 * A wheel on its rig.
 *
 * @param {THREE.Object3D} wheel its meshes, round the middle of the wheel, the axle along x
 * @param {THREE.Vector3} at the middle of the wheel, in the car
 * @param {number} radius
 * @param {boolean} steers whether it is a front one
 */
export function mountWheel(wheel, at, radius, steers) {
  const spin = new THREE.Group().add(wheel);
  const steer = new THREE.Group().add(spin);
  const mount = new THREE.Group().add(steer);
  mount.position.copy(at);
  Object.assign(mount.userData, { part: "wheel", radius, steers });
  return mount;
}

/**
 * The wheel, bumper, mirror or spare wheel a node is part of (the node with `userData.part` above it, under
 * the car's root), or null: the body.
 *
 * @param {THREE.Object3D} node
 * @param {THREE.Object3D} root
 * @returns {THREE.Object3D | null}
 */
export function partOf(node, root) {
  for (let up = node.parent; up && up !== root; up = up.parent) {
    if (up.userData.part) return up;
  }
  return null;
}

/**
 * A car's wheels on their rigs.
 *
 * @param {THREE.Object3D} car
 * @returns {Wheel[]}
 */
export function wheelsOf(car) {
  /** @type {Wheel[]} */
  const wheels = [];
  car.traverse((mount) => {
    if (mount.userData.part !== "wheel") return;
    const steer = mount.children[0];
    wheels.push({ mount, steer, spin: steer.children[0], radius: mount.userData.radius });
  });
  return wheels;
}
