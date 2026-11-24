import * as THREE from "three";
import { TRAFFIC } from "../config.js";
import {
  OFFSET,
  STATION,
  bars,
  builtIn,
  byFaces,
  counterClockwise,
  creaseRuns,
  densify,
  densifyLine,
  ellipse,
  evenNormals,
  face,
  facingPositions,
  fillPoints,
  fineFace,
  flatGeometry,
  glassTriangles,
  joined,
  ladder,
  mergeParts,
  mirrored,
  prism,
  recessed,
  rectangle,
  rounded,
  sample,
  surface,
  triangleFacing,
  withPolygons,
  zip,
} from "./polygons.js";
import { mountWheel } from "./rig.js";
import { TRAFFIC_MODELS } from "./trafficModels.js";
import { vanGeometry } from "./van.js";
import { dress } from "./wire.js";

/**
 * @typedef {import("./trafficModels.js").TrafficModel} TrafficModel
 * @typedef {import("./trafficModels.js").Bumper} Bumper
 * @typedef {import("./trafficModels.js").Decal} Decal
 * @typedef {import("./trafficModels.js").Mark} Mark
 * @typedef {import("./polygons.js").Point} Point
 * @typedef {import("./polygons.js").Part} Part
 */

/** Segments of each wheel arch (half an ellipse). */
const ARCH_SEGMENTS = 6;
/** The waist line keeps this far above a wheel arch, metres. */
const ARCH_LIP = 0.03;
/** An arch's feet come down to the sill this far out from its ends, metres. */
const ARCH_FOOT = 0.01;
/** A curve's point closer than this to a station is left out: the loft samples it, metres. */
const STATION_GAP = 0.04;
const WHEEL_SEGMENTS = 12;
/** Segments round a round hole in a rim: a few centimetres across, an octagon is round enough. */
const HOLE_SEGMENTS = 8;
/** How far a rim sits in its tyre, and a hubcap stands out of the rim, metres. */
const [RIM_DEPTH, HUBCAP] = [0.04, 0.03];
/** Bumper thickness, metres. */
const BUMPER_DEPTH = 0.06;
/** Window frame width around the windscreen and the rear window, metres. */
const FRAME = 0.07;
/**
 * Across the deck, the roof and the screens, as on the Bolones: four flat facets, two each side,
 * the line between them FACET of the half width out and INNER of the crown high (facets()).
 */
const [FACET, INNER] = [0.55, 0.85];
/** How much higher the middle of the roof is than its edges, metres, unless the model says. */
const CROWN = 0.035;
/** Across the roof and the screens (-1 left edge, 1 right): the facets' corners. */
const ACROSS = [-1, -FACET, 0, FACET, 1];
/** The drip rail along each side of the roof, this far under its edge, metres. */
const RAIL = [0.012, 0.03];
/** How often a decal samples the body under it, and how far off it it sits, metres. */
const [DECAL_STEP, DECAL_OFFSET] = [0.03, 0.01];
/** How far a decal may stray from the body under it between the points it keeps, metres. */
const DECAL_TOLERANCE = 0.002;
/** A screen that neither curves nor rounds its corners (TrafficModel `cabin.screens`). */
const FLAT_SCREEN = { bow: [0, 0], corners: [0, 0] };

/**
 * How far the widest of the cars reaches out from its centre line, mirrors and all (their
 * `reach`), in scene units: the minigame keeps lanes this far from the centre.
 *
 * @param {THREE.Object3D[]} models createTrafficModels()
 */
export function widestReach(models) {
  return Math.max(
    ...models.map(({ userData: { reach } }) => Math.max(-reach.min[0], reach.max[0])),
  );
}

/**
 * The minigames' low-poly traffic of the communist era (Polakito, Kredens, the Ramses: van.js),
 * traced from blueprints, one template per TRAFFIC_MODELS entry; the front faces +z (towards the
 * camera). The body is one geometry (one draw call plus its wireframe twin), with
 * `userData.polygons` like the FBX models (core/fbx.js), so its lines follow the designed
 * outlines, not every triangle. Each wheel and
 * bumper is a node of its own (`userData.part`), so a crash can move a wheel whole and tear either
 * off; each headlamp is a mesh of its own ("lamp"), so a crash can put out just the ones it
 * crushes.
 *
 * The local hitbox (the bounds of the body, its wheels and bumpers: the crash's box for the
 * physics) is in `userData.hitbox` as { min, max } arrays: clone() copies userData through JSON,
 * which would turn a Box3 into a plain object. The mirrors (a mesh "mirrors", both sides')
 * stand out of it: `userData.reach`, the same with them, is what the Bolones must not touch
 * (game/minigame.js); in a crash they are dented with the body. The car's mass is in
 * `userData.mass`.
 *
 * @param {import("./materials.js").Materials} materials
 * @returns {THREE.Group[]}
 */
export function createTrafficModels(materials) {
  return Object.values(TRAFFIC_MODELS).map((model) => {
    const { body, lamps } =
      "van" in model
        ? vanGeometry(model)
        : { body: carGeometry(model), lamps: lampGeometries(model) };
    const scale = TRAFFIC.scale;
    const car = new THREE.Group().add(new THREE.Mesh(body.scale(scale, scale, scale)));
    for (const { geometry, at, part } of looseParts(model)) {
      const mesh = new THREE.Mesh(geometry.scale(scale, scale, scale));
      at.multiplyScalar(scale);
      if (part === "wheel") {
        const front = at.z > 0; // the front faces +z
        car.add(mountWheel(mesh, at, model.wheel.radius * scale, front));
        continue;
      }
      const bumper = new THREE.Group().add(mesh); // it bends with the body, or comes off
      bumper.position.copy(at);
      bumper.userData.part = part;
      car.add(bumper);
    }
    for (const lamp of lamps) {
      const mesh = new THREE.Mesh(lamp.scale(TRAFFIC.scale, TRAFFIC.scale, TRAFFIC.scale));
      mesh.name = "lamp";
      car.add(mesh);
    }
    dress(car, materials.solid.traffic, materials.wire.traffic);
    for (const lamp of car.getObjectsByProperty("name", "lamp")) {
      // lit, its outline waiting for a crash to put it out (game/minigame.js); flush on the body,
      // its shadow falls in the body's: five sun shadow passes saved
      /** @type {THREE.Mesh} */ (lamp).material = materials.headlight;
      lamp.children[0].visible = false;
      lamp.castShadow = false;
    }

    car.updateMatrixWorld(true);
    const { min, max } = new THREE.Box3().setFromObject(car);
    car.userData.hitbox = { min: min.toArray(), max: max.toArray() };
    // after the hitbox: the mirrors stand out of it (a box as wide would make the physics' box
    // wider and, one mirror only, shift its middle), within the reach
    if (model.mirrors) {
      const mirrors = new THREE.Mesh(
        mirrorGeometry(model.mirrors, model).scale(scale, scale, scale),
      );
      mirrors.name = "mirrors";
      car.add(dress(mirrors, materials.solid.traffic, materials.wire.traffic));
      car.updateMatrixWorld(true);
    }
    const reach = new THREE.Box3().setFromObject(car);
    car.userData.reach = { min: reach.min.toArray(), max: reach.max.toArray() };
    car.userData.mass = model.mass;
    car.userData.label = model.label;
    return car;
  });
}

/**
 * @typedef {object} Loose a wheel or a bumper of a car: a node of its own
 * @property {THREE.BufferGeometry} geometry round its middle
 * @property {THREE.Vector3} at its middle in the car, metres
 * @property {"wheel" | "bumper"} part
 */

/**
 * A car's bumpers and wheels, each round its middle, in metres (the car's origin on the ground in
 * the middle of its length).
 *
 * @param {TrafficModel | import("./trafficModels.js").VanModel} model
 * @returns {Loose[]}
 */
function looseParts(model) {
  const { wheel } = model;
  /** A part round its middle, and where that is. @param {Part[]} of @param {Loose["part"]} part */
  const loose = (of, part) => {
    const geometry = centred(withPolygons(of), model);
    geometry.computeBoundingBox();
    const at = /** @type {THREE.Box3} */ (geometry.boundingBox).getCenter(new THREE.Vector3());
    geometry.translate(-at.x, -at.y, -at.z);
    return { geometry, at, part };
  };
  return [
    loose([bumper(model.bumpers.front, model.length, -1)], "bumper"),
    loose([bumper(model.bumpers.rear, 0, 1)], "bumper"),
    ...wheel.axles.flatMap((axle, i) =>
      [-1, 1].map((side) =>
        loose(wheelParts(wheel, [(side * wheel.track[i]) / 2, wheel.radius, axle], side), "wheel"),
      ),
    ),
  ];
}

/**
 * Body, cabin, windows and marks of a car, in metres, its origin on the ground in the middle of
 * its length.
 *
 * @param {TrafficModel} model
 * @returns {THREE.BufferGeometry}
 */
function carGeometry(model) {
  const { cabin } = model;
  const cabinBottom = Math.min(...cabin.outline.map(([, y]) => y));
  const cabinTop = Math.max(...cabin.outline.map(([, y]) => y));
  const cabinHalf = (/** @type {number} */ y) =>
    THREE.MathUtils.lerp(cabin.base, cabin.roof, (y - cabinBottom) / (cabinTop - cabinBottom));

  // the deck's crown, which the cabin's foot follows across
  const deckCrown = (/** @type {number} */ x) =>
    Math.max(0, sample(model.body.top, x) - sample(model.body.shoulder, x));
  /** @type {Part[]} */
  const parts = [lowerBody(model), ...cabinParts(model, cabinHalf, deckCrown)];
  for (const side of [-1, 1]) {
    for (const mark of model.sideMarks) {
      const at = (/** @type {Point} */ [x, y]) =>
        new THREE.Vector3(side * (sideWidth(model, x, y) + OFFSET), y, x);
      parts.push(
        ...bars(mark.outline, mark.bars ?? 1).map((bar) =>
          fineFace(bar, at, new THREE.Vector3(side, 0, 0), STATION),
        ),
      );
    }
  }

  if (model.body.flares) parts.push(...flareParts(model, model.body.flares));

  const [rear, front] = ends(model);
  for (const { marks, z, facing } of [
    { marks: model.frontMarks, z: front + OFFSET, facing: 1 },
    { marks: model.rearMarks, z: rear - OFFSET, facing: -1 },
    // a lamp with depth stands out of the front in a housing, its lit glass on it
    { marks: model.lamps.filter(({ depth }) => depth), z: front, facing: 1 },
  ]) {
    const at = (/** @type {Point} */ [w, y]) => new THREE.Vector3(w, y, z);
    const out = new THREE.Vector3(0, 0, facing);
    for (const mark of mirrored(marks)) {
      if (mark.depth) parts.push(raised(rectangle(mark), at, out, mark.depth, mark.bars));
      else {
        for (const bar of bars(rectangle(mark), mark.bars ?? 1)) {
          parts.push(fineFace(bar, at, out, STATION));
        }
      }
    }
  }

  const leaned = leanEnds(withPolygons(parts), model);
  if (!model.decals?.length) return centred(leaned, model);
  /** @type {Part} */
  const body = { geometry: leaned, polygon: Array.from(leaned.userData.polygons.polygon) };
  const decals = decalParts(model.decals, leaned);
  const geometry = withPolygons([body, ...decals]);
  // the flat decals shaded each as if flat (polygons.js evenNormals(); scene/dents.js again)
  geometry.userData.even = Uint8Array.from(
    [body, ...decals].flatMap((part) => part.polygon.map(() => (part.even ? 1 : 0))),
  );
  evenNormals(geometry);
  return centred(geometry, model);
}

/**
 * The half width of a car's lower body at (x, y): the side tucked in from the waist down to the
 * sill, between the waist and the shoulder as sideWidth().
 *
 * @param {TrafficModel} model
 * @param {number} x
 * @param {number} y
 */
function surfaceWidth(model, x, y) {
  const { body } = model;
  const [waist, sill] = [sample(body.waist, x), sample(body.bottom, x)];
  if (y >= waist) return sideWidth(model, x, y);
  return sample(body.width, x) - (body.tuck * (waist - y)) / (waist - sill);
}

/**
 * A flare round each wheel arch, `width` wide, standing OFFSET out of the side: a band between
 * the arch (as lowerBody() cuts it) and the arch grown by `width`, one polygon each.
 *
 * @param {TrafficModel} model
 * @param {number} width
 * @returns {Part[]}
 */
function flareParts(model, width) {
  const { wheel } = model;
  return wheel.axles.flatMap((axle, i) => {
    const [r, height] = wheel.arches[i];
    /** Round the arch from its rear foot to its front. @param {number} grow */
    const arc = (grow) =>
      Array.from({ length: ARCH_SEGMENTS + 1 }, (_, k) => {
        const angle = Math.PI - (Math.PI * k) / ARCH_SEGMENTS;
        return /** @type {Point} */ ([
          axle + (r + grow) * Math.cos(angle),
          wheel.radius + (height + grow) * Math.sin(angle),
        ]);
      });
    const band = [...arc(width), ...arc(0).reverse()];
    return [-1, 1].map((side) =>
      face(
        band,
        ([x, y]) => new THREE.Vector3(side * (surfaceWidth(model, x, y) + OFFSET), y, x),
        new THREE.Vector3(side, 0, 0),
      ),
    );
  });
}

/**
 * An outline standing `depth` out of a surface: its face, cut into bars, and the walls round it,
 * with corners every STATION.
 *
 * @param {Point[]} rim convex
 * @param {(p: Point) => THREE.Vector3} at on the surface
 * @param {THREE.Vector3} out unit
 * @param {number} depth
 * @param {number} [count] bars
 * @returns {Part}
 */
function raised(rim, at, out, depth, count = 1) {
  const outline = densify(rim, STATION);
  const top = (/** @type {Point} */ p) => at(p).addScaledVector(out, depth);
  const centre = outline.reduce((sum, p) => sum.add(at(p)), new THREE.Vector3());
  centre.divideScalar(outline.length);
  const walls = outline.flatMap((p, i) => {
    const q = outline[(i + 1) % outline.length];
    const facing = at(p).add(at(q)).multiplyScalar(0.5).sub(centre); // out of the outline
    return [
      triangleFacing([at(p), at(q), top(q)], facing),
      triangleFacing([at(p), top(q), top(p)], facing),
    ];
  });
  return mergeParts([
    ...bars(outline, count).map((bar) => face(bar, top, out)),
    joined(
      walls,
      walls.map(() => 0),
    ),
  ]);
}

/**
 * Decals (TrafficModel `decals`): each outline drawn in a view, cut into bars or columns, one
 * polygon each, its corners (every DECAL_STEP, inside too) projected onto the body along the view
 * and DECAL_OFFSET off it.
 *
 * @param {Decal[]} decals
 * @param {THREE.BufferGeometry} body built from the rear (z = 0) forward
 * @returns {Part[]}
 */
function decalParts(decals, body) {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const position = /** @type {THREE.BufferAttribute} */ (body.getAttribute("position")).array;
  // each triangle's smallest and largest x, y, z
  const triangles = position.length / 9;
  const [low, high] = [new Float32Array(triangles * 3), new Float32Array(triangles * 3)];
  for (let t = 0; t < triangles; t++) {
    for (let axis = 0; axis < 3; axis++) {
      const [a, b, c] = [0, 3, 6].map((k) => position[9 * t + k + axis]);
      low[3 * t + axis] = Math.min(a, b, c);
      high[3 * t + axis] = Math.max(a, b, c);
    }
  }
  /**
   * The body's triangles that lie (in the view) round the outline's box, a margin wider, as a
   * mesh to cast rays at: tested against every triangle of the body, the rays would be slow.
   *
   * @param {Point[]} outline
   * @param {[number, number, number, number]} axes the view's two coordinates: the scene axis
   *   (0 x, 1 y, 2 z) and the sign of each
   */
  const under = (outline, [axisA, signA, axisB, signB]) => {
    const margin = 0.05;
    const [as, bs] = [outline.map(([a]) => a), outline.map(([, b]) => b)];
    const [a0, a1, b0, b1] = [Math.min(...as), Math.max(...as), Math.min(...bs), Math.max(...bs)];
    /**
     * The triangle's range along an axis, signed.
     *
     * @param {number} t
     * @param {number} axis
     * @param {number} sign
     */
    const range = (t, axis, sign) =>
      sign > 0
        ? [low[3 * t + axis], high[3 * t + axis]]
        : [-high[3 * t + axis], -low[3 * t + axis]];
    /** @type {number[]} */
    const kept = [];
    for (let t = 0; t < triangles; t++) {
      const [[pa0, pa1], [pb0, pb1]] = [range(t, axisA, signA), range(t, axisB, signB)];
      if (pa1 < a0 - margin || pa0 > a1 + margin || pb1 < b0 - margin || pb0 > b1 + margin)
        continue;
      for (let k = 0; k < 9; k++) kept.push(position[9 * t + k]);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(kept, 3));
    return new THREE.Mesh(geometry, material);
  };
  const raycaster = new THREE.Raycaster();
  const far = 50;
  /** @type {Part[]} */
  const parts = [];
  for (const decal of decals) {
    const { view } = decal;
    const outline = decal.outline ?? rectangle(/** @type {Mark} */ (decal.shape));
    const across = view === "top" ? 1 : 0; // which coordinate runs across the car
    const offCentre = outline.every((p) => p[across] > 0);
    const sides = view === "side" || offCentre ? [1, -1] : [1];
    // transposed, cut into bars, back: columns
    const swap = (/** @type {Point[]} */ points) =>
      points.map(([a, b]) => /** @type {Point} */ ([b, a]));
    const pieces = decal.columns
      ? bars(swap(outline), decal.columns).map(swap)
      : bars(outline, decal.bars ?? 1);
    for (const side of sides) {
      /** The ray towards the body through a point of the view. @param {Point} p */
      const ray = ([a, b]) => {
        if (view === "side")
          return [new THREE.Vector3(side * far, b, a), new THREE.Vector3(-side, 0, 0)];
        if (view === "front")
          return [new THREE.Vector3(side * a, b, far), new THREE.Vector3(0, 0, -1)];
        if (view === "rear")
          return [new THREE.Vector3(side * a, b, -far), new THREE.Vector3(0, 0, 1)];
        return [new THREE.Vector3(side * b, far, a), new THREE.Vector3(0, -1, 0)];
      };
      // the view's coordinates in the scene: side [z, y], top [z, ±x], front and rear [±x, y]
      /** @type {[number, number, number, number]} */
      const axes =
        view === "side" ? [2, 1, 1, 1] : view === "top" ? [2, 1, 0, side] : [0, side, 1, 1];
      const mesh = under(outline, axes);
      /** Where the ray through a point meets the body, and its normal. @param {Point} p */
      const hit = (p) => {
        const [origin, direction] = ray(p);
        raycaster.set(origin, direction);
        const [first] = raycaster.intersectObject(mesh);
        if (!first?.face) throw new Error(`a ${view} decal misses the body at ${p}`);
        return { point: first.point, normal: first.face.normal };
      };
      const facing = ray([0, 0])[1].negate();
      if (decal.raise) {
        parts.push(...block(outline, pieces, ray, hit, facing, decal.raise));
        continue;
      }
      const at = (/** @type {Point} */ p) => {
        const { point, normal } = hit(p);
        return point.clone().addScaledVector(normal, DECAL_OFFSET);
      };
      // a four-sided piece as a grid fine enough to follow a curved surface (a long side would
      // cut under it), anything else (small and round) as it is
      for (const piece of pieces) {
        const flat = piece.length === 4 ? grid(piece, at, facing) : face(piece, at, facing);
        parts.push({ ...flat, even: true });
      }
    }
  }
  return parts;
}

/**
 * A four-sided outline as a grid of quads (bilinear over its corners) on the body: sampled every
 * DECAL_STEP, then only the columns and rows kept where the body bends away from a straight line
 * through the ones kept by more than DECAL_TOLERANCE, and at least every STATION, for a crash to
 * bend it with the body. On a flat panel it is quads STATION long; on a curved one, as fine as the
 * curve needs. One polygon.
 *
 * @param {Point[]} quad corners in order round it
 * @param {(p: Point) => THREE.Vector3} at
 * @param {THREE.Vector3} facing
 * @returns {Part}
 */
function grid([p0, p1, p2, p3], at, facing) {
  const length = (/** @type {Point} */ a, /** @type {Point} */ b) =>
    Math.hypot(b[0] - a[0], b[1] - a[1]);
  const across = Math.max(1, Math.ceil(Math.max(length(p0, p1), length(p3, p2)) / DECAL_STEP));
  const up = Math.max(1, Math.ceil(Math.max(length(p0, p3), length(p1, p2)) / DECAL_STEP));
  /** @param {number} u @param {number} v */
  const point = (u, v) =>
    at(
      /** @type {Point} */ (
        [0, 1].map(
          (k) =>
            p0[k] * (1 - u) * (1 - v) + p1[k] * u * (1 - v) + p2[k] * u * v + p3[k] * (1 - u) * v,
        )
      ),
    );
  const fine = Array.from({ length: up + 1 }, (_, j) =>
    Array.from({ length: across + 1 }, (_, i) => point(i / across, j / up)),
  );
  const straight = (
    /** @type {THREE.Vector3} */ a,
    /** @type {THREE.Vector3} */ b,
    /** @type {THREE.Vector3} */ c,
    /** @type {number} */ t,
  ) => c.distanceTo(a.clone().lerp(b, t)) <= DECAL_TOLERANCE;
  /**
   * The indices kept of `count`: the ends, and each one where a straight line on to the next
   * would leave the body or run on further than `most` samples.
   *
   * @param {number} count
   * @param {number} most
   * @param {(a: number, b: number, c: number) => boolean} fits whether c lies on the line a-b
   */
  const keep = (count, most, fits) => {
    const kept = [0];
    let a = 0;
    for (let b = 2; b < count; b++) {
      if (b - a > most) {
        a = b - 1;
        kept.push(a);
        continue;
      }
      for (let c = a + 1; c < b; c++) {
        if (fits(a, b, c)) continue;
        a = b - 1;
        kept.push(a);
        break;
      }
    }
    kept.push(count - 1);
    return kept;
  };
  /** How many samples apart, at most, so that they stay a STATION apart. @param {number} long @param {number} count */
  const most = (long, count) => Math.max(1, Math.floor((STATION * count) / long));
  const columns = keep(
    across + 1,
    most(Math.max(length(p0, p1), length(p3, p2)), across),
    (a, b, c) => fine.every((row) => straight(row[a], row[b], row[c], (c - a) / (b - a))),
  );
  const rows = keep(up + 1, most(Math.max(length(p0, p3), length(p1, p2)), up), (a, b, c) =>
    fine[0].every((_, i) => straight(fine[a][i], fine[b][i], fine[c][i], (c - a) / (b - a))),
  );
  /** @type {number[]} */
  const positions = [];
  for (let j = 0; j + 1 < rows.length; j++) {
    for (let i = 0; i + 1 < columns.length; i++) {
      const [r0, r1, c0, c1] = [rows[j], rows[j + 1], columns[i], columns[i + 1]];
      const [a, b, c, d] = [fine[r0][c0], fine[r0][c1], fine[r1][c1], fine[r1][c0]];
      positions.push(...facingPositions([a, b, c], facing), ...facingPositions([a, c, d], facing));
    }
  }
  return { geometry: flatGeometry(positions), polygon: new Array(positions.length / 9).fill(0) };
}

/**
 * A decal standing out of the body as a block: its face flat, square to the view across the car
 * and tilted up or down as the body under it is, `raise` out past the body's farthest point
 * under it, cut into its pieces; its walls back to the body.
 *
 * @param {Point[]} outline
 * @param {Point[][]} pieces
 * @param {(p: Point) => THREE.Vector3[]} ray origin and direction through a point of the view
 * @param {(p: Point) => { point: THREE.Vector3, normal: THREE.Vector3 }} hit
 * @param {THREE.Vector3} facing towards the view
 * @param {number} raise
 * @returns {Part[]}
 */
function block(outline, pieces, ray, hit, facing, raise) {
  const rim = densify(outline, DECAL_STEP);
  const hits = rim.map(hit);
  const bottoms = hits.map(({ point }) => point);
  // the face's normal: the view's, tilted up or down as the body's normals are on average
  const up = new THREE.Vector3(0, 1, 0);
  const mean = hits.reduce((sum, { normal }) => sum.add(normal), new THREE.Vector3());
  const tilt = Math.abs(facing.dot(up)) > 0.5 ? 0 : mean.dot(up) / Math.max(mean.dot(facing), 1e-6);
  const n = facing.clone().addScaledVector(up, tilt).normalize();
  const level = Math.max(...bottoms.map((point) => point.dot(n))) + raise;
  /** On the face: along the ray, where it meets the face's plane. @param {Point} p */
  const onFace = (p) => {
    const [origin, direction] = ray(p);
    return origin.clone().addScaledVector(direction, (level - origin.dot(n)) / direction.dot(n));
  };
  const centre = rim.reduce((sum, p) => sum.add(onFace(p)), new THREE.Vector3());
  centre.divideScalar(rim.length);
  // the walls run on into the body, closed there by a back: their far edge draws no line where
  // the body curves away from it
  const sunk = bottoms.map((point) => point.clone().addScaledVector(facing, -3 * DECAL_OFFSET));
  const back = sunk.reduce((sum, point) => sum.add(point), new THREE.Vector3());
  back.divideScalar(sunk.length);
  const inwards = facing.clone().negate();
  const walls = rim.flatMap((p, i) => {
    const j = (i + 1) % rim.length;
    const [a, b] = [onFace(p), onFace(rim[j])];
    const out = a.clone().add(b).multiplyScalar(0.5).sub(centre);
    return [
      triangleFacing([a, b, sunk[j]], out),
      triangleFacing([a, sunk[j], sunk[i]], out),
      triangleFacing([back, sunk[i], sunk[j]], inwards),
    ];
  });
  return [
    ...pieces.map((piece) => face(piece, onFace, facing)),
    joined(
      walls,
      walls.map(() => 0),
    ),
  ];
}

/**
 * Leans a car's ends: the front forward above `body.nose.from`, the higher the more (its top
 * edge `lean` ahead); the rear back above `body.tail.from`, its top edge `lean` behind the face
 * below, the face drawn in under its top (which stays where the deck has it) towards the bottom.
 * Each fades out over a STATION from its end; the faces that move get their normals again.
 *
 * @param {THREE.BufferGeometry} geometry non-indexed, built from the rear (z = 0) forward
 * @param {TrafficModel} model
 */
function leanEnds(geometry, model) {
  const { nose, tail, top: deck } = model.body;
  if (!nose && !tail) return geometry;
  const [rear, front] = ends(model);
  const [frontTop, rearTop] = [sample(deck, front), sample(deck, rear)];
  /** How far a point moves along the car. @param {number} y @param {number} z */
  const shift = (y, z) => {
    let by = 0;
    if (nose) {
      const high = THREE.MathUtils.clamp((y - nose.from) / (frontTop - nose.from), 0, 1);
      by += nose.lean * high * THREE.MathUtils.clamp((z - front + STATION) / STATION, 0, 1);
    }
    if (tail) {
      const low = THREE.MathUtils.clamp((rearTop - y) / (rearTop - tail.from), 0, 1);
      by += tail.lean * low * THREE.MathUtils.clamp((rear + STATION - z) / STATION, 0, 1);
    }
    return by;
  };
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const corners = [0, 1, 2].map(() => new THREE.Vector3());
  for (let i = 0; i < position.count; i += 3) {
    let moved = false;
    for (let k = 0; k < 3; k++) {
      const [y, z] = [position.getY(i + k), position.getZ(i + k)];
      const by = shift(y, z);
      position.setZ(i + k, z + by);
      moved ||= by !== 0;
    }
    if (!moved) continue;
    const [a, b, c] = corners.map((v, k) => v.fromBufferAttribute(position, i + k));
    const n = c.sub(b).cross(a.sub(b)).normalize();
    for (let k = 0; k < 3; k++) normal.setXYZ(i + k, n.x, n.y, n.z);
  }
  return geometry;
}

/**
 * A car's geometry, built from its rear bumper (z = 0) forward, moved to have its origin in the
 * middle of its length.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {{ length: number }} model
 */
const centred = (geometry, { length }) => geometry.translate(0, 0, -length / 2);

/** The body's rear and front ends (without the bumpers). @param {TrafficModel} model */
const ends = ({ body }) => [body.top[0][0], body.top[body.top.length - 1][0]];

/**
 * Half width of the body side at (x, y), between the waist and the shoulder.
 *
 * @param {TrafficModel} model
 * @param {number} x
 * @param {number} y
 */
function sideWidth({ body }, x, y) {
  const [waist, shoulder] = [sample(body.waist, x), sample(body.shoulder, x)];
  const width = sample(body.width, x);
  const t = THREE.MathUtils.clamp((y - waist) / (shoulder - waist), 0, 1);
  return width - t * body.shoulderInset;
}

/** Which band of the lower body each stretch of its section is: underside, sides, deck. */
const BANDS = [0, 1, 1, 2, 2, 3, 3, 3, 3];

/**
 * The lower body, lofted through cross-sections along the car: each half section runs from the
 * underside centre out to the sill (`tuck` inside the waist), up to the waist (the widest line,
 * `width` in the top view), the shoulder (`shoulderInset` inside it) and in to the deck centre;
 * the other half mirrors it. Wheel arches are cut into the underside. Underside, lower side, upper
 * side, deck and the two ends are one polygon each, so the lines run along the sill, the waist
 * (over an arch reaching above it) and the shoulder and around the ends; the door seams split
 * the sides into panels.
 *
 * @param {TrafficModel} model
 * @returns {Part}
 */
function lowerBody(model) {
  const { body, wheel } = model;
  const curves = [body.top, body.shoulder, body.waist, body.bottom, body.width];
  const [start, end] = ends(model);
  // the stations: the ends, the seams and round the arches; the curves' points where none is
  // near (one a few millimetres from another cuts a sliver of a strip, twisted, its shading in
  // patches); then the gaps cut evenly, no longer than STATION
  const required = [start, end, ...body.seams];
  wheel.axles.forEach((axle, i) => {
    const [r] = wheel.arches[i];
    for (let k = 0; k <= ARCH_SEGMENTS; k++)
      required.push(axle + r * Math.cos((Math.PI * k) / ARCH_SEGMENTS));
    required.push(axle - r - ARCH_FOOT, axle + r + ARCH_FOOT); // the arch's feet drop to the sill
  });
  const kept = [...new Set(required.map((x) => Math.round(x * 1e4) / 1e4))].filter(
    (x) => x >= start && x <= end,
  );
  for (const x of curves.flatMap((curve) => curve.map(([cx]) => cx)).sort((a, b) => a - b)) {
    const clear = kept.every((k) => Math.abs(k - x) >= STATION_GAP);
    if (clear && x > start && x < end) kept.push(x);
  }
  kept.sort((a, b) => a - b);
  const stations = kept.flatMap((x, i) => {
    if (i === kept.length - 1) return [x];
    const pieces = Math.ceil((kept[i + 1] - x) / STATION - 1e-9);
    return Array.from({ length: pieces }, (_, k) => x + ((kept[i + 1] - x) * k) / pieces);
  });

  const bottom = (/** @type {number} */ x) =>
    wheel.axles.reduce(
      (y, axle, i) => {
        const [r, height] = wheel.arches[i];
        const t = Math.abs(x - axle) / r;
        if (t > 1.001) return y; // stations are rounded to 0.1 mm
        return Math.max(y, wheel.radius + height * Math.sqrt(Math.max(0, 1 - t * t)));
      },
      sample(body.bottom, x),
    );
  /** Half section at x: underside centre, sill, waist, shoulder, deck centre (BANDS). */
  const corners = (/** @type {number} */ x) => {
    const [width, sill, y] = [sample(body.width, x), sample(body.bottom, x), bottom(x)];
    const waist = Math.max(sample(body.waist, x), y + ARCH_LIP);
    // an arch cuts into the side (the sill point stays on its slope from the waist), its well
    // closed by the underside sloping up from the centre
    const tuck = (body.tuck * (waist - y)) / (waist - sill);
    return /** @type {Point[]} */ ([
      [0, sill],
      [width - tuck, y],
      [width, waist],
      [width - body.shoulderInset, sample(body.shoulder, x)],
      [0, sample(body.top, x)],
    ]);
  };
  /**
   * The half section with a point halfway along each band but the underside (hidden), for a crash
   * to bend, the deck in two facets (facets()), each halved too; BANDS says which band each
   * stretch is.
   */
  const section = (/** @type {number} */ x) => {
    const [centre, sill, waist, shoulder, top] = corners(x);
    const between = (/** @type {Point} */ p, /** @type {Point} */ q) =>
      /** @type {Point} */ ([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
    /** @type {Point} */
    const inner = [FACET * shoulder[0], shoulder[1] + (top[1] - shoulder[1]) * INNER];
    return [
      centre,
      ...[sill, waist, shoulder, inner].flatMap((p, i, all) =>
        i ? [between(all[i - 1], p), p] : [p],
      ),
      between(inner, top),
      top,
    ];
  };

  /** @type {number[]} */
  const positions = [];
  /** @type {number[]} */
  const polygon = [];
  /**
   * Triangle facing away from `inside`.
   *
   * @param {THREE.Vector3[]} t
   * @param {THREE.Vector3} inside
   */
  const triangle = ([a, b, c], inside) => {
    const centre = a.clone().add(b).add(c).divideScalar(3);
    positions.push(...facingPositions([a, b, c], centre.sub(inside)));
  };
  for (let s = 0; s + 1 < stations.length; s++) {
    const [x0, x1] = [stations[s], stations[s + 1]];
    const [s0, s1] = [section(x0), section(x1)];
    const top = s0.length - 1;
    const inside = new THREE.Vector3(
      0,
      (s0[0][1] + s0[top][1] + s1[0][1] + s1[top][1]) / 4,
      (x0 + x1) / 2,
    );
    const panel = body.seams.filter((seam) => seam <= (x0 + x1) / 2).length;
    for (let band = 0; band < top; band++) {
      const corner = BANDS[band];
      const id = corner === 1 || corner === 2 ? corner + 4 * panel : corner; // the sides by panel
      for (const side of [-1, 1]) {
        const v = (/** @type {Point} */ [w, y], /** @type {number} */ x) =>
          new THREE.Vector3(side * w, y, x);
        const [a, b, c, d] = [
          v(s0[band], x0),
          v(s0[band + 1], x0),
          v(s1[band + 1], x1),
          v(s1[band], x1),
        ];
        triangle([a, b, c], inside);
        triangle([a, c, d], inside);
        polygon.push(id, id);
      }
    }
  }
  const parts = [{ geometry: flatGeometry(positions), polygon }];
  for (const [x, facing] of [
    [start, -1],
    [end, 1],
  ]) {
    const half = section(x);
    /** @type {Point[]} */
    const outline = [
      ...half,
      ...half
        .slice(1, -1)
        .reverse()
        .map(([w, y]) => /** @type {Point} */ ([-w, y])),
    ];
    // a fan from the middle: it keeps the points halfway along the bands, which the sides share
    const height = outline.reduce((sum, [, y]) => sum + y, 0) / outline.length;
    const centre = new THREE.Vector3(0, height, x);
    const at = (/** @type {Point} */ [w, y]) => new THREE.Vector3(w, y, x);
    parts.push(
      joined(
        outline.map((p, i) => {
          const q = outline[(i + 1) % outline.length];
          return triangleFacing([centre, at(p), at(q)], new THREE.Vector3(0, 0, facing));
        }),
        outline.map(() => 0),
      ),
    );
  }
  return mergeParts(parts);
}

/**
 * The cabin: its side profile drawn across the car, narrowing up to the roof (`halfWidth`). The
 * roof and the screens bulge up (CROWN, from nothing at the cabin's foot to all of it at the
 * roof), rounding off at the edges, and the screens curve out in the middle (`cabin.screens`,
 * as seen from above); the windscreen, the rear window and the side windows, their corners
 * rounded, are set in (RECESS) behind their frames and the pillars, in openings with sides of
 * their own; a drip rail runs along each side of the roof. Stretches longer than STATION are
 * cut, and the sides get points inside, for a crash to bend.
 *
 * @param {TrafficModel} model
 * @param {(y: number) => number} halfWidth
 * @param {(x: number) => number} deckCrown how much higher the deck's middle is than its sides
 * @returns {Part[]}
 */
function cabinParts({ cabin, windows }, halfWidth, deckCrown) {
  const profile = counterClockwise(cabin.outline);
  const foot = Math.min(...profile.map(([, y]) => y));
  const middle = (Math.min(...profile.map(([x]) => x)) + Math.max(...profile.map(([x]) => x))) / 2;
  const screens = [
    { line: cabin.windscreen, ...(cabin.screens?.windscreen ?? FLAT_SCREEN) },
    { line: cabin.rearWindow, ...(cabin.screens?.rearWindow ?? FLAT_SCREEN) },
  ];
  const roof = Math.min(...screens.map(({ line }) => Math.max(...line.map(([, y]) => y))));
  // from the deck's crown at the cabin's foot to the roof's at the top
  const crown = (/** @type {number} */ s, /** @type {number} */ y, /** @type {number} */ x) =>
    facets(s) *
    THREE.MathUtils.lerp(
      deckCrown(x),
      cabin.crown ?? CROWN,
      THREE.MathUtils.clamp((y - foot) / (roof - foot), 0, 1),
    );
  /**
   * @param {number} x
   * @param {number} y
   * @param {number} s across, -1 left to 1 right
   * @param {number} bow how far the middle curves out along the car (a screen's)
   */
  const point = (x, y, s, bow) =>
    new THREE.Vector3(s * halfWidth(y), y + crown(s, y, x), x + bow * facets(s));

  // the profile: a screen's segment curves out at both ends (out along the car, away from the
  // middle), the other segments cut every STATION
  const on = (/** @type {Point} */ a, /** @type {Point} */ b) =>
    screens.find(({ line }) =>
      line.every(([x, y]) => {
        const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
        return Math.abs((x - a[0]) * dy - (y - a[1]) * dx) / Math.hypot(dx, dy) < 0.002;
      }),
    );
  const bows = profile.map(() => 0);
  profile.forEach((a, i) => {
    const screen = on(a, profile[(i + 1) % profile.length]);
    if (!screen) return;
    const away = Math.sign((screen.line[0][0] + screen.line[1][0]) / 2 - middle);
    const b = profile[(i + 1) % profile.length];
    const [bottom, top] = screen.bow.map((bow) => away * bow);
    [bows[i], bows[(i + 1) % profile.length]] = a[1] < b[1] ? [bottom, top] : [top, bottom];
  });
  /** @type {{ at: Point, bow: number, screen: (typeof screens)[number] | undefined }[]} */
  const stations = profile.flatMap((a, i) => {
    const k = (i + 1) % profile.length;
    const [b, screen] = [profile[k], on(a, profile[k])];
    const pieces = screen ? 1 : Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / STATION);
    return Array.from({ length: pieces }, (_, j) => {
      const t = j / pieces;
      const at = /** @type {Point} */ ([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      return { at, bow: bows[i] + (bows[k] - bows[i]) * t, screen };
    });
  });
  const outline = stations.map(({ at }) => at);

  /** @type {Part[]} */
  const parts = [];
  /** A recessed glass in an opening (polygons.js recessed()). @type {typeof recessed} */
  const glass = (rim, triangles, at, out) => {
    const pieces = recessed(rim, triangles, at, out);
    parts.push(...pieces);
    return pieces;
  };

  // the strip round the profile: one polygon per run between creases, as prism()
  /** @type {Part[]} */
  const strip = [];
  /** @type {number[]} */
  const runs = [];
  for (const { i, run } of creaseRuns(outline)) {
    const [{ at: a, bow: bowA, screen }, { at: b, bow: bowB }] = [
      stations[i],
      stations[(i + 1) % stations.length],
    ];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const length = Math.hypot(dx, dy);
    const out = new THREE.Vector3(0, -dx, dy).divideScalar(length); // ccw: right of the way round
    /** (s across, t from a to b) on the strip. @param {Point} p */
    const at = ([u, t]) => point(a[0] + dx * t, a[1] + dy * t, u, bowA + (bowB - bowA) * t);
    /** Points across at t, left to right. @param {number[]} us @param {number} t */
    const row = (us, t) => us.map((u) => /** @type {Point} */ ([u, t]));
    if (!screen) {
      strip.push(surface(ladder(row(ACROSS, 0), row(ACROSS, 1)), at, out));
      runs.push(run);
      continue;
    }
    // the opening, the frame in from the strip's ends and sides, its corners cut (in metres
    // across and along: X, T), with points along its bottom and top only where they cross the
    // facets' corners: the glass a strip between the two, one quad a facet, the frame zipped
    // round it
    const frame = cabin.frame ?? FRAME;
    const ts = screen.line.map(([x, y]) => ((x - a[0]) * dx + (y - a[1]) * dy) / length ** 2);
    const [t0, t1] = [Math.min(...ts) + frame / length, Math.max(...ts) - frame / length];
    const half = (/** @type {number} */ t) => halfWidth(a[1] + dy * t);
    const [r0, r1] = dy > 0 ? screen.corners : [...screen.corners].reverse(); // bottom, top
    /** @type {Point[]} [BL, BR, TR, TL] */
    const [bl, br, tr, tl] = [
      [-(half(t0) - frame), t0 * length],
      [half(t0) - frame, t0 * length],
      [half(t1) - frame, t1 * length],
      [-(half(t1) - frame), t1 * length],
    ];
    /** A corner cut `r` towards its neighbours, the side's first (uncut: the corner itself). */
    const cut = (
      /** @type {Point} */ corner,
      /** @type {Point} */ side,
      /** @type {Point} */ along,
      /** @type {number} */ r,
    ) => {
      const towards = (/** @type {Point} */ p) => {
        const share = Math.min(r / Math.hypot(p[0] - corner[0], p[1] - corner[1]), 0.45);
        return /** @type {Point} */ ([
          corner[0] + (p[0] - corner[0]) * share,
          corner[1] + (p[1] - corner[1]) * share,
        ]);
      };
      return r > 1e-4 ? [towards(side), towards(along)] : [corner];
    };
    /** Where an edge at T crosses the facets' corners between X0 and X1. */
    const creases = (/** @type {number} */ X0, /** @type {number} */ X1, /** @type {number} */ T) =>
      [-FACET, 0, FACET]
        .map((u) => u * half(T / length))
        .filter((X) => X > X0 + 1e-3 && X < X1 - 1e-3)
        .map((X) => /** @type {Point} */ ([X, T]));
    // each left to right
    const [bottomLeft, bottomRight] = [cut(bl, tl, br, r0), cut(br, bl, tr, r0)];
    const [topLeft, topRight] = [cut(tl, bl, tr, r1), cut(tr, tl, br, r1)];
    const toStrip = (/** @type {Point} */ [X, T]) =>
      /** @type {Point} */ ([X / half(T / length), T / length]);
    const bottom = densifyLine(
      [
        ...bottomLeft,
        ...creases(bottomLeft[bottomLeft.length - 1][0], bottomRight[0][0], t0 * length),
        ...bottomRight,
      ],
      STATION,
    ).map(toStrip);
    const top = densifyLine(
      [
        ...topLeft,
        ...creases(topLeft[topLeft.length - 1][0], topRight[0][0], t1 * length),
        ...topRight,
      ],
      STATION,
    ).map(toStrip);
    const rim = [...bottom, ...[...top].reverse()];
    const centre = /** @type {Point} */ ([0, (t0 + t1) / 2]);
    const angle = (/** @type {Point} */ [u, t]) =>
      Math.atan2((t - centre[1]) * length, u * half(t));
    const outer = [...row(ACROSS, 0), ...row([...ACROSS].reverse(), 1)];
    strip.push(surface(zip(outer, rim, angle), at, out));
    runs.push(run);
    glass(rim, ladder(bottom, top), at, out);
  }
  parts.push(joined(strip, runs));

  // the sides, their windows set in, with points inside for a crash to bend
  const panes = windows.map((window) =>
    densify(rounded(window, cabin.windowCorners ?? 0, 1), STATION),
  );
  const steiner = fillPoints(outline, panes, STATION, 0.03, 2 * STATION);
  const roofLine = outline.filter(([, y]) => y >= roof - 1e-6);
  for (const side of [-1, 1]) {
    const out = new THREE.Vector3(side, 0, 0);
    const at = (/** @type {Point} */ [x, y]) => new THREE.Vector3(side * halfWidth(y), y, x);
    parts.push(face(outline, at, out, [...panes, ...steiner]));
    for (const pane of panes) glass(pane, glassTriangles(pane, STATION), at, out);
    // the drip rail, under the roof's edge
    /** @type {Point[]} */
    const rail = [
      ...roofLine.map(([x, y]) => /** @type {Point} */ ([x, y - RAIL[0]])),
      ...[...roofLine].reverse().map(([x, y]) => /** @type {Point} */ ([x, y - RAIL[1]])),
    ];
    const above = (/** @type {Point} */ [x, y]) =>
      new THREE.Vector3(side * (halfWidth(y) + OFFSET), y, x);
    parts.push(face(rail, above, out));
  }
  return parts;
}

/**
 * Outside mirrors (Mirror, scene/trafficModels.js), both sides' in one geometry, with
 * `userData.polygons`: on each side a head (an outline with its corners cut, drawn across and
 * deep along the car), its glass outlined on its back (looking back: -z, the car's front is +z),
 * and the arms from the body, boxes.
 *
 * @param {import("./trafficModels.js").Mirror} mirror
 * @param {{ length: number }} model
 */
function mirrorGeometry({ sides, head, depth, corners, centre, arms, arm }, model) {
  const [x, y, w] = centre;
  const [across, up] = head;
  /** @type {Part[]} */
  const parts = [];
  for (const side of sides) {
    // the head: its outline across and up, drawn along the car (prism: x across -> z)
    const outline = rounded(
      [
        [side * w - across / 2, y - up / 2],
        [side * w + across / 2, y - up / 2],
        [side * w + across / 2, y + up / 2],
        [side * w - across / 2, y + up / 2],
      ],
      corners,
      1,
    );
    const shell = prism(outline, () => depth / 2);
    // (±depth / 2, up, across) -> (across, up, x ∓ depth / 2)
    shell.geometry.rotateY(Math.PI / 2).translate(0, 0, x);
    parts.push(shell);
    // the glass, looking back
    const inset = Math.min(across, up) * 0.15;
    const glass = rounded(
      [
        [side * w - across / 2 + inset, y - up / 2 + inset],
        [side * w + across / 2 - inset, y - up / 2 + inset],
        [side * w + across / 2 - inset, y + up / 2 - inset],
        [side * w - across / 2 + inset, y + up / 2 - inset],
      ],
      corners / 2,
      1,
    );
    const back = x - depth / 2 - OFFSET;
    parts.push(face(glass, ([u, v]) => new THREE.Vector3(u, v, back), new THREE.Vector3(0, 0, -1)));
    for (const [from, to] of arms) {
      const [a, b] = [from, to].map(([px, py, pw]) => new THREE.Vector3(side * pw, py, px));
      const rod = new THREE.BoxGeometry(arm, arm, a.distanceTo(b));
      rod.applyQuaternion(
        new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 0, 1),
          b.clone().sub(a).normalize(),
        ),
      );
      rod.translate(...a.add(b).multiplyScalar(0.5).toArray());
      parts.push(byFaces(rod));
    }
  }
  return centred(withPolygons(parts), model);
}

/**
 * The headlamps, one geometry each, with `userData.polygons` (its outline): lines once it is out.
 *
 * @param {TrafficModel} model
 */
function lampGeometries(model) {
  const front = ends(model)[1];
  return mirrored(model.lamps).map((lamp) => {
    const z = front + (lamp.depth ?? 0) + 2 * OFFSET; // on its housing, if it has one
    const at = (/** @type {Point} */ [w, y]) => new THREE.Vector3(w, y, z);
    return centred(
      leanEnds(withPolygons([face(rectangle(lamp), at, new THREE.Vector3(0, 0, 1))]), model),
      model,
    );
  });
}

/**
 * A wheel: the tyre (its tread, the sidewall round the rim), the rim set RIM_DEPTH into it with
 * its holes, the hubcap. Lines draw the rings, the holes and the hubcap.
 *
 * @param {Omit<TrafficModel["wheel"], "arches">} wheel
 * @param {number[]} centre
 * @param {number} side -1 left, 1 right: where the outer face looks
 * @returns {Part[]}
 */
function wheelParts({ radius, width, rim }, [x, y, z], side) {
  const outside = x + (side * width) / 2;
  const facing = new THREE.Vector3(side, 0, 0);
  /** A point on the wheel (u along the car, v up from the centre), `depth` in from its face. */
  const on =
    (/** @type {number} */ depth) =>
    (/** @type {Point} */ [u, v]) =>
      new THREE.Vector3(outside - side * depth, y + v, z + u);
  /** A circle as the tread's corners. @param {number} r */
  const ring = (r) => ellipse(0, 0, r, r, WHEEL_SEGMENTS);
  const inner = rim.radius * radius;
  const { count, at, size, round, turn } = rim.holes;
  const holes = Array.from({ length: count }, (_, k) => {
    const angle = (2 * Math.PI * (k + turn)) / count;
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    const [w, h] = [size[0] * radius, size[1] * radius];
    const hole = rectangle({ x: at * radius, y: 0, w, h, round }, HOLE_SEGMENTS);
    const turned = hole.map(
      ([a, b]) => /** @type {Point} */ ([a * cos - b * sin, a * sin + b * cos]),
    );
    return face(turned, on(RIM_DEPTH - OFFSET), facing);
  });
  return [
    tube(radius, width, [x, y, z]), // the tread
    face(ring(radius), on(width), facing.clone().negate()), // the inner side
    // the sidewall: quads between the rings (earcut would cut thin slivers, their lines spikes)
    surface(ladderRing(ring(radius), ring(inner)), on(0), facing),
    tube(inner, RIM_DEPTH, [outside - (side * RIM_DEPTH) / 2, y, z], true), // the rim's lip
    face(ring(inner), on(RIM_DEPTH), facing), // the rim
    ...holes,
    cylinder(rim.hub * radius, HUBCAP, [outside - side * (RIM_DEPTH - HUBCAP / 2), y, z]),
  ];
}

/**
 * Triangles between two closed rings of as many points, point i of one facing point i of the
 * other: two a quad.
 *
 * @param {Point[]} outer
 * @param {Point[]} inner
 * @returns {Point[][]}
 */
function ladderRing(outer, inner) {
  return outer.flatMap((p, i) => {
    const j = (i + 1) % outer.length;
    return [
      [p, outer[j], inner[j]],
      [p, inner[j], inner[i]],
    ];
  });
}

/**
 * A bumper: a bar `depth` thick (BUMPER_DEPTH unless it says) and `height` tall around y, its
 * outer edge along `plan` (mirrored to the other side) from z = end into the car.
 * The bar's top and bottom are one polygon each, the faces around it one per run between creases.
 *
 * @param {Bumper} bumper
 * @param {number} end z of the bumper's outermost point
 * @param {number} back 1 or -1: the direction into the car
 * @returns {Part}
 */
function bumper({ y, height, plan, depth: thick = BUMPER_DEPTH }, end, back) {
  /** @type {Point[]} [across, back], from one end round to the other, a point every STATION */
  const outer = densifyLine(
    [
      ...plan
        .slice(1)
        .map(([w, b]) => /** @type {Point} */ ([-w, b]))
        .reverse(),
      ...plan,
    ],
    STATION,
  );
  // the inner edge: `thick` along the normal of each point's neighbours' chord
  const inner = outer.map(([w, b], i) => {
    const [p, q] = [outer[Math.max(i - 1, 0)], outer[Math.min(i + 1, outer.length - 1)]];
    const [dw, db] = [q[0] - p[0], q[1] - p[1]];
    const length = Math.hypot(dw, db);
    return /** @type {Point} */ ([w - (db / length) * thick, b + (dw / length) * thick]);
  });
  const outline = [...outer, ...inner.reverse()].map(
    ([w, b]) => /** @type {Point} */ ([end + back * b, w]),
  );
  const bar = prism(outline, () => height / 2);
  // prism: (±height / 2, across, z) -> (across, ∓height / 2, z)
  bar.geometry.rotateZ(-Math.PI / 2).translate(0, y, 0);
  return bar;
}

/**
 * A tyre or hubcap along x: its sides are one polygon each, its tread one more (no lines across).
 *
 * @param {number} radius
 * @param {number} width
 * @param {number[]} centre
 * @returns {Part}
 */
function cylinder(radius, width, [x, y, z]) {
  const shape = new THREE.CylinderGeometry(radius, radius, width, WHEEL_SEGMENTS)
    .rotateZ(Math.PI / 2)
    .translate(x, y, z);
  // CylinderGeometry: the tread (2 triangles a segment), then the two caps (1 a segment)
  const tread = 2 * WHEEL_SEGMENTS;
  return builtIn(shape, (t) => (t < tread ? 0 : t < tread + WHEEL_SEGMENTS ? 1 : 2));
}

/**
 * An open tube along x (a tread, a rim's lip): one polygon, its two rims drawn.
 *
 * @param {number} radius
 * @param {number} length
 * @param {number[]} centre
 * @param {boolean} [inward] facing the axle: the inside of a cup (the rim set into the tyre)
 * @returns {Part}
 */
function tube(radius, length, [x, y, z], inward = false) {
  const shape = new THREE.CylinderGeometry(radius, radius, length, WHEEL_SEGMENTS, 1, true);
  if (inward) {
    const index = /** @type {THREE.BufferAttribute} */ (shape.getIndex());
    for (let i = 0; i < index.count; i += 3) {
      const second = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2)).setX(i + 2, second);
    }
    const normal = shape.getAttribute("normal");
    for (let i = 0; i < normal.count; i++) {
      normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
    }
  }
  return builtIn(shape.rotateZ(Math.PI / 2).translate(x, y, z), () => 0);
}

/**
 * How high across (s: -1 left edge, 0 middle, 1 right edge) a crowned surface stands, as a share
 * of its crown: four flat facets (FACET, INNER).
 *
 * @param {number} s
 */
function facets(s) {
  const u = Math.abs(s);
  return u <= FACET ? 1 - ((1 - INNER) * u) / FACET : (INNER * (1 - u)) / (1 - FACET);
}
