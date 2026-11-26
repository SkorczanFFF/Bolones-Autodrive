import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { ConvexHull } from "three/addons/math/ConvexHull.js";
import { MINIGAME, MOUNTAINS, PALETTE, SPEED } from "../config.js";
import { settle } from "../core/tween.js";
import { crumple, reaches } from "../scene/crumple.js";
import { createDebris } from "../scene/debris.js";
import { partOf, wheelsOf } from "../scene/rig.js";
import { solidMeshes } from "../scene/wire.js";
import { OVER, boxOf, endOn, overlap } from "./crash/boxes.js";
import { createCrushes, reachOf } from "./crash/crush.js";
import { createDriver, hardest, lookAhead, stopping } from "./crash/drivers.js";
import {
  ACROSS,
  AHEAD,
  CARS,
  GRAVITY,
  IDENTITY,
  METRE,
  ORIGIN,
  PARTS,
  POSTS,
  ROAD,
  STEP,
  UP,
  giving,
  groups,
  rotation,
  vector,
  velocityAt,
} from "./crash/physics.js";
import { createPosts } from "./crash/posts.js";
import { createVehicle } from "./crash/vehicle.js";

export { ready } from "./crash/physics.js";

const LANDINGS = 3; // a car's roof crushes coming down on the road this often at most
const LANDED = 0.3; // seconds after one before it does again (it comes down once, not each step)
const TOUCH = 0.02 * METRE; // units above the road a roof's corner comes down on it from
/**
 * Units along the road the ground goes either way: further than a crash goes (its cars stop within
 * some 1500), no further: Rapier's contacts with a box are only as exact as the box is small, and
 * one far longer takes a car lying on the road for 20 cm in it, throwing it up.
 */
const FAR = 2000;

/**
 * @typedef {object} Car a car in a crash, on its rig (scene/rig.js)
 * @property {THREE.Object3D} object posed by the crash; upright on the road when it starts
 * @property {THREE.Box3} box the car in the object's frame
 * @property {number} mass kg
 * @property {THREE.Vector3} velocity over the road, units/s
 * @property {THREE.Color} color its lines: the colour of its shards
 * @property {(crushed: (point: THREE.Vector3) => boolean) => void} [onCrash] told what each crash
 *   crushed (world space): its lamps there go out, it is drawn whole
 * @property {string} label what it is called, for the one in view
 * @property {import("./crash/drivers.js").Driving} [driving] how its driver reacts and brakes, if
 *   not as MINIGAME.crash
 *
 * @typedef {import("./crash/posts.js").Post} Post
 * @typedef {import("../scene/crumple.js").Hit} Hit
 * @typedef {import("../scene/crumple.js").Dent} Dent
 *
 * @typedef {import("./crash/crush.js").Solid & {
 *   color?: THREE.Color,
 *   struck: (hit: Hit, speed: number, time: number) => Dent | undefined,
 * }} Party a car or a palm in a crash: what it does to it (the hit on the road)
 */

const SPARKS = new THREE.Color(PALETTE.headlight);
/** Rapier's cylinder (along y) lying along x, as a wheel's axle. */
const LYING = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);

/**
 * A crash (MINIGAME.crash) on Rapier, with the laws of car crashes on top:
 * - each car is a box over its lower part with the centre of mass low (MINIGAME.crash.car), on
 *   its wheels (crash/vehicle.js): springs, tyres gripping the road; its driver brakes or swerves
 *   once they react (crash/drivers.js); its body scrapes the road where it comes down on it;
 * - cars meet through their crumple zones (crash/crush.js), the palms and the rocks are posts
 *   that do not give (crash/posts.js), every one by the road;
 * - every crash dents both cars (scene/crumple.js), puts their lamps out, breaks a wheel of a car
 *   hit on its side, pushes wheels askew and sheds shards and sparks (scene/debris.js) by the
 *   energy it took up; a palm hit leans and sways; a car rolled over coming down on its roof
 *   crushes it where it lands, and lies on it crushed;
 * - a wheel or a bumper crushed past (MINIGAME.crash.parts) is torn off: it flies on by itself,
 *   rolls (a wheel) to a stop, bounces off the cars, the palms and the other parts; a car down a
 *   wheel sinks onto that corner's hub, dragging it.
 *
 * The camera rides along the road with the car in view (the Bolones first), at its speed forward
 * with a lag: the road scrolls past (the scene rides along). update() returns that speed.
 *
 * @param {THREE.Object3D} scene where the debris goes
 * @param {Car[]} cars the Bolones and the car it hit first (they crashed), then the other traffic
 * @param {() => Post[]} [posts] by the road now (more come up as the camera goes on)
 * @param {() => number} [random] what the drivers do, in [0, 1)
 */
export function createCrash(scene, cars, posts = () => [], random = Math.random) {
  const {
    stiffness,
    cameraLag,
    debris: spray,
    car: build,
    dents: sheet,
    parts,
    scrape,
    restitution,
    nudge,
  } = MINIGAME.crash;
  const world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
  world.timestep = STEP;
  world.lengthUnit = METRE;
  /**
   * The ground as a box (not a half-space: Rapier's lets a hull through, a roof, faces of more
   * than four corners), its top or its side at a point, longer than any crash goes.
   *
   * @param {number} x half its width
   * @param {number} y half its height
   * @param {{ x: number, y: number, z: number }} middle
   */
  const ground = (x, y, middle) =>
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(x, y, FAR)
        .setTranslation(middle.x, middle.y, middle.z)
        .setFriction(0)
        .setRestitution(restitution.contact)
        .setCollisionGroups(groups(ROAD, CARS | PARTS)),
    );
  // the tyres grip by themselves (crash/vehicle.js): the road itself is smooth, the metal on it not
  const { start } = MOUNTAINS;
  const road = ground(2 * start, start, { x: 0, y: -start, z: 0 });
  // the side hills stop what slides off the road: walls the hills rise behind
  for (const side of [-1, 1]) ground(start, 2 * start, { x: side * 2 * start, y: start, z: 0 });
  /**
   * A car's sheet metal (its body, its hubs): it scrapes the road.
   *
   * @param {RAPIER.ColliderDesc} desc
   */
  const metal = (desc) =>
    desc
      .setDensity(0)
      .setFriction(scrape)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max)
      .setRestitution(restitution.contact)
      .setCollisionGroups(groups(CARS, ROAD | PARTS));
  /**
   * A car's roof, as the road and the parts meet it, on its body.
   *
   * @param {Hull} hull in the body's frame
   * @param {RAPIER.RigidBody} body
   */
  const roofCollider = ({ corners, faces }, body) => {
    const points = new Float32Array(corners.flatMap(({ x, y, z }) => [x, y, z]));
    const desc = RAPIER.ColliderDesc.convexMesh(points, new Uint32Array(faces));
    return world.createCollider(metal(/** @type {RAPIER.ColliderDesc} */ (desc)), body);
  };

  const debris = createDebris(GRAVITY);
  scene.add(debris.object);
  /** @type {(() => void)[]} */
  const undo = [];
  /** @type {{ set: (progress: number) => void, progress: number, shown: number }[]} */
  const dents = [];
  let time = 0; // game seconds since the crash
  let lag = 0; // game seconds not stepped yet
  let travel = 0; // how far the camera went forward since the crash: the scene rides along
  /**
   * A point of the road (the physics, the debris) in the scene, which rides along with the
   * camera.
   *
   * @param {{ x: number, y: number, z: number }} point
   */
  const inScene = ({ x, y, z }, target = new THREE.Vector3()) => target.set(x, y, z + travel);
  /** A point of the scene on the road. @param {{ x: number, y: number, z: number }} point */
  const onRoad = ({ x, y, z }) => new THREE.Vector3(x, y, z - travel);

  const pose = new THREE.Matrix4();
  /**
   * A car comes into the crash, on its wheels, its driver reacting from now on.
   *
   * @param {Car} car upright on the road, in the scene
   * @param {boolean} swerves whether its driver may swerve (not the Bolones')
   * @param {boolean} [joined] it came along after the crash began
   */
  function board(car, swerves, joined = false) {
    const { object, box, mass, velocity } = car;
    const { com } = build;
    object.updateWorldMatrix(true, true);
    const size = box.getSize(new THREE.Vector3());
    const floor = -object.matrixWorld.elements[13]; // the road, in the object's frame
    const height = box.max.y - floor;
    const centre = box.getCenter(new THREE.Vector3()).setY(floor + com * height); // of mass
    const half = new THREE.Vector3(size.x / 2, (build.box / 2) * height, size.z / 2);
    const shift = new THREE.Vector3(0, (build.box / 2 - com) * height, 0); // box from centre
    const [at, turn] = [new THREE.Vector3(), new THREE.Quaternion()];
    pose.copy(object.matrixWorld).multiply(translation(centre));
    pose.decompose(at, turn, new THREE.Vector3());
    at.z -= travel; // on the road, which the scene has ridden along since the crash began
    const { x, y, z } = half;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(at.x, at.y, at.z)
        .setRotation(turn)
        .setLinvel(velocity.x, velocity.y, velocity.z)
        // a box's, round the centre of mass
        .setAdditionalMassProperties(
          mass,
          ORIGIN,
          {
            x: (mass * (y * y + z * z)) / 3,
            y: (mass * (x * x + z * z)) / 3,
            z: (mass * (x * x + y * y)) / 3,
          },
          IDENTITY,
        ),
    );
    const rig = wheelsOf(object);
    // on its wheels its body comes down on the road only when the springs give: from its underside
    const bottom = rig.length ? underside(object) - centre.y : shift.y - y;
    const top = shift.y + y;
    const shape = RAPIER.ColliderDesc.cuboid(x, (top - bottom) / 2, z);
    world.createCollider(metal(shape).setTranslation(0, (top + bottom) / 2, 0), body);
    // rolled over it lands on the rest of it, its roof: for the road and the parts only, crushed
    // where it lands (`land`); its corners in the body's frame
    const above = roofOf(object, centre.y + top);
    const shell = { ...above, corners: above.corners.map((corner) => corner.clone().sub(centre)) };
    const cabin = shell.faces.length ? roofCollider(shell, body) : undefined;
    body.recomputeMassPropertiesFromColliders(); // so the crush and the springs weigh it at once
    const vehicle = createVehicle(world, body, rig, centre, groups(CARS, ROAD));
    const offset = translation(centre.clone().negate());
    const entry = {
      car,
      body,
      half: [x, y, z],
      shift,
      roof: (1 - build.box) * height,
      faces: facesOf(object, floor),
      cabin,
      shell,
      landings: 0,
      landed: -Infinity,
      offset,
      vehicle,
      stiffness: stiffness * mass,
      driver: createDriver(vehicle, swerves, random, joined ? time : undefined, car.driving),
      color: car.color,
      /**
       * Crumples the car where it was hit, in a frame of its own (crumpling): a crash dents two
       * cars at once, a pile-up more, and each takes a while. Till then, it shows how far its
       * crush has gone in as soon as it is there.
       *
       * @param {Hit} hit on the road
       * @param {number} speed
       * @returns {Dent}
       */
      struck(hit, speed) {
        const [at, turn] = [vector(body.translation()), rotation(body.rotation())]; // as they met
        /** The hit in the scene, which rides along with the camera. */
        const met = () => ({ ...hit, point: inScene(hit.point) });
        put(car.object, offset, at, turn);
        car.onCrash?.(reaches(met())); // its lamps go out at once, before the dent moves them
        /** @type {ReturnType<typeof crumple> | undefined} */
        let dent;
        let progress = 0;
        crumpling.push({
          going: () => progress < 1,
          crumple() {
            put(car.object, offset, at, turn);
            dent = crumple(car.object, met());
            dent.set(progress);
            for (const { node, position, quaternion } of dent.moved) {
              vehicle.skew(node, position, quaternion);
            }
            const heading = headingOf(turn); // as it was hit: it may have turned since
            for (const { node, by } of dent.torn) {
              tearing.push({ node, by, into: hit.into, heading, car: entry, speed });
            }
          },
        });
        return {
          set(value) {
            progress = value;
            dent?.set(value);
          },
          undo: () => dent?.undo(),
        };
      },
    };
    return entry;
  }
  const bodies = cars.map((car, i) => board(car, i > 0));
  /** @typedef {(typeof bodies)[number]} Body */
  /**
   * Parts torn off in a frame's physics steps, taken away after them: how far the crush pushes
   * each and the way it went in, as the car was heading then (`heading`).
   *
   * @type {{ car: Body, node: THREE.Object3D, by: THREE.Vector3, into: THREE.Vector3, heading: number, speed: number }[]}
   */
  const tearing = [];
  /**
   * The cars hit, to crumple: one a frame (struck), the first whose crush is still going in (its
   * dent grows with it: late, it would come in all at once), else the first. A dent all the way in
   * at once (where the cars slide on, a roof) looks the same whenever it comes.
   *
   * @type {{ going: () => boolean, crumple: () => void }[]}
   */
  const crumpling = [];
  /**
   * The parts torn off: on their own, meeting every car but the one they came off till clear of it
   * (`apart`).
   *
   * @type {{ node: THREE.Object3D, body: RAPIER.RigidBody, collider: RAPIER.Collider, from: Body, apart?: RAPIER.ImpulseJoint, half: number[], shift: THREE.Vector3, offset: THREE.Matrix4, size: THREE.Vector3 }[]}
   */
  const loose = [];
  /** @type {Body[]} the cars that crashed or touched, in the order they did: the Bolones first */
  const wrecks = bodies.slice(0, 2);
  const crashed = new Set(wrecks); // of them, the ones that really crashed
  /** @type {Map<RAPIER.RigidBody, { at: THREE.Vector3, turn: THREE.Quaternion }>} */
  const before = new Map(); // where the bodies shown were a step ago

  const stands = createPosts(world, posts, onRoad);
  /** @type {Party[]} the cars, then the palms and rocks there are now */
  let solids = bodies;
  /** @type {THREE.Vector3[]} where the palms and rocks there are now stand */
  let postsAt = [];
  /** @type {import("./crash/drivers.js").Looking[]} the cars as the drivers saw them last */
  let looking = [];
  /** @type {[number, number][]} the pairs of solids that may meet in this frame's steps (nearby) */
  let near = [];
  let absorbed = 0; // J the crumple zones took up
  /** @type {Set<Party>} the palms and rocks hit */
  const struck = new Set();

  /**
   * Puts an object where its body is, in the scene.
   *
   * @param {THREE.Object3D} object
   * @param {THREE.Matrix4} offset the body's centre to the object's origin
   * @param {THREE.Vector3} at
   * @param {THREE.Quaternion} turn
   * @param {THREE.Vector3} [size] its scale
   */
  function put(object, offset, at, turn, size = new THREE.Vector3(1, 1, 1)) {
    place(object, pose.compose(inScene(at), turn, size).multiply(offset));
    object.updateWorldMatrix(true, true);
  }

  /**
   * Where a body is before a step, for posed(): written into the same vectors every step (Rapier
   * fills what it is given, makes new ones otherwise).
   *
   * @param {RAPIER.RigidBody} body
   */
  function remember(body) {
    let was = before.get(body);
    if (!was) before.set(body, (was = { at: new THREE.Vector3(), turn: new THREE.Quaternion() }));
    body.translation(was.at);
    body.rotation(was.turn);
  }

  /**
   * Where a body is shown: between where it was a step ago and is now, as far as the time not
   * stepped yet goes (steps do not come every frame in slow motion).
   *
   * @param {RAPIER.RigidBody} body
   * @returns {[THREE.Vector3, THREE.Quaternion]}
   */
  function posed(body) {
    const [at, turn] = [vector(body.translation()), rotation(body.rotation())];
    const was = before.get(body);
    if (!was) return [at, turn];
    const t = lag / STEP;
    return [new THREE.Vector3().lerpVectors(was.at, at, t), was.turn.clone().slerp(turn, t)];
  }

  /**
   * Takes a part torn off a car away: it flies on by itself, thrown along the hit (and up), a
   * wheel rolling on; a car down a wheel sinks onto that corner's hub, dragging it.
   *
   * @param {(typeof tearing)[number]} tear
   */
  function tearOff({ car, node, by: push, into: along, heading, speed }) {
    /** @type {"wheel" | "bumper"} */
    const part = node.userData.part;
    // the hit turned as far as the car has turned on the road since (a wreck spinning, its dent
    // waiting its turn: crumpling), still level
    const turned = headingOf(rotation(car.body.rotation())) - heading;
    const [by, into] = [push, along].map((v) => v.clone().applyAxisAngle(UP, turned));
    // its middle and its size, in its own frame
    const toNode = node.matrixWorld.clone().invert();
    const bounds = new THREE.Box3();
    for (const mesh of solidMeshes(node)) {
      mesh.geometry.computeBoundingBox();
      const box = /** @type {THREE.Box3} */ (mesh.geometry.boundingBox).clone();
      bounds.union(box.applyMatrix4(toNode.clone().multiply(mesh.matrixWorld)));
    }
    const [at, turn, size] = [new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3()];
    node.matrixWorld.decompose(at, turn, size);
    const middle = bounds.getCenter(new THREE.Vector3());
    const centre = onRoad(middle.clone().applyMatrix4(node.matrixWorld).add(by)); // the crush's
    const [x, y, z] = bounds.getSize(new THREE.Vector3()).multiply(size).toArray();
    const radius = Math.max(y, z) / 2;
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
      part === "wheel"
        ? RAPIER.ColliderDesc.cylinder(x / 2, radius).setRotation(LYING)
        : RAPIER.ColliderDesc.cuboid(x / 2, y / 2, z / 2);
    const collider = world.createCollider(
      shape
        .setMass(parts[part].mass)
        .setFriction(parts.friction)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max)
        .setRestitution(restitution.contact)
        .setCollisionGroups(groups(PARTS, ROAD | POSTS | PARTS | CARS)),
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

    const hub = car.vehicle.lose(node);
    if (hub) {
      const ball = RAPIER.ColliderDesc.ball(build.hub * hub.radius);
      world.createCollider(metal(ball).setTranslation(hub.at.x, hub.at.y, hub.at.z), car.body);
    }
  }

  /**
   * A car rolled over coming down on its roof (or its side) faster than a nudge, before a step:
   * the roof crushes where it lands, as a front does on a wall (MINIGAME.crash.stiffness), as
   * deep as the speed it comes down at there takes. It comes down on an edge first: that crushes,
   * the rest less or not at all, so not flat. Then the car lies on it crushed: the roof's corners
   * are cut off where the crush ends.
   *
   * @param {Body} entry
   */
  function land(entry) {
    const { body, cabin } = entry;
    const { corners } = entry.shell;
    if (!cabin || entry.landings >= LANDINGS || time < entry.landed + LANDED) return;
    const turn = rotation(body.rotation());
    if (UP.clone().applyQuaternion(turn).y > OVER[0]) return; // on its wheels, its roof up
    const at = vector(body.translation());
    const [{ y: sinking }, { x: pitch, z: roll }] = [body.linvel(), body.angvel()];
    let fall = nudge * METRE;
    let point;
    const p = new THREE.Vector3();
    for (const corner of corners) {
      p.copy(corner).applyQuaternion(turn).add(at);
      // how fast the corner comes down: the body's speed and its turn there (velocityAt's y)
      const down = -(sinking + roll * (p.x - at.x) - pitch * (p.z - at.z));
      if (down > fall && p.y < down * STEP + TOUCH) [fall, point] = [down, p.clone()]; // this step
    }
    if (!point) return;
    entry.landings++;
    entry.landed = time;
    const deep = fall * Math.sqrt(1 / giving(body, point, UP) / entry.stiffness);
    // the road is under all of it: how deep alone says what crushes
    const dent = entry.struck(
      { point, into: UP.clone(), plane: deep, reach: Infinity, tall: Infinity },
      fall,
    );
    undo.push(dent.undo);
    dents.push({ set: dent.set, progress: 1, shown: 0 });
    // the corners beyond where the crush ends cut off there (its plane: up, in the body's frame)
    const back = turn.invert();
    const up = UP.clone().applyQuaternion(back);
    const plane = point.clone().sub(at).applyQuaternion(back).dot(up) + deep;
    const over = corners.map((corner) => corner.dot(up) - plane); // < 0: crushed
    const left = corners.filter((_, i) => over[i] >= 0);
    corners.forEach((corner, i) => {
      if (over[i] >= 0) return;
      corners.forEach((other, j) => {
        if (over[j] > 0) left.push(corner.clone().lerp(other, over[i] / (over[i] - over[j])));
      });
    });
    const shell = hullOf(left);
    if (!shell.faces.length) return;
    world.removeCollider(cabin, false);
    entry.cabin = roofCollider(shell, body);
    entry.shell = shell;
  }

  /**
   * The parts torn off, after a step: rolling on the road they slow down (MINIGAME.crash.parts
   * roll); clear of the car they came off, they hit it too.
   */
  function loosen() {
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
  }

  /** @type {ReturnType<typeof createCrushes<Party>>} */
  const crushes = createCrushes(world, (a, b, crash) => {
    const met = bodies.filter((body) => body === a || body === b);
    for (const body of met) if (!wrecks.includes(body)) wrecks.push(body);
    if (!crash) return undefined;
    for (const body of met) crashed.add(body);
    absorbed += crash.energy;
    for (const solid of [a, b]) if (!met.some((body) => body === solid)) struck.add(solid);
    for (const body of met) {
      if (endOn(body.body, crash.normal)) continue;
      // hit on its side: where from, in its own frame
      const facing = rotation(body.body.rotation()).invert();
      const towards = crash.normal.clone().multiplyScalar(body === a ? 1 : -1);
      body.driver.breakWheel(towards.applyQuaternion(facing).setY(0).normalize());
    }
    /** @type {typeof dents} */
    const crushed = [];
    for (const [i, solid] of [a, b].entries()) {
      const hit = crash.hits[i];
      const dent = solid.struck(hit, crash.speed, time);
      if (!dent) continue;
      undo.push(dent.undo);
      crushed.push({ set: dent.set, progress: 0, shown: 0 });
    }
    dents.push(...crushed);

    const { at, speed, energy } = crash;
    const count = Math.round((spray.count * energy) / 1e4);
    const { shard, spark } = spray;
    for (const { color, body } of [a, b]) {
      if (!color) continue; // a rock does not break
      const velocity = vector(body.linvel());
      const spread = shard.spread * speed;
      debris.burst(at, { count, velocity, spread, size: shard.size, life: Infinity, color });
    }
    const [still, spread] = [new THREE.Vector3(), spark.spread * speed];
    const { size, life } = spark;
    debris.burst(at, { count, velocity: still, spread, size, life, color: SPARKS });
    return (progress) => {
      for (const dent of crushed) dent.progress = progress;
    };
  });

  /**
   * The pairs of solids (a car, then a car or a post) that may come within reach of each other in
   * a frame's steps, from where they are as it starts: as if both went towards each other twice as
   * fast as the fastest car (a crash throws none faster), a unit to spare. Most pairs are far
   * apart, and the palms and rocks by the road are many: the steps measure only these.
   *
   * @param {number} span game seconds the frame's steps take
   */
  function nearby(span) {
    const fastest = Math.max(0, ...looking.map(({ velocity }) => velocity.length()));
    const slack = 4 * fastest * span + 1;
    const at = (/** @type {number} */ i) =>
      i < bodies.length ? looking[i].at : postsAt[i - bodies.length];
    /** @type {[number, number][]} */
    const pairs = [];
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < solids.length; j++) if (within(at, i, j, slack)) pairs.push([i, j]);
    }
    return pairs;
  }

  /**
   * Whether two solids are within reach of each other where `at` says they are, `slack` to spare.
   *
   * @param {(i: number) => THREE.Vector3} at
   * @param {number} i
   * @param {number} j
   * @param {number} [slack]
   */
  function within(at, i, j, slack = 0) {
    const reach = reachOf(solids[i]) + reachOf(solids[j]) + slack;
    return at(i).distanceToSquared(at(j)) <= reach ** 2;
  }

  /**
   * One physics step: the drivers and the wheels, the crush pushing the cars through it (forces,
   * as gravity does: kicks at its start would lift a car standing on its springs), then the parts
   * torn off and the snags.
   */
  function step() {
    for (const { body } of bodies) remember(body);
    for (const { body } of loose) remember(body);
    for (const { body, driver, vehicle } of bodies) {
      body.resetForces(false);
      body.resetTorques(false);
      driver.drive(time);
      vehicle.update();
    }
    for (const entry of bodies) land(entry);
    // where each is (just remembered): of the pairs that may meet this frame, most are still too
    // far apart to touch, not worth their boxes, nor are two at rest
    const at = (/** @type {number} */ i) =>
      i < bodies.length
        ? /** @type {{ at: THREE.Vector3 }} */ (before.get(bodies[i].body)).at
        : postsAt[i - bodies.length];
    const still = (/** @type {number} */ i) => i >= bodies.length || bodies[i].body.isSleeping();
    for (const [i, j] of near) {
      if ((still(i) && still(j)) || !within(at, i, j)) continue;
      crushes.collide(solids[i], solids[j], time);
    }
    world.step();
    time += STEP;
    loosen();
    crushes.release(time);
  }

  const [first, second] = cars;
  let camera = -first.velocity.z; // speed along the road, forward

  return {
    /** How hard the first crash was: 1 at SPEED.traffic (the speed multiplier 1). */
    impact: first.velocity.distanceTo(second.velocity) / SPEED.traffic,

    /**
     * @param {number} dt seconds of game time
     * @param {number} [which] the car in view, by the order they crashed (0: the Bolones)
     * @returns {number} the camera's speed forward along the road, units/s
     */
    update(dt, which = 0) {
      const standing = stands.sync();
      solids = [...bodies, ...standing];
      postsAt = standing.map(({ body }) => vector(body.translation()));
      // what each driver sees ahead, once a frame
      looking = bodies.map(({ body, half }) => ({
        at: vector(body.translation()),
        velocity: vector(body.linvel()),
        half,
      }));
      bodies.forEach(({ driver }, i) => driver.see(lookAhead(looking[i], looking)));
      lag = Math.min(lag + dt, 30 * STEP); // further behind, the rest is dropped
      near = nearby(Math.floor(lag / STEP) * STEP);
      for (; lag >= STEP; lag -= STEP) step();
      // how far each dent has gone, then one of them crumpled (its crush going in first)
      for (const dent of dents) {
        if (dent.progress !== dent.shown) dent.set((dent.shown = dent.progress));
      }
      const next = Math.max(
        0,
        crumpling.findIndex(({ going }) => going()),
      );
      crumpling.splice(next, 1)[0]?.crumple();
      camera += (-wrecks[which].body.linvel().z - camera) * settle(cameraLag, dt);
      travel += Math.max(0, camera) * dt;

      for (const { car, offset, body, vehicle } of bodies) {
        put(car.object, offset, ...posed(body));
        vehicle.show();
      }
      for (const tear of tearing.splice(0)) tearOff(tear);
      for (const { node, body, offset, size } of loose) put(node, offset, ...posed(body), size);
      stands.sway(time);
      debris.update(dt);
      inScene({ x: 0, y: 0, z: 0 }, debris.object.position);
      return Math.max(0, camera);
    },

    /**
     * A car of the traffic that comes along after the crash began: into it, its driver reacting
     * from now on.
     *
     * @param {Car} car upright on the road, in the scene
     */
    join(car) {
      bodies.push(board(car, true, true));
    },

    /**
     * Whether a car coming along there could stop for the cars ahead in its way, braking hard at
     * most: else the road is jammed up to there. One who will not see them in time (driving.seen)
     * only comes along clear of them, the gap drivers keep (MINIGAME.crash.drivers).
     *
     * @param {Car} car upright on the road, in the scene
     */
    room(car) {
      const size = car.box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      const coming = {
        at: onRoad(car.object.position),
        velocity: car.velocity,
        half: size.toArray(),
      };
      const seen = lookAhead(coming, looking);
      if (car.driving?.seen) return !seen || seen.gap > MINIGAME.crash.drivers.gap * METRE;
      const hard = hardest(car.driving);
      return stopping(seen, hard) <= hard;
    },

    /** How much power the Bolones' engine has left in the player's hands (0 to 1, stalling). */
    get engine() {
      return bodies[0].driver.engine(time);
    },

    /**
     * The Bolones in the player's hands (crash mode, MINIGAME.crash.player): from now on its
     * driver steers and drives on as told.
     *
     * @param {number} steer -1 (left) to 1 (right)
     * @param {boolean} gas
     */
    control(steer, gas) {
      bodies[0].driver.take(steer, gas);
    },

    /**
     * What it has wrecked so far: the energy the crumple zones took up (J), the cars that crashed
     * (not only touched), the parts torn off, the palms and rocks hit.
     */
    get tally() {
      return { energy: absorbed, cars: crashed.size, parts: loose.length, posts: struck.size };
    },

    /** The cars that crashed, in the order they did (the Bolones and the car it hit first). */
    get wrecks() {
      return wrecks.map(({ car }) => car);
    },

    /**
     * The centre of mass of the car that crashed `which`th (0: the Bolones), in the scene, as it
     * is shown.
     *
     * @param {THREE.Vector3} target
     * @param {number} which
     */
    centre(target, which) {
      return inScene(posed(wrecks[which].body)[0], target);
    },

    /**
     * Removes the debris, takes the dents out, puts the parts torn off back, stands the palms
     * up.
     */
    dispose() {
      for (const { vehicle } of bodies) vehicle.dispose();
      undo.reverse().forEach((restore) => restore());
      stands.dispose();
      scene.remove(debris.object);
      debris.dispose();
      world.free();
    },
  };
}

/** @param {THREE.Vector3} v */
const translation = (v) => new THREE.Matrix4().makeTranslation(v);

/**
 * Which way a body turned so heads on the road: its length seen from above, radians about the up.
 *
 * @param {THREE.Quaternion} turn
 */
function headingOf(turn) {
  const { x, z } = AHEAD.clone().applyQuaternion(turn);
  return Math.atan2(x, z);
}

/** @type {WeakMap<THREE.BufferGeometry, Hull>} by the model's body: clones share it */
const roofs = new WeakMap();
/** @type {WeakMap<THREE.BufferGeometry, import("./crash/crush.js").Faces>} by the model's body */
const faces = new WeakMap();
const FACE_STEP = 0.05 * METRE; // the depths a car's ends are measured at

/**
 * How high a car's ends stand (its length is its z), from the road: at each depth in from either
 * end, the highest its body comes that far in, its bumpers too (not its wheels, nor its mirrors):
 * the face a crush that deep meets another car with (a car's bonnet, low; a van's flat front, all
 * of it). Measured once a model.
 *
 * @param {THREE.Object3D} object upright on the road, its world matrices up to date
 * @param {number} floor the road, in its frame
 * @returns {import("./crash/crush.js").Faces}
 */
export function facesOf(object, floor) {
  const meshes = solidMeshes(object).filter(
    (mesh) => partOf(mesh, object)?.userData.part !== "wheel" && mesh.name !== "mirrors",
  );
  const key = meshes[0]?.geometry;
  const known = key && faces.get(key);
  if (known) return known;
  const toObject = object.matrixWorld.clone().invert();
  /** @type {THREE.Vector3[]} */
  const points = [];
  for (const mesh of meshes) {
    const matrix = toObject.clone().multiply(mesh.matrixWorld);
    const position = mesh.geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      points.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix));
    }
  }
  const [near, far] = [
    Math.min(...points.map(({ z }) => z)),
    Math.max(...points.map(({ z }) => z)),
  ];
  const count = Math.ceil((far - near) / 2 / FACE_STEP) + 1; // to its middle
  const ends = /** @type {[Float32Array, Float32Array]} */ (
    [0, 1].map(() => new Float32Array(count))
  );
  for (const { y, z } of points) {
    for (const [end, depth] of /** @type {const} */ ([
      [0, z - near],
      [1, far - z],
    ])) {
      const k = Math.floor(depth / FACE_STEP);
      if (k < count) ends[end][k] = Math.max(ends[end][k], y - floor);
    }
  }
  // the highest that far in or less
  for (const end of ends) for (let k = 1; k < count; k++) end[k] = Math.max(end[k], end[k - 1]);
  const measured = { ends, step: FACE_STEP };
  if (key) faces.set(key, measured);
  return measured;
}

/**
 * @typedef {object} Hull a convex hull
 * @property {THREE.Vector3[]} corners
 * @property {number[]} faces its triangles, three corners each (by their index), turned outwards
 */

/**
 * The convex hull round points (three's: Rapier's own keeps every point, and with many in a plane,
 * a crush's cut, falls through the road).
 *
 * @param {THREE.Vector3[]} points
 * @returns {Hull} none (no faces) for fewer than four
 */
function hullOf(points) {
  /** @type {Hull} */
  const hull = { corners: [], faces: [] };
  if (points.length < 4) return hull;
  const index = new Map();
  for (const { edge } of new ConvexHull().setFromPoints(points).faces) {
    const loop = [];
    let side = edge;
    do {
      const { point } = side.head();
      if (!index.has(point)) index.set(point, hull.corners.push(point) - 1);
      loop.push(index.get(point));
    } while ((side = side.next) !== edge);
    for (let i = 1; i + 1 < loop.length; i++) hull.faces.push(loop[0], loop[i], loop[i + 1]);
  }
  return hull;
}

/**
 * A car's body above a height, in its own frame (not its wheels, its bumpers, nor its mirrors,
 * which fold or come off): what it lands on rolled over, above the box it meets other cars with,
 * as its hull (its shape, a roof's rounded edges and all: not a box round it).
 *
 * @param {THREE.Object3D} object upright on the road, its world matrices up to date
 * @param {number} from
 */
export function roofOf(object, from) {
  const meshes = solidMeshes(object).filter(
    (mesh) => !partOf(mesh, object) && mesh.name !== "mirrors",
  );
  const key = meshes[0]?.geometry;
  let roof = key && roofs.get(key);
  if (roof) return roof;
  const toObject = object.matrixWorld.clone().invert();
  const points = [];
  for (const mesh of meshes) {
    const matrix = toObject.clone().multiply(mesh.matrixWorld);
    const position = mesh.geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix);
      if (p.y > from) points.push(p, p.clone().setY(from)); // down to the box (a flat roof too)
    }
  }
  roof = hullOf(points);
  if (key) roofs.set(key, roof);
  return roof;
}

/**
 * How low a car's body comes (not its wheels, nor its bumpers), in its own frame.
 *
 * @param {THREE.Object3D} object upright on the road, its world matrices up to date
 */
function underside(object) {
  const bounds = new THREE.Box3();
  for (const mesh of solidMeshes(object)) if (!partOf(mesh, object)) bounds.expandByObject(mesh);
  return object.worldToLocal(new THREE.Vector3(0, bounds.min.y, 0)).y;
}

/**
 * Gives an object a world pose, whatever its parent.
 *
 * @param {THREE.Object3D} object
 * @param {THREE.Matrix4} world
 */
function place(object, world) {
  const local = world.clone();
  if (object.parent) {
    object.parent.updateWorldMatrix(true, false);
    local.premultiply(object.parent.matrixWorld.clone().invert());
  }
  local.decompose(object.position, object.quaternion, object.scale);
}
