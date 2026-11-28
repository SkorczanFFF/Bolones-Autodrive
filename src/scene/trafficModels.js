/**
 * The minigames' traffic (scene/traffic.js builds it), traced from blueprints in metres.
 * Model data, not configuration, so it lives next to the code that reads it. Side views: x from
 * the car's rear end to the front, y up from the ground; front and rear views: offset from the
 * centre line (mirrored to the other side when not 0), y up.
 */

/**
 * @typedef {[number, number]} Point
 * @typedef {{ x: number, y: number, w: number, h: number, round?: number, bars?: number, columns?: number, depth?: number }} Mark
 *   a front or rear view rectangle: centre, size, corner cut (0.5: an ellipse), cut into bars
 *   and columns; with `depth` it stands that far out of the face (a lamp in its housing)
 * @typedef {object} Bumper
 * @property {number} y centre height
 * @property {number} height
 * @property {Point[]} plan the outer edge in the top view, [across, back from the car's end],
 *   from the centre to one end (mirrored to the other)
 * @property {number} [depth] how thick the bar is (scene/carParts.js BUMPER_DEPTH unless it says)
 * @property {Mark[]} [marks] outlines on its face, in the middle (front or rear view)
 *
 * @typedef {object} Rim the wheel's face, in shares of the tyre's radius
 * @property {number} radius
 * @property {number} hub the hubcap's radius
 * @property {{ count: number, at: number, size: Point, round: number, turn: number }} holes in a
 *   ring at `at` from the centre, [across, along the ring] big, corners cut by `round`, the first
 *   one `turn` of a step round from the front
 *
 * @typedef {object} Screen a windscreen's, a rear window's shape
 * @property {[number, number]} bow how far its middle curves out along the car (seen from above)
 *   at the bottom and at the top, metres: round into the pillars
 * @property {[number, number]} corners its corners rounded at the bottom and at the top, metres
 *
 * @typedef {object} TrafficModel
 * @property {string} label
 * @property {number} mass kg, against the Bolones' in a crash (game/crash.js)
 * @property {number} length overall, bumper to bumper
 * @property {number} width overall, the body traced to it
 * @property {{ radius: number, width: number, axles: number[], track: number[], arches: (Point | Point[])[], archRound?: number, rim: Rim }} wheel
 *   tyres; per axle (rear, front): x, track and wheel arch: half an ellipse (half its length, its
 *   height above the wheel centre) or traced (side view, from the rear foot over to the front
 *   foot, its corners over the wheel cut off by `archRound`)
 * @property {object} body the lower body, sides and deck (scene/sedan.js lowerBody)
 * @property {Point[]} body.top deck centre line (side view), from the rear end to the front end
 * @property {Point[]} body.shoulder top edge of the sides
 * @property {Point[]} body.waist the widest line along the sides
 * @property {Point[]} body.bottom underside; wheel arches are cut into it
 * @property {Point[]} body.width top view: [x, half width] at the waist
 * @property {number} body.shoulderInset the shoulder is this much narrower than the waist
 * @property {number} [body.flares] a flare this wide round each wheel arch
 * @property {number} body.tuck the underside is this much narrower than the waist
 * @property {{ lean: number, from: number }} [body.nose] the front leans forward above `from`
 *   (metres up), its top edge `lean` ahead of the face below (the grille and the lamps with it)
 * @property {{ lean: number, from: number }} [body.tail] the rear leans back above `from`, its
 *   top edge (where the deck has it) `lean` behind the face below (the marks and lamps with it)
 * @property {number[]} body.seams x of the door edges: lines down the sides
 * @property {object} cabin greenhouse on the deck
 * @property {Point[]} cabin.outline side view, its bottom edge on the shoulders, under the deck's
 *   crown
 * @property {number} cabin.base half width at its bottom
 * @property {number} cabin.roof half width at its top
 * @property {[Point, Point]} cabin.windscreen the windscreen's slope on the outline
 * @property {[Point, Point]} [cabin.rearWindow] the rear window's slope on the outline
 * @property {{ windscreen: Screen, rearWindow: Screen }} [cabin.screens] how they curve; flat
 *   and square without
 * @property {number} [cabin.windowCorners] the side windows' corners rounded, metres
 * @property {number} [cabin.frame] how wide the frame round the windscreen and the rear window is,
 *   metres (scene/sedan.js FRAME unless it says)
 * @property {number} [cabin.crown] how much higher the middle of the roof is than its edges
 * @property {Point[][]} windows side windows, inside the cabin outline
 * @property {{ outline: Point[], bars?: number }[]} sideMarks convex outlines on the body sides,
 *   cut into horizontal bars
 * @property {Mark[]} lamps headlamps (front view)
 * @property {Mark[]} frontMarks outlines on the front (front view)
 * @property {Mark[]} rearMarks outlines on the rear (rear view)
 * @property {Decal[]} [decals] outlines drawn in a view, projected onto the body along it
 * @property {{ front: Bumper, rear: Bumper }} bumpers
 * @property {Mirror} [mirrors]
 * @property {{ y: number }} [spare] a spare wheel (as the others) standing on the rear end, its
 *   centre `y` up; rigid, a crash pushes it in whole or tears it off
 * @property {Guard} [guard]
 * @property {RearWall} [rear] a flat rear instead of the cabin's rear face and the body's end
 *
 * @typedef {object} RearWall the cabin's rear face upright down the body's end (scene/sedan.js
 *   rearWall), in the rear view: across drawn at the belt's width, leaning in with the cabin
 * @property {{ w: number, y: Point }} door in the middle, its width, its bottom and top heights:
 *   across the belt
 * @property {Mark[]} windows in the wall or in the door
 * @typedef {object} Guard tubes over the front, on the front bumper's node (scene/carParts.js)
 * @property {[number, number, number][][]} tubes each a line of points [along, up, across] on
 *   the car's left, mirrored to the right
 * @property {number} thick
 *
 * @typedef {object} Mirror outside mirrors (scene/carParts.js): a head with its corners cut, the
 *   glass outlined at its back, on arms from the body. Points are [along, up, across] on the
 *   car's left (+x, the driver's side), mirrored to the right for a side of -1. They stand out of
 *   the car's hitbox (the physics' box), within its reach (what the Bolones must not touch);
 *   a crash tears them off
 * @property {number[]} sides 1 the car's left, -1 its right
 * @property {Point} head its size: across, up
 * @property {number} depth how deep the head is, along the car
 * @property {number} corners how far its corners are cut
 * @property {[number, number, number]} centre the head's middle
 * @property {[number, number, number][][]} arms from the body to the head, each [from, to]
 * @property {number} arm how thick the arms are
 *
 * @typedef {object} Decal an outline in one of the views, projected onto the body
 * @property {"side" | "front" | "rear" | "top"} view
 * @property {Point[]} [outline] side: [along, up]; front, rear: [across, up]; top: [along,
 *   across]. All on one side of the centre line (front, rear, top): mirrored to the other; side
 *   views: on both sides
 * @property {Mark} [shape] a rectangle or an ellipse instead of the outline, in the same axes
 * @property {number} [bars] cut into bars across its second coordinate
 * @property {number} [columns] cut into bars across its first coordinate
 * @property {number} [raise] a block instead: its face flat, square to the view, this far out past
 *   the body under it (a lamp)
 * @property {1 | -1} [side] front, rear and top views: on that side only (1 the car's left)
 *
 * @typedef {object} VanModel a van (scene/van.js): a box with rounded corners on wheels, the cab
 *   at its front. Side views: x from the back of the tail lamps; top, front and rear views: w
 *   across, from the centre line
 * @property {string} label
 * @property {number} mass kg
 * @property {number} length overall, from the tail lamps to the front bumper
 * @property {number} width overall, the body traced to it
 * @property {Omit<TrafficModel["wheel"], "arches">} wheel tyres; per axle (rear, front): x, track
 * @property {Van} van
 * @property {{ front: Bumper, rear: Bumper }} bumpers
 * @property {Mirror} [mirrors]
 *
 * @typedef {object} Van the body. Below the belt it runs round the plan in bands, between the
 *   sill, the ribs pressed into it and the belt: a line all round at each; above the belt the
 *   walls lean in up to the gutter, where the roof rounds off
 * @property {[number, number]} ends x of the rear face and of the front face
 * @property {number} half half width of the lower body, and of the walls at the belt
 * @property {number} corner radius of the four corners, rounded in plan
 * @property {number} sill height of the underside
 * @property {number} belt height of the crease round the car where the walls begin to lean in
 * @property {number[]} ribs heights of the ribs round the lower body, from the bottom up
 * @property {{ y: number, half: number, rear: number }} gutter the walls' top edge: its height,
 *   half width and the rear face's x there (the tailgate leans in from the belt up; its corners
 *   tighten, their sides staying upright)
 * @property {{ edge: number, crown: number, rounding: Point[] }} roof the line where its rounded
 *   edge meets the top (height), how much higher the top's middle is, and the rounding: [how far
 *   in from the gutter, share of the way up to the edge]
 * @property {VanCab} cab
 * @property {Point[][]} arches wheel arches (side view), from the rear foot on the sill over to
 *   the front foot, their corners rounded by `archRound`; per axle (rear, front)
 * @property {number} archRound
 * @property {number} lip width of the flare round each arch
 * @property {number[]} seams x of the door edges behind the cab's front doors: lines down the sides
 * @property {{ x: Point, y: Point }[]} windows side windows (side view), corners rounded by
 *   `windowCorners`
 * @property {number} windowCorners
 * @property {{ x: Point, y: Point }[]} blanks blind panels in the shape of windows, an outline
 *   inside them `blankInset` in
 * @property {number} blankInset
 * @property {{ x: Point, y: Point, bars: number }[]} vents louvres on the sides, cut into bars
 * @property {{ half: number, y: Point, corners: number }} rearWindow in the tailgate, its corners
 *   rounded
 * @property {number} panel half width of the front face's middle panel, round the grille and
 *   the lamps, up to the belt
 * @property {Mark[]} lamps headlamps (front view): lit
 * @property {Mark[]} frontMarks outlines on the front face (front view)
 * @property {{ x: number, y: number, r: number, depth: number }} fogLamps round, standing out of
 *   the front face (front view): lit
 * @property {{ w: number, y: number[], radius: Point }} tailLamps cut cones one over another at
 *   each rear corner, from the rear face back to the car's end: across, the heights, the radius
 *   at the body and at the lens
 * @property {Mark[]} rearMarks outlines on the rear face (rear view)
 * @property {{ x: number, w: Point, y: Point }} mudflaps behind the rear wheels
 * @property {{ x: Point, half: number, y: Point }} frame the chassis under the body, between the
 *   wheels
 *
 * @typedef {object} VanCab the cab's front above the belt: a ledge and a panel up from the front
 *   face to the windscreen, corner windows wrapping round from the windscreen's sides to pillars
 * @property {number} pillar x of the walls' front end, the front doors' front edge
 * @property {Point} ledge x and height of the ledge's top over the front face
 * @property {number} ledgeHalf its half width there
 * @property {Point} screenBottom x and height of the windscreen's bottom edge
 * @property {Point} screenTop x and height of its top edge
 * @property {number} screenHalf half width of the windscreen
 * @property {number} frame width of the frame round the windscreen and the corner windows
 */

/** @type {Record<string, TrafficModel | VanModel>} */
export const TRAFFIC_MODELS = {
  polakito: {
    label: "Polakito",
    mass: 600,
    // traced from blueprints (side, front, rear and top views): the later one, its big plastic
    // bumpers
    length: 3.129,
    width: 1.382,
    wheel: {
      radius: 0.259,
      width: 0.135,
      // a steel wheel: six slots round a small hubcap
      rim: {
        radius: 0.62,
        hub: 0.2,
        holes: { count: 6, at: 0.42, size: [0.13, 0.24], round: 0.45, turn: 0 },
      },
      axles: [0.732, 2.596],
      track: [1.203, 1.142],
      arches: [
        [0.29, 0.256],
        [0.307, 0.256],
      ],
    },
    body: {
      // the rear face, up the engine lid to the cabin, the belt under it, the bonnet, the nose
      top: [
        [0.082, 0.68],
        [0.17, 0.78],
        [0.36, 0.845],
        [2.25, 0.85],
        [2.364, 0.871],
        [2.629, 0.843],
        [2.904, 0.798],
        [3.04, 0.758],
        [3.08, 0.736],
        [3.1, 0.7],
      ],
      shoulder: [
        [0.082, 0.68],
        [0.17, 0.775],
        [0.36, 0.84],
        [2.25, 0.845],
        [2.364, 0.84],
        [2.629, 0.815],
        [2.904, 0.775],
        [3.04, 0.735],
        [3.1, 0.698],
      ],
      // the crease along the sides at the top of the lamps, down round the rear corners
      waist: [
        [0.082, 0.6],
        [0.14, 0.64],
        [0.25, 0.675],
        [2.9, 0.68],
        [3.04, 0.675],
        [3.1, 0.66],
      ],
      bottom: [
        [0.082, 0.33],
        [0.2, 0.26],
        [0.4, 0.25],
        [2.9, 0.25],
        [3.02, 0.27],
        [3.1, 0.33],
      ],
      // rounded ends
      width: [
        [0.082, 0.5],
        [0.11, 0.57],
        [0.17, 0.625],
        [0.27, 0.66],
        [0.45, 0.674],
        [1.2, 0.678],
        [2.0, 0.676],
        [2.6, 0.666],
        [2.85, 0.65],
        [2.98, 0.625],
        [3.06, 0.59],
        [3.1, 0.55],
      ],
      shoulderInset: 0.035,
      tuck: 0.04,
      flares: 0.055,
      // the rear face leans back up to the engine lid, as in both side views of the drawings
      tail: { lean: 0.035, from: 0.33 },
      seams: [1.21, 2.232],
    },
    // a fastback: the rear window runs down into the engine lid; the windscreen wraps round its
    // corners in front of the A pillars (as seen from the side), on under the bonnet's crown
    cabin: {
      outline: [
        [0.17, 0.78],
        [2.25, 0.82],
        [2.052, 1.242],
        [2.0, 1.268],
        [1.9, 1.283],
        [1.4, 1.293],
        [0.9, 1.29],
        [0.75, 1.272],
        [0.68, 1.252],
        [0.62, 1.225],
        [0.33, 0.94],
      ],
      base: 0.59,
      roof: 0.51,
      crown: 0.04,
      windscreen: [
        [2.233, 0.857],
        [2.052, 1.242],
      ],
      rearWindow: [
        [0.62, 1.225],
        [0.33, 0.94],
      ],
      screens: {
        windscreen: { bow: [0.13, 0.02], corners: [0.03, 0.03] },
        rearWindow: { bow: [0.04, 0], corners: [0.04, 0.03] },
      },
      windowCorners: 0.025,
      frame: 0.045,
    },
    // quarter-light, door window, rear quarter window
    windows: [
      [
        [2.1, 0.885],
        [1.93, 1.245],
        [1.83, 1.245],
        [1.83, 0.885],
      ],
      [
        [1.8, 1.245],
        [1.285, 1.245],
        [1.285, 0.885],
        [1.8, 0.885],
      ],
      [
        [1.19, 1.232],
        [0.78, 1.225],
        [0.732, 1.205],
        [0.616, 0.929],
        [0.632, 0.885],
        [1.19, 0.885],
      ],
    ],
    // the engine's air intake behind the rear quarter window
    sideMarks: [
      {
        outline: [
          [0.661, 0.804],
          [0.482, 0.804],
          [0.402, 0.705],
          [0.607, 0.705],
        ],
        bars: 4,
      },
    ],
    // rectangular headlamps in housings, indicators under them, a trim strip between, the badge
    lamps: [{ x: 0.44, y: 0.617, w: 0.22, h: 0.15, round: 0.15, depth: 0.012 }],
    frontMarks: [
      { x: 0.43, y: 0.48, w: 0.16, h: 0.08, round: 0.15, depth: 0.008 },
      { x: 0, y: 0.623, w: 0.64, h: 0.014 },
      { x: 0, y: 0.58, w: 0.13, h: 0.028, round: 0.4 },
    ],
    // the light bar between the tail lamps (no number plate, as on the Bolones)
    rearMarks: [{ x: 0, y: 0.598, w: 0.82, h: 0.086, round: 0.3 }],
    decals: [
      // the tail lamps round the rear corners
      {
        view: "rear",
        outline: [
          [0.47, 0.43],
          [0.61, 0.43],
          [0.61, 0.68],
          [0.47, 0.68],
        ],
        bars: 3,
        raise: 0.012,
      },
      // the louvres in the engine lid
      {
        view: "rear",
        outline: [
          [0.065, 0.775],
          [0.36, 0.775],
          [0.36, 0.865],
          [0.065, 0.865],
        ],
        columns: 12,
      },
      // the door handle, the fuel cap, the indicator on the wing
      { view: "side", shape: { x: 1.3, y: 0.765, w: 0.1, h: 0.035, round: 0.4 } },
      { view: "side", shape: { x: 1.08, y: 0.625, w: 0.1, h: 0.1, round: 0.5 } },
      { view: "side", shape: { x: 2.33, y: 0.7, w: 0.045, h: 0.018, round: 0.5 } },
      // the rubbing strips along the door and the rear wing
      { view: "side", shape: { x: 1.737, y: 0.367, w: 0.983, h: 0.1 } },
      { view: "side", shape: { x: 1.11, y: 0.367, w: 0.16, h: 0.1 } },
    ],
    // the driver's only (the drawings'): a small head on a short stalk from the door's front top
    // corner, under the quarter-light
    mirrors: {
      sides: [1],
      head: [0.13, 0.09],
      depth: 0.035,
      corners: 0.025,
      centre: [2.12, 0.905, 0.73],
      arms: [
        [
          [2.085, 0.82, 0.65],
          [2.165, 0.82, 0.65],
        ],
        [
          [2.12, 0.825, 0.66],
          [2.12, 0.87, 0.69],
        ],
      ],
      arm: 0.022,
    },
    // plastic, deep, wrapped round the corners
    bumpers: {
      front: {
        y: 0.37,
        height: 0.14,
        depth: 0.07,
        plan: [
          [0, 0],
          [0.45, 0.01],
          [0.6, 0.04],
          [0.665, 0.11],
          [0.685, 0.28],
        ],
      },
      rear: {
        y: 0.35,
        height: 0.14,
        depth: 0.09,
        plan: [
          [0, 0],
          [0.45, 0.01],
          [0.6, 0.04],
          [0.665, 0.11],
          [0.685, 0.31],
        ],
      },
    },
  },
  kredens: {
    label: "Kredens",
    mass: 1010,
    // traced from blueprints (side, front and rear views; the top view's plan from an earlier
    // one's): the later one, its tail lamps across the rear
    length: 4.226,
    width: 1.63,
    wheel: {
      radius: 0.309,
      width: 0.165,
      // a hubcap with a ring of twelve holes round its middle
      rim: {
        radius: 0.6,
        hub: 0.28,
        holes: { count: 12, at: 0.43, size: [0.065, 0.065], round: 0.5, turn: 0 },
      },
      axles: [1.05, 3.559],
      track: [1.276, 1.298],
      // the rear one low over the tyre
      arches: [
        [0.36, 0.242],
        [0.35, 0.333],
      ],
    },
    body: {
      // three boxes: the boot lid, the belt under the cabin, the bonnet sloping down to the nose
      top: [
        [0.076, 0.76],
        [0.093, 0.805],
        [0.143, 0.856],
        [0.3, 0.876],
        [0.473, 0.888],
        [0.721, 0.904],
        [0.8, 0.935],
        [3.0, 0.945],
        [3.195, 0.929],
        [3.393, 0.92],
        [3.604, 0.9],
        [3.79, 0.888],
        [3.935, 0.88],
        [4.04, 0.85],
        [4.11, 0.789],
      ],
      shoulder: [
        [0.076, 0.755],
        [0.093, 0.795],
        [0.143, 0.835],
        [0.473, 0.86],
        [0.8, 0.89],
        [1.2, 0.9],
        [2.9, 0.9],
        [3.1, 0.895],
        [3.393, 0.875],
        [3.79, 0.85],
        [3.935, 0.845],
        [4.04, 0.82],
        [4.11, 0.78],
      ],
      // the crease along the sides under the windows
      waist: [
        [0.076, 0.7],
        [0.15, 0.8],
        [0.5, 0.835],
        [1.2, 0.86],
        [3.0, 0.86],
        [4.0, 0.81],
        [4.11, 0.76],
      ],
      bottom: [
        [0.076, 0.4],
        [0.15, 0.3],
        [0.5, 0.24],
        [3.85, 0.24],
        [4.0, 0.285],
        [4.11, 0.43],
      ],
      width: [
        [0.076, 0.73],
        [0.425, 0.745],
        [0.59, 0.755],
        [0.755, 0.775],
        [0.887, 0.787],
        [1.052, 0.795],
        [1.217, 0.8],
        [3.4, 0.8],
        [3.79, 0.788],
        [4.0, 0.77],
        [4.11, 0.745],
      ],
      shoulderInset: 0.02,
      tuck: 0.05,
      // the front leans forward over the bumper, its top edge 7 cm ahead
      nose: { lean: 0.07, from: 0.5 },
      seams: [1.195, 2.065, 2.993],
    },
    // the windscreen and the rear window wrap round into slim pillars
    cabin: {
      outline: [
        [3.03, 0.895],
        [2.73, 1.345],
        [2.7, 1.362],
        [2.62, 1.37],
        [2.3, 1.374],
        [1.6, 1.374],
        [1.32, 1.37],
        [1.22, 1.355],
        [1.169, 1.336],
        [0.75, 0.89],
      ],
      base: 0.74,
      roof: 0.635,
      crown: 0.045,
      windscreen: [
        [3.0, 0.94],
        [2.73, 1.345],
      ],
      rearWindow: [
        [1.169, 1.336],
        [0.797, 0.94],
      ],
      screens: {
        windscreen: { bow: [0.135, 0.02], corners: [0.04, 0.03] },
        rearWindow: { bow: [0.12, 0], corners: [0.07, 0.03] },
      },
      windowCorners: 0.03,
    },
    // quarter-light, front door, rear door, the rear door's fixed glass along the C pillar
    windows: [
      [
        [2.93, 0.965],
        [2.665, 1.31],
        [2.625, 1.31],
        [2.625, 0.96],
      ],
      [
        [2.59, 1.312],
        [2.125, 1.316],
        [2.125, 0.955],
        [2.59, 0.955],
      ],
      [
        [2.035, 1.31],
        [1.53, 1.305],
        [1.49, 1.28],
        [1.49, 0.95],
        [2.035, 0.95],
      ],
      [
        [1.468, 1.28],
        [1.436, 1.28],
        [1.25, 0.95],
        [1.468, 0.95],
      ],
    ],
    sideMarks: [],
    // four round headlamps standing out of a dark panel across the front, indicators at its ends
    lamps: [
      { x: 0.382, y: 0.659, w: 0.16, h: 0.16, round: 0.5, depth: 0.012 },
      { x: 0.55, y: 0.659, w: 0.16, h: 0.16, round: 0.5, depth: 0.012 },
    ],
    frontMarks: [
      { x: 0, y: 0.653, w: 1.47, h: 0.2 },
      { x: 0.687, y: 0.646, w: 0.09, h: 0.16, depth: 0.008 },
    ],
    // tail lamps across the rear (no number plate, as on the Bolones; no boot lock, too fine)
    rearMarks: [{ x: 0.55, y: 0.622, w: 0.314, h: 0.157, bars: 2, depth: 0.015 }],
    decals: [
      // the grille between the headlamps
      {
        view: "front",
        outline: [
          [-0.263, 0.575],
          [0.263, 0.575],
          [0.263, 0.74],
          [-0.263, 0.74],
        ],
        columns: 10,
      },
      // the chrome strip along the doors, the sill's, the door handles, the fuel flap
      { view: "side", shape: { x: 2.315, y: 0.515, w: 1.77, h: 0.018 } },
      { view: "side", shape: { x: 2.29, y: 0.317, w: 1.77, h: 0.03 } },
      { view: "side", shape: { x: 2.2, y: 0.814, w: 0.14, h: 0.025, round: 0.4 } },
      { view: "side", shape: { x: 1.317, y: 0.814, w: 0.15, h: 0.025, round: 0.4 } },
      { view: "side", shape: { x: 0.374, y: 0.7, w: 0.18, h: 0.125, round: 0.15 } },
      // the louvres in the C pillar
      {
        view: "side",
        outline: [
          [1.3, 1.2],
          [1.25, 1.2],
          [1.075, 0.95],
          [1.165, 0.95],
        ],
        bars: 4,
      },
    ],
    // as on the estate in the same drawings: both sides, a small head on a stalk from each front
    // door's top corner, by the quarter-light
    mirrors: {
      sides: [-1, 1],
      head: [0.13, 0.09],
      depth: 0.035,
      corners: 0.025,
      centre: [2.93, 0.99, 0.81],
      arms: [
        [
          [2.89, 0.885, 0.78],
          [2.97, 0.885, 0.78],
        ],
        [
          [2.93, 0.89, 0.775],
          [2.93, 0.955, 0.765],
        ],
      ],
      arm: 0.022,
    },
    // chrome bars wrapped round the corners
    bumpers: {
      front: {
        y: 0.478,
        height: 0.06,
        depth: 0.1,
        plan: [
          [0, 0],
          [0.5, 0.008],
          [0.65, 0.035],
          [0.76, 0.09],
          [0.805, 0.16],
          [0.81, 0.3],
        ],
      },
      rear: {
        y: 0.462,
        height: 0.08,
        depth: 0.08,
        plan: [
          [0, 0],
          [0.5, 0.008],
          [0.65, 0.035],
          [0.76, 0.09],
          [0.805, 0.17],
          [0.81, 0.42],
        ],
      },
    },
  },
  ramses: {
    label: "Ramses",
    mass: 1600,
    // traced from blueprints (side, top, front and rear views), without the gear on its roof
    length: 4.39,
    width: 1.79,
    wheel: {
      radius: 0.367,
      width: 0.17,
      // a steel wheel, six oval windows round a big hubcap
      rim: {
        radius: 0.6,
        hub: 0.3,
        holes: { count: 6, at: 0.45, size: [0.17, 0.3], round: 0.45, turn: 0.5 },
      },
      axles: [1.026, 3.761],
      track: [1.345, 1.4],
    },
    van: {
      ends: [0.075, 4.334],
      half: 0.894,
      corner: 0.14,
      sill: 0.47,
      belt: 1.17,
      ribs: [0.589, 0.69, 0.782, 0.881, 0.973, 1.069],
      gutter: { y: 1.935, half: 0.775, rear: 0.147 },
      roof: {
        edge: 2.1,
        crown: 0.043,
        rounding: [
          [0.03, 0.3],
          [0.085, 0.7],
          [0.175, 1],
        ],
      },
      cab: {
        pillar: 3.66,
        ledge: [4.2, 1.24],
        ledgeHalf: 0.68,
        screenBottom: [4.12, 1.4],
        screenTop: [3.78, 2.02],
        screenHalf: 0.7,
        frame: 0.05,
      },
      // trapezoids, their lips reaching the ribs over them
      arches: [
        [
          [0.65, 0.47],
          [0.812, 0.655],
          [1.256, 0.655],
          [1.425, 0.47],
        ],
        [
          [3.38, 0.47],
          [3.53, 0.747],
          [3.969, 0.747],
          [4.137, 0.47],
        ],
      ],
      archRound: 0.08,
      lip: 0.035,
      seams: [2.635, 2.778],
      // the front door's, the crew's
      windows: [
        { x: [2.799, 3.594], y: [1.39, 1.9] },
        { x: [1.816, 2.577], y: [1.39, 1.9] },
      ],
      windowCorners: 0.035,
      blanks: [
        { x: [0.997, 1.761], y: [1.396, 1.9] },
        { x: [0.28, 0.949], y: [1.396, 1.9] },
      ],
      blankInset: 0.07,
      vents: [{ x: [0.28, 1.761], y: [1.218, 1.328], bars: 3 }],
      rearWindow: { half: 0.525, y: [1.375, 1.88], corners: 0.06 },
      panel: 0.66,
      // round headlamps in square housings either side of a barred grille, sidelights under them
      lamps: [{ x: 0.536, y: 0.878, w: 0.18, h: 0.18, round: 0.5 }],
      frontMarks: [
        { x: 0.536, y: 0.905, w: 0.212, h: 0.265, round: 0.1 },
        { x: 0, y: 0.915, w: 0.786, h: 0.23, bars: 5 },
        { x: 0.535, y: 0.687, w: 0.11, h: 0.09 },
      ],
      fogLamps: { x: 0.39, y: 0.7, r: 0.068, depth: 0.05 },
      tailLamps: { w: 0.738, y: [0.638, 0.735, 0.832], radius: [0.045, 0.036] },
      // no number plate, nor its lamp, as on the Bolones
      rearMarks: [],
      mudflaps: { x: 0.55, w: [0.54, 0.87], y: [0.15, 0.47] },
      frame: { x: [1.5, 3.3], half: 0.42, y: [0.36, 0.465] },
    },
    // a lorry's: tall heads well out on two arms from each front door's front edge, beside the
    // corner windows (232 x 145 mm, as drawn)
    mirrors: {
      sides: [-1, 1],
      head: [0.145, 0.232],
      depth: 0.04,
      corners: 0.02,
      centre: [3.7, 1.56, 1.03],
      arms: [
        [
          [3.62, 1.66, 0.81],
          [3.7, 1.63, 0.97],
        ],
        [
          [3.62, 1.46, 0.84],
          [3.7, 1.49, 0.97],
        ],
      ],
      arm: 0.022,
    },
    // plain bars wrapped round the corners
    bumpers: {
      front: {
        y: 0.575,
        height: 0.13,
        plan: [
          [0, 0],
          [0.7, 0.005],
          [0.8, 0.03],
          [0.86, 0.09],
          [0.885, 0.25],
        ],
      },
      rear: {
        y: 0.525,
        height: 0.11,
        plan: [
          [0, 0.035],
          [0.7, 0.04],
          [0.8, 0.06],
          [0.86, 0.11],
          [0.885, 0.22],
        ],
      },
    },
  },
  honeker: {
    label: "Honeker",
    mass: 2100,
    // traced from blueprints (side, front and rear views) of the long one with the hardtop,
    // without the fire brigade's beacon; scaled to its 2.827 m wheelbase. x = 0: the spare wheel's
    // back
    length: 4.51,
    width: 1.83,
    wheel: {
      radius: 0.379,
      width: 0.2,
      // a steel wheel: five holes round a small hubcap
      rim: {
        radius: 0.555,
        hub: 0.2,
        holes: { count: 5, at: 0.3, size: [0.08, 0.11], round: 0.45, turn: 0.25 },
      },
      axles: [0.918, 3.745],
      track: [1.58, 1.6],
      // trapezoids, high over the tyres; the front one's front foot on the higher sill there
      arches: [
        [
          [0.505, 0.568],
          [0.745, 0.866],
          [1.156, 0.866],
          [1.358, 0.568],
        ],
        [
          [3.268, 0.568],
          [3.502, 0.963],
          [3.951, 0.963],
          [4.13, 0.741],
        ],
      ],
      archRound: 0.06,
    },
    body: {
      // the belt from the rear face to the windscreen, the bonnet down to the front
      top: [
        [0.21, 1.318],
        [3.362, 1.318],
        [4.329, 1.272],
        [4.345, 1.255],
        [4.354, 1.21],
      ],
      shoulder: [
        [0.21, 1.318],
        [3.362, 1.318],
        [4.329, 1.27],
        [4.345, 1.25],
        [4.354, 1.205],
      ],
      waist: [
        [0.21, 1.19],
        [4.354, 1.19],
      ],
      // the sill, up over the front bumper
      bottom: [
        [0.21, 0.568],
        [4.1, 0.568],
        [4.14, 0.741],
        [4.354, 0.741],
      ],
      // square at the rear: the flat rear runs on up the cabin
      width: [
        [0.21, 0.9],
        [4.31, 0.9],
        [4.354, 0.885],
      ],
      shoulderInset: 0.043,
      tuck: 0.01,
      flares: 0.03,
      seams: [2.319, 3.241],
    },
    // the hardtop: a flat windscreen, a header over it up to the roof, the rear face upright (`rear`)
    cabin: {
      outline: [
        [3.362, 1.318],
        [3.074, 1.83],
        [2.985, 2.018],
        [2.309, 2.101],
        [0.21, 2.07],
        [0.21, 1.318],
      ],
      base: 0.857,
      roof: 0.82,
      crown: 0.03,
      windscreen: [
        [3.362, 1.318],
        [3.074, 1.83],
      ],
      windowCorners: 0.035,
      frame: 0.05,
    },
    // the front door's, split; the two behind it, split each
    windows: [
      [
        [3.186, 1.473],
        [2.981, 1.867],
        [2.642, 1.867],
        [2.642, 1.473],
      ],
      [
        [2.597, 1.867],
        [2.342, 1.867],
        [2.342, 1.473],
        [2.597, 1.473],
      ],
      [
        [2.033, 1.905],
        [1.644, 1.905],
        [1.644, 1.49],
        [2.033, 1.49],
      ],
      [
        [1.626, 1.905],
        [1.3, 1.905],
        [1.3, 1.49],
        [1.626, 1.49],
      ],
      [
        [1.148, 1.905],
        [0.77, 1.905],
        [0.77, 1.49],
        [1.148, 1.49],
      ],
      [
        [0.755, 1.905],
        [0.436, 1.905],
        [0.436, 1.49],
        [0.755, 1.49],
      ],
    ],
    sideMarks: [],
    // round headlamps in square housings, indicators under them, a barred grille each side of the
    // badge
    lamps: [{ x: 0.718, y: 1.059, w: 0.19, h: 0.19, round: 0.5, depth: 0.03 }],
    frontMarks: [
      { x: 0.71, y: 1.055, w: 0.33, h: 0.237, depth: 0.02 },
      { x: 0.745, y: 0.798, w: 0.141, h: 0.062, depth: 0.01 },
      { x: 0.276, y: 1.056, w: 0.478, h: 0.217, bars: 10 },
      { x: 0, y: 1.06, w: 0.07, h: 0.093 },
    ],
    // the tail lamps are on the bumper
    rearMarks: [],
    // the door with its window, a narrow window each side of it
    rear: {
      door: { w: 0.886, y: [0.778, 2.033] },
      windows: [
        { x: 0.667, y: 1.688, w: 0.254, h: 0.566, round: 0.15 },
        { x: 0, y: 1.72, w: 0.706, h: 0.544, round: 0.1 },
      ],
    },
    decals: [
      // the rear door's handle; no hinges, no number plate nor its lamp, as on the Bolones
      { view: "rear", side: -1, shape: { x: 0.41, y: 1.235, w: 0.06, h: 0.055, round: 0.3 } },
      // the trim strips along the sides, the door's lower one
      { view: "side", shape: { x: 1.263, y: 1.103, w: 2.066, h: 0.041 } },
      { view: "side", shape: { x: 2.776, y: 1.103, w: 0.885, h: 0.041 } },
      { view: "side", shape: { x: 3.763, y: 1.11, w: 0.98, h: 0.041 } },
      { view: "side", shape: { x: 2.786, y: 0.914, w: 0.732, h: 0.033, round: 0.5 } },
      // the door handle, the fuel flap and the box under it, the indicator on the wing, the vent
      // by the windscreen
      { view: "side", shape: { x: 2.412, y: 1.244, w: 0.144, h: 0.068, round: 0.3 } },
      { view: "side", shape: { x: 2.212, y: 0.951, w: 0.152, h: 0.165, round: 0.15 } },
      { view: "side", shape: { x: 2.212, y: 0.792, w: 0.128, h: 0.111 } },
      { view: "side", shape: { x: 4.13, y: 1.006, w: 0.078, h: 0.045, round: 0.3 } },
      { view: "side", shape: { x: 3.43, y: 1.285, w: 0.095, h: 0.034 } },
      // the lockers low on the sides
      {
        view: "side",
        shape: { x: 1.696, y: 0.903, w: 0.354, h: 0.235, round: 0.25 },
        raise: 0.015,
      },
      {
        view: "side",
        shape: { x: 0.416, y: 0.885, w: 0.354, h: 0.263, round: 0.25 },
        raise: 0.015,
      },
    ],
    // tall heads on two arms from each front door's front edge
    mirrors: {
      sides: [-1, 1],
      head: [0.148, 0.25],
      depth: 0.05,
      corners: 0.02,
      centre: [3.1, 1.54, 1.023],
      arms: [
        [
          [3.1, 1.19, 0.89],
          [3.1, 1.42, 1.0],
        ],
        [
          [3.07, 1.33, 0.85],
          [3.1, 1.42, 0.97],
        ],
      ],
      arm: 0.022,
    },
    spare: { y: 1.16 },
    // a tube round each headlamp and indicator, stayed back to the front
    guard: {
      tubes: [
        [
          [4.354, 1.174, 0.826],
          [4.407, 1.174, 0.826],
          [4.407, 0.761, 0.826],
          [4.407, 0.761, 0.665],
          [4.407, 0.897, 0.603],
          [4.407, 1.174, 0.603],
          [4.354, 1.174, 0.603],
        ],
        [
          [4.407, 0.761, 0.745],
          [4.354, 0.761, 0.745],
        ],
      ],
      thick: 0.025,
    },
    // straight bars; the tail lamps in the rear one
    bumpers: {
      front: {
        y: 0.65,
        height: 0.15,
        depth: 0.115,
        plan: [
          [0, 0],
          [0.9, 0],
        ],
      },
      rear: {
        y: 0.635,
        height: 0.12,
        plan: [
          [0, 0.152],
          [0.9, 0.152],
        ],
        marks: [{ x: 0.652, y: 0.621, w: 0.375, h: 0.085, columns: 5 }],
      },
    },
  },
};
