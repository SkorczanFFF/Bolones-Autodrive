import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  BasicLineMaterial,
  lineGeometry,
  polygonLineGeometry,
  writeWireEdges,
  HIDDEN,
} from "../src/scene/lines.js";
import { addWireframe } from "../src/scene/wire.js";

/** Right triangle with legs 3 and 4 (hypotenuse 5). */
function triangle() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 3, 0, 0, 0, 4, 0], 3),
  );
  return geometry;
}

/**
 * Unit squares in the xy plane at these corners, as the FBX loader gives them: each one a fan
 * (0, 1, 2), (0, 2, 3) whose diagonal 0-2 lies inside the polygon, each one a part of its own.
 *
 * @param {number[][]} corners
 */
function quads(corners) {
  const positions = corners.flatMap(([x, y]) => {
    const [p0, p1, p2, p3] = [
      [x, y, 0],
      [x + 1, y, 0],
      [x + 1, y + 1, 0],
      [x, y + 1, 0],
    ];
    return [...p0, ...p1, ...p2, ...p0, ...p2, ...p3];
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.userData.polygons = {
    inner: Uint8Array.from(corners.flatMap(() => [0b010, 0b100])), // c-a, then a-b
    polygon: Uint32Array.from(corners.flatMap((_, i) => [i, i])),
    part: Uint32Array.from(corners.flatMap((_, i) => [i, i])),
  };
  return geometry;
}

describe("polygon lines", () => {
  it("hide the diagonal of a quad and fade by the size of the quad", () => {
    const edge = polygonLineGeometry(quads([[0, 0]])).getAttribute("wireEdge");
    for (let v = 0; v < 3; v++) {
      expect(edge.getY(v)).toBeGreaterThanOrEqual(HIDDEN);
      expect(edge.getZ(3 + v)).toBeGreaterThanOrEqual(HIDDEN);
    }
    expect(edge.getX(0)).toBeCloseTo(1); // the sides of the square stay
    expect(edge.getZ(2)).toBeCloseTo(1);
    expect(edge.getW(0)).toBeCloseTo(0.5); // 2 * area / perimeter of the square
    expect(edge.getW(5)).toBeCloseTo(0.5);
  });

  it("share the source's attributes, once per source", () => {
    const geometry = quads([[0, 0]]);
    const lines = polygonLineGeometry(geometry);
    expect(lines.getAttribute("position")).toBe(geometry.getAttribute("position"));
    expect(geometry.hasAttribute("wireEdge")).toBe(false);
    expect(polygonLineGeometry(geometry)).toBe(lines);
  });

  it("apply to the listed parts only, the others keep their triangles", () => {
    const geometry = quads([
      [0, 0],
      [5, 0],
    ]);
    const edge = polygonLineGeometry(geometry, { parts: [1] }).getAttribute("wireEdge");
    expect(edge.getY(0)).toBeLessThan(HIDDEN); // part 0: the diagonal stays
    expect(edge.getW(0)).toBeCloseTo((2 - Math.SQRT2) / 2); // as does the triangle's inradius
    expect(edge.getY(6)).toBeGreaterThanOrEqual(HIDDEN); // part 1: a quad
  });

  it("fall back to triangle lines without polygons", () => {
    const geometry = triangle();
    expect(polygonLineGeometry(geometry)).toBe(lineGeometry(geometry));
  });
});

describe("line geometry", () => {
  it("stores each vertex's distance to the opposite edge and the inradius", () => {
    const edge = lineGeometry(triangle()).getAttribute("wireEdge");
    // vertex 0 (right angle) to the hypotenuse: 3 * 4 / 5
    expect(edge.getX(0)).toBeCloseTo(2.4);
    expect(edge.getY(1)).toBeCloseTo(3); // vertex 1 (3, 0) to the leg along y
    expect(edge.getZ(2)).toBeCloseTo(4); // vertex 2 (0, 4) to the leg along x
    expect(edge.getY(0)).toBe(0); // edges through a vertex are at distance 0
    expect(edge.getW(0)).toBeCloseTo(1); // inradius = 2 * 6 / 12
    expect(edge.getW(2)).toBeCloseTo(1);
  });

  it("un-indexes indexed geometry and prepares each source geometry once", () => {
    const box = new THREE.BoxGeometry();
    const prepared = lineGeometry(box);
    expect(prepared).not.toBe(box);
    expect(prepared.index).toBeNull();
    expect(lineGeometry(box)).toBe(prepared);
  });

  it("hides the edge opposite the second vertex for quad grids", () => {
    const geometry = triangle();
    writeWireEdges(geometry, { hideDiagonals: true });
    const edge = geometry.getAttribute("wireEdge");
    for (let v = 0; v < 3; v++) expect(edge.getY(v)).toBeGreaterThanOrEqual(HIDDEN); // never near a line
    expect(edge.getY(1) - edge.getY(0)).toBeCloseTo(3); // still linear: the shader needs dFdx
    expect(edge.getX(0)).toBeCloseTo(2.4); // the other edges as without hiding
    expect(edge.getZ(2)).toBeCloseTo(4);
    expect(edge.getW(0)).toBeCloseTo(1);
  });

  it("keeps the wireEdge of a generator and rewrites it in place", () => {
    const geometry = triangle();
    writeWireEdges(geometry, { hideDiagonals: true });
    const attribute = geometry.getAttribute("wireEdge");
    expect(lineGeometry(geometry)).toBe(geometry);
    expect(attribute.getY(0)).toBeGreaterThanOrEqual(HIDDEN);

    geometry.getAttribute("position").setY(2, 8); // the generator moved a vertex
    writeWireEdges(geometry);
    expect(geometry.getAttribute("wireEdge")).toBe(attribute); // same buffer, no reallocation
    expect(attribute.getZ(2)).toBeCloseTo(8);
    expect(attribute.getY(0)).toBe(0);
  });

  it("wires meshes with the prepared geometry for line materials", () => {
    const mesh = new THREE.Mesh(triangle(), new THREE.MeshBasicMaterial());
    addWireframe(mesh, new BasicLineMaterial());
    const wire = /** @type {THREE.Mesh} */ (mesh.children[0]);
    expect(wire.geometry.getAttribute("wireEdge")).toBeDefined();
  });

  it("wires meshes with polygon lines when the material asks for them", () => {
    const mesh = new THREE.Mesh(quads([[0, 0]]), new THREE.MeshBasicMaterial());
    const material = new BasicLineMaterial();
    material.userData.wirePolygons = true;
    addWireframe(mesh, material);
    const wire = /** @type {THREE.Mesh} */ (mesh.children[0]);
    expect(wire.geometry).toBe(polygonLineGeometry(mesh.geometry));
  });

  it("line materials survive clone() (fade-in copies)", () => {
    const material = new BasicLineMaterial({ color: 0xff0000 });
    const copy = material.clone();
    expect(copy).toBeInstanceOf(BasicLineMaterial);
    expect(copy.transparent).toBe(true);
    expect(copy.side).toBe(THREE.DoubleSide);
    expect(copy.lineUniforms).toBe(material.lineUniforms); // GUI changes reach fading copies
    expect(copy.customProgramCacheKey()).toBe(material.customProgramCacheKey());
  });
});
