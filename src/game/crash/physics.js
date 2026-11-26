import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { TRAFFIC } from "../../config.js";

/** Rapier, ready (its WebAssembly loaded) once this resolves: before the first crash. */
export const ready = RAPIER.init();

/** The crash's physics step and units, shared by its parts. */
export const STEP = 1 / 240; // seconds
export const METRE = TRAFFIC.scale; // units per metre
export const GRAVITY = 9.82 * METRE; // units/s²

/** Directions in a body's frame (a car's length is its z): copy them before moving one. */
export const UP = new THREE.Vector3(0, 1, 0);
export const AHEAD = new THREE.Vector3(0, 0, 1);
export const ACROSS = new THREE.Vector3(1, 0, 0);
export const ORIGIN = { x: 0, y: 0, z: 0 };
export const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Who collides with whom in Rapier: the road holds up the cars' bodies and the parts torn off;
 * the parts hit the cars (each as one hull round its body: HULLS), the palms and each other. Cars
 * meet cars and palms through their crush (crash/crush.js), not Rapier's contacts.
 */
export const [ROAD, CARS, PARTS, POSTS, HULLS] = [1, 2, 4, 8, 16];

/**
 * Rapier interaction groups: what a collider is, what it meets.
 *
 * @param {number} member
 * @param {number} meets
 */
export const groups = (member, meets) => (member << 16) | meets;

/** A Rapier vector as three.js'. @param {{ x: number, y: number, z: number }} v */
export const vector = ({ x, y, z }) => new THREE.Vector3(x, y, z);

/** A Rapier rotation as three.js'. @param {{ x: number, y: number, z: number, w: number }} q */
export const rotation = ({ x, y, z, w }) => new THREE.Quaternion(x, y, z, w);

/**
 * @param {RAPIER.RigidBody} body
 * @param {THREE.Vector3} point world space
 */
export const velocityAt = (body, point) =>
  vector(body.angvel())
    .cross(new THREE.Vector3().subVectors(point, vector(body.translation())))
    .add(vector(body.linvel()));

/**
 * How easily a body gives at a point along a unit normal: its inverse mass there, turning
 * included.
 *
 * @param {RAPIER.RigidBody} body
 * @param {THREE.Vector3} point
 * @param {THREE.Vector3} normal
 */
export function giving(body, point, normal) {
  const { x, y, z } = new THREE.Vector3()
    .subVectors(point, vector(body.translation()))
    .cross(normal);
  const { m11, m12, m13, m22, m23, m33 } = body.effectiveWorldInvInertia();
  const turning =
    x * (m11 * x + m12 * y + m13 * z) +
    y * (m12 * x + m22 * y + m23 * z) +
    z * (m13 * x + m23 * y + m33 * z);
  return body.invMass() + turning;
}
