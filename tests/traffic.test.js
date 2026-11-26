import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { TRAFFIC } from "../src/config.js";
import { prism } from "../src/scene/polygons.js";
import { dent, dentable } from "../src/scene/dents.js";
import { createTrafficModels, drawFar, widestReach } from "../src/scene/traffic.js";
import { TRAFFIC_MODELS } from "../src/scene/trafficModels.js";
import { vanGeometry } from "../src/scene/van.js";
import { solidMeshes, wireOf } from "../src/scene/wire.js";
import { testMaterials as materials } from "./helpers.js";

/**
 * @typedef {[number, number]} Point
 * @typedef {import("../src/scene/trafficModels.js").TrafficModel} TrafficModel
 */

/** y of a polyline sorted by x, at x. @param {Point[]} curve @param {number} x */
const at = (curve, x) => {
  const i = Math.max(
    1,
    curve.findIndex(([cx]) => cx >= x),
  );
  const [[ax, ay], [bx, by]] = [curve[i - 1], curve[i]];
  return ay + ((by - ay) * (x - ax)) / (bx - ax);
};

/**
 * A car's mirrors (nodes with `userData.part` "mirror"), its right one (-x) first.
 *
 * @param {THREE.Object3D} car
 */
const mirrorsOf = (car) =>
  car.children
    .filter(({ userData }) => userData.part === "mirror")
    .sort((a, b) => a.position.x - b.position.x);

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
  /** The cars with a cabin on their deck, and their templates. */
  const sedans = configs.flatMap((config, i) =>
    "cabin" in config ? [{ config, model: models[i] }] : [],
  );

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
    for (const {
      config: { label, body, cabin, windows },
    } of sedans) {
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
    for (const { config, model } of sedans) {
      const profileTop = Math.max(...config.cabin.outline.map(([, y]) => y));
      const top = model.userData.hitbox.max[1] / TRAFFIC.scale;
      expect(top - profileTop).toBeGreaterThan(0.02);
      expect(top - profileTop).toBeLessThan(0.1);
    }
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
      for (const wheel of wheels) {
        // round the axle: the node sits in the middle of the wheel, on the ground
        const bounds = new THREE.Box3().setFromObject(wheel);
        expect(bounds.min.y).toBeCloseTo(0, 5);
        expect(bounds.getCenter(new THREE.Vector3()).distanceTo(wheel.position)).toBeLessThan(0.1);
      }
    }
  });

  it("cast a shadow by the body only: its parts' fall in the body's", () => {
    for (const model of models) {
      const casting = solidMeshes(model).filter(({ castShadow }) => castShadow);
      expect(casting).toEqual([model.children[0]]);
    }
  });

  it("lean the Polakito's rear face back up to its engine lid, as the drawings have it", () => {
    const i = Object.keys(TRAFFIC_MODELS).indexOf("polakito");
    const config = /** @type {import("../src/scene/trafficModels.js").TrafficModel} */ (configs[i]);
    const body = /** @type {THREE.Mesh} */ (models[i].children[0]);
    const raycaster = new THREE.Raycaster();
    /** Where the body's rear is, in the middle at a height y: metres from the car's rear end. */
    const rearAt = (/** @type {number} */ y) => {
      raycaster.set(
        new THREE.Vector3(0.2, y, -10).multiplyScalar(TRAFFIC.scale),
        new THREE.Vector3(0, 0, 1),
      );
      const [hit] = raycaster.intersectObject(body, false);
      return hit.point.z / TRAFFIC.scale + config.length / 2;
    };
    const [top, low] = [rearAt(0.67), rearAt(0.43)];
    expect(top).toBeCloseTo(config.body.top[0][0], 2); // the engine lid's edge stays
    expect(low - top).toBeGreaterThan(0.02); // the face drawn in towards the bumper
    expect(low - top).toBeLessThan(0.04);
  });

  it("give each car its mirrors, a node each to come off: out of its hitbox (the physics' box), within its reach", () => {
    models.forEach((model, i) => {
      const label = configs[i].label;
      const mirrors = mirrorsOf(model);
      const sides = configs[i].mirrors?.sides ?? [];
      expect(mirrors.length, label).toBe(sides.length);
      const each = mirrors.map((mirror) => new THREE.Box3().setFromObject(mirror));
      // on its side, the right one first (mirrorsOf)
      [...sides].sort().forEach((side, k) => {
        expect(side > 0 ? each[k].min.x : -each[k].max.x, label).toBeGreaterThan(0);
      });
      const bounds = each.reduce((all, box) => all.union(box), new THREE.Box3());
      const { hitbox, reach } = model.userData;
      expect(bounds.max.x, label).toBeGreaterThan(hitbox.max[0]); // the driver's side, out
      expect(bounds.min.y, label).toBeGreaterThan(0.5 * TRAFFIC.scale); // up by the windows
      expect(reach.max[0], label).toBeCloseTo(bounds.max.x, 5); // the Bolones must not touch them
      for (const k of [1, 2]) {
        // otherwise as the hitbox
        expect(reach.min[k], label).toBeCloseTo(hitbox.min[k], 5);
        expect(reach.max[k], label).toBeCloseTo(hitbox.max[k], 5);
      }
    });
  });

  it("keeps lanes clear of the widest car, mirrors and all", () => {
    const widest = widestReach(models);
    for (const model of models) {
      const { min, max } = mirrorsOf(model).reduce(
        (bounds, mirror) => bounds.expandByObject(mirror),
        new THREE.Box3(),
      );
      expect(widest).toBeGreaterThanOrEqual(Math.max(-min.x, max.x) - 1e-6);
      expect(widest).toBeGreaterThanOrEqual(model.userData.hitbox.max[0]);
    }
    expect(widest).toBeGreaterThan(
      Math.max(...configs.map(({ width }) => width / 2)) * TRAFFIC.scale,
    );
  });

  it("give decals, bumpers and mirrors corners no further apart than a crash bends (15 cm)", () => {
    const longest = (/** @type {THREE.BufferGeometry} */ geometry, /** @type {number} */ t) => {
      const p = geometry.getAttribute("position");
      const v = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(p, 3 * t + k));
      return Math.max(v[0].distanceTo(v[1]), v[1].distanceTo(v[2]), v[2].distanceTo(v[0]));
    };
    // a quad's diagonal 15 cm by 15 cm, or a small round shape
    const most = 0.25 * TRAFFIC.scale;
    models.forEach((model, i) => {
      const label = configs[i].label;
      const body = /** @type {THREE.Mesh} */ (model.children[0]).geometry;
      const even = body.userData.even ?? [];
      for (let t = 0; t < even.length; t++) {
        if (even[t]) expect(longest(body, t), `${label} decal`).toBeLessThan(most);
      }
      for (const node of model.children.filter(({ userData }) => userData.part === "bumper")) {
        // along the bar: its points every STATION across the car
        const p = /** @type {THREE.Mesh} */ (node.children[0]).geometry.getAttribute("position");
        const xs = [...new Set(Array.from({ length: p.count }, (_, k) => p.getX(k).toFixed(4)))]
          .map(Number)
          .sort((a, b) => a - b);
        const gaps = xs.slice(1).map((x, k) => x - xs[k]);
        expect(Math.max(...gaps) / TRAFFIC.scale, `${label} bumper`).toBeLessThanOrEqual(
          0.15 + 1e-3,
        );
      }
    });
  });

  it("clones keep the hitbox, the wireframe and the lit lamps, their outlines kept for a crash", () => {
    const clone = models[0].clone();
    expect(clone.userData.hitbox).toEqual(models[0].userData.hitbox);
    const lamps = /** @type {THREE.Mesh[]} */ (clone.getObjectsByProperty("name", "lamp"));
    expect(lamps).toHaveLength(2 * /** @type {TrafficModel} */ (configs[0]).lamps.length);
    for (const lamp of lamps) {
      expect(lamp.material).toBe(dressed.headlight);
      expect(lamp.children.map(({ visible }) => visible)).toEqual([false]);
    }
    /** @type {THREE.Object3D[]} */
    const wires = [];
    clone.traverse((o) => o.userData.isWire && !o.parent?.userData.far && wires.push(o));
    const mirrors = configs[0].mirrors?.sides.length ?? 0;
    expect(wires.filter(({ visible }) => visible)).toHaveLength(1 + 6 + mirrors); // body, wheels, bumpers, mirrors
  });

  it("stand in far away as one mesh of their parts where they are, the lamps another", () => {
    for (const model of models) {
      const car = model.clone();
      const far = car.children.filter(({ userData }) => userData.far);
      expect(far.map(({ visible }) => visible)).toEqual([false, false]); // whole until drawn far
      expect(solidMeshes(car).some(({ userData }) => userData.far)).toBe(false); // a crash's
      drawFar(car, true);
      expect(car.children.filter(({ visible }) => visible)).toEqual(far);
      const [body, lamps] = /** @type {THREE.Mesh[]} */ (far);
      const parts = solidMeshes(car).filter(({ name }) => name !== "lamp");
      const count = (/** @type {THREE.Mesh[]} */ meshes) =>
        meshes.reduce((sum, { geometry }) => sum + geometry.getAttribute("position").count, 0);
      expect(body.geometry.getAttribute("position").count).toBe(count(parts));
      expect(lamps.geometry.getAttribute("position").count).toBe(
        count(solidMeshes(car).filter(({ name }) => name === "lamp")),
      );
      // where the parts are, drawn with the lines they draw
      car.updateMatrixWorld(true);
      const whole = new THREE.Box3();
      for (const part of parts) whole.expandByObject(part);
      const stand = new THREE.Box3().setFromObject(body);
      expect(stand.min.distanceTo(whole.min) + stand.max.distanceTo(whole.max)).toBeLessThan(1e-5);
      expect(/** @type {THREE.Mesh} */ (wireOf(body)).geometry).toBe(body.geometry);
      drawFar(car, false);
      expect(far.map(({ visible }) => visible)).toEqual([false, false]);
    }
  });
});

describe("the Ramses, a van", () => {
  const models = createTrafficModels(materials());
  const car = models[Object.keys(TRAFFIC_MODELS).indexOf("ramses")];
  const { van, length } = /** @type {import("../src/scene/trafficModels.js").VanModel} */ (
    TRAFFIC_MODELS.ramses
  );
  const body = /** @type {THREE.Mesh} */ (car.children[0]).geometry;
  const position = body.getAttribute("position");
  /** A corner in metres: across, up, along from the car's end. @param {number} i */
  const corner = (i) => ({
    w: position.getX(i) / TRAFFIC.scale,
    y: position.getY(i) / TRAFFIC.scale,
    x: position.getZ(i) / TRAFFIC.scale + length / 2,
  });
  /** The ends of every edge a line is drawn along. */
  const lines = () => {
    const { inner } = body.userData.polygons;
    return Array.from(inner).flatMap((mask, t) =>
      [0, 1, 2]
        .filter((k) => !(mask & (1 << k)))
        .map((k) => [corner(3 * t + ((k + 1) % 3)), corner(3 * t + ((k + 2) % 3))]),
    );
  };

  it("rounds its roof off from the gutter up to a crowned top", () => {
    const top = car.userData.hitbox.max[1] / TRAFFIC.scale;
    expect(top).toBeCloseTo(van.roof.edge + van.roof.crown, 3);
  });

  it("runs a line round the rear and along both sides at the belt and each rib", () => {
    const drawn = lines();
    for (const y of [...van.ribs, van.belt]) {
      const level = drawn.filter(([a, b]) => Math.abs(a.y - y) < 1e-4 && Math.abs(b.y - y) < 1e-4);
      const rear = level.filter(([a, b]) => Math.abs(a.x - van.ends[0]) < 1e-4 && a.w !== b.w);
      expect(rear.length, `rear at ${y}`).toBeGreaterThan(0);
      for (const side of [-1, 1]) {
        const along = level.filter(([a, b]) => side * a.w > van.half - 1e-4 && a.x !== b.x);
        expect(along.length, `side ${side} at ${y}`).toBeGreaterThan(0);
      }
    }
  });

  it("cuts the sides round the wheel arches", () => {
    /** Whether a side face covers the point (along, up) on the side `side`. */
    const covered = (
      /** @type {number} */ x,
      /** @type {number} */ y,
      /** @type {number} */ side,
    ) => {
      for (let i = 0; i < position.count; i += 3) {
        const [a, b, c] = [i, i + 1, i + 2].map(corner);
        if (![a, b, c].every(({ w }) => Math.abs(side * w - van.half) < 1e-4)) continue;
        const sign = (/** @type {typeof a} */ p, /** @type {typeof a} */ q) =>
          Math.sign((q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x));
        const [s0, s1, s2] = [sign(a, b), sign(b, c), sign(c, a)];
        if (s0 === s1 && s1 === s2) return true;
      }
      return false;
    };
    for (const side of [-1, 1]) {
      for (const axle of TRAFFIC_MODELS.ramses.wheel.axles) {
        expect(covered(axle, van.sill + 0.1, side)).toBe(false); // the arch's opening
      }
      expect(covered(2.2, van.sill + 0.1, side)).toBe(true); // the side between the wheels
    }
  });

  it("lights its two headlamps and two fog lamps", () => {
    expect(car.getObjectsByProperty("name", "lamp")).toHaveLength(4);
  });
});

describe("the Ramses' build", () => {
  const ramses = /** @type {import("../src/scene/trafficModels.js").VanModel} */ (
    TRAFFIC_MODELS.ramses
  );

  it("shades its lamps alike on both sides: the mirrored ones keep their smooth normals", () => {
    const { body } = vanGeometry(ramses);
    const [p, n] = [body.getAttribute("position"), body.getAttribute("normal")];
    /** Points whose normal is not their triangle's, on the left and on the right. */
    const smooth = [0, 0];
    const v = [0, 1, 2].map(() => new THREE.Vector3());
    const normal = new THREE.Vector3();
    for (let t = 0; t < p.count / 3; t++) {
      v.forEach((corner, k) => corner.fromBufferAttribute(p, 3 * t + k));
      const face = v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).normalize();
      for (let k = 0; k < 3; k++) {
        if (normal.fromBufferAttribute(n, 3 * t + k).dot(face) > 0.9999) continue;
        if (Math.abs(v[k].x) > 1e-3) smooth[v[k].x > 0 ? 1 : 0]++;
      }
    }
    expect(smooth[1]).toBeGreaterThan(0); // the fog and tail lamps' sides
    expect(smooth[0]).toBe(smooth[1]);
  });

  it("refuses a side window across a door edge instead of leaving it out", () => {
    const [seam] = ramses.van.seams;
    const across = {
      x: /** @type {[number, number]} */ ([seam - 0.2, seam + 0.05]),
      y: ramses.van.windows[0].y,
    };
    const van = { ...ramses.van, windows: [...ramses.van.windows, across] };
    expect(() => vanGeometry({ ...ramses, van })).toThrow(/door edge/);
  });
});

describe("decals", () => {
  it("keep their even shading through a dent", () => {
    const i = Object.keys(TRAFFIC_MODELS).indexOf("kredens");
    const car = createTrafficModels(materials())[i];
    car.updateMatrixWorld(true);
    const body = /** @type {THREE.Mesh} */ (car.children[0]);
    const entries = dentable(body);
    // a dent along the side, for every point
    dent(entries, (_, v) => {
      v.x *= 0.97 + 0.02 * Math.sin(v.z * 7);
    });
    const geometry = body.geometry;
    const { even } = geometry.userData;
    const { polygon } = geometry.userData.polygons;
    const normal = geometry.getAttribute("normal");
    /** @type {Map<number, THREE.Vector3>} */
    const first = new Map();
    let checked = 0;
    for (let t = 0; t < even.length; t++) {
      if (!even[t]) continue;
      const v = new THREE.Vector3().fromBufferAttribute(normal, 3 * t);
      const seen = first.get(polygon[t]);
      if (seen) {
        expect(v.distanceTo(seen)).toBeLessThan(1e-5);
        checked++;
      } else first.set(polygon[t], v);
    }
    expect(checked).toBeGreaterThan(0);
  });
});
