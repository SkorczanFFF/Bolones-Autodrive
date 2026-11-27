import * as THREE from "three";
import { BLOOM } from "../config.js";

/** Seconds a shard takes to fade out at the end of its life. */
const FADE = 0.5;

/**
 * @typedef {object} Burst
 * @property {number} count
 * @property {THREE.Vector3} velocity the shards' common velocity, units/s
 * @property {number} spread random speed on top, any way but mostly up, units/s
 * @property {THREE.Color} color
 * @property {number} size shard length, units
 * @property {number} life seconds; Infinity: stays where it lands
 */

/** Every crash's debris draws with it: its shaders, compiled once (minigame warmUp), stay. */
const material = new THREE.MeshBasicMaterial({
  vertexColors: true,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
  forceSinglePass: true, // added up, in any order: one pass (scene/lines.js LINE_PARAMETERS)
});
material.userData.glow = 1;

/**
 * Glowing shards and sparks thrown off a crash: small triangles that tumble, fall and bounce on
 * the road (y = 0); the short-lived ones (sparks) fade out. One draw call, glowing (core/bloom.js).
 * A shard lying on the road for good, or gone, is drawn as it is: only the ones still moving or
 * fading are worked out and sent to the GPU again; the buffers grow, kept from burst to burst.
 *
 * @param {number} gravity units/s²
 */
export function createDebris(gravity) {
  /**
   * @type {{ at: THREE.Vector3, velocity: THREE.Vector3, turn: THREE.Vector3, rate: number,
   *   corners: THREE.Vector3[], color: THREE.Color, life: number, age: number, done: boolean }[]}
   */
  const shards = [];
  const geometry = new THREE.BufferGeometry();
  const object = new THREE.Mesh(geometry, material);
  object.frustumCulled = false;
  object.layers.enable(BLOOM.layer);
  let room = 0; // shards the buffers hold

  const turn = new THREE.Quaternion();
  const end = new THREE.Vector3();
  const random = () => new THREE.Vector3().randomDirection();

  return {
    object,

    /**
     * @param {THREE.Vector3} at
     * @param {Burst} burst
     */
    burst(at, { count, velocity, spread, color, size, life }) {
      if (count <= 0) return; // nothing to add, nothing to redraw
      const alive = shards.filter((shard) => shard.age < shard.life); // the sparks gone make room
      shards.splice(0, shards.length, ...alive);
      for (const shard of shards) shard.done = false; // moved up: drawn where they are now
      for (let i = 0; i < count; i++) {
        const kick = random();
        kick.y = Math.abs(kick.y) + 0.3;
        const scale = size * (0.4 + Math.random());
        shards.push({
          at: at.clone(),
          velocity: velocity.clone().addScaledVector(kick, spread * Math.random()),
          turn: random(),
          rate: (Math.random() * 2 - 1) * 25, // rad/s
          corners: [random(), random(), random()].map((c) => c.multiplyScalar(scale / 2)),
          color,
          life: life * (0.6 + 0.8 * Math.random()),
          age: 0,
          done: false,
        });
      }
      if (shards.length > room) {
        room = Math.max(shards.length, 2 * room); // a pile-up bursts again and again
        const length = room * 3 * 3;
        geometry.dispose(); // the old buffers
        geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(length), 3));
        geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(length), 3));
      }
      geometry.setDrawRange(0, shards.length * 3);
    },

    /** @param {number} dt */
    update(dt) {
      const position = /** @type {THREE.BufferAttribute} */ (geometry.getAttribute("position"));
      const colors = /** @type {THREE.BufferAttribute} */ (geometry.getAttribute("color"));
      if (!position) return;
      let [first, last] = [-1, -1]; // the shards drawn afresh
      shards.forEach((shard, i) => {
        if (shard.done) return;
        shard.age += dt;
        shard.velocity.y -= gravity * dt;
        shard.at.addScaledVector(shard.velocity, dt);
        if (shard.at.y < 0) {
          // a bounce on the road, losing most of its speed, until it lies there
          shard.at.y = 0;
          shard.velocity.multiplyScalar(0.5).y *= -0.6;
          shard.rate *= 0.5;
          if (shard.velocity.lengthSq() < 1) shard.velocity.set(0, 0, 0);
        }
        const lying = !shard.velocity.lengthSq() && !shard.at.y;
        if (lying) shard.rate = 0;
        turn.setFromAxisAngle(shard.turn, shard.rate * dt);
        const fade = THREE.MathUtils.clamp((shard.life - shard.age) / FADE, 0, 1);
        const { r, g, b } = shard.color;
        shard.corners.forEach((corner, k) => {
          corner.applyQuaternion(turn);
          end.copy(shard.at).add(corner);
          position.setXYZ(3 * i + k, end.x, end.y, end.z);
          colors.setXYZ(3 * i + k, r * fade, g * fade, b * fade);
        });
        // lying there for good, or gone (drawn black now): as it is drawn now from here on
        shard.done = (lying && shard.life === Infinity) || shard.age >= shard.life;
        if (first < 0) first = i;
        last = i;
      });
      if (first < 0) return;
      for (const attribute of [position, colors]) {
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(9 * first, 9 * (last - first + 1)); // three points of three
        attribute.needsUpdate = true;
      }
    },

    dispose() {
      geometry.dispose();
    },
  };
}
