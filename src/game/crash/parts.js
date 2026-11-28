import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { MINIGAME } from "../../config.js";
import { wheelsOf } from "../../scene/rig.js";
import { solidMeshes } from "../../scene/wire.js";
import { OVER, boxOf, headingOf, overlap } from "./boxes.js";
import {
  ACROSS,
  GRAVITY,
  HULLS,
  ORIGIN,
  PARTS,
  POSTS,
  ROAD,
  STEP,
  UP,
  groups,
  rotation,
  translation,
  vector,
  velocityAt,
} from "./physics.js";

/** Rapier's cylinder (along y) along a wheel's axle: x, a spare wheel's z (it stands on an end). */
const AXLES = {
  wheel: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2),
  spare: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
};

/**
 * @typedef {object} Owner a car of a crash (game/crash.js), as its parts come off it
 * @property {{ object: THREE.Object3D }} car
 * @property {RAPIER.RigidBody} body
 * @property {number[]} half its box's half size (crash/boxes.js)
 * @property {THREE.Vector3} shift its box from the body's centre
 * @property {number} [roof] how much higher its box goes rolled over
 * @property {THREE.Object3D[]} mirrors
 * @property {{ lose: (mount: THREE.Object3D) => { at: THREE.Vector3, radius: number } | undefined }} vehicle
 *
 * @typedef {object} Tear a part to tear off: how far the crush pushes it and the way it went in,
 *   as the car was heading then (`heading`)
 * @property {Owner} car
 * @property {THREE.Object3D} node
 * @property {THREE.Vector3} by
 * @property {THREE.Vector3} into
 * @property {number} heading
 * @property {number} speed
 *
 * @typedef {object} Loose a part torn off: on its own, meeting every car but the one it came off
 *   till clear of it (`apart`)
 * @property {THREE.Object3D} node
 * @property {RAPIER.RigidBody} body
 * @property {RAPIER.Collider} collider
 * @property {Owner} from
 * @property {RAPIER.ImpulseJoint} [apart]
 * @property {number[]} half
 * @property {THREE.Vector3} shift
 * @property {THREE.Matrix4} offset its body's centre to its node's origin
 * @property {THREE.Vector3} size its node's scale
 */

/**
 * The parts torn off in a crash (MINIGAME.crash.parts): a wheel, a bumper, a mirror or a spare
 * wheel crushed past, a mirror too where it touches the road. Each flies on by itself, thrown along the hit
 * (and up), rolls (a wheel) to a stop, bounces off the cars, the palms and the other parts; a car
 * down a wheel sinks onto that corner's hub, dragging it.
 *
 * @param {object} crash
 * @param {RAPIER.World} crash.world
 * @param {THREE.Object3D} crash.scene where the parts go
 * @param {RAPIER.Collider} crash.road
 * @param {(() => void)[]} crash.undo what puts them back, as the crash is undone
 * @param {(point: THREE.Vector3) => THREE.Vector3} crash.onRoad a point of the scene on the road
 * @param {(desc: RAPIER.ColliderDesc) => RAPIER.ColliderDesc} crash.metal a car's sheet metal
 * @param {() => number} crash.random in [0, 1)
 */
export function createTornParts({ world, scene, road, undo, onRoad, metal, random }) {
  const { parts, dents: sheet, restitution, car: build } = MINIGAME.crash;
  /** @type {Tear[]} the parts torn off in a frame, taken off once the cars are posed */
  const tearing = [];
  /** @type {Loose[]} */
  const loose = [];

  /**
   * Takes a part torn off a car away: it flies on by itself, thrown along the hit (and up), a
   * wheel rolling on; a car down a wheel sinks onto that corner's hub, dragging it.
   *
   * @param {Tear} tear
   */
  function tearOff({ car, node, by: push, into: along, heading, speed }) {
    if (node.parent === scene) return; // torn off already (a mirror crushed as it hit the road)
    /** @type {import("../../scene/rig.js").PartName} */
    const part = node.userData.part;
    // the hit turned as far as the car has turned on the road since (a wreck spinning, its dent
    // waiting its turn: crumpling), still level
    const turned = headingOf(rotation(car.body.rotation())) - heading;
    const [by, into] = [push, along].map((v) => v.clone().applyAxisAngle(UP, turned));
    /** Its meshes' bounds in a frame of it. @param {THREE.Object3D} frame */
    const boundsIn = (frame) => {
      const toFrame = frame.matrixWorld.clone().invert();
      const bounds = new THREE.Box3();
      for (const mesh of solidMeshes(node)) {
        mesh.geometry.computeBoundingBox();
        const box = /** @type {THREE.Box3} */ (mesh.geometry.boundingBox).clone();
        bounds.union(box.applyMatrix4(toFrame.clone().multiply(mesh.matrixWorld)));
      }
      return bounds;
    };
    // its middle in its own frame; its size there too, but a wheel's in its spin's: as round and
    // as wide as it is, however far it is spun and steered
    const bounds = boundsIn(node);
    const measured = part === "wheel" ? boundsIn(wheelsOf(node)[0].spin) : bounds;
    const [at, turn, size] = [new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3()];
    node.matrixWorld.decompose(at, turn, size);
    const middle = bounds.getCenter(new THREE.Vector3());
    const centre = onRoad(middle.clone().applyMatrix4(node.matrixWorld).add(by)); // the crush's
    const [x, y, z] = measured.getSize(new THREE.Vector3()).multiply(size).toArray();
    const [width, radius] = part === "spare" ? [z, Math.max(x, y) / 2] : [x, Math.max(y, z) / 2];
    const fling = parts.fling * speed;
    const velocity = velocityAt(car.body, centre).add(
      new THREE.Vector3(into.x * fling, fling / 2, into.z * fling),
    );
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(centre.x, centre.y, centre.z)
      .setRotation(turn)
      .setLinvel(velocity.x, velocity.y, velocity.z)
      .setCcdEnabled(true); // flung fast, never through the road
    if (part === "wheel") {
      // rolling on about its axle, as fast as it goes along it
      const axle = new THREE.Vector3(1, 0, 0).applyQuaternion(turn);
      const rolling = UP.clone().cross(velocity).divideScalar(radius);
      desc.setAngvel(axle.multiplyScalar(axle.dot(rolling)));
      // buckled, leaning in its spin as far as it leant when it went (MINIGAME.crash.dents
      // camber): rolling, it wobbles
      const [{ spin }] = wheelsOf(node);
      const leant = spin.rotation.y;
      spin.rotation.y = (random() < 0.5 ? -1 : 1) * sheet.camber * parts.wheel.tear;
      undo.push(() => (spin.rotation.y = leant));
    }
    const body = world.createRigidBody(desc);
    const shape =
      part === "wheel" || part === "spare"
        ? RAPIER.ColliderDesc.cylinder(width / 2, radius).setRotation(AXLES[part])
        : RAPIER.ColliderDesc.cuboid(x / 2, y / 2, z / 2);
    const collider = world.createCollider(
      shape
        .setMass(parts[part].mass)
        .setFriction(parts.friction)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max)
        .setRestitution(restitution.contact)
        .setCollisionGroups(groups(PARTS, ROAD | POSTS | PARTS | HULLS)),
      body,
    );
    // it meets every car at once (not to fly through the other one in the crash) but the one it
    // came off, till clear of it (loosen): a joint holding nothing, only keeping their contacts off
    const none = /** @type {RAPIER.JointAxesMask} */ (0);
    const apart = world.createImpulseJoint(
      RAPIER.JointData.generic(ORIGIN, ORIGIN, ACROSS, none),
      body,
      car.body,
      true,
    );
    apart.setContactsEnabled(false);

    const { parent } = node;
    const [from, facing, scaled] = [
      node.position.clone(),
      node.quaternion.clone(),
      node.scale.clone(),
    ];
    undo.push(() => {
      parent?.add(node);
      node.position.copy(from);
      node.quaternion.copy(facing);
      node.scale.copy(scaled);
    });
    // where its hub is, in the body's frame: read before it leaves the car for the scene
    const hub = car.vehicle.lose(node);
    scene.attach(node);
    const half = [x / 2, y / 2, z / 2];
    const offset = translation(middle.negate());
    loose.push({
      node,
      body,
      collider,
      from: car,
      apart,
      half,
      shift: new THREE.Vector3(),
      offset,
      size,
    });

    if (hub) {
      const ball = RAPIER.ColliderDesc.ball(build.hub * hub.radius);
      world.createCollider(metal(ball).setTranslation(hub.at.x, hub.at.y, hub.at.z), car.body);
    }
  }

  return {
    /** The parts torn off so far. */
    loose,

    /**
     * A part to tear off once the cars are posed (takeOff).
     *
     * @param {Tear} tear
     */
    tear(tear) {
      tearing.push(tear);
    },

    /**
     * Tears a car's mirrors off where they touch the road (it went over onto its side): they
     * break off, they do not hold it up.
     *
     * @param {Owner} entry
     */
    snap(entry) {
      const { car, body, mirrors } = entry;
      const turn = rotation(body.rotation());
      if (UP.clone().applyQuaternion(turn).y > OVER[0]) return; // on its wheels, its roof up
      car.object.updateWorldMatrix(true, true);
      for (const node of mirrors) {
        if (node.parent === scene || new THREE.Box3().setFromObject(node).min.y >= 0) continue;
        const by = new THREE.Vector3();
        tearing.push({
          node,
          by,
          into: UP.clone(),
          heading: headingOf(turn),
          car: entry,
          speed: 0,
        });
      }
    },

    /** Takes off the parts torn in the frame, in the order they tore. */
    takeOff() {
      for (const tear of tearing.splice(0)) tearOff(tear);
    },

    /**
     * The parts torn off, after a step: rolling on the road they slow down (MINIGAME.crash.parts
     * roll); clear of the car they came off, they hit it too.
     */
    loosen() {
      for (const piece of loose) {
        const { body, collider } = piece;
        if (piece.apart && !overlap(boxOf(piece), boxOf(piece.from))) {
          world.removeImpulseJoint(piece.apart, true);
          delete piece.apart;
        }
        let rolling = false;
        world.contactPair(collider, road, (manifold) => {
          rolling ||= manifold.numContacts() > 0;
        });
        if (!rolling) continue;
        const v = vector(body.linvel());
        const along = Math.hypot(v.x, v.z);
        if (!along) continue;
        const slower = Math.max(0, along - parts.roll * GRAVITY * STEP) / along;
        body.setLinvel({ x: v.x * slower, y: v.y, z: v.z * slower }, false);
      }
    },
  };
}
