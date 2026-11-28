import * as THREE from "three";
import { centred } from "./carParts.js";
import { decalParts } from "./decals.js";
import {
  archLine,
  bars,
  counterClockwise,
  creaseRuns,
  densify,
  densifyLine,
  fillPoints,
  heightOn,
  mirrored,
  offsetArch,
  pieces,
  rectangle,
  rounded,
  sample,
  SPARSE,
  STATION,
} from "./outline.js";
import { ladder, zip } from "./triangulate.js";
import {
  evenNormals,
  face,
  facingPositions,
  fineFace,
  flatGeometry,
  glassTriangles,
  joined,
  mergeParts,
  OFFSET,
  recessed,
  surface,
  triangleFacing,
  withPolygons,
} from "./polygons.js";

/**
 * A car with a cabin on its deck (SedanModel), in metres, its origin on the ground in the middle
 * of its length, its front towards +z: the lower body lofted along the car, the cabin on it, the
 * details and the decals (decals.js); the headlamps apart. Wheels, bumpers, mirrors: carParts.js.
 *
 * @typedef {import("./trafficModels.js").SedanModel} SedanModel
 * @typedef {import("./trafficModels.js").RearWall} RearWall
 * @typedef {import("./outline.js").Point} Point
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
/** A screen that neither curves nor rounds its corners (SedanModel `cabin.screens`). */
const FLAT_SCREEN = { bow: [0, 0], corners: [0, 0] };

/**
 * Its body and its headlamps, one geometry each.
 *
 * @param {SedanModel} model
 * @returns {{ body: THREE.BufferGeometry, lamps: THREE.BufferGeometry[] }}
 */
export function sedanGeometry(model) {
  return { body: bodyGeometry(model), lamps: lampGeometries(model) };
}

/**
 * The body: one geometry with its polygons.
 *
 * @param {SedanModel} model
 * @returns {THREE.BufferGeometry}
 */
function bodyGeometry(model) {
  const { cabin } = model;
  const cabinBottom = Math.min(...cabin.outline.map(([, y]) => y));
  const cabinTop = Math.max(...cabin.outline.map(([, y]) => y));
  const cabinHalf = (/** @type {number} */ y) =>
    THREE.MathUtils.lerp(cabin.base, cabin.roof, (y - cabinBottom) / (cabinTop - cabinBottom));

  // the deck's crown, which the cabin's foot follows across
  const deckCrown = (/** @type {number} */ x) =>
    Math.max(0, sample(model.body.top, x) - sample(model.body.shoulder, x));
  const lower = lowerBody(model);
  /** @type {Part[]} */
  const parts = [lower.part, ...cabinParts(model, cabinHalf, deckCrown, lower.rearSection)];
  for (const side of [-1, 1]) {
    for (const mark of model.sideMarks) {
      const at = (/** @type {Point} */ [x, y]) =>
        new THREE.Vector3(side * (sideWidth(model, x, y) + OFFSET), y, x);
      parts.push(
        ...pieces(mark.outline, mark).map((bar) =>
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
      if (mark.depth) parts.push(raised(rectangle(mark), at, out, mark.depth, mark));
      else {
        for (const piece of pieces(rectangle(mark), mark)) {
          parts.push(fineFace(piece, at, out, STATION));
        }
      }
    }
  }

  if (!model.decals?.length) return centred(leanEnds(withPolygons(parts), model), model);
  // leaned, then its edges found once with the decals' (withPolygons)
  const body = mergeParts(parts);
  leanEnds(body.geometry, model);
  const decals = decalParts(model.decals, body.geometry);
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
 * @param {SedanModel} model
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
 * Each wheel arch (SedanModel `wheel.arches`) from its rear foot over to its front foot: its
 * line, its height at x (-Infinity off it) and its line grown by `grow`, a flare's outer edge.
 *
 * @param {SedanModel} model
 */
function arches({ wheel }) {
  return wheel.arches.map((arch, i) => {
    if (typeof arch[0] !== "number") {
      const line = archLine(/** @type {Point[]} */ (arch), wheel.archRound ?? 0, 1);
      return {
        line,
        height: (/** @type {number} */ x) => heightOn(line, x),
        grown: (/** @type {number} */ grow) => offsetArch(line, grow),
      };
    }
    // half an ellipse over the wheel's centre
    const [r, height] = /** @type {Point} */ (arch);
    const axle = wheel.axles[i];
    const arc = (/** @type {number} */ grow) =>
      Array.from({ length: ARCH_SEGMENTS + 1 }, (_, k) => {
        const angle = Math.PI - (Math.PI * k) / ARCH_SEGMENTS;
        return /** @type {Point} */ ([
          axle + (r + grow) * Math.cos(angle),
          wheel.radius + (height + grow) * Math.sin(angle),
        ]);
      });
    return {
      line: arc(0),
      height: (/** @type {number} */ x) => {
        const t = Math.abs(x - axle) / r;
        if (t > 1.001) return -Infinity; // stations are rounded to 0.1 mm
        return wheel.radius + height * Math.sqrt(Math.max(0, 1 - t * t));
      },
      grown: arc,
    };
  });
}

/**
 * A flare round each wheel arch, `width` wide, standing OFFSET out of the side: a band between
 * the arch (as lowerBody() cuts it) and the arch grown by `width`, one polygon each.
 *
 * @param {SedanModel} model
 * @param {number} width
 * @returns {Part[]}
 */
function flareParts(model, width) {
  return arches(model).flatMap(({ line, grown }) => {
    const band = [...grown(width), ...[...line].reverse()];
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
 * An outline standing `depth` out of a surface: its face, cut into bars and columns, and the walls
 * round it, with corners every STATION.
 *
 * @param {Point[]} rim convex
 * @param {(p: Point) => THREE.Vector3} at on the surface
 * @param {THREE.Vector3} out unit
 * @param {number} depth
 * @param {{ bars?: number, columns?: number }} cuts
 * @returns {Part}
 */
function raised(rim, at, out, depth, cuts) {
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
    ...pieces(outline, cuts).map((piece) => face(piece, top, out)),
    joined(
      walls,
      walls.map(() => 0),
    ),
  ]);
}

/**
 * Leans a car's ends: the front forward above `body.nose.from`, the higher the more (its top
 * edge `lean` ahead); the rear back above `body.tail.from`, its top edge `lean` behind the face
 * below, the face drawn in under its top (which stays where the deck has it) towards the bottom.
 * Each fades out over a STATION from its end; the faces that move get their normals again.
 *
 * @param {THREE.BufferGeometry} geometry non-indexed, built from the rear (z = 0) forward
 * @param {SedanModel} model
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

/** The body's rear and front ends (without the bumpers). @param {SedanModel} model */
const ends = ({ body }) => [body.top[0][0], body.top[body.top.length - 1][0]];

/**
 * Half width of the body side at (x, y), between the waist and the shoulder.
 *
 * @param {SedanModel} model
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
 * The lower body, lofted through half sections (underside middle, sill, waist, shoulder, deck
 * middle; mirrored), the arches cut into the underside. Underside, lower side, upper side, deck
 * and each end are a polygon each, the sides split at the seams, so lines run along the sill, the
 * waist and the shoulder. A flat rear (`rear`) leaves its end to rearWall().
 *
 * @param {SedanModel} model
 * @returns {{ part: Part, rearSection: Point[] }} the half section at the rear end too
 */
function lowerBody(model) {
  const { body } = model;
  const curves = [body.top, body.shoulder, body.waist, body.bottom, body.width];
  const [start, end] = ends(model);
  // the stations: the ends, the seams and round the arches; the curves' points where none is
  // near (one a few millimetres from another cuts a sliver of a strip, twisted, its shading in
  // patches); then the gaps cut evenly, no longer than STATION
  const required = [start, end, ...body.seams];
  const archList = arches(model);
  for (const { line } of archList) {
    required.push(...line.map(([x]) => x));
    // the arch's feet drop to the sill
    required.push(line[0][0] - ARCH_FOOT, line[line.length - 1][0] + ARCH_FOOT);
  }
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
    archList.reduce((y, { height }) => Math.max(y, height(x)), sample(body.bottom, x));
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
    if (x === start && model.rear) continue;
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
  return { part: mergeParts(parts), rearSection: section(start) };
}

/**
 * The cabin: its profile drawn across, narrowing up (`halfWidth`); the roof and the screens
 * crowned (none at the foot, all of it at the roof), the screens bowed (`cabin.screens`); the
 * windows set in behind their frames; a drip rail along the roof. Cut every STATION, the sides
 * filled with points, for a crash to bend.
 *
 * @param {SedanModel} model
 * @param {(y: number) => number} halfWidth
 * @param {(x: number) => number} deckCrown how much higher the deck's middle is than its sides
 * @param {Point[]} rearSection the lower body's half section at its rear end (lowerBody())
 * @returns {Part[]}
 */
function cabinParts(model, halfWidth, deckCrown, rearSection) {
  const { cabin, windows } = model;
  const profile = counterClockwise(cabin.outline);
  const foot = Math.min(...profile.map(([, y]) => y));
  const middle = (Math.min(...profile.map(([x]) => x)) + Math.max(...profile.map(([x]) => x))) / 2;
  const screens = [
    { line: cabin.windscreen, ...(cabin.screens?.windscreen ?? FLAT_SCREEN) },
    ...(cabin.rearWindow
      ? [{ line: cabin.rearWindow, ...(cabin.screens?.rearWindow ?? FLAT_SCREEN) }]
      : []),
  ];
  const rearEnd = model.body.top[0][0];
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
    if (model.rear && a[0] === rearEnd && b[0] === rearEnd) continue; // rearWall()'s
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
  const steiner = fillPoints(outline, panes, ...SPARSE);
  // a flat rear's edge rises above the windscreen: the rail stops at its top
  const rearTop = Math.max(...outline.filter(([x]) => x === rearEnd).map(([, y]) => y));
  const roofLine = outline.filter(
    ([x, y]) => y >= roof - 1e-6 && !(model.rear && x === rearEnd && y < rearTop),
  );
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
  if (model.rear) {
    const edge = outline.filter(([x]) => x === rearEnd).map(([, y]) => y);
    parts.push(...rearWall(model, { rearSection, edge, foot, halfWidth, point }));
  }
  return parts;
}

/**
 * A flat rear (SedanModel `rear`): the lower body's end and the cabin's rear face in one plane,
 * split along the belt (the cabin's foot) beside the door, the door one polygon across it, the
 * windows set in. Its outline takes the sides', the deck's and the roof's points there.
 *
 * @param {SedanModel} model
 * @param {object} shape
 * @param {Point[]} shape.rearSection the lower body's half section (lowerBody())
 * @param {number[]} shape.edge heights of the cabin's points up its rear edge
 * @param {number} shape.foot the belt
 * @param {(y: number) => number} shape.halfWidth the cabin's
 * @param {(x: number, y: number, s: number, bow: number) => THREE.Vector3} shape.point on the cabin
 * @returns {Part[]}
 */
function rearWall(model, { rearSection, edge, foot, halfWidth, point }) {
  const { door, windows } = /** @type {RearWall} */ (model.rear);
  const x = model.body.top[0][0];
  const out = new THREE.Vector3(0, 0, -1);
  const at = (/** @type {Point} */ [w, y]) =>
    point(x, y, THREE.MathUtils.clamp(w / halfWidth(y), -1, 1), 0).setX(w);
  /** Drawn at the belt's width, leaning in with the cabin. @param {Point} p */
  const lean = ([w, y]) => /** @type {Point} */ ([(w * halfWidth(y)) / halfWidth(foot), y]);
  /** @param {Point[]} points @returns {Point[]} */
  const mirror = (points) => points.map(([w, y]) => /** @type {Point} */ ([-w, y])).reverse();

  const [half, [bottom, top]] = [door.w / 2, door.y];
  if (bottom >= foot || top <= foot) throw new Error("the rear door must reach across the belt");
  /** @param {Point[]} corners @returns {Point[]} */
  const rim = (corners) => densifyLine(corners.map(lean), STATION);
  // from the door's left side at the belt round its top to its right side; round its bottom back
  const upperRim = rim([
    [-half, foot],
    [-half, top],
    [half, top],
    [half, foot],
  ]);
  const lowerRim = rim([
    [half, foot],
    [half, bottom],
    [-half, bottom],
    [-half, foot],
  ]);
  // along the belt: the deck's and the cabin floor's points, outermost first, beside the door
  // or behind it; the deck's where the cabin's foot puts them
  const deck = rearSection.slice(5);
  if (deck.some(([w, y]) => Math.abs(at([w, foot]).y - y) > 1e-4)) {
    throw new Error("a flat rear's deck must meet the cabin's foot");
  }
  const belt = [
    ...deck.map(([w]) => w),
    ...ACROSS.filter((u) => u > 0).map((u) => u * halfWidth(foot)),
  ]
    .sort((a, b) => b - a)
    .filter((w, i, all) => i === 0 || all[i - 1] - w > 1e-6);
  const beside = belt.filter((w) => w > half).map((w) => /** @type {Point} */ ([w, foot]));
  const behind = belt.filter((w) => w < half).flatMap((w) => (w ? [w, -w] : [w]));
  const lowerSide = rearSection.slice(0, 5); // the bottom's middle to under the shoulder
  /** @type {Point[]} */
  const lower = [
    ...lowerSide,
    ...beside,
    ...lowerRim,
    ...mirror(beside),
    ...mirror(lowerSide.slice(1)),
  ];
  const ys = [...new Set(edge)].sort((a, b) => a - b);
  const roof = ys[ys.length - 1];
  const cabinSide = ys.slice(1, -1).map((y) => /** @type {Point} */ ([halfWidth(y), y]));
  /** @type {Point[]} */
  const upper = [
    ...beside.slice(0, 1),
    ...cabinSide,
    ...[...ACROSS].reverse().map((u) => /** @type {Point} */ ([u * halfWidth(roof), roof])),
    ...mirror(cabinSide),
    ...beside.map(([w, y]) => /** @type {Point} */ ([-w, y])),
    ...upperRim,
    ...[...beside.slice(1)].reverse(),
  ];

  const windowRims = mirrored(windows).map((mark) => {
    const [left, right, low, high] = [
      Math.abs(mark.x) - mark.w / 2,
      Math.abs(mark.x) + mark.w / 2,
      mark.y - mark.h / 2,
      mark.y + mark.h / 2,
    ];
    const inDoor = right < half && low > bottom && high < top;
    if (!inDoor && (left <= half || low <= foot)) {
      throw new Error("a rear window must be in the door or beside it, above the belt");
    }
    return { rim: densify(rectangle(mark).map(lean), STATION), inDoor };
  });
  const [doorRims, wallRims] = [true, false].map((inDoor) =>
    windowRims.filter((window) => window.inDoor === inDoor).map((window) => window.rim),
  );
  /** A flat polygon with holes, and points inside for a crash to bend. */
  const panel = (
    /** @type {Point[]} */ outline,
    /** @type {Point[][]} */ holes,
    /** @type {Point[][]} */ points = [],
  ) => face(outline, at, out, [...holes, ...points, ...fillPoints(outline, holes, ...SPARSE)]);
  return [
    panel(lower, []),
    panel(upper, wallRims),
    panel(
      [...upperRim, ...lowerRim.slice(1, -1)],
      doorRims,
      behind.map((w) => [[w, foot]]),
    ),
    ...[...doorRims, ...wallRims].flatMap((window) =>
      recessed(window, glassTriangles(window, STATION), at, out),
    ),
  ];
}

/**
 * The headlamps, one geometry each, with `userData.polygons` (its outline): lines once it is out.
 *
 * @param {SedanModel} model
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
 * How high across (s: -1 left edge, 0 middle, 1 right edge) a crowned surface stands, as a share
 * of its crown: four flat facets (FACET, INNER).
 *
 * @param {number} s
 */
function facets(s) {
  const u = Math.abs(s);
  return u <= FACET ? 1 - ((1 - INNER) * u) / FACET : (INNER * (1 - u)) / (1 - FACET);
}
