import { SPAWN, WORLD } from "../../config.js";
import { between, pick, randomIn } from "../../core/random.js";
import { createInstances } from "../instances.js";
import { createSpawner } from "../spawner.js";
import { dress, solidMeshes } from "../wire.js";

const FULL_TURN = 2 * Math.PI;

/**
 * @param {import("three").Object3D} node
 * @param {number} x
 * @param {number} [scale]
 */
function place(node, x, scale = 1) {
  node.position.set(x, 0, 0);
  node.rotation.set(0, between(0, FULL_TURN), 0);
  node.scale.setScalar(scale);
  return node;
}

/**
 * Roadside props: palm pairs on both road edges and rocks scattered further out, drawn as copies
 * of their models (scene/instances.js): a model and its lines a draw call each, however many.
 * Exposes `palms.density` and `rocks.density` for the GUI, and their copies' nodes (`objects`).
 *
 * @param {import("../world.js").WorldContext} context
 */
export function createScenery({ scene, models, materials }) {
  const { palms: palmCfg, rocks: rockCfg } = SPAWN;

  const palm = dress(models[palmCfg.model], materials.solid.palm, materials.wire.palm);
  const rocks = rockCfg.models.map((key) =>
    dress(models[key], materials.solid.rock, materials.wire.rock),
  );
  // they cast no shadows (they still take the cars'): theirs were faint on the dark ground, each
  // a caster in five sun shadow passes; the cars' stay (scene/car.js, scene/traffic.js)
  for (const model of [palm, ...rocks]) {
    for (const mesh of solidMeshes(model)) mesh.castShadow = false;
  }
  const palmCopies = createInstances(scene, [palm]);
  const rockCopies = createInstances(scene, rocks);

  // on past the camera too (SPAWN.behind), where a crash can throw the cars
  const endZ = SPAWN.endZ + SPAWN.behind;
  const palmSpawner = createSpawner({
    parent: scene,
    speed: WORLD.speed,
    endZ,
    interval: () => palmCfg.interval,
    minInterval: palmCfg.minInterval,
    create: () => palmCfg.x.map((x) => place(palmCopies.copy(palm), x)),
    fader: palmCopies,
  });

  const rockSpawner = createSpawner({
    parent: scene,
    speed: WORLD.speed,
    endZ,
    interval: () => rockCfg.interval,
    minInterval: rockCfg.minInterval,
    create: () => {
      const node = rockCopies.copy(pick(rocks));
      return [place(node, randomIn(pick(rockCfg.xRanges)), randomIn(rockCfg.scale))];
    },
    fader: rockCopies,
  });

  /** The copies where their nodes are now (a palm swayed by a crash too, game/crash/posts.js). */
  const draw = () => {
    palmCopies.update(palmSpawner.objects);
    rockCopies.update(rockSpawner.objects);
  };

  // The road starts lined with palms and rocks: the first ones would need a whole trip
  // (SPAWN.startZ to the camera, ~14 s) to arrive.
  palmSpawner.prewarm();
  rockSpawner.prewarm();
  draw();

  return {
    palms: palmSpawner,
    rocks: rockSpawner,
    /**
     * @param {number} dt
     * @param {number} speedMultiplier
     */
    update(dt, speedMultiplier) {
      palmSpawner.update(dt, speedMultiplier);
      rockSpawner.update(dt, speedMultiplier);
      draw();
    },
  };
}
