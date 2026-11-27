import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { createCrushes } from "../src/game/crash/crush.js";
import { ready } from "../src/game/crash/physics.js";

beforeAll(() => ready);

describe("the crush", () => {
  it("has a car lying on top of another meet it: they are in the wreck together", () => {
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    /** A car's box 2 wide, 1 high and 4 long, its middle at height `y`. @param {number} y */
    const solid = (y) => {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, y, 0));
      world.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.5, 2).setDensity(100), body);
      return { body, half: [1, 0.5, 2], shift: new THREE.Vector3(), stiffness: 7e4 };
    };
    const [below, above] = [solid(0.5), solid(1.45)]; // 5 cm into its top
    /** @type {[unknown, unknown][]} */
    const met = [];
    const crushes = createCrushes(world, (a, b) => {
      met.push([a, b]);
      return undefined;
    });
    crushes.collide(above, below, 0);
    expect(met).toEqual([[above, below]]);
    expect(above.body.userForce().y).toBeGreaterThan(0); // held up
    world.free();
  });
});
