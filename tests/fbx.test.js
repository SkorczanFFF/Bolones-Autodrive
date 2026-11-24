// @ts-expect-error no @types/node in this browser project; the tests run in node
import fs from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ASSETS } from "../src/config.js";
import { FanFBXLoader, polygonsOf } from "../src/core/fbx.js";

/**
 * FBX PolygonVertexIndex of these polygons: the last index of each one stored as ~index.
 *
 * @param {number[][]} polygons
 */
const indices = (polygons) =>
  polygons.flatMap((polygon) => polygon.map((v, i) => (i === polygon.length - 1 ? ~v : v)));

describe("polygonsOf", () => {
  it("marks the fan diagonals of a polygon, one polygon per FBX polygon", () => {
    const { inner, polygon } = polygonsOf(
      indices([
        [0, 1, 2, 3, 4],
        [5, 6, 7],
      ]),
    );
    // fan (0, 1, 2), (0, 2, 3), (0, 3, 4); bit k is the edge opposite corner k
    expect([...inner]).toEqual([0b010, 0b110, 0b100, 0]);
    expect([...polygon]).toEqual([0, 0, 0, 1]);
  });

  it("joins triangles over the edges 3ds Max exported as hidden", () => {
    // two triangles on the edge 1-2; Edges lists 0-1, 1-2, 2-0, 1-3, 3-2 by their first vertex
    const { inner, polygon } = polygonsOf(
      indices([
        [0, 1, 2],
        [1, 3, 2],
      ]),
      [0, 1, 2, 3, 4],
      [1, 0, 1, 1, 1],
    );
    expect([...inner]).toEqual([0b001, 0b010]); // 1-2: edge b-c of the first, c-a of the second
    expect(polygon[0]).toBe(polygon[1]);
  });
});

describe("FanFBXLoader", () => {
  it("gives every model mesh its polygons, one entry per loaded triangle", () => {
    for (const url of Object.values(ASSETS.models)) {
      const file = fs.readFileSync(`public/${url}`);
      const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
      new FanFBXLoader().parse(buffer, "").traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const { polygons } = object.geometry.userData;
        expect(polygons.inner.length * 3, url).toBe(object.geometry.getAttribute("position").count);
      });
    }
  });
});
