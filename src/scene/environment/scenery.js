import { SPAWN, WORLD } from "../../config.js";
import { between, pick, randomIn } from "../../core/random.js";
import { createSpawner } from "../spawner.js";
import { dress, solidMeshes } from "../wire.js";

const FULL_TURN = 2 * Math.PI;

/**
 * @param {import("three").Object3D} template
 * @param {number} x
 * @param {number} [scale]
 */
function place(template, x, scale = 1) {
  const instance = template.clone();
  instance.position.set(x, 0, 0);
  instance.rotation.set(0, between(0, FULL_TURN), 0);
  instance.scale.setScalar(scale);
  return instance;
}

/**
 * Roadside props: palm pairs on both road edges and rocks scattered further out. Exposes
 * `palms.density` and `rocks.density` for the GUI.
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

  // on past the camera too (SPAWN.behind), where a crash can throw the cars
  const endZ = SPAWN.endZ + SPAWN.behind;
  const palmSpawner = createSpawner({
    parent: scene,
    speed: WORLD.speed,
    endZ,
    interval: () => palmCfg.interval,
    minInterval: palmCfg.minInterval,
    create: () => palmCfg.x.map((x) => place(palm, x)),
  });

  const rockSpawner = createSpawner({
    parent: scene,
    speed: WORLD.speed,
    endZ,
    interval: () => rockCfg.interval,
    minInterval: rockCfg.minInterval,
    create: () => [place(pick(rocks), randomIn(pick(rockCfg.xRanges)), randomIn(rockCfg.scale))],
  });

  // The road starts lined with palms and rocks: the first ones would need a whole trip
  // (SPAWN.startZ to the camera, ~14 s) to arrive.
  palmSpawner.prewarm();
  rockSpawner.prewarm();

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
    },
  };
}
