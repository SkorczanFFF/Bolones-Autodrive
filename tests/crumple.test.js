import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { MINIGAME } from "../src/config.js";
import { crumple, reaches } from "../src/scene/crumple.js";
import { mountWheel, wheelsOf } from "../src/scene/rig.js";
import { BasicLineMaterial } from "../src/scene/lines.js";
import { dress } from "../src/scene/wire.js";

/** A 2 x 1 x 4 box (non-indexed, as the models are), dressed with polygon lines. */
function car() {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4, 4, 2, 8).toNonIndexed());
  const wire = new BasicLineMaterial();
  wire.userData.wirePolygons = true;
  return dress(new THREE.Group().add(mesh), new THREE.MeshBasicMaterial(), wire);
}
/** @param {THREE.Object3D} root */
const meshOf = (root) => /** @type {THREE.Mesh} */ (root.children[0]);

describe("crumple", () => {
  // hit in the middle of the front, crushed 0.4 back, 0.3 either side (running out over 0.6), as
  // high as the car is
  const hit = {
    point: new THREE.Vector3(0, 0, -2),
    into: new THREE.Vector3(0, 0, 1),
    plane: 0.4,
    reach: 0.3,
    tall: 0.5,
  };
  const plane = hit.point.z + hit.plane;

  it("crushes what is in reach back onto the plane, the whole height, and leaves the rest", () => {
    const root = car();
    const before = meshOf(root).geometry.getAttribute("position").clone();
    crumple(root, hit).set(1);
    const after = meshOf(root).geometry.getAttribute("position");
    let crushed = 0;
    for (let i = 0; i < after.count; i++) {
      const [x, z] = [before.getX(i), before.getZ(i)];
      if (z < plane && Math.abs(x) <= hit.reach) {
        expect(after.getZ(i)).toBeGreaterThanOrEqual(plane - 1e-6); // not short of the plane
        crushed++;
      } else if (z >= plane || Math.abs(x) >= 1) {
        expect(after.getZ(i)).toBeCloseTo(z, 9); // behind it, or out of reach
      }
    }
    expect(crushed).toBeGreaterThan(0);
  });

  it("wrinkles what it crushes a little, never back out of the crush, and nothing else", () => {
    const { dents } = MINIGAME.crash;
    /** The box crushed, wrinkled as much as that. @param {number} wrinkle */
    const crushed = (wrinkle) => {
      const saved = dents.wrinkle;
      dents.wrinkle = wrinkle;
      try {
        const root = car();
        crumple(root, hit).set(1);
        return meshOf(root).geometry.getAttribute("position").clone();
      } finally {
        dents.wrinkle = saved;
      }
    };
    const [smooth, wrinkled] = [crushed(0), crushed(dents.wrinkle)];
    const before = meshOf(car()).geometry.getAttribute("position");
    const [a, b, c] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    let changed = 0;
    for (let i = 0; i < before.count; i++) {
      a.fromBufferAttribute(before, i);
      b.fromBufferAttribute(smooth, i);
      c.fromBufferAttribute(wrinkled, i);
      const off = b.distanceTo(c);
      if (a.z >= plane) expect(off).toBe(0); // not crushed: as it was without
      expect(c.z).toBeGreaterThanOrEqual(b.z - 1e-9); // as deep as without at least (into is +z)
      if (off > 1e-6) changed++;
      expect(off).toBeLessThan(2 * dents.wrinkle * hit.plane); // a little
    }
    expect(changed).toBeGreaterThan(0);
  });

  it("goes in as far as it is set, from nothing", () => {
    const root = car();
    const before = meshOf(root).geometry.getAttribute("position").clone();
    const dent = crumple(root, hit);
    const moved = () => {
      const now = meshOf(root).geometry.getAttribute("position");
      let most = 0;
      for (let i = 0; i < now.count; i++) {
        const at = new THREE.Vector3().fromBufferAttribute(before, i);
        most = Math.max(most, new THREE.Vector3().fromBufferAttribute(now, i).distanceTo(at));
      }
      return most;
    };
    expect(moved()).toBe(0);
    dent.set(0.5);
    const half = moved();
    dent.set(1);
    expect(half).toBeCloseTo(moved() / 2, 5);
  });

  it("keeps the corners that touch together", () => {
    const root = car();
    crumple(root, hit).set(1);
    const position = meshOf(root).geometry.getAttribute("position");
    /** @type {Map<string, string>} original corner -> where it went */
    const moved = new Map();
    let changed = 0;
    const original = new THREE.BoxGeometry(2, 1, 4, 4, 2, 8)
      .toNonIndexed()
      .getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      const from = [original.getX(i), original.getY(i), original.getZ(i)]
        .map((v) => v.toFixed(4))
        .join();
      const to = [position.getX(i), position.getY(i), position.getZ(i)]
        .map((v) => v.toFixed(4))
        .join();
      expect(moved.get(from) ?? to).toBe(to);
      moved.set(from, to);
      if (from !== to) changed++;
    }
    expect(changed).toBeGreaterThan(0); // dented
  });

  it("tents the bonnet up in its middle behind the crush, not its wings, nor the roof", () => {
    // a body 2 x 0.6 x 4 and a cabin on its rear half: the bonnet's top is 0.6 of the way up
    const body = new THREE.Mesh(new THREE.BoxGeometry(2, 0.6, 4, 8, 2, 16).toNonIndexed());
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.4, 1.6, 4, 2, 4).toNonIndexed());
    body.position.y = 0.3;
    cabin.position.set(0, 0.8, 1);
    const root = new THREE.Group().add(body, cabin);
    const before = body.geometry.getAttribute("position").clone();
    crumple(root, { ...hit, reach: 1 }).set(1); // the whole front, 0.4 deep
    const after = body.geometry.getAttribute("position");
    let [middle, wings] = [0, 0];
    for (let i = 0; i < after.count; i++) {
      const [x, y, z] = [before.getX(i), before.getY(i), before.getZ(i)];
      if (Math.abs(y - 0.3) > 1e-6 || z <= plane || z >= plane + 3 * hit.plane) continue; // bonnet
      const lift = after.getY(i) - y;
      if (Math.abs(x) < 0.3) middle = Math.max(middle, lift);
      if (Math.abs(x) === 1) wings = Math.max(wings, lift);
    }
    expect(middle).toBeGreaterThan(0.05);
    expect(wings).toBeLessThan(middle / 4);
  });

  it("drives a deep, narrow hit in as a V, not a cut", () => {
    const root = car();
    const before = meshOf(root).geometry.getAttribute("position").clone();
    crumple(root, { ...hit, plane: 1, reach: 0.1 }).set(1);
    const after = meshOf(root).geometry.getAttribute("position");
    /** How far the front went in at x. @param {number} x */
    const front = (x) => {
      let most = 0;
      for (let i = 0; i < after.count; i++) {
        if (before.getX(i) === x && before.getZ(i) === -2) most = Math.max(most, after.getZ(i) + 2);
      }
      return most;
    };
    expect(front(0)).toBeGreaterThan(0.95);
    expect(front(0.5)).toBeGreaterThan(0.2); // the panels round it are pulled in
    expect(front(0.5)).toBeLessThan(front(0) - 0.2); // less
  });

  it("bends a car hit off its middle towards the side hit", () => {
    const root = car();
    const before = meshOf(root).geometry.getAttribute("position").clone();
    crumple(root, { ...hit, point: new THREE.Vector3(0.8, 0, -2) }).set(1);
    const after = meshOf(root).geometry.getAttribute("position");
    let checked = 0;
    for (let i = 0; i < after.count; i++) {
      // the left side, just behind the crush, moves right (+x), where the car was hit
      if (before.getX(i) !== -1 || before.getZ(i) !== -1.5) continue;
      expect(after.getX(i)).toBeGreaterThan(-1);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  /**
   * A car with a wheel on its rig at `at`, reached by the crush, and its points in the world.
   *
   * @param {THREE.Vector3} at
   */
  function wheeled(at) {
    const root = car();
    const tyre = new THREE.CylinderGeometry(0.4, 0.4, 0.2, 12).rotateZ(Math.PI / 2);
    const mount = mountWheel(new THREE.Mesh(tyre.toNonIndexed()), at, 0.4, true);
    root.add(mount);
    const [{ spin }] = wheelsOf(root);
    const wheel = /** @type {THREE.Mesh} */ (spin.children[0]);
    const points = () => {
      wheel.updateWorldMatrix(true, false);
      const position = wheel.geometry.getAttribute("position");
      return Array.from({ length: position.count }, (_, i) =>
        new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(wheel.matrixWorld),
      );
    };
    return { root, mount, spin, points };
  }

  it("moves a wheel whole, its mount: pushed back and turned, never squashed, still spinning", () => {
    const { root, mount, spin, points } = wheeled(new THREE.Vector3(0.9, 0, -1.4));
    const before = points();
    const dent = crumple(root, { ...hit, plane: 0.4, reach: 1 }); // 0.2 past its front
    dent.set(1);
    expect(dent.torn).toEqual([]);
    expect(dent.moved.map(({ node }) => node)).toEqual([mount]);
    const after = points();
    for (let i = 1; i < after.length; i++) {
      expect(after[i].distanceTo(after[0])).toBeCloseTo(before[i].distanceTo(before[0]), 5);
    }
    expect(after[0].z).toBeGreaterThan(before[0].z + 0.1); // back
    // its spin goes on round its axle, wherever the mount went
    const centre = () => mount.getWorldPosition(new THREE.Vector3());
    const at = centre();
    spin.rotation.x += 1;
    expect(centre().distanceTo(at)).toBeLessThan(1e-9);
    spin.rotation.x -= 1;
    dent.undo();
    expect(points()[0].distanceTo(before[0])).toBeLessThan(1e-6); // back on, as it was
  });

  it("tears a wheel off a car crushed well past it, leaving it as it is for the crash", () => {
    const tear = (/** @type {number} */ plane) => {
      const { root, mount, points } = wheeled(new THREE.Vector3(0.9, 0, -1.4)); // its front 0.2 in
      const before = points()[0];
      const dent = crumple(root, { ...hit, plane, reach: 1 });
      dent.set(1);
      const torn = dent.torn.find(({ node }) => node === mount);
      return { torn: Boolean(torn), moved: points()[0].z - before.z, by: torn?.by.z ?? 0 };
    };
    const pushed = tear(0.35); // 0.15 past its front: pushed back
    expect(pushed.torn).toBe(false);
    expect(pushed.moved).toBeGreaterThan(0.1);
    const off = tear(0.8); // 0.6 past it
    expect(off).toMatchObject({ torn: true, moved: 0 });
    expect(off.by).toBeCloseTo(0.6, 6); // the crash takes it from the plane, not from the other car
  });

  it("lets a wheel pushed up its spring ride into its arch before it bends or comes off", () => {
    // the wheel under the car, the car on its side (its underside to -x), hit underneath
    const crush = (/** @type {number} */ past) => {
      const { root, mount, points } = wheeled(new THREE.Vector3(0.9, -0.5, -1.4));
      root.rotation.z = -Math.PI / 2;
      const before = points();
      const front = Math.min(...before.map(({ x }) => x));
      const { y, z } = mount.getWorldPosition(new THREE.Vector3());
      const under = { point: new THREE.Vector3(front, y, z), into: new THREE.Vector3(1, 0, 0) };
      const dent = crumple(root, { ...under, plane: past, reach: 1, tall: 1 });
      dent.set(1);
      return {
        torn: dent.torn.some(({ node }) => node === mount),
        moved: points()[0].x - before[0].x,
      };
    };
    const pushed = crush(0.6); // as far past it as tears it off a front (above)
    expect(pushed.torn).toBe(false);
    expect(pushed.moved).toBeGreaterThan(0.4); // up into its arch
    expect(crush(1.2).torn).toBe(true); // far past its spring
  });

  it("tears a bumper off a front crushed well past it; crushed less, it bends", () => {
    const bumper = (/** @type {number} */ plane) => {
      const root = car();
      const bar = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 0.1, 8, 1, 1).toNonIndexed());
      const node = new THREE.Group().add(bar);
      node.position.set(0, -0.3, -2.05); // across the front
      node.userData.part = "bumper";
      root.add(node);
      const before = bar.geometry.getAttribute("position").clone();
      const dent = crumple(root, { ...hit, point: new THREE.Vector3(0, 0, -2.1), plane });
      dent.set(1);
      // how far its middle went back, and its ends
      const after = /** @type {THREE.Mesh} */ (node.children[0]).geometry.getAttribute("position");
      const back = (/** @type {(x: number) => boolean} */ where) => {
        let most = 0;
        for (let i = 0; i < after.count; i++) {
          if (where(before.getX(i))) most = Math.max(most, after.getZ(i) - before.getZ(i));
        }
        return most;
      };
      const middle = back((x) => Math.abs(x) < 0.2);
      const bent = middle - back((x) => Math.abs(x) > 0.9);
      const by = dent.torn.find((tear) => tear.node === node)?.by.z ?? 0;
      return { torn: by > 0, bent, middle, by };
    };
    const crushed = bumper(0.3);
    expect(crushed.torn).toBe(false);
    expect(crushed.bent).toBeGreaterThan(0.1); // its middle pushed back, its ends less: bent
    const off = bumper(0.9);
    expect(off.torn).toBe(true);
    expect(off.bent).toBeGreaterThan(0.1); // it comes off bent
    // as far as the crush had come when it went (half its size, MINIGAME.crash.parts), no further
    expect(off.middle).toBeGreaterThan(0.4);
    expect(off.middle).toBeLessThan(0.6);
    // the crash pushes it the rest of the way: its front ends on the plane (buckled a little
    // deeper), not in the car
    expect(off.middle + off.by).toBeGreaterThan(0.85);
    expect(off.middle + off.by).toBeLessThan(1.05);
  });

  it("pushes a side in without folding it up", () => {
    const root = car();
    const before = meshOf(root).geometry.getAttribute("position").clone();
    // the 2 x 4 box hit on its side, in the middle
    const side = {
      point: new THREE.Vector3(-1, 0, 0),
      into: new THREE.Vector3(1, 0, 0),
      plane: 0.3,
      reach: 0.5,
      tall: 0.5,
    };
    crumple(root, side).set(1);
    const after = meshOf(root).geometry.getAttribute("position");
    let pushed = 0;
    for (let i = 0; i < after.count; i++) {
      expect(after.getY(i)).toBeCloseTo(before.getY(i), 6); // nothing rises
      pushed = Math.max(pushed, after.getX(i) - before.getX(i));
    }
    expect(pushed).toBeGreaterThan(0.25);
  });

  it("folds a car only as much as its size allows, however deep the crush", () => {
    const root = car();
    const before = meshOf(root).geometry.getAttribute("position").clone();
    crumple(root, { ...hit, plane: 1.5, reach: 1 }).set(1); // the 4 long box crushed by 1.5
    const after = meshOf(root).geometry.getAttribute("position");
    for (let i = 0; i < after.count; i++) {
      // behind the crush the ridge stays under a sixth of the box's height (1)
      if (before.getZ(i) > -2 + 1.6) expect(after.getY(i) - before.getY(i)).toBeLessThan(0.15);
    }
  });

  it("tells what a hit crushes", () => {
    const crushed = reaches(hit);
    expect(crushed(new THREE.Vector3(0.3, 0.4, -1.9))).toBe(true);
    expect(crushed(new THREE.Vector3(0, 0, -1.5))).toBe(false); // behind the plane
    expect(crushed(new THREE.Vector3(1, 0, -1.9))).toBe(false); // out of reach
  });

  it("redraws the lines and puts everything back on undo", () => {
    const root = car();
    const mesh = meshOf(root);
    const [geometry, lines] = [
      mesh.geometry,
      /** @type {THREE.Mesh} */ (mesh.children[0]).geometry,
    ];
    const { undo } = crumple(root, hit);
    expect(mesh.geometry).not.toBe(geometry);
    expect(/** @type {THREE.Mesh} */ (mesh.children[0]).geometry).not.toBe(lines);
    undo();
    expect(mesh.geometry).toBe(geometry);
    expect(/** @type {THREE.Mesh} */ (mesh.children[0]).geometry).toBe(lines);
  });
});
