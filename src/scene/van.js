import * as THREE from "three";
import {
  archLine,
  bars,
  CORNER_STEPS,
  densify,
  fillPoints,
  heightOn,
  mirrored,
  offsetArch,
  pieces,
  rectangle,
  rounded,
  SPARSE,
  STATION,
} from "./outline.js";
import { zipBy } from "./triangulate.js";
import {
  builtIn,
  byFaces,
  face,
  facingPositions,
  fineFace,
  flatGeometry,
  glassTriangles,
  innerEdges,
  joined,
  OFFSET,
  recessed,
  withPolygons,
} from "./polygons.js";

/**
 * @typedef {import("./outline.js").Point} Point
 * @typedef {import("./polygons.js").Part} Part
 * @typedef {import("./trafficModels.js").VanModel} VanModel
 * @typedef {import("./trafficModels.js").Mark} Mark
 * @typedef {{ x: number, y: number, w: number }} Spot a point on the body: along, up, across
 * @typedef {ReturnType<typeof vanContext>} VanContext what the sections of a van share
 */

/** The roof's corners, rounded in plan, keep at least this radius, metres. */
const MIN_RADIUS = 0.02;
/** Points closer than this are one, metres; a band is closed off where an arch gets this near. */
const EPS = 5e-4;
/** Segments round a fog lamp, and round a tail lamp: a hexagon, plain. */
const [ROUND_SEGMENTS, TAIL_SEGMENTS] = [12, 6];

/** A point of the body in the scene's axes: across is x, along is z (the front faces +z). */
const at3 = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ w) =>
  new THREE.Vector3(w, y, x);

/**
 * `count` + 1 numbers from `from` to `to`, evenly apart.
 *
 * @param {number} from
 * @param {number} to
 * @param {number} count
 */
const between = (from, to, count) =>
  Array.from({ length: count + 1 }, (_, k) => from + ((to - from) * k) / count);

/** From `from` to `to`, at most `step` apart. @param {number} from @param {number} to @param {number} step */
const steps = (from, to, step) =>
  between(from, to, Math.max(1, Math.ceil(Math.abs(to - from) / step)));

/** Sorted, without the ones within EPS of another. @param {number[]} values */
const distinct = (values) =>
  [...values].sort((a, b) => a - b).filter((value, i, all) => i === 0 || value - all[i - 1] > EPS);

/**
 * A van (VanModel, scene/trafficModels.js), in metres, its origin on the ground in the
 * middle of its length, its front towards +z: the body as one geometry, with `userData.polygons`
 * (its lines run round the polygons, see scene/polygons.js), and the lit lamps, one geometry each.
 *
 * Below the belt the body runs round the plan (a rectangle, its corners rounded) in bands
 * between the sill, the ribs and the belt, each band a polygon all round the rear and along each
 * side to the door edges, so a line runs round the car at each rib; the bands are cut round the
 * wheel arches, a flare round each. Above the belt the walls lean in up to the gutter, the
 * windows set in them; the tailgate leans in too. The roof rounds off from the gutter in rings
 * up to its crowned top, all one polygon: no line on it that would read as gear on the roof. The
 * cab's front: a ledge and a panel up from the front face to the windscreen, corner windows
 * wrapping round from its sides to the pillars, the corners under them sloping back down to the
 * belt.
 *
 * @param {VanModel} model
 * @returns {{ body: THREE.BufferGeometry, lamps: THREE.BufferGeometry[] }}
 */
export function vanGeometry(model) {
  const context = vanContext(model);
  addBands(context);
  addFrontPanel(context);
  addArches(context);
  addUnderside(context);
  addWalls(context);
  addTailgate(context);
  addCab(context);
  addRoof(context);
  addDetails(context);
  return assembled(context);
}

/**
 * What the sections of a van share: its measurements, the walls and the tailgate leaning in above
 * the belt, the corners rounded in plan, the points along and up the body where the pieces of one
 * section meet another's, and the pieces of the body as the sections add them.
 *
 * @param {VanModel} model
 */
function vanContext(model) {
  const { van, wheel, length } = model;
  const [rear, front] = van.ends;
  const { half, corner, sill, belt, gutter, cab, roof } = van;
  const [tanRear, tanFront] = [rear + corner, front - corner]; // where the sides meet the corners
  const faceHalf = half - corner; // the end faces' flat half width
  const heights = [sill, ...van.ribs, belt];
  // the corners below the belt, [along, across]: from the sides round to the end faces
  const rearArc = cornerArc(tanRear, faceHalf, corner, -1);
  const frontArc = cornerArc(tanFront, faceHalf, corner, 1);

  // above the belt: the walls lean in, the tailgate leans forward, its corners tighten
  const lean = (half - gutter.half) / (gutter.y - belt);
  const wallHalf = (/** @type {number} */ y) => half - (y - belt) * lean;
  const tailX = (/** @type {number} */ y) =>
    rear + ((y - belt) * (gutter.rear - rear)) / (gutter.y - belt);
  const radiusAt = (/** @type {number} */ y) => tanRear - tailX(y);
  const tailHalf = (/** @type {number} */ y) => wallHalf(y) - radiusAt(y);
  const wallNormal = new THREE.Vector3(1, lean, 0).normalize();
  const wallAt = (/** @type {Point} */ [x, y]) => at3(x, y, wallHalf(y));
  const tailNormal = new THREE.Vector3(0, (gutter.rear - rear) / (gutter.y - belt), -1).normalize();
  const tailAt = (/** @type {Point} */ [w, y]) => at3(tailX(y), y, w);

  /** @type {{ part: Part, name: string }[]} pieces on the right, mirrored to the left */
  const right = [];
  /** @type {{ part: Part, name: string }[]} pieces across the middle */
  const whole = [];
  /**
   * A piece of the body: pieces of one name are one polygon (each of a part's own polygons one).
   *
   * @param {Part} part
   * @param {string} name
   */
  const add = (part, name, mirror = true) => (mirror ? right : whole).push({ part, name });
  let unique = 0;
  /** A name no other piece has. @param {string} kind */
  const own = (kind) => `${kind}:${unique++}`;
  /**
   * A glass set in an opening (polygons.js recessed()).
   *
   * @param {Point[]} rim
   * @param {(p: Point) => THREE.Vector3} at
   * @param {THREE.Vector3} out
   */
  const glass = (rim, at, out, mirror = true) => {
    const triangles = glassTriangles(rim, STATION);
    for (const pane of recessed(rim, triangles, at, out)) add(pane, own("glass"), mirror);
  };

  // below the belt: each arch's edge and its flare's outer edge, the side panels' edges; the
  // bands under the flares end on the sill
  const archLines = van.arches.map((arch) => {
    if ([arch[0], arch[arch.length - 1]].some(([, y]) => Math.abs(y - van.sill) > EPS)) {
      throw new Error("a van's wheel arches must stand on its sill");
    }
    const inner = archLine(arch, van.archRound);
    return { inner, outer: offsetArch(inner, van.lip) };
  });
  const panels = distinct([tanRear, ...van.seams, cab.pillar, tanFront]);
  const crossings = archLines.flatMap(({ outer }) => heights.flatMap((h) => crossingsOf(outer, h)));
  // every point along the sides: the stations, the seams, the arches' corners and where their
  // flares cross the ribs, so the bands, the flares and the underside share them
  const along = distinct([
    ...steps(tanRear, tanFront, STATION),
    ...panels,
    ...archLines.flatMap(({ inner, outer }) => [...inner, ...outer].map(([x]) => x)),
    ...crossings,
  ]).filter((x) => x >= tanRear - EPS && x <= tanFront + EPS);
  /** The stations from `a` to `b`. @param {number} a @param {number} b */
  const alongIn = (a, b) => along.filter((x) => x >= a - EPS && x <= b + EPS);
  /** Snapped to the nearest band line. @param {number} y */
  const snap = (y) => heights.find((h) => Math.abs(h - y) < EPS) ?? y;
  const side = new THREE.Vector3(1, 0, 0);
  const sideAt = (/** @type {Point} */ [x, y]) => at3(x, y, half);
  const rearW = steps(0, faceHalf, STATION); // across the rear face, from its middle to the corner
  const frontW = between(-van.panel, van.panel, 8); // across the front face's middle panel
  // how far across the wheel wells' inner walls stand: a little inside the tyres
  const wellHalf = Math.min(...wheel.track) / 2 - wheel.width / 2 - 0.03;

  // stations across half the windscreen (flat: the roof over it needs them to crown), up the
  // corner windows
  const screenSteps = 2;
  const upright = steps(belt, gutter.y, STATION); // up the walls' rear edges and corners
  const [screenX, screenY] = cab.screenBottom;
  const [topX, topY] = cab.screenTop;
  // along the gutter, from the rear corner to the pillar: the stations and the seams
  const top = distinct([...steps(tanRear, cab.pillar, STATION), ...van.seams]);
  const gutterRear = steps(0, tailHalf(gutter.y), STATION); // across the tailgate's top

  return {
    van,
    wheel,
    length,
    rear,
    front,
    half,
    sill,
    belt,
    gutter,
    cab,
    roof,
    tanRear,
    tanFront,
    faceHalf,
    heights,
    rearArc,
    frontArc,
    wallHalf,
    radiusAt,
    tailHalf,
    wallNormal,
    wallAt,
    tailNormal,
    tailAt,
    right,
    whole,
    add,
    own,
    glass,
    archLines,
    panels,
    along,
    alongIn,
    snap,
    side,
    sideAt,
    rearW,
    frontW,
    wellHalf,
    screenSteps,
    upright,
    screenX,
    screenY,
    topX,
    topY,
    top,
    gutterRear,
  };
}

/**
 * The bands below the belt, between the sill, the ribs and the belt: along each side panel by
 * panel, cut round the flares, then round the rear corner and across the rear face, and round the
 * front corner and across the front face beside its middle panel. A band is one polygon a panel,
 * the rear's with the rearmost panel's, the front's with the frontmost's.
 *
 * @param {VanContext} context
 */
function addBands({
  van,
  rear,
  front,
  tanRear,
  tanFront,
  faceHalf,
  heights,
  rearArc,
  frontArc,
  archLines,
  panels,
  alongIn,
  snap,
  side,
  sideAt,
  rearW,
  add,
}) {
  /** Highest flare at x (-Infinity clear of them). @param {number} x */
  const flareAt = (x) => Math.max(...archLines.map(({ outer }) => heightOn(outer, x)));
  heights.slice(1).forEach((y1, k) => {
    const y0 = heights[k];
    const band = (/** @type {number} */ panel) => `band:${k}:${panel}`;
    for (let p = 0; p + 1 < panels.length; p++) {
      for (const outline of bandPieces(alongIn(panels[p], panels[p + 1]), y0, y1, flareAt, snap)) {
        add(face(outline, sideAt, side), band(p));
      }
    }
    // the rear: its corner and its face, one band with the rearmost panel's
    add(
      shell(
        strip(
          rearArc.map(([x, w]) => at3(x, y0, w)),
          rearArc.map(([x, w]) => at3(x, y1, w)),
        ),
        (c) => new THREE.Vector3(c.x - faceHalf, 0, c.z - tanRear),
      ),
      band(0),
    );
    add(
      face(
        [
          ...rearW.map((w) => /** @type {Point} */ ([w, y0])),
          ...[...rearW].reverse().map((w) => /** @type {Point} */ ([w, y1])),
        ],
        ([w, y]) => at3(rear, y, w),
        new THREE.Vector3(0, 0, -1),
      ),
      band(0),
    );
    // the front: its corner and the face beside the middle panel, with the frontmost panel's
    const last = panels.length - 2;
    add(
      shell(
        strip(
          frontArc.map(([x, w]) => at3(x, y0, w)),
          frontArc.map(([x, w]) => at3(x, y1, w)),
        ),
        (c) => new THREE.Vector3(c.x - faceHalf, 0, c.z - tanFront),
      ),
      band(last),
    );
    add(
      face(
        [
          [van.panel, y0],
          [faceHalf, y0],
          [faceHalf, y1],
          [van.panel, y1],
        ],
        ([w, y]) => at3(front, y, w),
        new THREE.Vector3(0, 0, 1),
      ),
      band(last),
    );
  });
}

/**
 * The front face's middle panel, round the grille and the lamps: one polygon from the sill up to
 * the belt, meeting the bands beside it at the ribs.
 *
 * @param {VanContext} context
 */
function addFrontPanel({ van, front, sill, belt, heights, frontW, add }) {
  /** @type {Point[]} */
  const outline = [
    ...frontW.map((w) => /** @type {Point} */ ([w, sill])),
    ...heights.slice(1).map((y) => /** @type {Point} */ ([van.panel, y])),
    ...[...frontW]
      .reverse()
      .slice(1)
      .map((w) => /** @type {Point} */ ([w, belt])),
    ...[...heights]
      .reverse()
      .slice(1, -1)
      .map((y) => /** @type {Point} */ ([-van.panel, y])),
  ];
  add(
    face(
      outline,
      ([w, y]) => at3(front, y, w),
      new THREE.Vector3(0, 0, 1),
      fillPoints(outline, [], 2 * STATION, 0.03, (belt - sill) / 2),
    ),
    "front",
    false,
  );
}

/**
 * The wheel arches: round each, its flare from the arch out to the flare's outer edge and down to
 * the sill, and the well behind it, from the arch in to the well's wall.
 *
 * @param {VanContext} context
 */
function addArches({ wheel, half, sill, archLines, alongIn, snap, side, sideAt, wellHalf, add }) {
  archLines.forEach(({ inner, outer }, i) => {
    const [a0, a1] = [inner[0][0], inner[inner.length - 1][0]];
    const [l0, l1] = [outer[0][0], outer[outer.length - 1][0]];
    const sillPoints = (/** @type {number} */ from, /** @type {number} */ to) =>
      alongIn(from, to)
        .filter((x) => x > from + EPS && x < to - EPS)
        .map((x) => /** @type {Point} */ ([x, sill]));
    /** @type {Point[]} */
    const flare = [
      ...alongIn(l0, l1).map((x) => /** @type {Point} */ ([x, snap(heightOn(outer, x))])),
      ...sillPoints(a1, l1).reverse(),
      ...[...inner].reverse(),
      ...sillPoints(l0, a0).reverse(),
    ];
    add(face(flare, sideAt, side), "flare");
    const centre = new THREE.Vector3(0, wheel.radius, wheel.axles[i]);
    add(
      shell(
        strip(
          inner.map(([x, y]) => at3(x, y, half)),
          inner.map(([x, y]) => at3(x, y, wellHalf)),
        ),
        (c) => centre.clone().setX(c.x).sub(c),
      ),
      "well",
    );
    add(
      face(inner, ([x, y]) => at3(x, y, wellHalf), side),
      "well",
    );
  });
}

/**
 * The underside at the sill, one polygon: along the right side, notched in round the wells, round
 * the front corner and across the front, back down the left side, round the rear corner and across
 * the rear.
 *
 * @param {VanContext} context
 */
function addUnderside({
  front,
  rear,
  half,
  sill,
  frontArc,
  rearArc,
  archLines,
  along,
  alongIn,
  rearW,
  frontW,
  wellHalf,
  add,
}) {
  /** @type {Point[]} [along, across] */
  const rightSide = [];
  for (const x of along) {
    const well = archLines.find(
      ({ inner }) => x > inner[0][0] + EPS && x < inner[inner.length - 1][0] - EPS,
    );
    if (well) continue;
    const starts = archLines.find(({ inner }) => Math.abs(x - inner[0][0]) < EPS);
    const ends = archLines.find(({ inner }) => Math.abs(x - inner[inner.length - 1][0]) < EPS);
    if (ends) rightSide.push([x, wellHalf]);
    rightSide.push([x, half]);
    if (starts) {
      const to = starts.inner[starts.inner.length - 1][0];
      rightSide.push(
        [x, wellHalf],
        ...alongIn(x, to)
          .filter((s) => s > x + EPS && s < to - EPS)
          .map((s) => /** @type {Point} */ ([s, wellHalf])),
      );
    }
  }
  // round to the front, across it, back down the left side, round the rear and across it
  const frontCorner = frontArc.slice(1);
  const frontEdge = [...frontW].reverse();
  /** @type {Point[]} */
  const plan = [
    ...rightSide,
    ...frontCorner,
    ...frontEdge.map((w) => /** @type {Point} */ ([front, w])),
    ...[...frontCorner].reverse().map(([x, w]) => /** @type {Point} */ ([x, -w])),
    ...[...rightSide].reverse().map(([x, w]) => /** @type {Point} */ ([x, -w])),
    ...rearArc.slice(1).map(([x, w]) => /** @type {Point} */ ([x, -w])),
    ...rearW
      .slice(1, -1)
      .reverse()
      .map((w) => /** @type {Point} */ ([rear, -w])),
    ...rearW.slice(0, -1).map((w) => /** @type {Point} */ ([rear, w])),
    ...[...rearArc].reverse().slice(0, -1),
  ];
  add(
    face(
      plan,
      ([x, w]) => at3(x, sill, w),
      new THREE.Vector3(0, -1, 0),
      fillPoints(plan, [], 2 * STATION, 0.03, half),
    ),
    "under",
    false,
  );
}

/**
 * The walls above the belt, leaning in up to the gutter: one polygon a panel, from the rear corner
 * past the seams to the pillar, the side windows set in them (each in one panel); the blind panels
 * and the louvres standing out of them.
 *
 * @param {VanContext} context
 */
function addWalls({
  van,
  cab,
  belt,
  gutter,
  tanRear,
  screenSteps,
  screenY,
  upright,
  top,
  alongIn,
  wallAt,
  wallNormal,
  add,
  own,
  glass,
}) {
  const paneUp = between(screenY, gutter.y, screenSteps); // up the pillar, beside a corner window
  const wallPanels = distinct([tanRear, ...van.seams, cab.pillar]);
  for (const { x } of van.windows) {
    const fits = wallPanels.some(
      (x0, p) => p + 1 < wallPanels.length && x[0] > x0 && x[1] < wallPanels[p + 1],
    );
    if (!fits)
      throw new Error(`a side window (${x}) crosses a door edge: it must sit in one panel`);
  }
  for (let p = 0; p + 1 < wallPanels.length; p++) {
    const [x0, x1] = [wallPanels[p], wallPanels[p + 1]];
    const atPillar = Math.abs(x1 - cab.pillar) < EPS;
    const atRear = Math.abs(x0 - tanRear) < EPS;
    /** @type {Point[]} */
    const outline = [
      ...alongIn(x0, x1).map((x) => /** @type {Point} */ ([x, belt])),
      ...(atPillar ? [screenY, ...paneUp.slice(1)] : [gutter.y]).map(
        (y) => /** @type {Point} */ ([x1, y]),
      ),
      ...top
        .filter((x) => x > x0 + EPS && x < x1 - EPS)
        .reverse()
        .map((x) => /** @type {Point} */ ([x, gutter.y])),
      [x0, gutter.y],
      ...(atRear ? upright.slice(1, -1).reverse() : []).map((y) => /** @type {Point} */ ([x0, y])),
    ];
    const windows = van.windows
      .filter(({ x }) => x[0] > x0 && x[1] < x1)
      .map(({ x, y }) => densify(rounded(box(x, y), van.windowCorners, 1), STATION));
    add(
      face(outline, wallAt, wallNormal, [...windows, ...fillPoints(outline, windows, ...SPARSE)]),
      `wall:${p}`,
    );
    for (const window of windows) glass(window, wallAt, wallNormal);
  }
  // the blind panels and the louvres stand out of the walls
  const onWall = (/** @type {number} */ layer) => (/** @type {Point} */ p) =>
    wallAt(p).addScaledVector(wallNormal, OFFSET * layer);
  for (const { x, y } of van.blanks) {
    const inset = van.blankInset;
    const outer = rounded(box(x, y), van.windowCorners, 1);
    add(fineFace(outer, onWall(1), wallNormal, STATION), own("mark"));
    const inner = box([x[0] + inset, x[1] - inset], [y[0] + inset, y[1] - inset]);
    add(
      fineFace(rounded(inner, van.windowCorners / 2, 1), onWall(2), wallNormal, STATION),
      own("mark"),
    );
  }
  for (const { x, y, bars: count } of van.vents) {
    for (const bar of bars(box(x, y), count)) {
      add(fineFace(bar, onWall(1), wallNormal, STATION), own("mark"));
    }
  }
}

/**
 * The rear above the belt: its corners, one polygon with the walls' rearmost panel, and the
 * tailgate between them, leaning forward, its window set in it.
 *
 * @param {VanContext} context
 */
function addTailgate({
  van,
  belt,
  gutter,
  tanRear,
  upright,
  rearW,
  gutterRear,
  radiusAt,
  tailHalf,
  tailAt,
  tailNormal,
  add,
  glass,
}) {
  for (let i = 0; i + 1 < upright.length; i++) {
    const arc = (/** @type {number} */ y) =>
      cornerArc(tanRear, tailHalf(y), radiusAt(y), -1).map(([x, w]) => at3(x, y, w));
    add(
      shell(
        strip(arc(upright[i]), arc(upright[i + 1])),
        (c) => new THREE.Vector3(c.x - tailHalf(c.y), 0, c.z - tanRear),
      ),
      "wall:0",
    );
  }
  const bottom = [...rearW]
    .reverse()
    .map((w) => -w)
    .concat(rearW.slice(1));
  const upper = [...gutterRear].reverse().concat(gutterRear.slice(1).map((w) => -w));
  /** @type {Point[]} */
  const outline = [
    ...bottom.map((w) => /** @type {Point} */ ([w, belt])),
    ...upright.slice(1, -1).map((y) => /** @type {Point} */ ([tailHalf(y), y])),
    ...upper.map((w) => /** @type {Point} */ ([w, gutter.y])),
    ...upright
      .slice(1, -1)
      .reverse()
      .map((y) => /** @type {Point} */ ([-tailHalf(y), y])),
  ];
  const { half: windowHalf, y, corners } = van.rearWindow;
  const window = densify(rounded(box([-windowHalf, windowHalf], y), corners, 1), STATION);
  add(
    face(outline, tailAt, tailNormal, [window, ...fillPoints(outline, [window], ...SPARSE)]),
    "tailgate",
    false,
  );
  glass(window, tailAt, tailNormal, false);
}

/**
 * The cab's front above the belt: the ledge and the panel up from the front face to the
 * windscreen, the windscreen, the corner windows from its sides back to the pillars, and the
 * corner under each corner window, from the belt up.
 *
 * @param {VanContext} context
 */
function addCab({
  van,
  cab,
  front,
  half,
  belt,
  gutter,
  tanFront,
  frontArc,
  screenSteps,
  screenX,
  screenY,
  topX,
  topY,
  alongIn,
  wallHalf,
  add,
  glass,
}) {
  const [ledgeX, ledgeY] = cab.ledge;
  const across = between(-1, 1, 2 * screenSteps); // -1 left to 1 right
  const frontTop = (/** @type {number} */ w) => at3(front, belt, w);
  const ledge = (/** @type {number} */ w) => at3(ledgeX, ledgeY, w);
  const screenBottom = (/** @type {number} */ w) => at3(screenX, screenY, w);
  const screenTop = (/** @type {number} */ w) => at3(topX, topY, w);
  // the ledge and the panel under the windscreen
  for (const [name, lower, upper, lowerHalf, upperHalf] of /** @type {const} */ ([
    ["cowl:0", frontTop, ledge, van.panel, cab.ledgeHalf],
    ["cowl:1", ledge, screenBottom, cab.ledgeHalf, cab.screenHalf],
  ])) {
    /** @type {Point[]} [across, up] */
    const outline = [
      ...across.map((u) => /** @type {Point} */ ([u, 0])),
      ...[...across].reverse().map((u) => /** @type {Point} */ ([u, 1])),
    ];
    const at = (/** @type {Point} */ [u, t]) => lower(u * lowerHalf).lerp(upper(u * upperHalf), t);
    add(
      face(outline, at, outwards(at([0, 0]), at([1, 0]), at([0, 1]), new THREE.Vector3(0, 1, 1))),
      name,
      false,
    );
  }
  // the windscreen
  const slope = screenBottom(0).distanceTo(screenTop(0));
  {
    const screenAt = (/** @type {Point} */ [w, s]) => screenBottom(w).lerp(screenTop(w), s / slope);
    const sides = between(0, slope, screenSteps).slice(1);
    /** @type {Point[]} */
    const outline = [
      ...across.map((u) => /** @type {Point} */ ([u * cab.screenHalf, 0])),
      ...sides.map((s) => /** @type {Point} */ ([cab.screenHalf, s])),
      ...[...across]
        .reverse()
        .slice(1)
        .map((u) => /** @type {Point} */ ([u * cab.screenHalf, slope])),
      ...[...sides]
        .reverse()
        .slice(1)
        .map((s) => /** @type {Point} */ ([-cab.screenHalf, s])),
    ];
    const inset = cab.screenHalf - cab.frame;
    const window = densify(
      rounded(box([-inset, inset], [cab.frame, slope - cab.frame]), cab.frame, 1),
      STATION,
    );
    const out = outwards(
      screenAt([0, 0]),
      screenAt([1, 0]),
      screenAt([0, 1]),
      new THREE.Vector3(0, 1, 1),
    );
    add(
      face(outline, screenAt, out, [window, ...fillPoints(outline, [window], STATION)]),
      "screen",
      false,
    );
    glass(window, screenAt, out, false);
  }
  // the corner windows, from the windscreen's sides back to the pillars
  const pillarBottom = at3(cab.pillar, screenY, wallHalf(screenY));
  const pillarTop = at3(cab.pillar, gutter.y, gutter.half);
  const paneAt = bilinear(
    pillarBottom,
    screenBottom(cab.screenHalf),
    screenTop(cab.screenHalf),
    pillarTop,
  );
  {
    const uv = between(0, 1, screenSteps);
    /** @type {Point[]} [from the pillar, up] */
    const outline = [
      ...uv.map((u) => /** @type {Point} */ ([u, 0])),
      ...uv.slice(1).map((v) => /** @type {Point} */ ([1, v])),
      [0, 1],
      ...uv
        .slice(1, -1)
        .reverse()
        .map((v) => /** @type {Point} */ ([0, v])),
    ];
    const out = outwards(
      paneAt([0, 0]),
      paneAt([1, 0]),
      paneAt([0, 1]),
      new THREE.Vector3(1, 0, 1),
    );
    const { frame } = cab;
    const [bottom, upper] = [
      paneAt([0, 0]).distanceTo(paneAt([1, 0])),
      paneAt([0, 1]).distanceTo(paneAt([1, 1])),
    ];
    const tall =
      (paneAt([0, 0]).distanceTo(paneAt([0, 1])) + paneAt([1, 0]).distanceTo(paneAt([1, 1]))) / 2;
    /** @type {Point[]} */
    const window = [
      [frame / bottom, frame / tall],
      [1 - frame / bottom, frame / tall],
      [1 - frame / upper, 1 - frame / tall],
      [frame / upper, 1 - frame / tall],
    ];
    add(face(outline, paneAt, out, [window]), "pane");
    glass(window, paneAt, out);
  }
  // the corner under each corner window, from the belt up
  {
    const belted = [
      ...alongIn(cab.pillar, tanFront).map((x) => at3(x, belt, half)),
      ...frontArc.slice(1).map(([x, w]) => at3(x, belt, w)),
      frontTop(van.panel),
    ];
    const raised = [
      ...between(0, 1, screenSteps).map((u) => paneAt([u, 0])),
      ledge(cab.ledgeHalf),
      frontTop(van.panel),
    ];
    const inside = new THREE.Vector3(0, belt, cab.pillar - 0.5);
    add(
      shell(zipChains(belted, raised), (c) => c.clone().sub(inside)),
      "corner",
    );
  }
}

/**
 * The roof, one polygon: rings from the gutter in and up to its edge, then its crowned top.
 *
 * @param {VanContext} context
 */
function addRoof({
  cab,
  roof,
  belt,
  gutter,
  tanRear,
  screenSteps,
  topX,
  topY,
  top,
  gutterRear,
  radiusAt,
  tailHalf,
  add,
}) {
  /** @type {Spot[]} the gutter, from the windscreen's middle round to the tailgate's */
  const gutterRing = [
    ...between(0, cab.screenHalf, screenSteps).map((w) => ({ x: topX, y: topY, w })),
    { x: cab.pillar, y: gutter.y, w: gutter.half },
    ...[...top]
      .reverse()
      .filter((x) => x < cab.pillar - EPS && x > tanRear + EPS)
      .map((x) => ({ x, y: gutter.y, w: gutter.half })),
    ...cornerArc(tanRear, tailHalf(gutter.y), radiusAt(gutter.y), -1).map(([x, w]) => ({
      x,
      y: gutter.y,
      w,
    })),
    ...[...gutterRear]
      .reverse()
      .slice(1)
      .map((w) => ({ x: gutter.rear, y: gutter.y, w })),
  ];
  const [deepest] = roof.rounding[roof.rounding.length - 1];
  const topHalf = gutter.half - deepest;
  const crown = (/** @type {number} */ w) => roof.crown * Math.max(0, 1 - (w / topHalf) ** 2);
  const rings = [
    gutterRing,
    ...roof.rounding.map(([d, share]) =>
      insetRing(gutterRing, d, { cab, gutter, tanRear, screenSteps }).map((spot, i) => ({
        ...spot,
        y: THREE.MathUtils.lerp(gutterRing[i].y, roof.edge + crown(spot.w), share),
      })),
    ),
  ];
  // facing away from the line along the body's middle, at the belt, short of its ends
  const outOfMiddle = (/** @type {THREE.Vector3} */ c) =>
    c.clone().sub(at3(THREE.MathUtils.clamp(c.z, tanRear + 0.3, cab.pillar - 0.3), belt, 0));
  for (let i = 0; i + 1 < rings.length; i++) {
    const row = (/** @type {Spot[]} */ ring) => ring.map(({ x, y, w }) => at3(x, y, w));
    add(shell(strip(row(rings[i]), row(rings[i + 1])), outOfMiddle), "roof");
  }
  {
    const ring = rings[rings.length - 1];
    /** @type {Point[]} [along, across] */
    const rightHalf = ring.map(({ x, w }) => /** @type {Point} */ ([x, w]));
    const plan = dropRepeats([
      ...rightHalf,
      ...[...rightHalf]
        .reverse()
        .slice(1, -1)
        .map(([x, w]) => /** @type {Point} */ ([x, -w])),
    ]);
    add(
      face(
        plan,
        ([x, w]) => at3(x, roof.edge + crown(w), w),
        new THREE.Vector3(0, 1, 0),
        fillPoints(plan, [], 2 * STATION, 0.03, topHalf / 2), // rows across for the crown
      ),
      "roof",
      false,
    );
  }
}

/**
 * The details: the marks on the front and rear faces, the fog lamps, the tail lamps, the mudflaps
 * and the frame under the body.
 *
 * @param {VanContext} context
 */
function addDetails({ van, front, rear, add, own }) {
  for (const { marks, x, facing } of [
    { marks: van.frontMarks, x: front + OFFSET, facing: 1 },
    { marks: van.rearMarks, x: rear - OFFSET, facing: -1 },
  ]) {
    for (const mark of mirrored(marks)) {
      for (const bar of pieces(rectangle(mark), mark)) {
        add(
          fineFace(bar, ([w, y]) => at3(x, y, w), new THREE.Vector3(0, 0, facing), STATION),
          own("mark"),
          false,
        );
      }
    }
  }
  const { fogLamps: fog } = van;
  {
    const lamp = new THREE.CylinderGeometry(fog.r, fog.r, fog.depth, ROUND_SEGMENTS)
      .rotateX(Math.PI / 2)
      .translate(fog.x, fog.y, front + fog.depth / 2);
    // CylinderGeometry: the side (2 triangles a segment), then the two caps (1 a segment)
    const sides = 2 * ROUND_SEGMENTS;
    add(
      builtIn(lamp, (t) => (t < sides ? 0 : 1)),
      own("fog"),
    );
  }
  // the tail lamps: cut cones from the rear face back to the car's end, the lens their small end
  {
    const { w, y: ys, radius } = van.tailLamps;
    const [base, lens] = radius;
    for (const y of ys) {
      // CylinderGeometry along y: its top (base) turned to the front, the bottom (lens) back
      const lamp = new THREE.CylinderGeometry(base, lens, rear, TAIL_SEGMENTS)
        .rotateX(Math.PI / 2)
        .translate(w, y, rear / 2);
      const sides = 2 * TAIL_SEGMENTS; // the side, then the two caps
      add(
        builtIn(lamp, (t) => (t < sides ? 0 : 1)),
        own("tail"),
      );
    }
  }
  {
    const { x, w, y } = van.mudflaps;
    const flap = new THREE.BoxGeometry(w[1] - w[0], y[1] - y[0], 0.01).translate(
      (w[0] + w[1]) / 2,
      (y[0] + y[1]) / 2,
      x,
    );
    add(byFaces(flap), own("mudflap"));
  }
  {
    const { x, half: frameHalf, y } = van.frame;
    // cut along it, for a crash to bend it
    const [wide, long] = [2 * frameHalf, x[1] - x[0]];
    const frame = new THREE.BoxGeometry(wide, y[1] - y[0], long, 1, 1, Math.ceil(long / STATION));
    frame.translate(0, (y[0] + y[1]) / 2, (x[0] + x[1]) / 2);
    add(byFaces(frame), "frame", false);
  }
}

/**
 * The van's geometries from the pieces added: the body, the pieces on the right mirrored to the
 * left, as one geometry with its polygons; the lit lamps, one geometry each; all with the origin
 * in the middle of the van's length.
 *
 * @param {VanContext} context
 * @returns {{ body: THREE.BufferGeometry, lamps: THREE.BufferGeometry[] }}
 */
function assembled({ van, front, length, right, whole }) {
  const pieces = [
    ...right,
    ...right.map(({ part, name }) => ({ part: flipped(part), name })),
    ...whole,
  ];
  /** @type {Map<string, number>} */
  const ids = new Map();
  const polygon = pieces.flatMap(({ part, name }) =>
    part.polygon.map((k) => {
      const key = `${name}#${k}`;
      if (!ids.has(key)) ids.set(key, ids.size);
      return /** @type {number} */ (ids.get(key));
    }),
  );
  const { geometry } = joined(
    pieces.map(({ part }) => part),
    pieces.map(() => 0),
  );
  geometry.userData.polygons = {
    inner: innerEdges(geometry, polygon),
    polygon: Uint32Array.from(polygon),
  };

  // the lit lamps: the headlamps on the front face, the fog lamps' glass
  const { fogLamps: fog } = van;
  const lit = (/** @type {Mark} */ mark, /** @type {number} */ x) =>
    withPolygons([face(rectangle(mark), ([w, y]) => at3(x, y, w), new THREE.Vector3(0, 0, 1))]);
  const lamps = [
    ...mirrored(van.lamps).map((mark) => lit(mark, front + 2 * OFFSET)),
    ...mirrored([{ x: fog.x, y: fog.y, w: 2 * fog.r * 0.85, h: 2 * fog.r * 0.85, round: 0.5 }]).map(
      (mark) => lit(mark, front + fog.depth + OFFSET),
    ),
  ];
  return {
    body: geometry.translate(0, 0, -length / 2),
    lamps: lamps.map((lamp) => lamp.translate(0, 0, -length / 2)),
  };
}

/**
 * A rectangle (side, front or rear view) from its two ranges.
 *
 * @param {number[]} x
 * @param {number[]} y
 * @returns {Point[]}
 */
function box([x0, x1], [y0, y1]) {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/**
 * A corner rounded in plan, [along, across]: from the side (along = cx, across = cw + radius) round
 * to the end face (along = cx + end * radius, across = cw).
 *
 * @param {number} cx
 * @param {number} cw
 * @param {number} radius
 * @param {-1 | 1} end -1 the rear, 1 the front
 * @returns {Point[]}
 */
function cornerArc(cx, cw, radius, end) {
  return Array.from({ length: CORNER_STEPS + 1 }, (_, k) => {
    const phi = (Math.PI / 2) * (k / CORNER_STEPS);
    return [cx + end * radius * Math.sin(phi), cw + radius * Math.cos(phi)];
  });
}

/**
 * Where a polyline running along x crosses the height y.
 *
 * @param {Point[]} line
 * @param {number} y
 */
function crossingsOf(line, y) {
  return line.slice(1).flatMap(([bx, by], i) => {
    const [ax, ay] = line[i];
    if ((ay - y) * (by - y) >= 0 || ay === by) return [];
    return [ax + ((bx - ax) * (y - ay)) / (by - ay)];
  });
}

/**
 * The pieces of a band of the side between y0 and y1 at the stations `xs`, where no flare rises
 * into it: each piece's outline, its bottom running over a flare that rises into the band, the
 * band closed off where a flare rises through it.
 *
 * @param {number[]} xs
 * @param {number} y0
 * @param {number} y1
 * @param {(x: number) => number} flareAt
 * @param {(y: number) => number} snap
 * @returns {Point[][]}
 */
function bandPieces(xs, y0, y1, flareAt, snap) {
  /** @type {Point[][]} */
  const pieces = [];
  /** @type {Point[]} */
  let bottom = [];
  /** @type {number | null} */
  let closedAt = null;
  const finish = () => {
    if (bottom.length >= 2) {
      const upper = [...bottom]
        .reverse()
        .filter(([, y]) => y < y1)
        .map(([x]) => /** @type {Point} */ ([x, y1]));
      pieces.push([...bottom, ...upper]);
    }
    bottom = [];
  };
  for (const x of xs) {
    const y = snap(Math.max(y0, flareAt(x)));
    if (y < y1 - EPS) {
      if (!bottom.length && closedAt !== null) bottom.push([closedAt, y1]);
      bottom.push([x, y]);
      closedAt = null;
    } else {
      if (bottom.length) {
        bottom.push([x, y1]);
        finish();
      }
      closedAt = x;
    }
  }
  finish();
  return pieces;
}

/**
 * A roof ring `d` in from the gutter's (gutter ring, same points): the front pulled back from the
 * windscreen's top, the corner window's top edge and the sides in, the tailgate's top forward,
 * the rear corners tighter. Points that would cross each other meet.
 *
 * @param {Spot[]} ring the gutter
 * @param {number} d
 * @param {{ cab: import("./trafficModels.js").VanCab, gutter: { y: number, half: number, rear: number }, tanRear: number, screenSteps: number }} shape
 * @returns {Spot[]}
 */
function insetRing(ring, d, { cab, gutter, tanRear, screenSteps }) {
  const [topX] = cab.screenTop;
  // the corner window's top edge, from the windscreen's corner to the pillar, moved in by d
  const [fx, fw] = [topX, cab.screenHalf];
  const [tx, tw] = [cab.pillar - fx, gutter.half - fw];
  const length = Math.hypot(tx, tw);
  const [nx, nw] = [-tw / length, tx / length]; // in, away from the outside
  const sideW = gutter.half - d;
  const frontX = topX - d;
  // where the moved edge meets the moved front and the moved side
  let cornerW = fw + (d - (frontX - fx) * nx) / nw;
  let pillarX = fx + (d - (sideW - fw) * nw) / nx;
  if (cornerW > sideW || pillarX > frontX) [cornerW, pillarX] = [sideW, frontX];
  const rearX = gutter.rear + d;
  const radius = Math.max(tanRear - gutter.rear - d, MIN_RADIUS);
  const sideStart = rearX + radius; // where the side meets the rear corner
  const pillar = cab.pillar;
  const span = pillar - tanRear;
  return ring.map((spot, i) => {
    if (i <= screenSteps) return { ...spot, x: frontX, w: (spot.w / cab.screenHalf) * cornerW };
    if (i === screenSteps + 1) return { ...spot, x: pillarX, w: sideW };
    if (spot.w === gutter.half) {
      // along the side, as far between its ends as the gutter's point is between its own
      const t = (pillar - spot.x) / span;
      return { ...spot, x: pillarX + (sideStart - pillarX) * t, w: sideW };
    }
    if (spot.x === gutter.rear) {
      const tailHalf = gutter.half - (tanRear - gutter.rear);
      return { ...spot, x: rearX, w: (spot.w / tailHalf) * (sideW - radius) };
    }
    // round the rear corner: as far round as the gutter's point is round its own
    const gutterRadius = tanRear - gutter.rear;
    const phi = Math.atan2(tanRear - spot.x, spot.w - (gutter.half - gutterRadius));
    return {
      ...spot,
      x: sideStart - radius * Math.sin(phi),
      w: sideW - radius + radius * Math.cos(phi),
    };
  });
}

/**
 * Bilinear patch over four corners: (0, 0) `a`, (1, 0) `b`, (1, 1) `c`, (0, 1) `d`.
 *
 * @param {THREE.Vector3} a
 * @param {THREE.Vector3} b
 * @param {THREE.Vector3} c
 * @param {THREE.Vector3} d
 * @returns {(p: Point) => THREE.Vector3}
 */
function bilinear(a, b, c, d) {
  return ([u, v]) =>
    a
      .clone()
      .multiplyScalar((1 - u) * (1 - v))
      .addScaledVector(b, u * (1 - v))
      .addScaledVector(c, u * v)
      .addScaledVector(d, (1 - u) * v);
}

/**
 * The unit normal of the plane through three points, turned the way of `towards`.
 *
 * @param {THREE.Vector3} a
 * @param {THREE.Vector3} b
 * @param {THREE.Vector3} c
 * @param {THREE.Vector3} towards
 */
function outwards(a, b, c, towards) {
  const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
  return normal.dot(towards) < 0 ? normal.negate() : normal;
}

/**
 * Quads between two rows of as many points, two triangles each.
 *
 * @param {THREE.Vector3[]} a
 * @param {THREE.Vector3[]} b
 * @returns {THREE.Vector3[][]}
 */
function strip(a, b) {
  return a.slice(1).flatMap((_, i) => [
    [a[i], a[i + 1], b[i + 1]],
    [a[i], b[i + 1], b[i]],
  ]);
}

/**
 * Triangles between two chains of points (any number each) from one end to the other, zipped by
 * how far along each they are.
 *
 * @param {THREE.Vector3[]} a
 * @param {THREE.Vector3[]} b
 * @returns {THREE.Vector3[][]}
 */
function zipChains(a, b) {
  const shares = (/** @type {THREE.Vector3[]} */ chain) => {
    const lengths = chain.reduce(
      (all, p, i) => [...all, i ? all[i - 1] + p.distanceTo(chain[i - 1]) : 0],
      /** @type {number[]} */ ([]),
    );
    return lengths.map((l) => l / lengths[lengths.length - 1]);
  };
  return zipBy(a, b, shares(a), shares(b));
}

/**
 * Triangles (corners in the scene's axes) as one polygon, each turned to face the way `facing`
 * gives for its middle; triangles without area are left out.
 *
 * @param {THREE.Vector3[][]} triangles
 * @param {(centre: THREE.Vector3) => THREE.Vector3} facing
 * @returns {Part}
 */
function shell(triangles, facing) {
  /** @type {number[]} */
  const positions = [];
  for (const corners of triangles) {
    const [a, b, c] = corners;
    if (b.clone().sub(a).cross(c.clone().sub(a)).lengthSq() < 1e-14) continue;
    const centre = a.clone().add(b).add(c).divideScalar(3);
    positions.push(...facingPositions(corners, facing(centre)));
  }
  return { geometry: flatGeometry(positions), polygon: new Array(positions.length / 9).fill(0) };
}

/**
 * A part mirrored to the other side (across is x), still facing out, its normals mirrored (a
 * cylinder's smooth ones stay smooth).
 *
 * @param {Part} part
 * @returns {Part}
 */
function flipped({ geometry, polygon }) {
  const [position, normal] = [geometry.getAttribute("position"), geometry.getAttribute("normal")];
  /** @type {number[][]} */
  const positions = [];
  /** @type {number[][]} */
  const normals = [];
  for (let i = 0; i < position.count; i += 3) {
    for (const k of [0, 2, 1]) {
      positions.push([-position.getX(i + k), position.getY(i + k), position.getZ(i + k)]);
      normals.push([-normal.getX(i + k), normal.getY(i + k), normal.getZ(i + k)]);
    }
  }
  const mirrored = new THREE.BufferGeometry();
  mirrored.setAttribute("position", new THREE.Float32BufferAttribute(positions.flat(), 3));
  mirrored.setAttribute("normal", new THREE.Float32BufferAttribute(normals.flat(), 3));
  return { geometry: mirrored, polygon: [...polygon] };
}

/**
 * A closed outline without points repeated one after another.
 *
 * @param {Point[]} outline
 * @returns {Point[]}
 */
function dropRepeats(outline) {
  return outline.filter((p, i) => {
    const q = outline[(i + outline.length - 1) % outline.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > EPS;
  });
}
