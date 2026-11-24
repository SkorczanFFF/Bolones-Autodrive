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

/**
 * Glowing shards and sparks thrown off a crash: small triangles that tumble, fall and bounce on
 * the road (y = 0); the short-lived ones (sparks) fade out. One draw call, glowing (core/bloom.js).
 *
 * @param {number} gravity units/s²
 */
export function createDebris(gravity) {
  /**
   * @type {{ at: THREE.Vector3, velocity: THREE.Vector3, turn: THREE.Vector3, rate: number,
   *   corners: THREE.Vector3[], color: THREE.Color, life: number, age: number }[]}
   */
  const shards = [];
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  material.userData.glow = 1;
  const object = new THREE.Mesh(geometry, material);
  object.frustumCulled = false;
  object.layers.enable(BLOOM.layer);

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
      const alive = shards.filter((shard) => shard.age < shard.life); // the sparks gone make room
      shards.splice(0, shards.length, ...alive);
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
        });
      }
      const length = shards.length * 3 * 3;
      geometry.dispose(); // the old buffers
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(length), 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(length), 3));
    },

    /** @param {number} dt */
    update(dt) {
      const position = geometry.getAttribute("position");
      const colors = geometry.getAttribute("color");
      if (!position) return;
      shards.forEach((shard, i) => {
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
        if (!shard.velocity.lengthSq() && !shard.at.y) shard.rate = 0;
        turn.setFromAxisAngle(shard.turn, shard.rate * dt);
        const fade = THREE.MathUtils.clamp((shard.life - shard.age) / FADE, 0, 1);
        shard.corners.forEach((corner, k) => {
          corner.applyQuaternion(turn);
          end.copy(shard.at).add(corner);
          position.setXYZ(3 * i + k, end.x, end.y, end.z);
          const { r, g, b } = shard.color;
          colors.setXYZ(3 * i + k, r * fade, g * fade, b * fade);
        });
      });
      position.needsUpdate = true;
      colors.needsUpdate = true;
    },

    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
