import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { TRAFFIC, WIRE } from "../config.js";
import { mountWheel } from "./rig.js";
import { TRAFFIC_MODELS } from "./trafficModels.js";
import { dress } from "./wire.js";

/**
 * @typedef {import("./trafficModels.js").TrafficModel} TrafficModel
 * @typedef {import("./trafficModels.js").Bumper} Bumper
 * @typedef {import("./trafficModels.js").Point} Point
 * @typedef {{ geometry: THREE.BufferGeometry, polygon: number[] }} Part non-indexed geometry
 *   (position, normal) and the polygon of each triangle, numbered within the part
 */

/** Segments of each wheel arch (half an ellipse). */
const ARCH_SEGMENTS = 6;
/** The waist line keeps this far above a wheel arch, metres. */
const ARCH_LIP = 0.03;
const WHEEL_SEGMENTS = 12;
/** Segments of a rounded corner (a window's, a screen's). */
const CORNER_STEPS = 4;
/** How far a rim sits in its tyre, and a hubcap stands out of the rim, metres. */
const [RIM_DEPTH, HUBCAP] = [0.04, 0.03];
const LAMP_SEGMENTS = 12;
/** Bumper thickness, metres. */
const BUMPER_DEPTH = 0.06;
/** Windows, lamps and marks sit this far off the body, so they draw their own outline. */
const OFFSET = 0.005;
/** Window frame width around the windscreen and the rear window, metres. */
const FRAME = 0.07;
/** How far the glass sits in behind the pillars and frames, metres. */
const RECESS = 0.02;
/**
 * Across the deck, the roof and the screens, as on the Bolones: four flat facets, two each side,
 * the line between them FACET of the half width out and INNER of the crown high (facets()).
 */
const [FACET, INNER] = [0.55, 0.85];
/** How much higher the middle of the roof is than its edges, metres, unless the model says. */
const CROWN = 0.035;
/** Across the roof and the screens (-1 left edge, 1 right): the facets' corners, and halfway. */
const ACROSS = [-1, -(1 + FACET) / 2, -FACET, -FACET / 2, 0, FACET / 2, FACET, (1 + FACET) / 2, 1];
/** The drip rail along each side of the roof, this far under its edge, metres. */
const RAIL = [0.012, 0.03];
/** Stations along the body and the cabin at least this close, metres (a crash bends them). */
const STATION = 0.15;
/** A screen that neither curves nor rounds its corners (TrafficModel `cabin.screens`). */
const FLAT_SCREEN = { bow: [0, 0], corners: [0, 0] };

/** Half the widest car, in scene units: the minigame keeps lanes this far from the centre. */
export function trafficHalfWidth() {
  const widest = Math.max(...Object.values(TRAFFIC_MODELS).map((model) => model.width));
  return (widest * TRAFFIC.scale) / 2;
}

/**
 * Low-poly oncoming cars of the communist era (Polakito, Kredens), traced from blueprints,
 * one template per TRAFFIC_MODELS entry; the front faces +z (towards the camera). The body is one
 * geometry (one draw call plus its wireframe twin), with `userData.polygons` like the FBX models
 * (core/fbx.js), so its lines follow the designed outlines, not every triangle. Each wheel and
 * bumper is a node of its own (`userData.part`; a wheel `rigid`), so a crash can move a wheel
 * whole and tear either off; each headlamp is a mesh of its own ("lamp"), so a crash can put out
 * just the ones it crushes.
 *
 * The local hitbox (the car's bounds) is in `userData.hitbox` as { min, max } arrays: clone()
 * copies userData through JSON, which would turn a Box3 into a plain object. The car's mass is
 * in `userData.mass`.
 *
 * @param {import("./materials.js").Materials} materials
 * @returns {THREE.Group[]}
 */
export function createTrafficModels(materials) {
  return Object.values(TRAFFIC_MODELS).map((model) => {
    const { body, loose } = carGeometry(model);
    const scale = TRAFFIC.scale;
    const car = new THREE.Group().add(new THREE.Mesh(body.scale(scale, scale, scale)));
    for (const { geometry, at, part } of loose) {
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
    for (const lamp of lampGeometries(model)) {
      const mesh = new THREE.Mesh(lamp.scale(TRAFFIC.scale, TRAFFIC.scale, TRAFFIC.scale));
      mesh.name = "lamp";
      car.add(mesh);
    }
    dress(car, materials.solid.traffic, materials.wire.traffic);
    for (const lamp of car.getObjectsByProperty("name", "lamp")) {
      // lit, its outline waiting for a crash to put it out (game/minigame.js)
      /** @type {THREE.Mesh} */ (lamp).material = materials.headlight;
      lamp.children[0].visible = false;
    }

    car.updateMatrixWorld(true);
    const { min, max } = new THREE.Box3().setFromObject(car);
    car.userData.hitbox = { min: min.toArray(), max: max.toArray() };
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
 * Body, cabin, windows and marks of a car, and its bumpers and wheels, in metres, its origin on
 * the ground in the middle of its length.
 *
 * @param {TrafficModel} model
 * @returns {{ body: THREE.BufferGeometry, loose: Loose[] }}
 */
function carGeometry(model) {
  const { cabin, wheel } = model;
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
          face(bar, at, new THREE.Vector3(side, 0, 0)),
        ),
      );
    }
  }

  const [rear, front] = ends(model);
  for (const { marks, z, facing } of [
    { marks: model.frontMarks, z: front + OFFSET, facing: 1 },
    { marks: model.rearMarks, z: rear - OFFSET, facing: -1 },
  ]) {
    const at = (/** @type {Point} */ [w, y]) => new THREE.Vector3(w, y, z);
    for (const mark of mirrored(marks)) {
      for (const bar of bars(rectangle(mark), mark.bars ?? 1)) {
        parts.push(face(bar, at, new THREE.Vector3(0, 0, facing)));
      }
    }
  }

  /** A part round its middle, and where that is. @param {Part[]} of @param {Loose["part"]} part */
  const loose = (of, part) => {
    const geometry = centred(withPolygons(of), model);
    geometry.computeBoundingBox();
    const at = /** @type {THREE.Box3} */ (geometry.boundingBox).getCenter(new THREE.Vector3());
    geometry.translate(-at.x, -at.y, -at.z);
    return { geometry, at, part };
  };
  return {
    body: centred(leanNose(withPolygons(parts), model), model),
    loose: [
      loose([bumper(model.bumpers.front, model.length, -1)], "bumper"),
      loose([bumper(model.bumpers.rear, 0, 1)], "bumper"),
      ...wheel.axles.flatMap((axle, i) =>
        [-1, 1].map((side) =>
          loose(
            wheelParts(wheel, [(side * wheel.track[i]) / 2, wheel.radius, axle], side),
            "wheel",
          ),
        ),
      ),
    ],
  };
}

/**
 * Leans the front of a car forward above `body.nose.from`, the higher the more (its top edge
 * `lean` ahead), fading out over a STATION behind the front end; the faces that move get their
 * normals again.
 *
 * @param {THREE.BufferGeometry} geometry non-indexed, built from the rear (z = 0) forward
 * @param {TrafficModel} model
 */
function leanNose(geometry, model) {
  const { nose, top: deck } = model.body;
  if (!nose) return geometry;
  const { lean, from } = nose;
  const front = ends(model)[1];
  const top = sample(deck, front);
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const corners = [0, 1, 2].map(() => new THREE.Vector3());
  for (let i = 0; i < position.count; i += 3) {
    let moved = false;
    for (let k = 0; k < 3; k++) {
      const [y, z] = [position.getY(i + k), position.getZ(i + k)];
      const high = THREE.MathUtils.clamp((y - from) / (top - from), 0, 1);
      const near = THREE.MathUtils.clamp((z - front + STATION) / STATION, 0, 1);
      position.setZ(i + k, z + lean * high * near);
      moved ||= high * near > 0;
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
 * @param {TrafficModel} model
 */
const centred = (geometry, { length }) => geometry.translate(0, 0, -length / 2);

/** The body's rear and front ends (without the bumpers). @param {TrafficModel} model */
const ends = ({ body }) => [body.top[0][0], body.top[body.top.length - 1][0]];

/**
 * y of a polyline sorted by x, at x (clamped at its ends).
 *
 * @param {Point[]} curve
 * @param {number} x
 */
function sample(curve, x) {
  if (x <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [[ax, ay], [bx, by]] = [curve[i - 1], curve[i]];
    if (x <= bx) return ay + ((by - ay) * (x - ax)) / (bx - ax);
  }
  return curve[curve.length - 1][1];
}

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
const BANDS = [0, 0, 1, 1, 2, 2, 3, 3, 3, 3];

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
  const xs = [...curves.flatMap((curve) => curve.map(([x]) => x)), ...body.seams];
  for (let x = start; x < end; x += STATION) xs.push(x);
  wheel.axles.forEach((axle, i) => {
    const [r] = wheel.arches[i];
    for (let k = 0; k <= ARCH_SEGMENTS; k++)
      xs.push(axle + r * Math.cos((Math.PI * k) / ARCH_SEGMENTS));
    xs.push(axle - r - 0.002, axle + r + 0.002); // the arch's feet drop straight to the sill
  });
  const stations = [...new Set(xs.map((x) => Math.round(x * 1e4) / 1e4))]
    .filter((x) => x >= start && x <= end)
    .sort((a, b) => a - b);

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
   * The half section with a point halfway along each band, for a crash to bend, the deck in two
   * facets (facets()), each halved too; BANDS says which band each stretch is.
   */
  const section = (/** @type {number} */ x) => {
    const [sill, arch, waist, shoulder, top] = corners(x);
    const between = (/** @type {Point} */ p, /** @type {Point} */ q) =>
      /** @type {Point} */ ([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
    /** @type {Point} */
    const inner = [FACET * shoulder[0], shoulder[1] + (top[1] - shoulder[1]) * INNER];
    return [
      ...[sill, arch, waist, shoulder, inner].flatMap((p, i, all) =>
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
  /** Triangle facing away from `inside`. @param {THREE.Vector3[]} t @param {THREE.Vector3} inside */
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
 * A closed solid over a side profile: the profile's x runs along the car (+z), its y up; the
 * left and right sides sit at x = ∓halfWidth(y), joined by a strip around the outline. Each side
 * is one polygon; the strip is one polygon per run of outline between creases (a turn of
 * WIRE.edgeAngle or more), so lines draw the outline and its sharp corners only. Faces point
 * outwards.
 *
 * @param {Point[]} profile simple polygon, any winding
 * @param {(y: number) => number} halfWidth
 * @returns {Part}
 */
export function prism(profile, halfWidth) {
  const outline = counterClockwise(profile);
  const at =
    (/** @type {number} */ side) =>
    (/** @type {Point} */ [x, y]) =>
      new THREE.Vector3(side * halfWidth(y), y, x);
  const parts = [
    face(outline, at(-1), new THREE.Vector3(-1, 0, 0)),
    face(outline, at(1), new THREE.Vector3(1, 0, 0)),
  ];

  // The strip, counter-clockwise: quad i joins point i to the next, one polygon per run.
  const n = outline.length;
  /** @type {number[]} */
  const positions = [];
  /** @type {number[]} */
  const polygon = [];
  for (const { i, run } of creaseRuns(outline)) {
    const [a, b] = [at(-1)(outline[i]), at(-1)(outline[(i + 1) % n])];
    const [a1, b1] = [at(1)(outline[i]), at(1)(outline[(i + 1) % n])];
    positions.push(...a.toArray(), ...b1.toArray(), ...b.toArray());
    positions.push(...a.toArray(), ...a1.toArray(), ...b1.toArray());
    polygon.push(run, run);
  }
  parts.push({ geometry: flatGeometry(positions), polygon });
  return mergeParts(parts);
}

/**
 * The polygon going counter-clockwise: itself, or reversed.
 *
 * @param {Point[]} polygon
 * @returns {Point[]}
 */
function counterClockwise(polygon) {
  const clockwise = THREE.ShapeUtils.isClockWise(polygon.map(([x, y]) => new THREE.Vector2(x, y)));
  return clockwise ? [...polygon].reverse() : polygon;
}

/**
 * The sides of a closed outline (side i from point i to the next) in the order to walk them, each
 * with its run: a crease (a turn of WIRE.edgeAngle or more) at a point starts a new run. The walk
 * starts at a crease, so a run never wraps around.
 *
 * @param {Point[]} outline
 * @returns {{ i: number, run: number }[]}
 */
function creaseRuns(outline) {
  const n = outline.length;
  const crease = Math.cos(THREE.MathUtils.degToRad(WIRE.edgeAngle));
  const direction = (/** @type {number} */ i) => {
    const [a, b] = [outline[i % n], outline[(i + 1) % n]];
    return new THREE.Vector2(b[0] - a[0], b[1] - a[1]).normalize();
  };
  const creases = (/** @type {number} */ i) => direction(i + n - 1).dot(direction(i)) < crease;
  const first = Math.max(
    0,
    outline.findIndex((_, i) => creases(i)),
  );
  let run = -1;
  return outline.map((_, s) => {
    const i = (first + s) % n;
    if (s === 0 || creases(i)) run++;
    return { i, run };
  });
}

/**
 * A flat polygon from a 2D outline (and the holes in it) mapped into 3D, its triangles facing
 * `facing`.
 *
 * @param {Point[]} outline
 * @param {(point: Point) => THREE.Vector3} at
 * @param {THREE.Vector3} facing
 * @param {Point[][]} [holes]
 * @returns {Part}
 */
function face(outline, at, facing, holes = []) {
  const vectors = (/** @type {Point[]} */ points) =>
    points.map(([x, y]) => new THREE.Vector2(x, y));
  const points = [outline, ...holes].flat();
  // earcut drops the outline's points that lie in line; nudged in a hair, they stay corners and
  // the neighbours sharing them stay joined
  const turn = THREE.ShapeUtils.isClockWise(vectors(outline)) ? -1 : 1;
  const contour = outline.map(([x, y], i) => {
    const [p, q] = [
      outline[(i + outline.length - 1) % outline.length],
      outline[(i + 1) % outline.length],
    ];
    const cross = (x - p[0]) * (q[1] - y) - (y - p[1]) * (q[0] - x);
    if (Math.abs(cross) > 1e-12) return new THREE.Vector2(x, y);
    const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
    const nudge = (turn * 1e-6) / Math.hypot(dx, dy);
    return new THREE.Vector2(x - dy * nudge, y + dx * nudge);
  });
  /** @type {number[]} */
  const positions = [];
  for (const triangle of THREE.ShapeUtils.triangulateShape(contour, holes.map(vectors))) {
    const corners = triangle.map((i) => at(points[i]));
    positions.push(...facingPositions(corners, facing));
  }
  return { geometry: flatGeometry(positions), polygon: new Array(positions.length / 9).fill(0) };
}

/**
 * A convex outline cut into `count` horizontal bars (one bar: the outline itself).
 *
 * @param {Point[]} outline
 * @param {number} count
 * @returns {Point[][]}
 */
function bars(outline, count) {
  if (count === 1) return [outline];
  const ys = outline.map(([, y]) => y);
  const [bottom, top] = [Math.min(...ys), Math.max(...ys)];
  /** The outline's left and right x at height y. @param {number} y */
  const across = (y) => {
    const xs = outline.flatMap(([ax, ay], i) => {
      const [bx, by] = outline[(i + 1) % outline.length];
      if (y < Math.min(ay, by) || y > Math.max(ay, by) || ay === by) return ay === y ? [ax] : [];
      return [ax + ((bx - ax) * (y - ay)) / (by - ay)];
    });
    return [Math.min(...xs), Math.max(...xs)];
  };
  return Array.from({ length: count }, (_, b) => {
    const [y0, y1] = [b, b + 1].map((k) => THREE.MathUtils.lerp(bottom, top, k / count));
    const [[l0, r0], [l1, r1]] = [across(y0), across(y1)];
    return /** @type {Point[]} */ ([
      [l0, y0],
      [r0, y0],
      [r1, y1],
      [l1, y1],
    ]);
  });
}

/**
 * Marks with an offset x are mirrored to the other side.
 *
 * @template {{ x: number }} T
 * @param {T[]} marks
 * @returns {T[]}
 */
const mirrored = (marks) =>
  marks.flatMap((mark) => (mark.x ? [mark, { ...mark, x: -mark.x }] : [mark]));

/**
 * A front view outline: a rectangle with its corners cut by `round` (0..0.5 of the smaller side),
 * or an ellipse with `round` 0.5.
 *
 * @param {{ x: number, y: number, w: number, h: number, round?: number }} mark
 * @returns {Point[]}
 */
function rectangle({ x, y, w, h, round = 0 }) {
  if (round >= 0.5) return ellipse(x, y, w / 2, h / 2, LAMP_SEGMENTS);
  const [hw, hh, c] = [w / 2, h / 2, round * Math.min(w, h)];
  return /** @type {Point[]} */ ([
    [x - hw + c, y - hh],
    [x + hw - c, y - hh],
    [x + hw, y - hh + c],
    [x + hw, y + hh - c],
    [x + hw - c, y + hh],
    [x - hw + c, y + hh],
    [x - hw, y + hh - c],
    [x - hw, y - hh + c],
  ]).filter((p, i, all) => {
    const [px, py] = all[(i + all.length - 1) % all.length]; // uncut corners repeat points
    return p[0] !== px || p[1] !== py;
  });
}

/**
 * Points round an ellipse, counter-clockwise from its right end.
 *
 * @param {number} x centre
 * @param {number} y
 * @param {number} rx half width
 * @param {number} ry half height
 * @param {number} segments
 * @returns {Point[]}
 */
function ellipse(x, y, rx, ry, segments) {
  return Array.from({ length: segments }, (_, k) => {
    const angle = (2 * Math.PI * k) / segments;
    return [x + rx * Math.cos(angle), y + ry * Math.sin(angle)];
  });
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
  /**
   * A recessed glass in an opening: the glass (its triangles) and the opening's sides (round
   * its rim).
   */
  const glass = (
    /** @type {Point[]} */ rim,
    /** @type {Point[][]} */ triangles,
    /** @type {(p: Point) => THREE.Vector3} */ at,
    /** @type {THREE.Vector3} */ out,
  ) => {
    const inner = (/** @type {Point} */ p) => at(p).addScaledVector(out, -RECESS);
    parts.push(surface(triangles, inner, out));
    const centre = rim.reduce((sum, p) => sum.add(inner(p)), new THREE.Vector3());
    centre.divideScalar(rim.length);
    const sides = rim.flatMap((p, i) => {
      const q = rim[(i + 1) % rim.length];
      const facing = centre.clone().sub(at(p).add(at(q)).multiplyScalar(0.5)); // into the opening
      return [
        triangleFacing([at(p), at(q), inner(q)], facing),
        triangleFacing([at(p), inner(q), inner(p)], facing),
      ];
    });
    parts.push(
      joined(
        sides,
        sides.map(() => 0),
      ),
    );
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
    // the opening, FRAME in from the strip's ends and sides, its corners rounded (in metres
    // across and along: X, T), and the frame zipped round it
    const ts = screen.line.map(([x, y]) => ((x - a[0]) * dx + (y - a[1]) * dy) / length ** 2);
    const [t0, t1] = [Math.min(...ts) + FRAME / length, Math.max(...ts) - FRAME / length];
    const half = (/** @type {number} */ t) => halfWidth(a[1] + dy * t);
    const [r0, r1] = dy > 0 ? screen.corners : [...screen.corners].reverse(); // bottom, top
    /** @type {Point[]} */
    const corners = [
      [-(half(t0) - FRAME), t0 * length],
      [half(t0) - FRAME, t0 * length],
      [half(t1) - FRAME, t1 * length],
      [-(half(t1) - FRAME), t1 * length],
    ];
    const rim = densify(rounded(corners, [r0, r0, r1, r1]), STATION).map(
      ([X, T]) => /** @type {Point} */ ([X / half(T / length), T / length]),
    );
    const centre = /** @type {Point} */ ([0, (t0 + t1) / 2]);
    const angle = (/** @type {Point} */ [u, t]) =>
      Math.atan2((t - centre[1]) * length, u * half(t));
    const outer = [...row(ACROSS, 0), ...row([...ACROSS].reverse(), 1)];
    strip.push(surface(zip(outer, rim, angle), at, out));
    runs.push(run);
    glass(
      rim,
      rim.map((p, j) => [centre, p, rim[(j + 1) % rim.length]]),
      at,
      out,
    );
  }
  parts.push(joined(strip, runs));

  // the sides, their windows set in, with points inside for a crash to bend
  const panes = windows.map((window) => rounded(window, cabin.windowCorners ?? 0));
  /** @type {Point[][]} */
  const steiner = [];
  const [xs, ys] = [outline.map(([x]) => x), outline.map(([, y]) => y)];
  for (let x = Math.min(...xs) + STATION / 2; x < Math.max(...xs); x += STATION) {
    for (let y = Math.min(...ys) + STATION / 2; y < Math.max(...ys); y += STATION) {
      const p = /** @type {Point} */ ([x, y]);
      const clear = [outline, ...panes].every((polygon) => distanceTo(polygon, p) > 0.03);
      if (contains(outline, p) && !panes.some((pane) => contains(pane, p)) && clear) {
        steiner.push([p]);
      }
    }
  }
  const roofLine = outline.filter(([, y]) => y >= roof - 1e-6);
  for (const side of [-1, 1]) {
    const out = new THREE.Vector3(side, 0, 0);
    const at = (/** @type {Point} */ [x, y]) => new THREE.Vector3(side * halfWidth(y), y, x);
    parts.push(face(outline, at, out, [...panes, ...steiner]));
    for (const pane of panes) {
      const contour = pane.map(([x, y]) => new THREE.Vector2(x, y));
      const triangles = THREE.ShapeUtils.triangulateShape(contour, []);
      glass(
        pane,
        triangles.map((t) => t.map((i) => pane[i])),
        at,
        out,
      );
    }
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
 * The headlamps, one geometry each, with `userData.polygons` (its outline): lines once it is out.
 *
 * @param {TrafficModel} model
 */
function lampGeometries(model) {
  const front = ends(model)[1];
  const at = (/** @type {Point} */ [w, y]) => new THREE.Vector3(w, y, front + 2 * OFFSET);
  return mirrored(model.lamps).map((lamp) =>
    centred(
      leanNose(withPolygons([face(rectangle(lamp), at, new THREE.Vector3(0, 0, 1))]), model),
      model,
    ),
  );
}

/**
 * A wheel: the tyre (its tread, the sidewall round the rim), the rim set RIM_DEPTH into it with
 * its holes, the hubcap. Lines draw the rings, the holes and the hubcap.
 *
 * @param {TrafficModel["wheel"]} wheel
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
    const hole = rectangle({ x: at * radius, y: 0, w, h, round });
    const turned = hole.map(
      ([a, b]) => /** @type {Point} */ ([a * cos - b * sin, a * sin + b * cos]),
    );
    return face(turned, on(RIM_DEPTH - OFFSET), facing);
  });
  return [
    tube(radius, width, [x, y, z]), // the tread
    face(ring(radius), on(width), facing.clone().negate()), // the inner side
    face(ring(radius), on(0), facing, [ring(inner)]), // the sidewall
    tube(inner, RIM_DEPTH, [outside - (side * RIM_DEPTH) / 2, y, z]), // the rim's lip
    face(ring(inner), on(RIM_DEPTH), facing), // the rim
    ...holes,
    cylinder(rim.hub * radius, HUBCAP, [outside - side * (RIM_DEPTH - HUBCAP / 2), y, z]),
  ];
}

/**
 * A bumper: a bar BUMPER_DEPTH thick and `height` tall around y, its outer edge along `plan`
 * (mirrored to the other side) from z = end into the car, and its guards. The bar's top and
 * bottom are one polygon each, the faces around it one per run between creases.
 *
 * @param {Bumper} bumper
 * @param {number} end z of the bumper's outermost point
 * @param {number} back 1 or -1: the direction into the car
 * @returns {Part}
 */
function bumper({ y, height, plan, guards }, end, back) {
  /** @type {Point[]} [across, back], from one end round to the other */
  const outer = [
    ...plan
      .slice(1)
      .map(([w, b]) => /** @type {Point} */ ([-w, b]))
      .reverse(),
    ...plan,
  ];
  // the inner edge: BUMPER_DEPTH along the normal of each point's neighbours' chord
  const inner = outer.map(([w, b], i) => {
    const [p, q] = [outer[Math.max(i - 1, 0)], outer[Math.min(i + 1, outer.length - 1)]];
    const [dw, db] = [q[0] - p[0], q[1] - p[1]];
    const length = Math.hypot(dw, db);
    return /** @type {Point} */ ([
      w - (db / length) * BUMPER_DEPTH,
      b + (dw / length) * BUMPER_DEPTH,
    ]);
  });
  const outline = [...outer, ...inner.reverse()].map(
    ([w, b]) => /** @type {Point} */ ([end + back * b, w]),
  );
  const bar = prism(outline, () => height / 2);
  // prism: (±height / 2, across, z) -> (across, ∓height / 2, z)
  bar.geometry.rotateZ(-Math.PI / 2).translate(0, y, 0);
  const parts = [bar];
  if (guards) {
    const depth = sample(plan, guards.x) + BUMPER_DEPTH; // from the car's end back through the bar
    for (const side of [-1, 1]) {
      const box = new THREE.BoxGeometry(guards.width, guards.y[1] - guards.y[0], depth);
      box.translate(side * guards.x, (guards.y[0] + guards.y[1]) / 2, end + (back * depth) / 2);
      parts.push(builtIn(box, (t) => Math.floor(t / 2))); // two triangles a face
    }
  }
  return mergeParts(parts);
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
 * @returns {Part}
 */
function tube(radius, length, [x, y, z]) {
  const shape = new THREE.CylinderGeometry(radius, radius, length, WHEEL_SEGMENTS, 1, true);
  return builtIn(shape.rotateZ(Math.PI / 2).translate(x, y, z), () => 0);
}

/**
 * @param {THREE.BufferGeometry} geometry a built-in shape
 * @param {(triangle: number) => number} polygonOf
 * @returns {Part}
 */
function builtIn(geometry, polygonOf) {
  const flat = plain(geometry);
  const count = flat.getAttribute("position").count / 3;
  return { geometry: flat, polygon: Array.from({ length: count }, (_, t) => polygonOf(t)) };
}

/**
 * Parts as one, their polygons by `ids` (parts with the same id are one polygon).
 *
 * @param {Part[]} parts
 * @param {number[]} ids
 * @returns {Part}
 */
function joined(parts, ids) {
  const geometry = /** @type {THREE.BufferGeometry} */ (
    mergeGeometries(parts.map((part) => part.geometry))
  );
  return { geometry, polygon: parts.flatMap((part, k) => part.polygon.map(() => ids[k])) };
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

/**
 * A polygon with its corners rounded off (a quadratic curve through each, CORNER_STEPS long),
 * by `radius` each or all; a corner never takes more than 45 % of its sides.
 *
 * @param {Point[]} polygon
 * @param {number | number[]} radius
 * @returns {Point[]}
 */
function rounded(polygon, radius) {
  return polygon.flatMap((v, i) => {
    const r = typeof radius === "number" ? radius : radius[i];
    const [p, q] = [
      polygon[(i + polygon.length - 1) % polygon.length],
      polygon[(i + 1) % polygon.length],
    ];
    const [lp, lq] = [Math.hypot(p[0] - v[0], p[1] - v[1]), Math.hypot(q[0] - v[0], q[1] - v[1])];
    const cos = ((p[0] - v[0]) * (q[0] - v[0]) + (p[1] - v[1]) * (q[1] - v[1])) / (lp * lq);
    const cut = Math.min(
      r / Math.tan(Math.acos(THREE.MathUtils.clamp(cos, -1, 1)) / 2),
      0.45 * lp,
      0.45 * lq,
    );
    if (!(cut > 1e-4)) return [v];
    const [a, b] = [
      [v[0] + ((p[0] - v[0]) * cut) / lp, v[1] + ((p[1] - v[1]) * cut) / lp],
      [v[0] + ((q[0] - v[0]) * cut) / lq, v[1] + ((q[1] - v[1]) * cut) / lq],
    ];
    return Array.from({ length: CORNER_STEPS + 1 }, (_, k) => {
      const t = k / CORNER_STEPS;
      const [u, w, z] = [(1 - t) ** 2, 2 * (1 - t) * t, t ** 2];
      return /** @type {Point} */ ([
        u * a[0] + w * v[0] + z * b[0],
        u * a[1] + w * v[1] + z * b[1],
      ]);
    });
  });
}

/**
 * A closed polygon with its sides cut at most `step` long.
 *
 * @param {Point[]} polygon
 * @param {number} step
 * @returns {Point[]}
 */
function densify(polygon, step) {
  return polygon.flatMap((p, i) => {
    const q = polygon[(i + 1) % polygon.length];
    const pieces = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / step));
    return Array.from({ length: pieces }, (_, j) => {
      const t = j / pieces;
      return /** @type {Point} */ ([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    });
  });
}

/** @param {Point[]} polygon @param {Point} p */
function contains(polygon, [x, y]) {
  let inside = false;
  polygon.forEach(([ax, ay], i) => {
    const [bx, by] = polygon[(i + 1) % polygon.length];
    if (ay > y !== by > y && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside;
  });
  return inside;
}

/** How far a point is from a polygon's sides. @param {Point[]} polygon @param {Point} p */
function distanceTo(polygon, [x, y]) {
  return Math.min(
    ...polygon.map(([ax, ay], i) => {
      const [bx, by] = polygon[(i + 1) % polygon.length];
      const [dx, dy] = [bx - ax, by - ay];
      const t = THREE.MathUtils.clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0, 1);
      return Math.hypot(ax + dx * t - x, ay + dy * t - y);
    }),
  );
}

/**
 * Triangles between two closed loops, one round the other (the frame round a window): both go
 * the same way round, each point a corner, zipped by the angle `angle` gives them.
 *
 * @param {Point[]} outer
 * @param {Point[]} inner
 * @param {(p: Point) => number} angle
 * @returns {Point[][]}
 */
function zip(outer, inner, angle) {
  /** The loop from its smallest angle, the angles unwrapped, closed. @param {Point[]} loop */
  const unwrap = (loop) => {
    const angles = loop.map(angle);
    const start = angles.indexOf(Math.min(...angles));
    const points = [...loop.slice(start), ...loop.slice(0, start)];
    const turned = points.map(angle);
    for (let k = 1; k < turned.length; k++) {
      while (turned[k] < turned[k - 1]) turned[k] += 2 * Math.PI;
    }
    return { points: [...points, points[0]], angles: [...turned, turned[0] + 2 * Math.PI] };
  };
  const [o, w] = [unwrap(outer), unwrap(inner)];
  /** @type {Point[][]} */
  const triangles = [];
  let [i, j] = [0, 0];
  while (i < o.points.length - 1 || j < w.points.length - 1) {
    const along =
      j === w.points.length - 1 || (i < o.points.length - 1 && o.angles[i + 1] <= w.angles[j + 1]);
    if (along) triangles.push([o.points[i], o.points[++i], w.points[j]]);
    else triangles.push([o.points[i], w.points[j + 1], w.points[j++]]);
  }
  return triangles;
}

/**
 * Triangles between two rows of points, each from left to right (along the first coordinate):
 * every point is a corner, so what the rows share with their neighbours stays joined (earcut
 * would drop the points in line, THREE.ShapeUtils.triangulateShape).
 *
 * @param {Point[]} bottom
 * @param {Point[]} top
 * @returns {Point[][]}
 */
function ladder(bottom, top) {
  /** @type {Point[][]} */
  const triangles = [];
  let [i, j] = [0, 0];
  while (i < bottom.length - 1 || j < top.length - 1) {
    const up = i === bottom.length - 1 || (j < top.length - 1 && top[j + 1][0] < bottom[i + 1][0]);
    if (up) triangles.push([bottom[i], top[j + 1], top[j++]]);
    else triangles.push([bottom[i], bottom[++i], top[j]]);
  }
  return triangles;
}

/**
 * Triangles (2D) mapped into 3D, facing `facing`: one polygon.
 *
 * @param {Point[][]} triangles
 * @param {(point: Point) => THREE.Vector3} at
 * @param {THREE.Vector3} facing
 * @returns {Part}
 */
function surface(triangles, at, facing) {
  const parts = triangles.map((triangle) => triangleFacing(triangle.map(at), facing));
  return joined(
    parts,
    parts.map(() => 0),
  );
}

/**
 * A triangle turned to face `facing`.
 *
 * @param {THREE.Vector3[]} corners
 * @param {THREE.Vector3} facing
 * @returns {Part}
 */
function triangleFacing(corners, facing) {
  return { geometry: flatGeometry(facingPositions(corners, facing)), polygon: [0] };
}

/**
 * A triangle's positions (x, y, z of each corner), wound to face `facing`.
 *
 * @param {THREE.Vector3[]} corners
 * @param {THREE.Vector3} facing
 * @returns {number[]}
 */
function facingPositions([a, b, c], facing) {
  const normal = new THREE.Vector3().subVectors(b, a).cross(c.clone().sub(a));
  const [p, q] = normal.dot(facing) >= 0 ? [b, c] : [c, b];
  return [...a.toArray(), ...p.toArray(), ...q.toArray()];
}

/**
 * One geometry of parts, with `userData.polygons` (as core/fbx.js), so its lines follow them.
 *
 * @param {Part[]} parts
 */
export function withPolygons(parts) {
  const { geometry, polygon } = mergeParts(parts);
  geometry.userData.polygons = {
    inner: innerEdges(geometry, polygon),
    polygon: Uint32Array.from(polygon),
  };
  return geometry;
}

/**
 * One part of many; each part's polygons keep numbers of their own.
 *
 * @param {Part[]} parts
 * @returns {Part}
 */
function mergeParts(parts) {
  const geometry = /** @type {THREE.BufferGeometry} */ (
    mergeGeometries(parts.map((part) => part.geometry))
  );
  /** @type {number[]} */
  const polygon = [];
  for (const part of parts) {
    const offset = polygon.length ? Math.max(...polygon) + 1 : 0;
    polygon.push(...part.polygon.map((id) => id + offset));
  }
  return { geometry, polygon };
}

/**
 * Per triangle, the edges it shares with a triangle of its own polygon (bit k: the edge opposite
 * vertex k, as core/fbx.js): lines are drawn along the others.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {number[]} polygon
 */
function innerEdges(geometry, polygon) {
  const position = geometry.getAttribute("position");
  const point = (/** @type {number} */ i) =>
    [position.getX(i), position.getY(i), position.getZ(i)].map((v) => Math.round(v * 1e5)).join();
  const edgeKey = (/** @type {number} */ t, /** @type {number} */ k) => {
    const [a, b] = [point(3 * t + ((k + 1) % 3)), point(3 * t + ((k + 2) % 3))];
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  };
  /** @type {Map<string, number[]>} */
  const owners = new Map();
  for (let t = 0; t < polygon.length; t++) {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(t, k);
      let triangles = owners.get(key);
      if (!triangles) owners.set(key, (triangles = []));
      triangles.push(t);
    }
  }
  return Uint8Array.from(polygon, (id, t) => {
    let mask = 0;
    for (let k = 0; k < 3; k++) {
      const shared = /** @type {number[]} */ (owners.get(edgeKey(t, k)));
      if (shared.some((u) => u !== t && polygon[u] === id)) mask |= 1 << k;
    }
    return mask;
  });
}

/** @param {number[]} positions non-indexed triangles */
function flatGeometry(positions) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Non-indexed, position + normal only, so built-in shapes merge with the rest.
 *
 * @param {THREE.BufferGeometry} geometry
 */
function plain(geometry) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  flat.deleteAttribute("uv");
  return flat;
}
