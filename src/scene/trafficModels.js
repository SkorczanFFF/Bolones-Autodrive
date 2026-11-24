/**
 * The minigame's oncoming cars (scene/traffic.js builds them), traced from blueprints in metres.
 * Model data, not configuration, so it lives next to the code that reads it. Side views: x from
 * the car's rear end to the front, y up from the ground; front and rear views: offset from the
 * centre line (mirrored to the other side when not 0), y up.
 */

/**
 * @typedef {[number, number]} Point
 * @typedef {{ x: number, y: number, w: number, h: number, round?: number, bars?: number }} Mark a
 *   front or rear view rectangle: centre, size, corner cut (0.5: an ellipse), horizontal bars
 * @typedef {object} Bumper
 * @property {number} y centre height
 * @property {number} height
 * @property {Point[]} plan the outer edge in the top view, [across, back from the car's end],
 *   from the centre to one end (mirrored to the other)
 * @property {{ x: number, width: number, y: [number, number] }} [guards] vertical overriders at
 *   ±x, from y[0] to y[1], from the car's end back through the bar
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
 * @property {number} width overall: the lanes keep clear of it
 * @property {{ radius: number, width: number, axles: number[], track: number[], arches: Point[], rim: Rim }} wheel
 *   tyres; per axle (rear, front): x, track and wheel arch (half an ellipse: half its length, its
 *   height above the wheel centre)
 * @property {object} body the lower body, sides and deck (scene/traffic.js lowerBody)
 * @property {Point[]} body.top deck centre line (side view), from the rear end to the front end
 * @property {Point[]} body.shoulder top edge of the sides
 * @property {Point[]} body.waist the widest line along the sides
 * @property {Point[]} body.bottom underside; wheel arches are cut into it
 * @property {Point[]} body.width top view: [x, half width] at the waist
 * @property {number} body.shoulderInset the shoulder is this much narrower than the waist
 * @property {number} body.tuck the underside is this much narrower than the waist
 * @property {{ lean: number, from: number }} [body.nose] the front leans forward above `from`
 *   (metres up), its top edge `lean` ahead of the face below (the grille and the lamps with it)
 * @property {number[]} body.seams x of the door edges: lines down the sides
 * @property {object} cabin greenhouse on the deck
 * @property {Point[]} cabin.outline side view, its bottom edge on the shoulders, under the deck's
 *   crown
 * @property {number} cabin.base half width at its bottom
 * @property {number} cabin.roof half width at its top
 * @property {[Point, Point]} cabin.windscreen the windscreen's slope on the outline
 * @property {[Point, Point]} cabin.rearWindow the rear window's slope on the outline
 * @property {{ windscreen: Screen, rearWindow: Screen }} [cabin.screens] how they curve; flat
 *   and square without
 * @property {number} [cabin.windowCorners] the side windows' corners rounded, metres
 * @property {number} [cabin.crown] how much higher the middle of the roof is than its edges
 * @property {Point[][]} windows side windows, inside the cabin outline
 * @property {{ outline: Point[], bars?: number }[]} sideMarks convex outlines on the body sides,
 *   cut into horizontal bars
 * @property {Mark[]} lamps headlamps (front view)
 * @property {Mark[]} frontMarks outlines on the front (front view)
 * @property {Mark[]} rearMarks outlines on the rear (rear view)
 * @property {{ front: Bumper, rear: Bumper }} bumpers
 */

/** @type {Record<string, TrafficModel>} */
export const TRAFFIC_MODELS = {
  polakito: {
    label: "Polakito",
    mass: 580,
    length: 3.054,
    width: 1.377,
    wheel: {
      radius: 0.252,
      width: 0.14,
      // a steel wheel: four round holes on the diagonals, a small hubcap
      rim: {
        radius: 0.64,
        hub: 0.18,
        holes: { count: 4, at: 0.37, size: [0.2, 0.16], round: 0.5, turn: 0.5 },
      },
      axles: [0.691, 2.53],
      track: [1.203, 1.142],
      arches: [
        [0.283, 0.283],
        [0.335, 0.335],
      ],
    },
    body: {
      // rear face, the engine lid up to the belt, the belt under the cabin, the bonnet, the nose
      top: [
        [0.054, 0.671],
        [0.204, 0.818],
        [2.332, 0.859],
        [2.416, 0.856],
        [2.552, 0.848],
        [2.688, 0.838],
        [2.789, 0.824],
        [2.878, 0.804],
        [2.945, 0.778],
        [2.986, 0.744],
        [3.006, 0.704],
      ],
      shoulder: [
        [0.054, 0.671],
        [0.204, 0.818],
        [2.212, 0.818],
        [2.28, 0.811],
        [2.552, 0.791],
        [2.789, 0.764],
        [2.925, 0.738],
        [3.006, 0.704],
      ],
      // the crease around the car at the top of the headlamps, wrapping down at the rear
      waist: [
        [0.054, 0.524],
        [0.156, 0.531],
        [0.176, 0.591],
        [0.21, 0.666],
        [3.006, 0.674],
      ],
      bottom: [
        [0.054, 0.351],
        [0.122, 0.271],
        [0.21, 0.197],
        [2.789, 0.197],
        [2.844, 0.237],
        [2.945, 0.297],
        [3.006, 0.377],
      ],
      // rounded corners front and rear
      width: [
        [0.054, 0.573],
        [0.115, 0.601],
        [0.224, 0.64],
        [0.414, 0.67],
        [0.74, 0.687],
        [1.384, 0.687],
        [2.029, 0.682],
        [2.416, 0.67],
        [2.755, 0.648],
        [2.884, 0.64],
        [2.979, 0.58],
        [3.006, 0.533],
      ],
      shoulderInset: 0.045,
      tuck: 0.051,
      seams: [1.201, 2.178],
    },
    // a fastback: the rear window runs down into the engine lid; the windscreen runs on under the
    // bonnet's crown down to the shoulder
    cabin: {
      outline: [
        [0.204, 0.818],
        [2.385, 0.807],
        [1.912, 1.272],
        [1.877, 1.308],
        [1.771, 1.328],
        [0.787, 1.328],
        [0.659, 1.294],
        [0.608, 1.224],
      ],
      base: 0.605,
      roof: 0.489,
      windscreen: [
        [2.332, 0.859],
        [1.912, 1.272],
      ],
      rearWindow: [
        [0.608, 1.224],
        [0.334, 0.948],
      ],
    },
    // quarter-light, door window, rear quarter window
    windows: [
      [
        [2.043, 0.878],
        [1.792, 1.208],
        [1.781, 1.211],
        [1.781, 0.861],
        [2.056, 0.861],
      ],
      [
        [1.753, 1.214],
        [1.276, 1.228],
        [1.237, 1.204],
        [1.237, 0.861],
        [1.753, 0.861],
      ],
      [
        [1.167, 1.204],
        [0.801, 1.198],
        [0.584, 0.924],
        [0.618, 0.864],
        [1.154, 0.861],
      ],
    ],
    // the engine's air intake behind the rear quarter window
    sideMarks: [
      {
        outline: [
          [0.584, 0.778],
          [0.434, 0.778],
          [0.38, 0.711],
          [0.543, 0.711],
        ],
        bars: 4,
      },
    ],
    // rectangular headlamps, indicators under them, a trim strip between
    lamps: [{ x: 0.45, y: 0.614, w: 0.208, h: 0.14, round: 0.25 }],
    frontMarks: [
      { x: 0.442, y: 0.472, w: 0.155, h: 0.077, round: 0.2 },
      { x: 0, y: 0.621, w: 0.642, h: 0.015 },
    ],
    // tail lamps at the corners, the number plate between them
    rearMarks: [
      { x: 0.44, y: 0.57, w: 0.11, h: 0.2 },
      { x: 0, y: 0.556, w: 0.268, h: 0.2 },
    ],
    // wrapped round the corners
    bumpers: {
      front: {
        y: 0.402,
        height: 0.07,
        plan: [
          [0, 0],
          [0.48, 0.047],
          [0.594, 0.098],
          [0.632, 0.19],
        ],
      },
      rear: {
        y: 0.367,
        height: 0.07,
        plan: [
          [0, 0],
          [0.48, 0.027],
          [0.594, 0.078],
          [0.64, 0.176],
        ],
      },
    },
  },
  kredens: {
    label: "Kredens",
    mass: 1010,
    // traced from the 1967 Fiat 125 Special's drawings (side, top, front and rear views)
    length: 4.223,
    width: 1.6,
    wheel: {
      radius: 0.285,
      width: 0.17,
      // a hubcap with eight slots round the hub
      rim: {
        radius: 0.64,
        hub: 0.13,
        holes: { count: 8, at: 0.4, size: [0.13, 0.07], round: 0.2, turn: 0 },
      },
      axles: [1.063, 3.567],
      track: [1.291, 1.313],
      arches: [
        [0.3, 0.245],
        [0.373, 0.38],
      ],
    },
    body: {
      // three boxes: the boot lid, the belt under the cabin, the bonnet rising to the scuttle
      top: [
        [0.095, 0.774],
        [0.128, 0.807],
        [0.161, 0.82],
        [0.293, 0.837],
        [0.491, 0.856],
        [0.689, 0.872],
        [0.83, 0.895],
        [3.09, 0.92],
        [3.231, 0.906],
        [3.429, 0.897],
        [3.627, 0.886],
        [3.825, 0.869],
        [3.957, 0.854],
        [4.089, 0.831],
        [4.155, 0.795],
      ],
      shoulder: [
        [0.095, 0.755],
        [0.13, 0.767],
        [0.353, 0.799],
        [0.771, 0.837],
        [0.95, 0.852],
        [1.2, 0.862],
        [1.5, 0.875],
        [2.994, 0.877],
        [3.134, 0.87],
        [3.414, 0.858],
        [3.692, 0.839],
        [3.971, 0.82],
        [4.117, 0.805],
        [4.155, 0.79],
      ],
      // the moulding along the sides, over the wheel arches
      waist: [
        [0.095, 0.69],
        [4.155, 0.735],
      ],
      bottom: [
        [0.095, 0.46],
        [0.14, 0.32],
        [0.3, 0.288],
        [3.96, 0.287],
        [4.06, 0.33],
        [4.155, 0.44],
      ],
      width: [
        [0.095, 0.715],
        [0.425, 0.729],
        [0.59, 0.743],
        [0.755, 0.77],
        [0.887, 0.783],
        [1.052, 0.791],
        [1.217, 0.795],
        [3.4, 0.795],
        [3.676, 0.788],
        [3.825, 0.772],
        [3.924, 0.755],
        [4.05, 0.74],
        [4.155, 0.7],
      ],
      shoulderInset: 0.02,
      tuck: 0.05,
      // the grille leans forward under the bonnet's edge, from its bottom up
      nose: { lean: 0.05, from: 0.635 },
      seams: [1.33, 2.094, 3.015],
    },
    // the windscreen and the rear window wrap round into slim pillars
    cabin: {
      outline: [
        [2.958, 0.878],
        [2.726, 1.269],
        [2.69, 1.29],
        [2.62, 1.3],
        [2.3, 1.306],
        [1.45, 1.302],
        [1.28, 1.3],
        [1.19, 1.29],
        [0.949, 0.878],
      ],
      base: 0.73,
      roof: 0.651,
      crown: 0.078,
      windscreen: [
        [2.958, 0.878],
        [2.726, 1.269],
      ],
      rearWindow: [
        [1.19, 1.29],
        [0.949, 0.878],
      ],
      screens: {
        windscreen: { bow: [0.135, 0.02], corners: [0.04, 0.03] },
        rearWindow: { bow: [0.12, 0], corners: [0.07, 0.03] },
      },
      windowCorners: 0.03,
    },
    // quarter-light, front door, rear door, the rear door's fixed glass round the C pillar
    windows: [
      [
        [2.901, 0.918],
        [2.636, 1.25],
        [2.64, 0.912],
      ],
      [
        [2.61, 1.262],
        [2.123, 1.266],
        [2.131, 0.894],
        [2.61, 0.899],
      ],
      [
        [2.054, 1.263],
        [1.521, 1.239],
        [1.521, 0.885],
        [2.054, 0.89],
      ],
      [
        [1.493, 1.231],
        [1.447, 1.211],
        [1.408, 1.175],
        [1.369, 1.128],
        [1.33, 1.066],
        [1.292, 1.004],
        [1.253, 0.942],
        [1.232, 0.889],
        [1.493, 0.884],
      ],
    ],
    sideMarks: [],
    // four round headlamps in the grille, indicators at the corners
    lamps: [
      { x: 0.371, y: 0.657, w: 0.167, h: 0.167, round: 0.5 },
      { x: 0.544, y: 0.657, w: 0.167, h: 0.167, round: 0.5 },
    ],
    frontMarks: [
      { x: 0, y: 0.66, w: 1.25, h: 0.22, bars: 5 },
      { x: 0.655, y: 0.684, w: 0.05, h: 0.105 },
    ],
    // tail lamps, the number plate between them
    rearMarks: [
      { x: 0.531, y: 0.628, w: 0.184, h: 0.188, round: 0.1 },
      { x: 0, y: 0.646, w: 0.389, h: 0.13 },
    ],
    // wrapped round the corners, with overriders
    bumpers: {
      front: {
        y: 0.46,
        height: 0.09,
        plan: [
          [0, 0.005],
          [0.5, 0.013],
          [0.63, 0.045],
          [0.74, 0.095],
          [0.775, 0.15],
          [0.775, 0.275],
        ],
        guards: { x: 0.556, width: 0.062, y: [0.36, 0.547] },
      },
      rear: {
        y: 0.443,
        height: 0.094,
        plan: [
          [0, 0.015],
          [0.45, 0.022],
          [0.672, 0.045],
          [0.724, 0.067],
          [0.76, 0.098],
          [0.786, 0.143],
          [0.79, 0.43],
        ],
        guards: { x: 0.528, width: 0.059, y: [0.322, 0.544] },
      },
    },
  },
};
