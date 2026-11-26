import * as THREE from "three";
import { CAR, MINIGAME, SPAWN, SPEED, TEXT, TRAFFIC, WORLD } from "../config.js";
import { createRandom, pick, randomIn, randomInt } from "../core/random.js";
import { wheelsOf } from "../scene/rig.js";
import { createSpawner } from "../scene/spawner.js";
import { createTrafficModels, drawFar, widestReach } from "../scene/traffic.js";
import { boundsOf } from "../scene/instances.js";
import { solidMeshes } from "../scene/wire.js";
import { createCrash } from "./crash.js";
import { convexOutline } from "./crash/boxes.js";

/** @typedef {import("../config.js").Mode} Mode */

/**
 * The lanes the traffic keeps to, x from and to: left and right of the centre safe zone, inside
 * the car's steering range.
 *
 * @param {number} halfWidth half the widest obstacle (widestReach)
 */
function lanesOf(halfWidth) {
  const { innerGap, outerMargin, safeZone } = MINIGAME;
  const reach = CAR.steer.maxOffset;
  const minLaneWidth = 0.1; // v1 guard for tiny steering ranges
  const lanes = {
    left: [-reach + outerMargin, -safeZone - halfWidth - innerGap],
    right: [safeZone + halfWidth + innerGap, reach - outerMargin],
  };
  for (const range of Object.values(lanes)) {
    if (range[1] <= range[0]) range[1] = range[0] + minLaneWidth;
  }
  return lanes;
}

/**
 * Obstacle x positions from v1: obstacles fill one lane (left or right of the centre safe zone)
 * for a batch of 1-3, then switch lanes.
 *
 * @param {number} halfWidth half the widest obstacle (widestReach)
 * @param {() => number} [rng]
 */
export function createLanePicker(halfWidth, rng = Math.random) {
  const { between, randomInt } = createRandom(rng);
  const { batch } = MINIGAME;
  const lanes = lanesOf(halfWidth);

  /** @type {"left" | "right"} */
  let lane = "left";
  let count = 0;
  let batchSize = randomInt(batch);

  return () => {
    const [min, max] = lanes[lane];
    const x = between(min, max);
    count++;
    if (count >= batchSize) {
      lane = lane === "left" ? "right" : "left";
      count = 0;
      batchSize = randomInt(batch);
    }
    return x;
  };
}

/**
 * A traffic car's hitbox (the physics' box), or its reach (with the mirrors: what the Bolones
 * must not touch), in its own frame (scene/traffic.js keeps them as arrays).
 *
 * @param {THREE.Object3D} car
 * @param {THREE.Box3} target
 * @param {"hitbox" | "reach"} [which]
 */
function hitboxOf(car, target, which = "hitbox") {
  const { min, max } = car.userData[which];
  target.min.fromArray(min);
  target.max.fromArray(max);
  return target;
}

/** Below this (of WORLD.speed) the camera has come to rest after a crash. */
export const MOVING = 0.05;

/** The heights a palm's trunk is measured at for a crash: where the cars hit it, units. */
const TRUNK = [0.5, 1.8];

/**
 * A palm's trunk where the cars hit it (TRUNK), in the palm's frame: the middle and half the
 * width of what is there (the trunk, leaning a little).
 *
 * @param {THREE.Object3D} palm the model of the palms
 */
function trunkOf(palm) {
  const points = pointsOf(palm).filter(({ y }) => y > TRUNK[0] && y < TRUNK[1]);
  const box = new THREE.Box3().setFromPoints(points);
  const centre = box.getCenter(new THREE.Vector3()).setY(0);
  const size = box.getSize(new THREE.Vector3());
  return { centre, radius: (size.x + size.z) / 4 };
}

/**
 * A rock seen from above, in its frame: the outline round it (x, z).
 *
 * @param {THREE.Object3D} rock the model of a rock
 */
const outlineOf = (rock) =>
  convexOutline(pointsOf(rock).map(({ x, z }) => new THREE.Vector2(x, z)));

/**
 * The points of a model's meshes, in its frame.
 *
 * @param {THREE.Object3D} model
 */
function pointsOf(model) {
  model.updateWorldMatrix(true, true);
  const toModel = model.matrixWorld.clone().invert();
  /** @type {THREE.Vector3[]} */
  const points = [];
  for (const mesh of solidMeshes(model)) {
    const position = mesh.geometry.getAttribute("position");
    const matrix = toModel.clone().multiply(mesh.matrixWorld);
    for (let i = 0; i < position.count; i++) {
      points.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix));
    }
  }
  return points;
}

/**
 * @typedef {object} Damage what a crash has wrecked so far, crash mode's score
 * @property {number} kJ the crumple zones took up
 * @property {number} parts wheels and bumpers torn off
 * @property {number} posts palms and rocks hit
 * @property {number} others cars in the wreck besides the Bolones: the points are multiplied by it
 * @property {number} score MINIGAME.modes.crash
 */

/**
 * Minigame obstacles: oncoming traffic (scene/traffic.js), and in overtake the cars going the
 * Bolones' way; collision with the car, the crash that follows (the palms and the rocks by the
 * road take part) and scoring. Each car is a clone of a random model; its hitbox is the model's
 * bounds (scene/traffic.js).
 *
 * @param {{ scene: THREE.Scene, car: ReturnType<typeof import("../scene/car.js").createCar>, materials: import("../scene/materials.js").Materials, palms: THREE.Object3D[], rocks: THREE.Object3D[] }} deps
 *   palms, rocks: the nodes of their copies (scene/instances.js)
 */
export function createMinigame({ scene, car, materials, palms, rocks }) {
  /** The colour of a wireframe material. @param {THREE.Material} material */
  const colorOf = (material) => /** @type {THREE.MeshBasicMaterial} */ (material).color;
  const models = createTrafficModels(materials);
  const halfWidth = widestReach(models);
  const nextX = createLanePicker(halfWidth);
  const lanes = lanesOf(halfWidth);
  const [minInterval, maxInterval] = MINIGAME.interval;
  const { overtake } = MINIGAME.modes;
  /** @type {Mode} */
  let mode = "dodge";
  let platoon = 0; // overtake: how many of the group towards the Bolones are still to come
  /** @type {ReturnType<typeof trunkOf> | undefined} */
  let trunk; // the palms are copies of one model: one trunk, measured at the first crash
  /** @type {Map<THREE.Object3D, THREE.Vector2[]>} the rocks' models, each outline measured once */
  const outlines = new Map();
  let pileup = 0; // crash mode: the share of the late traffic that runs in, rolled each game
  let keepComing = MINIGAME.crash.keepComing; // s, this game
  let forward = 0; // after a crash: how fast the camera goes on along the road, of WORLD.speed

  /**
   * How fast the traffic towards the Bolones goes over the road (+z), units/s.
   *
   * @param {number} level the traffic's speed multiplier
   */
  const towards = (level) =>
    (mode === "overtake" ? overtake.oncoming / SPEED.kmh : SPEED.traffic - WORLD.speed) * level;

  /**
   * How fast a car of the traffic goes over the road, units/s, +z: towards the Bolones, or (below
   * 0) going its way.
   *
   * @param {THREE.Object3D} other
   * @param {number} level the traffic's speed multiplier
   */
  const overRoadOf = (other, level) =>
    other.userData.sameWay ? -overtake.slow / SPEED.kmh : towards(level);

  /**
   * How fast the traffic towards the Bolones comes at it, of SPEED.traffic (a spawner's speed
   * multiplier): its speed and the Bolones'.
   *
   * @param {number} world the Bolones' speed, of WORLD.speed
   * @param {number} level the traffic's speed multiplier
   */
  const closing = (world, level) => (WORLD.speed * world + towards(level)) / SPEED.traffic;

  /**
   * Units apart, at random, as seconds at SPEED.traffic (the spawners').
   *
   * @param {number[]} range
   * @param {number} roll
   */
  const apart = ([near, far], roll) => (near + roll * (far - near)) / SPEED.traffic;

  /** @type {THREE.Object3D[]} the cars spawned since the last frame */
  const spawned = [];
  /** @type {WeakMap<THREE.Object3D, import("../scene/rig.js").Wheel[]>} */
  const rigs = new WeakMap();
  /** A car's wheels on their rig, found once. @param {THREE.Object3D} other */
  const rigOf = (other) => {
    let rig = rigs.get(other);
    if (!rig) rigs.set(other, (rig = wheelsOf(other)));
    return rig;
  };
  /**
   * A car of a random model coming along, turned round when it goes the Bolones' way; after a
   * crash none comes out of the haze where it could not stop for the jam.
   *
   * @param {number} x
   * @param {boolean} sameWay
   */
  const arrive = (x, sameWay) => {
    const other = pick(models).clone();
    other.position.set(x, TRAFFIC.y, SPAWN.startZ);
    other.rotation.y = sameWay ? Math.PI : 0;
    other.userData.sameWay = sameWay;
    // after a crash, in crash mode as many as rolled do not see the wreck in time, coming in line
    // with a car of it
    other.userData.blind = Boolean(crash) && Math.random() < pileup;
    if (crash && other.userData.blind) {
      other.position.x = pick(crash.wrecks).object.getWorldPosition(new THREE.Vector3()).x;
    }
    if (crash && !crash.room(asCar(other))) return [];
    other.userData.scored = false;
    spawned.push(other);
    return [other];
  };
  // towards the Bolones, in either lane (overtake: the left one, in groups)
  const oncoming = createSpawner({
    parent: scene,
    speed: SPEED.traffic,
    interval: (roll) =>
      mode !== "overtake"
        ? minInterval + roll * (maxInterval - minInterval)
        : apart(platoon > 0 ? overtake.platoon : overtake.window, roll),
    create: () => {
      if (mode !== "overtake") return arrive(nextX(), false);
      platoon = platoon > 0 ? platoon - 1 : randomInt(overtake.group) - 1;
      return arrive(randomIn(lanes.left), false);
    },
  });
  // overtake: going the Bolones' way, in the right lane
  const sameWay = createSpawner({
    parent: scene,
    speed: SPEED.traffic,
    interval: (roll) => apart(overtake.gaps, roll),
    create: () => arrive(randomIn(lanes.right), true),
  });
  const streams = [oncoming, sameWay];
  for (const stream of streams) stream.spawning = false;
  /** The traffic there is, either way. */
  const traffic = () => [...oncoming.objects, ...sameWay.objects];

  const carBounds = new THREE.Box3();
  const obstacleBounds = new THREE.Box3();
  let score = 0;
  /** @type {ReturnType<typeof createCrash> | null} */
  let crash = null;
  let pace = 1; // the traffic's speed multiplier when the crash came: it keeps coming at it
  let coming = 1; // how fast it came at the Bolones then (closing)
  let since = 0; // game seconds since the crash

  /**
   * Puts out a car's lamps that a crash crushed: the body's colour, outlined like the body
   * (scene/traffic.js).
   *
   * @param {THREE.Object3D} other
   * @returns {(crushed: (point: THREE.Vector3) => boolean) => void}
   */
  const lampsOut = (other) => (crushed) => {
    for (const lamp of /** @type {THREE.Mesh[]} */ (other.getObjectsByProperty("name", "lamp"))) {
      if (!lamp.geometry.boundingSphere) lamp.geometry.computeBoundingSphere();
      const middle = /** @type {THREE.Sphere} */ (lamp.geometry.boundingSphere).center;
      if (!crushed(lamp.localToWorld(middle.clone()))) continue;
      lamp.material = materials.solid.traffic;
      lamp.children[0].visible = true;
    }
  };

  /**
   * How a car's driver reacts and brakes after a crash (MINIGAME.modes' `drivers`): one who does
   * not see it in time, `pileup.seen` seconds late.
   *
   * @param {THREE.Object3D} other
   * @returns {import("./crash/drivers.js").Driving | undefined}
   */
  const drivingOf = (other) => {
    const rules = MINIGAME.modes[mode];
    const driving = "drivers" in rules ? rules.drivers : undefined;
    if (!other.userData.blind || !("pileup" in rules)) return driving;
    return { ...driving, seen: rules.pileup.seen };
  };

  /**
   * A car of the traffic in the crash, at its speed over the road. Once the crash dents it, it is
   * drawn whole (wreck): the one mesh far away is the car as it was.
   *
   * @param {THREE.Object3D} other
   * @returns {import("./crash.js").Car}
   */
  const asCar = (other) => {
    const putOut = lampsOut(other);
    return {
      object: other,
      box: hitboxOf(other, new THREE.Box3()),
      mass: other.userData.mass,
      velocity: new THREE.Vector3(0, 0, overRoadOf(other, pace)),
      color: colorOf(materials.wire.traffic),
      onCrash: (crushed) => {
        other.userData.dented = true;
        putOut(crushed);
      },
      label: other.userData.label,
      driving: drivingOf(other),
    };
  };

  /**
   * The Bolones in a crash (game/crash.js).
   *
   * @param {THREE.Vector3} velocity over the road
   * @returns {import("./crash.js").Car}
   */
  const bolones = (velocity) => ({
    object: car.wreck,
    box: car.box,
    mass: CAR.mass,
    velocity,
    color: colorOf(materials.wire.bolones),
    label: TEXT.bolones,
  });

  /**
   * The Bolones ran into a car: they and the rest of the traffic go over to the physics
   * (game/crash.js), each with its speed over the road.
   *
   * @param {THREE.Object3D} obstacle
   * @param {number} world the Bolones' speed, of WORLD.speed
   * @param {number} level the traffic's speed multiplier
   */
  function hit(obstacle, world, level) {
    crash?.dispose(); // one before, in the countdown (none so far), would go unseen
    pace = level;
    coming = closing(world, level);
    since = 0;
    forward = 0;
    spawned.length = 0; // the traffic there is goes in as it is
    sameWay.spawning = false; // going away from the crash
    // the physics has the traffic now: wherever it goes, it stays to be seen (and hit)
    for (const stream of streams) stream.keeping = true;
    const road = WORLD.speed * world;
    // every palm and rock by the road, measured where it is when it comes up
    /** @type {WeakMap<THREE.Object3D, import("./crash.js").Post>} */
    const measured = new WeakMap();
    /** @param {THREE.Object3D} palm */
    const palmPost = (palm) => {
      const { centre, radius } = (trunk ??= trunkOf(palm.userData.model)); // scene/instances.js
      palm.updateWorldMatrix(true, false);
      const at = palm.localToWorld(centre.clone()).setY(0);
      const color = colorOf(materials.wire.palm);
      return { object: palm, at, radius: radius * palm.scale.x, sways: true, color };
    };
    /** @param {THREE.Object3D} rock */
    const rockPost = (rock) => {
      const bounds = boundsOf(rock);
      const { x, z } = bounds.getCenter(new THREE.Vector3());
      const at = new THREE.Vector3(x, bounds.min.y, z);
      /** @type {THREE.Object3D} */
      const model = rock.userData.model; // scene/instances.js
      let around = outlines.get(model);
      if (!around) outlines.set(model, (around = outlineOf(model)));
      // as the rock stands, turned and scaled, round its middle (boundsOf brought it up to date)
      const outline = around.map((p) => {
        const { x: px, z: pz } = rock.localToWorld(new THREE.Vector3(p.x, 0, p.y));
        return new THREE.Vector2(px - x, pz - z);
      });
      const radius = Math.max(...outline.map((p) => p.length()));
      return { object: rock, at, radius, outline, height: bounds.max.y - bounds.min.y };
    };
    /**
     * @param {THREE.Object3D} object
     * @param {(object: THREE.Object3D) => import("./crash.js").Post} measure
     */
    const known = (object, measure) => {
      let post = measured.get(object);
      if (!post) measured.set(object, (post = measure(object)));
      return post;
    };
    const posts = () => [
      ...palms.map((palm) => known(palm, palmPost)),
      ...rocks.map((rock) => known(rock, rockPost)),
    ];
    crash = createCrash(
      scene,
      [
        bolones(new THREE.Vector3(car.sideways, 0, -road)), // where it went (its nose turns less)
        asCar(obstacle),
        ...traffic()
          .filter((other) => other !== obstacle)
          .map(asCar),
      ],
      posts,
    );
  }

  /** Removes all traffic and the crash, stops spawning and zeroes the score. */
  function reset() {
    crash?.dispose();
    crash = null;
    for (const stream of streams) {
      stream.clear();
      stream.spawning = false;
    }
    spawned.length = 0;
    score = 0;
  }

  return {
    get score() {
      return score;
    },

    /** @param {boolean} value */
    set spawning(value) {
      oncoming.spawning = value;
      sameWay.spawning = value && mode === "overtake";
    },

    /**
     * Gets a minigame ready (reset): crash mode's traffic denser, overtake's cars going the
     * Bolones' way lined up ahead.
     *
     * @param {Mode} value
     */
    play(value) {
      reset();
      mode = value;
      platoon = 0;
      const rules = MINIGAME.modes[mode];
      oncoming.density = rules.density;
      pileup = "pileup" in rules ? randomIn(rules.pileup.share) : 0;
      const longer = "pileup" in rules ? rules.pileup.longer : 1;
      keepComing = MINIGAME.crash.keepComing * (1 + (longer - 1) * pileup);
      if (mode !== "overtake") return;
      sameWay.spawning = true;
      sameWay.prewarm(0.25, -overtake.ahead);
      sameWay.spawning = false;
    },

    reset,

    /**
     * Plays a crash once, unseen, while the game loads: the first one in play would stall on
     * code running for the first time (the physics, the dents and their lines, the Bolones' as the
     * traffic's, the parts torn off) and on the shaders of what a crash brings (the shards, the
     * lamps out) and of the traffic fading in (its see-through copies, scene/fade.js), drawn once
     * with them in the scene.
     *
     * @param {() => void} render the whole scene, behind the loader (core/renderer.js warmUp)
     */
    warmUp(render) {
      // as the first crash in play: the Bolones run into by the traffic, one behind another, fast
      // enough to tear parts off (the Bolones' model a shape of its own for the code), then put
      // back as it stood
      const cars = models.map((model, i) => {
        const other = model.clone();
        other.position.set(0, TRAFFIC.y, -12 * (i + 1));
        scene.add(other);
        return { ...asCar(other), velocity: new THREE.Vector3(0, 0, 40) };
      });
      const [at, turn] = [car.wreck.position.clone(), car.wreck.quaternion.clone()];
      const warm = createCrash(scene, [bolones(new THREE.Vector3()), ...cars]);
      for (let t = 0; t < 0.8; t += 1 / 60) warm.update(1 / 60);
      // the traffic coming, fading in: the longest interval spawns a car too lately to be whole
      oncoming.spawning = true;
      oncoming.update(maxInterval, 1);
      render();
      warm.dispose();
      for (const { object } of cars) scene.remove(object);
      car.wreck.position.copy(at);
      car.wreck.quaternion.copy(turn);
      reset();
    },

    /** How much power the Bolones' engine has left after the crash, in the player's hands. */
    get engine() {
      return crash?.engine ?? 0;
    },

    /** @returns {Damage | null} null before the crash */
    get damage() {
      if (!crash) return null;
      const { energy, cars, parts, posts } = crash.tally;
      const { crush, part, post } = MINIGAME.modes.crash;
      const kJ = Math.round(energy / 1000);
      const others = cars - 1;
      return {
        kJ,
        parts,
        posts,
        others,
        score: (kJ * crush + parts * part + posts * post) * others,
      };
    },

    /** How hard the last crash was: 1 at SPEED.traffic (the speed multiplier 1). */
    get impact() {
      return crash?.impact ?? 1;
    },

    /**
     * Moves the traffic, scores the cars passed (dodged, or overtaken) and reports a crash.
     *
     * @param {number} dt
     * @param {number} world the Bolones' speed, of WORLD.speed (the world's speed multiplier)
     * @param {number} [level] the traffic's speed multiplier, if not the Bolones' (overtake)
     * @returns {{ crashed: boolean, scored: boolean }}
     */
    update(dt, world, level = world) {
      oncoming.update(dt, closing(world, level));
      const catching = WORLD.speed * world - overtake.slow / SPEED.kmh; // up on its way
      sameWay.update(dt, Math.max(0, catching) / SPEED.traffic);
      spawned.length = 0; // the spawners move them
      const cars = traffic();
      for (const other of cars) {
        const rolled = Math.abs(overRoadOf(other, level)) * dt; // the wheels roll as far as it goes
        for (const { spin, radius } of rigOf(other)) spin.rotation.x += rolled / radius;
        drawFar(other, other.position.z < -TRAFFIC.far);
      }
      if (cars.length === 0) return { crashed: false, scored: false };

      car.getBounds(carBounds);
      const carZ = car.group.position.z;
      let scored = false;

      for (const obstacle of cars) {
        obstacle.updateMatrix(); // turned round, going the Bolones' way
        hitboxOf(obstacle, obstacleBounds, "reach").applyMatrix4(obstacle.matrix);
        if (carBounds.intersectsBox(obstacleBounds)) {
          hit(obstacle, world, level);
          return { crashed: true, scored };
        }
        if (obstacle.userData.scored || obstacle.position.z <= carZ) continue;
        obstacle.userData.scored = true;
        if (obstacle.userData.sameWay !== (mode === "overtake")) continue; // passed, not scoring
        score++;
        scored = true;
      }

      return { crashed: false, scored };
    },

    /**
     * The Bolones in the player's hands after the crash (crash mode).
     *
     * @param {number} steer -1 (left) to 1 (right)
     * @param {boolean} gas
     */
    control(steer, gas) {
      crash?.control(steer, gas);
    },

    /**
     * After a crash: plays it out (game/crash.js). A car far from the camera is drawn as one mesh
     * till the crash dents it, as ahead on the road.
     *
     * @param {number} dt seconds of game time
     * @param {number} which the car in view, by the order they crashed (0: the Bolones)
     * @param {THREE.Vector3} eye where the camera is
     * @returns {number} the world's speed multiplier: the camera's forward along the road
     */
    wreck(dt, which, eye) {
      if (!crash) return 0;
      since += dt;
      // the traffic keeps coming a while into the crash, and on while the camera goes on along
      // the road; the physics moves it, the spawner fades it in
      oncoming.spawning = since < keepComing || forward > MOVING;
      oncoming.update(dt, 0, coming);
      sameWay.update(dt, 0);
      for (const other of spawned.splice(0)) crash.join(asCar(other));
      forward = crash.update(dt, which) / WORLD.speed;
      for (const other of traffic()) {
        drawFar(other, !other.userData.dented && other.position.distanceTo(eye) > TRAFFIC.far);
      }
      return forward;
    },

    /** What the cars of the wreck are called (touched too), in the order they joined it. */
    get wrecks() {
      return crash?.wrecks.map(({ label }) => label) ?? [];
    },

    /**
     * The centre of the car that crashed `which`th (0: the Bolones), in the scene.
     *
     * @param {THREE.Vector3} target
     * @param {number} which
     */
    wreckCentre(target, which) {
      return crash ? crash.centre(target, which) : target;
    },
  };
}
