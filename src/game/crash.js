import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { MINIGAME, MOUNTAINS, PALETTE, SPEED } from "../config.js";
import { settle } from "../core/tween.js";
import { crumple, reaches } from "../scene/crumple.js";
import { createDebris } from "../scene/debris.js";
import { partOf, wheelsOf } from "../scene/rig.js";
import { solidMeshes } from "../scene/wire.js";
import { boxOf, endOn, overlap } from "./crash/boxes.js";
import { createCrushes, reachOf } from "./crash/crush.js";
import { createDriver, hardest, lookAhead, stopping } from "./crash/drivers.js";
import {
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
  groups,
  rotation,
  vector,
  velocityAt,
} from "./crash/physics.js";
import { createPosts } from "./crash/posts.js";
import { createVehicle } from "./crash/vehicle.js";

export { ready } from "./crash/physics.js";

/**
 * @typedef {object} Car a car in a crash, on its rig (scene/rig.js)
 * @property {THREE.Object3D} object posed by the crash; upright on the road when it starts
 * @property {THREE.Box3} box the car in the object's frame
 * @property {number} mass kg
 * @property {THREE.Vector3} velocity over the road, units/s
 * @property {THREE.Color} color its lines: the colour of its shards
 * @property {(crushed: (point: THREE.Vector3) => boolean) => void} [onCrash] told what each crash
 *   crushed (world space): its lamps there go out
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
 * }} Party a car or a palm in a crash: what it does to it
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
 *   energy it took up; a palm hit leans and sways;
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
    parts,
    scrape,
    restitution,
  } = MINIGAME.crash;
  const world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
  world.timestep = STEP;
  world.lengthUnit = METRE;
  // the tyres grip by themselves (crash/vehicle.js): the road itself is smooth, the metal on it not
  const road = world.createCollider(
    new RAPIER.ColliderDesc(new RAPIER.HalfSpace(UP))
      .setFriction(0)
      .setRestitution(restitution.contact)
      .setCollisionGroups(groups(ROAD, CARS | PARTS)),
    world.createRigidBody(RAPIER.RigidBodyDesc.fixed()),
  );
  // the side hills (MOUNTAINS.start) stop what slides off the road: walls the hills rise behind
  for (const side of [-1, 1]) {
    world.createCollider(
      new RAPIER.ColliderDesc(new RAPIER.HalfSpace({ x: -side, y: 0, z: 0 }))
        .setTranslation(side * MOUNTAINS.start, 0, 0)
        .setFriction(0)
        .setRestitution(restitution.contact)
        .setCollisionGroups(groups(ROAD, CARS | PARTS)),
    );
  }
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
    // rolled over it lands on the rest of it, its roof: for the road and the parts only
    const roof = roofOf(object, centre.y + top);
    if (!roof.isEmpty()) {
      const [middle, extent] = [
        roof.getCenter(new THREE.Vector3()),
        roof.getSize(new THREE.Vector3()),
      ];
      const { x: rx, y: ry, z: rz } = middle.sub(centre);
      const cabin = RAPIER.ColliderDesc.cuboid(extent.x / 2, extent.y / 2, extent.z / 2);
      world.createCollider(metal(cabin).setTranslation(rx, ry, rz), body);
    }
    body.recomputeMassPropertiesFromColliders(); // so the crush and the springs weigh it at once
    const vehicle = createVehicle(world, body, rig, centre, groups(CARS, ROAD));
    const offset = translation(centre.clone().negate());
    const entry = {
      car,
      body,
      half: [x, y, z],
      shift,
      offset,
      vehicle,
      stiffness: stiffness * mass,
      driver: createDriver(vehicle, swerves, random, joined ? time : undefined, car.driving),
      color: car.color,
      /** @param {Hit} hit @param {number} speed */
      struck(hit, speed) {
        // as they meet, not as last shown
        put(car.object, offset, vector(body.translation()), rotation(body.rotation()));
        car.onCrash?.(reaches(hit)); // before the dent moves the points
        const dent = crumple(car.object, hit);
        for (const { node, position, quaternion } of dent.moved) {
          vehicle.skew(node, position, quaternion);
        }
        for (const node of dent.torn) {
          if (tearing.some((tear) => tear.node === node)) continue; // torn in this frame already
          tearing.push({ car: entry, node, into: hit.into, speed });
        }
        return dent;
      },
    };
    return entry;
  }
  const bodies = cars.map((car, i) => board(car, i > 0));
  /** @typedef {(typeof bodies)[number]} Body */
  /**
   * Parts torn off in a frame's physics steps, taken away after them.
   *
   * @type {{ car: Body, node: THREE.Object3D, into: THREE.Vector3, speed: number }[]}
   */
  const tearing = [];
  /**
   * The parts torn off: on their own, clear of the car they came off (then they hit it too) or not
   * yet.
   *
   * @type {{ node: THREE.Object3D, body: RAPIER.RigidBody, collider: RAPIER.Collider, from: Body, clear: boolean, half: number[], shift: THREE.Vector3, offset: THREE.Matrix4, size: THREE.Vector3 }[]}
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
  function tearOff({ car, node, into, speed }) {
    /** @type {"wheel" | "bumper"} */
    const part = node.userData.part;
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
    const centre = onRoad(middle.clone().applyMatrix4(node.matrixWorld));
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
        .setCollisionGroups(groups(PARTS, ROAD | POSTS | PARTS)),
      body,
    );

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
      clear: false,
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
   * The parts torn off, after a step: rolling on the road they slow down (MINIGAME.crash.parts
   * roll); clear of the car they came off, they hit it too.
   */
  function loosen() {
    for (const piece of loose) {
      const { body, collider } = piece;
      if (!piece.clear && !overlap(boxOf(piece), boxOf(piece.from))) {
        piece.clear = true;
        collider.setCollisionGroups(groups(PARTS, ROAD | POSTS | PARTS | CARS));
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
      const dent = solid.struck({ ...hit, point: inScene(hit.point) }, crash.speed, time);
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
   * One physics step: the drivers and the wheels, the crush pushing the cars through it (forces,
   * as gravity does: kicks at its start would lift a car standing on its springs), then the parts
   * torn off and the snags.
   */
  function step() {
    for (const { body } of [...bodies, ...loose]) {
      before.set(body, { at: vector(body.translation()), turn: rotation(body.rotation()) });
    }
    for (const { body, driver, vehicle } of bodies) {
      body.resetForces(false);
      body.resetTorques(false);
      driver.drive(time);
      vehicle.update();
    }
    // where each is, once: most pairs are too far apart to touch, not worth their boxes, nor are
    // two at rest
    const at = [...bodies.map(({ body }) => vector(body.translation())), ...postsAt];
    const still = solids.map((solid, i) => i >= bodies.length || solid.body.isSleeping());
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < solids.length; j++) {
        if (still[i] && still[j]) continue;
        const reach = reachOf(solids[i]) + reachOf(solids[j]);
        if (at[i].distanceToSquared(at[j]) > reach ** 2) continue;
        crushes.collide(solids[i], solids[j], time);
      }
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
      for (; lag >= STEP; lag -= STEP) step();
      camera += (-wrecks[which].body.linvel().z - camera) * settle(cameraLag, dt);
      travel += Math.max(0, camera) * dt;

      for (const { car, offset, body, vehicle } of bodies) {
        put(car.object, offset, ...posed(body));
        vehicle.show();
      }
      for (const tear of tearing.splice(0)) tearOff(tear);
      for (const { node, body, offset, size } of loose) put(node, offset, ...posed(body), size);
      stands.sway(time);
      for (const dent of dents) {
        if (dent.progress !== dent.shown) dent.set((dent.shown = dent.progress));
      }
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
/** @type {WeakMap<THREE.BufferGeometry, THREE.Box3>} by the model's body: clones share it */
const roofs = new WeakMap();

/**
 * A car's body above a height, in its own frame (not its wheels, its bumpers, nor its mirrors,
 * which fold or come off): what it lands on rolled over, above the box it meets other cars with.
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
  roof = new THREE.Box3();
  const toObject = object.matrixWorld.clone().invert();
  const p = new THREE.Vector3();
  for (const mesh of meshes) {
    const matrix = toObject.clone().multiply(mesh.matrixWorld);
    const position = mesh.geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      if (p.fromBufferAttribute(position, i).applyMatrix4(matrix).y > from) roof.expandByPoint(p);
    }
  }
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
