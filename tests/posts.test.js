import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { MINIGAME } from "../src/config.js";
import { METRE, POSTS, PARTS, ROAD, groups, ready } from "../src/game/crash/physics.js";
import { createPosts } from "../src/game/crash/posts.js";

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
