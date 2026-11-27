import * as THREE from "three";
import { densifyLine, ellipse, HOLE_SEGMENTS, rectangle, rounded, STATION } from "./outline.js";
import { builtIn, byFaces, face, OFFSET, prism, surface } from "./polygons.js";

/**
 * The parts both kinds of car of the traffic have (scene/sedan.js, scene/van.js): the wheels, the
 * bumpers and the outside mirrors, nodes of their own on the car (scene/traffic.js), in metres
 * from the car's rear end (z = 0) forward, its front towards +z; and centred(), which moves a
 * car's geometry so built to have its origin in the middle of its length.
 *
 * @typedef {import("./trafficModels.js").TrafficModel} TrafficModel
 * @typedef {import("./trafficModels.js").Bumper} Bumper
 * @typedef {import("./trafficModels.js").Mirror} Mirror
 * @typedef {import("./outline.js").Point} Point
 * @typedef {import("./polygons.js").Part} Part
 */

const WHEEL_SEGMENTS = 12;
/** How far a rim sits in its tyre, and a hubcap stands out of the rim, metres. */
const [RIM_DEPTH, HUBCAP] = [0.04, 0.03];
/** Bumper thickness, metres. */
const BUMPER_DEPTH = 0.06;

/**
 * A car's geometry, built from its rear bumper (z = 0) forward, moved to have its origin in the
 * middle of its length.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {{ length: number }} model
 */
export const centred = (geometry, { length }) => geometry.translate(0, 0, -length / 2);

/**
 * An outside mirror (Mirror, scene/trafficModels.js) on one side of the car: a head (an outline
 * with its corners cut, drawn across and deep along the car), its glass outlined on its back
 * (looking back: -z, the car's front is +z), and the arms from the body, boxes.
 *
 * @param {Mirror} mirror
 * @param {number} side 1 the car's left, -1 its right
 */
export function mirrorParts({ head, depth, corners, centre, arms, arm }, side) {
  const [x, y, w] = centre;
  const [across, up] = head;
  /** @type {Part[]} */
  const parts = [];
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
  return parts;
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
export function wheelParts({ radius, width, rim }, [x, y, z], side) {
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
export function bumper({ y, height, plan, depth: thick = BUMPER_DEPTH }, end, back) {
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
 * A hubcap along x: its sides are one polygon each, its tread one more (no lines across).
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
