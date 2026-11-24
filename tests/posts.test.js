import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { POSTS, PARTS, ROAD, groups, ready } from "../src/game/crash/physics.js";
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
});
