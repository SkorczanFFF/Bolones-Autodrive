import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { TRAFFIC } from "../src/config.js";
import { createTrafficModels, prism, trafficHalfWidth } from "../src/scene/traffic.js";
import { TRAFFIC_MODELS } from "../src/scene/trafficModels.js";
import { testMaterials as materials } from "./helpers.js";

/** @typedef {[number, number]} Point */

/** y of a polyline sorted by x, at x. @param {Point[]} curve @param {number} x */
const at = (curve, x) => {
  const i = Math.max(
    1,
    curve.findIndex(([cx]) => cx >= x),
  );
  const [[ax, ay], [bx, by]] = [curve[i - 1], curve[i]];
  return ay + ((by - ay) * (x - ax)) / (bx - ax);
};

describe("prism", () => {
  /** A box, with a 10° bend in its top (no crease) and a corner (a crease). */
  const profile = /** @type {Point[]} */ ([
    [0, 0],
    [2, 0],
    [2, 1],
    [1, 1.17],
    [0, 1],
  ]);

  it("faces point outwards", () => {
    const position = prism(profile, () => 0.5).geometry.getAttribute("position");
    const centre = new THREE.Vector3(0, 0.5, 1);
    const [a, b, c] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const normal = new THREE.Vector3();
    for (let i = 0; i < position.count; i += 3) {
      a.fromBufferAttribute(position, i);
      b.fromBufferAttribute(position, i + 1);
      c.fromBufferAttribute(position, i + 2);
      normal.subVectors(b, a).cross(c.clone().sub(a));
      const outwards = a.clone().add(b).add(c).divideScalar(3).sub(centre);
      expect(normal.dot(outwards)).toBeGreaterThan(0);
    }
  });

  it("one polygon per side, one per run of the strip between creases", () => {
    const { polygon } = prism(profile, () => 0.5);
    // 2 sides; strip runs: bottom, front, top (bent, not creased), rear
    expect(new Set(polygon).size).toBe(2 + 4);
  });
});

describe("traffic models", () => {
  const dressed = materials();
  const models = createTrafficModels(dressed);
  const configs = Object.values(TRAFFIC_MODELS);

  it("builds one template per model, front towards +z, on the ground", () => {
    expect(models).toHaveLength(configs.length);
    models.forEach((model, i) => {
      const config = configs[i];
      const { min, max } = model.userData.hitbox;
      const hitbox = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
      const size = hitbox.getSize(new THREE.Vector3());

      expect(hitbox.min.y).toBeCloseTo(0, 5); // tyres touch the ground
      expect(size.z).toBeCloseTo(config.length * TRAFFIC.scale, 5); // bumper to bumper
      expect(Math.abs(hitbox.min.z + hitbox.max.z)).toBeLessThan(1e-5); // centred along z
      expect(size.x).toBeLessThanOrEqual(config.width * TRAFFIC.scale + 1e-5); // fits its lane
      expect(size.x).toBeGreaterThan(0.98 * config.width * TRAFFIC.scale);
    });
  });

  it("stand their cabin on the deck, with the windows inside it", () => {
    /**
     * Within 2 mm of an edge (the data is in millimetres).
     *
     * @param {Point} p
     * @param {Point[]} outline
     */
    const onEdge = ([x, y], outline) =>
      outline.some(([ax, ay], i) => {
        const [bx, by] = outline[(i + 1) % outline.length];
        const length = Math.hypot(bx - ax, by - ay);
        const along = ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / length;
        const off = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / length;
        return Math.abs(off) < 0.002 && along > -0.002 && along < length + 0.002;
      });
    /** @param {Point} p @param {Point[]} outline */
    const inside = ([x, y], outline) =>
      outline.filter(([ax, ay], i) => {
        const [bx, by] = outline[(i + 1) % outline.length];
        return ay > y !== by > y && x < ax + ((y - ay) * (bx - ax)) / (by - ay);
      }).length %
        2 ===
      1;
    for (const { label, body, cabin, windows } of configs) {
      // the bottom edge: under the deck, not below the shoulder (no gap, no step)
      const bottom = Math.min(...cabin.outline.map(([, y]) => y));
      for (const [x, y] of cabin.outline.filter(([, y]) => y === bottom)) {
        expect(y, label).toBeLessThanOrEqual(at(body.top, x) + 1e-9);
        expect(y, label).toBeGreaterThan(at(body.shoulder, x) - 0.005);
      }
      for (const p of [...cabin.windscreen, ...cabin.rearWindow]) {
        expect(onEdge(p, cabin.outline), label).toBe(true);
      }
      for (const window of windows) {
        for (const p of window) expect(inside(p, cabin.outline), label).toBe(true);
      }
    }
  });

  it("draw lines along polygons, not every triangle", () => {
    for (const model of models) {
      const body = /** @type {THREE.Mesh} */ (model.children[0]);
      const { inner, polygon } = body.geometry.userData.polygons;
      expect(inner.length * 3).toBe(body.geometry.getAttribute("position").count);
      expect(polygon.length).toBe(inner.length);
      expect(new Set(polygon).size).toBeLessThan(inner.length / 2); // far fewer polygons
    }
  });

  it("crown the roof: its middle rises a few centimetres over its edges", () => {
    models.forEach((model, i) => {
      const profileTop = Math.max(...configs[i].cabin.outline.map(([, y]) => y));
      const top = model.userData.hitbox.max[1] / TRAFFIC.scale;
      expect(top - profileTop).toBeGreaterThan(0.02);
      expect(top - profileTop).toBeLessThan(0.1);
    });
  });

  it("wrap the Kredens' windscreen round into its pillars", () => {
    const i = Object.keys(TRAFFIC_MODELS).indexOf("kredens");
    const position = /** @type {THREE.Mesh} */ (models[i].children[0]).geometry.getAttribute(
      "position",
    );
    /**
     * How far forward the cabin comes over the bonnet, from `x0` to `x1` across.
     *
     * @param {number} x0
     * @param {number} x1
     */
    const front = (x0, x1) => {
      let most = -Infinity;
      for (let k = 0; k < position.count; k++) {
        const [x, y] = [Math.abs(position.getX(k)), position.getY(k)].map((v) => v / TRAFFIC.scale);
        if (x >= x0 && x <= x1 && y > 0.95 && y < 1.2) most = Math.max(most, position.getZ(k));
      }
      return most / TRAFFIC.scale;
    };
    expect(front(0, 0.35) - front(0.55, 0.65)).toBeGreaterThan(0.04); // the middle comes forward
  });

  it("give a crash points to bend all along the body, at least every 15 cm", () => {
    for (const model of models) {
      const position = /** @type {THREE.Mesh} */ (model.children[0]).geometry.getAttribute(
        "position",
      );
      const zs = [...new Set(Array.from({ length: position.count }, (_, k) => position.getZ(k)))];
      zs.sort((a, b) => a - b);
      const gaps = zs.slice(1).map((z, k) => z - zs[k]);
      expect(Math.max(...gaps) / TRAFFIC.scale).toBeLessThanOrEqual(0.15 + 1e-3);
    }
  });

  it("gives the wheels and the bumpers nodes of their own: a crash moves a wheel whole", () => {
    for (const model of models) {
      const parts = model.children.filter(({ userData }) => userData.part);
      const wheels = parts.filter(({ userData }) => userData.part === "wheel");
      const bumpers = parts.filter(({ userData }) => userData.part === "bumper");
      expect([wheels.length, bumpers.length]).toEqual([4, 2]);
      expect(wheels.every(({ userData }) => userData.rigid)).toBe(true);
      expect(bumpers.some(({ userData }) => userData.rigid)).toBe(false);
      for (const wheel of wheels) {
        // round the axle: the node sits in the middle of the wheel, on the ground
        const bounds = new THREE.Box3().setFromObject(wheel);
        expect(bounds.min.y).toBeCloseTo(0, 5);
        expect(bounds.getCenter(new THREE.Vector3()).distanceTo(wheel.position)).toBeLessThan(0.1);
      }
    }
  });

  it("keeps lanes clear of the widest car: as wide as the widest hitbox", () => {
    const halves = models.map(({ userData: { hitbox } }) => (hitbox.max[0] - hitbox.min[0]) / 2);
    expect(trafficHalfWidth()).toBeGreaterThanOrEqual(Math.max(...halves) - 1e-9);
  });

  it("clones keep the hitbox, the wireframe and the lit lamps, their outlines kept for a crash", () => {
    const clone = models[0].clone();
    expect(clone.userData.hitbox).toEqual(models[0].userData.hitbox);
    const lamps = /** @type {THREE.Mesh[]} */ (clone.getObjectsByProperty("name", "lamp"));
    expect(lamps).toHaveLength(2 * Object.values(TRAFFIC_MODELS)[0].lamps.length);
    for (const lamp of lamps) {
      expect(lamp.material).toBe(dressed.headlight);
      expect(lamp.children.map(({ visible }) => visible)).toEqual([false]);
    }
    /** @type {THREE.Object3D[]} */
    const wires = [];
    clone.traverse((o) => o.userData.isWire && wires.push(o));
    expect(wires.filter(({ visible }) => visible)).toHaveLength(1 + 6); // body, wheels, bumpers
  });
});
