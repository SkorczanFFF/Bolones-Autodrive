import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { MINIGAME } from "../src/config.js";
import { METRE, POSTS, PARTS, ROAD, groups, ready } from "../src/game/crash/physics.js";
import { createPosts, roadside } from "../src/game/crash/posts.js";

beforeAll(() => ready);

describe("crash posts", () => {
  it("stop a part torn off flying at a palm: at the trunk, not through it", () => {
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    const palm = new THREE.Object3D();
    const post = {
      object: palm,
      at: new THREE.Vector3(5, 0, 0),
      radius: 0.5,
      color: new THREE.Color(),
    };
    createPosts(
      world,
      () => [post],
      (point) => point.clone(),
    ).sync();
    const wheel = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 1, 0)
        .setLinvel(20, 0, 0)
        .setCcdEnabled(true),
    );
    const desc = RAPIER.ColliderDesc.ball(0.4).setCollisionGroups(
      groups(PARTS, ROAD | POSTS | PARTS),
    );
    world.createCollider(desc, wheel);
    for (let i = 0; i < 120; i++) world.step();
    expect(wheel.translation().x).toBeLessThan(5); // short of the trunk
    expect(wheel.linvel().x).toBeLessThanOrEqual(0); // stopped there
    world.free();
  });

  it("stop a part torn off flying at a long rock's flank there, not where it reaches at most", () => {
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    // 1 across the way the part flies, 4 along it
    const outline = [
      [-0.5, -2],
      [0.5, -2],
      [0.5, 2],
      [-0.5, 2],
    ].map(([x, z]) => new THREE.Vector2(x, z));
    const rock = { object: new THREE.Object3D(), at: new THREE.Vector3(5, 0, 0), outline };
    createPosts(
      world,
      () => [{ ...rock, radius: Math.hypot(0.5, 2), height: 2 }],
      (point) => point.clone(),
    ).sync();
    const wheel = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 1, 0)
        .setLinvel(20, 0, 0)
        .setCcdEnabled(true),
    );
    const desc = RAPIER.ColliderDesc.ball(0.4).setCollisionGroups(
      groups(PARTS, ROAD | POSTS | PARTS),
    );
    world.createCollider(desc, wheel);
    for (let i = 0; i < 120; i++) world.step();
    expect(wheel.translation().x).toBeGreaterThan(4); // at the flank, 4.1 in
    expect(wheel.translation().x).toBeLessThan(4.5);
    world.free();
  });

  it("lean a palm hit again on from as it is, swaying: not upright first, as far as `lean` in all", () => {
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    const palm = new THREE.Object3D();
    const post = { object: palm, at: new THREE.Vector3(), radius: 0.5, sways: true };
    const posts = createPosts(
      world,
      () => [post],
      (point) => point.clone(),
    );
    const [stand] = posts.sync();
    const vertical = new THREE.Vector3(0, 1, 0);
    const tilt = () => vertical.clone().applyQuaternion(palm.quaternion).angleTo(vertical);
    const { full, lean } = MINIGAME.crash.palm;
    const hit = { point: new THREE.Vector3(), plane: 0, reach: 1, tall: 1 };
    stand.struck({ ...hit, into: new THREE.Vector3(1, 0, 0) }, (full / 2) * METRE, 0);
    posts.sway(0.3); // leaning, swaying on
    const was = palm.quaternion.clone();
    stand.struck({ ...hit, into: new THREE.Vector3(0, 0, 1) }, full * METRE, 0.3);
    posts.sway(0.3);
    expect(palm.quaternion.angleTo(was)).toBeLessThan(1e-6); // as it was: not upright
    posts.sway(10);
    expect(tilt()).toBeGreaterThan(0.5 * lean); // further over
    expect(tilt()).toBeLessThan(lean + 1e-6); // as far as `lean` at most
    world.free();
  });
});

describe("the palms and rocks by the road", () => {
  /** A model standing on the ground, a box of that size (in metres up, to measure a trunk at). */
  const model = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) =>
    new THREE.Group().add(
      new THREE.Mesh(new THREE.BoxGeometry(x, y, z, 1, Math.round(y), 1).translate(0, y / 2, 0)),
    );
  /** A copy of a model by the road (scene/instances.js), turned and scaled. */
  const copy = (
    /** @type {THREE.Object3D} */ of,
    /** @type {number[]} */ [x, z],
    turn = 0,
    scale = 1,
  ) => {
    const node = new THREE.Object3D();
    node.userData.model = of;
    node.position.set(x, 0, z);
    node.rotation.y = turn;
    node.scale.setScalar(scale);
    return node;
  };

  it("measure a palm's trunk round, as wide as it is scaled, and a rock as it is turned", () => {
    const color = new THREE.Color();
    const palm = copy(model(0.4, 6, 0.4), [3, -10], 0.5, 2);
    const rock = copy(model(2, 1, 1), [-4, -20], Math.PI / 2);
    const [trunk, stone] = roadside([palm], [rock], color)();
    expect(trunk.at.distanceTo(new THREE.Vector3(3, 0, -10))).toBeCloseTo(0);
    expect(trunk.radius).toBeCloseTo(0.4); // half of 0.4 wide, twice the size
    expect(trunk).toMatchObject({ sways: true, color });
    expect(stone.at.distanceTo(new THREE.Vector3(-4, 0, -20))).toBeCloseTo(0);
    expect(stone.height).toBeCloseTo(1);
    // turned a quarter: 1 wide across the road, 2 along it
    const outline = /** @type {THREE.Vector2[]} */ (stone.outline);
    expect(Math.max(...outline.map(({ x }) => Math.abs(x)))).toBeCloseTo(0.5);
    expect(Math.max(...outline.map(({ y }) => Math.abs(y)))).toBeCloseTo(1);
    expect(stone.radius).toBeCloseTo(Math.hypot(0.5, 1));
    expect(stone.color).toBeUndefined(); // a rock sheds no shards
  });

  it("measure each once, as it stood when it came up, the new ones as they come", () => {
    const palms = [copy(model(0.4, 6, 0.4), [3, -10])];
    const posts = roadside(palms, [], new THREE.Color());
    const [first] = posts();
    palms[0].position.x = 5;
    palms.push(copy(palms[0].userData.model, [-3, -30]));
    const [again, next] = posts();
    expect(again).toBe(first);
    expect(next.at.x).toBeCloseTo(-3);
  });
});
