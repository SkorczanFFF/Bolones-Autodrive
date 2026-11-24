import * as THREE from "three";
import { CAR, MINIGAME, SPAWN, SPEED, TEXT, TRAFFIC, WORLD } from "../config.js";
import { createRandom, pick, randomIn, randomInt } from "../core/random.js";
import { wheelsOf } from "../scene/rig.js";
import { createSpawner } from "../scene/spawner.js";
import { createTrafficModels, trafficHalfWidth } from "../scene/traffic.js";
import { createCrash } from "./crash.js";

/** @typedef {import("./game.js").Mode} Mode */

/**
 * The lanes the traffic keeps to, x from and to: left and right of the centre safe zone, inside
 * the car's steering range.
 *
 * @param {number} [halfWidth] half the widest obstacle
 */
function lanesOf(halfWidth = trafficHalfWidth()) {
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
 * @param {number} [halfWidth] half the widest obstacle
 * @param {() => number} [rng]
 */
export function createLanePicker(halfWidth = trafficHalfWidth(), rng = Math.random) {
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
 * A traffic car's hitbox, in its own frame (scene/traffic.js keeps it as arrays).
 *
 * @param {THREE.Object3D} car
 * @param {THREE.Box3} target
 */
function hitboxOf(car, target) {
  const { min, max } = car.userData.hitbox;
  target.min.fromArray(min);
  target.max.fromArray(max);
  return target;
}

/** The heights a palm's trunk is measured at for a crash: where the cars hit it, units. */
const TRUNK = [0.5, 1.8];

/**
 * A palm's trunk where the cars hit it (TRUNK), in the palm's frame: the middle and half the
 * width of what is there (the trunk, leaning a little).
 *
 * @param {THREE.Object3D} palm
 */
function trunkOf(palm) {
  palm.updateWorldMatrix(true, true);
  const toPalm = palm.matrixWorld.clone().invert();
  /** @type {THREE.Vector3[]} */
  const points = [];
  /** @type {THREE.Mesh[]} */
  const meshes = [];
  palm.traverse((o) => o instanceof THREE.Mesh && !o.userData.isWire && meshes.push(o));
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute("position");
    const matrix = toPalm.clone().multiply(mesh.matrixWorld);
    for (let i = 0; i < position.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix);
      if (v.y > TRUNK[0] && v.y < TRUNK[1]) points.push(v);
    }
  }
  const box = new THREE.Box3().setFromPoints(points);
  const centre = box.getCenter(new THREE.Vector3()).setY(0);
  const size = box.getSize(new THREE.Vector3());
  return { centre, radius: (size.x + size.z) / 4 };
}

/**
 * @typedef {object} Damage what a crash has wrecked so far, crash mode's score
 * @property {number} kJ the crumple zones took up
 * @property {number} parts wheels and bumpers torn off
 * @property {number} posts palms and rocks hit
 * @property {number} others cars in the wreck besides the Bolones: the points are multiplied by it
 * @property {number} score MINIGAME.crashMode
 */

/**
 * Minigame obstacles: oncoming traffic (scene/traffic.js), and in overtake the cars going the
 * Bolones' way; collision with the car, the crash that follows (the palms and the rocks by the
 * road take part) and scoring. Each car is a clone of a random model; its hitbox is the model's
 * bounds (scene/traffic.js).
 *
 * @param {{ scene: THREE.Scene, car: ReturnType<typeof import("../scene/car.js").createCar>, materials: import("../scene/materials.js").Materials, palms: THREE.Object3D[], rocks: THREE.Object3D[] }} deps
 */
export function createMinigame({ scene, car, materials, palms, rocks }) {
  /** The colour of a wireframe material. @param {THREE.Material} material */
  const colorOf = (material) => /** @type {THREE.MeshBasicMaterial} */ (material).color;
  const models = createTrafficModels(materials);
  const nextX = createLanePicker();
  const lanes = lanesOf();
  const [minInterval, maxInterval] = MINIGAME.interval;
  const { overtake } = MINIGAME;
  /** How the traffic's drivers react and brake after a crash, by the minigame. */
  const habits = {
    dodge: undefined,
    crash: MINIGAME.crashMode.drivers,
    overtake: overtake.drivers,
  };
  /** @type {Mode} */
  let mode = "dodge";
  let platoon = 0; // overtake: how many of the group towards the Bolones are still to come

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
   * A car of the traffic in the crash, at its speed over the road.
   *
   * @param {THREE.Object3D} other
   * @returns {import("./crash.js").Car}
   */
  const asCar = (other) => ({
    object: other,
    box: hitboxOf(other, new THREE.Box3()),
    mass: other.userData.mass,
    velocity: new THREE.Vector3(0, 0, overRoadOf(other, pace)),
    color: colorOf(materials.wire.traffic),
    onCrash: lampsOut(other),
    label: other.userData.label,
    driving: habits[mode],
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
    spawned.length = 0; // the traffic there is goes in as it is
    sameWay.spawning = false; // going away from the crash
    const road = WORLD.speed * world;
    // every palm and rock by the road, measured where it is when it comes up
    /** @type {WeakMap<THREE.Object3D, import("./crash.js").Post>} */
    const measured = new WeakMap();
    /** @type {ReturnType<typeof trunkOf> | undefined} */
    let trunk; // the palms are clones of one model: one trunk
    /** @param {THREE.Object3D} palm */
    const palmPost = (palm) => {
      const { centre, radius } = (trunk ??= trunkOf(palm));
      palm.updateWorldMatrix(true, false);
      const at = palm.localToWorld(centre.clone()).setY(0);
      const color = colorOf(materials.wire.palm);
      return { object: palm, at, radius: radius * palm.scale.x, sways: true, color };
    };
    /** @param {THREE.Object3D} rock */
    const rockPost = (rock) => {
      const bounds = new THREE.Box3().setFromObject(rock);
      const { x, z } = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const at = new THREE.Vector3(x, bounds.min.y, z);
      return { object: rock, at, radius: (size.x + size.z) / 4, height: size.y };
    };
    /**
     * @param {THREE.Object3D} object
     * @param {(object: THREE.Object3D) => import("./crash.js").Post} measure
     */
    const known = (object, measure) => {
      const post = measured.get(object) ?? measure(object);
      measured.set(object, post);
      return post;
    };
    const posts = () => [
      ...palms.map((palm) => known(palm, palmPost)),
      ...rocks.map((rock) => known(rock, rockPost)),
    ];
    crash = createCrash(
      scene,
      [
        {
          object: car.wreck,
          box: car.box,
          mass: CAR.mass,
          // where it went (its nose turns less)
          velocity: new THREE.Vector3(car.sideways, 0, -road),
          color: colorOf(materials.wire.bolones),
          label: TEXT.bolones,
        },
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
      oncoming.density = mode === "crash" ? MINIGAME.crashMode.density : 1;
      if (mode !== "overtake") return;
      sameWay.spawning = true;
      sameWay.prewarm(0.25, -overtake.ahead);
      sameWay.spawning = false;
    },

    reset,

    /** How much power the Bolones' engine has left after the crash, in the player's hands. */
    get engine() {
      return crash?.engine ?? 0;
    },

    /** @returns {Damage | null} null before the crash */
    get damage() {
      if (!crash) return null;
      const { energy, cars, parts, posts } = crash.tally;
      const { crush, part, post } = MINIGAME.crashMode;
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

    /** How hard the last crash was: 1 at the first level's speed. */
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
      }
      if (cars.length === 0) return { crashed: false, scored: false };

      car.getBounds(carBounds);
      const carZ = car.group.position.z;
      let scored = false;

      for (const obstacle of cars) {
        obstacle.updateMatrix(); // turned round, going the Bolones' way
        hitboxOf(obstacle, obstacleBounds).applyMatrix4(obstacle.matrix);
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
     * After a crash: plays it out (game/crash.js).
     *
     * @param {number} dt seconds of game time
     * @param {number} which the car in view, by the order they crashed (0: the Bolones)
     * @returns {number} the world's speed multiplier: the camera's forward along the road
     */
    wreck(dt, which) {
      if (!crash) return 0;
      since += dt;
      // the traffic keeps coming a while (MINIGAME.crash.keepComing), into the crash; the physics
      // moves it, the spawner still fades it
      oncoming.spawning = since < MINIGAME.crash.keepComing;
      oncoming.update(dt, 0, coming);
      sameWay.update(dt, 0);
      for (const other of spawned.splice(0)) crash.join(asCar(other));
      return crash.update(dt, which) / WORLD.speed;
    },

    /** What the cars that crashed are called, in the order they did (wreckCentre's numbers). */
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
