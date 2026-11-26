import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createDebris } from "../src/scene/debris.js";

describe("debris", () => {
  it("falls to the road, stays above it and fades out", () => {
    const debris = createDebris(17.7);
    debris.burst(new THREE.Vector3(0, 1, 0), {
      count: 20,
      velocity: new THREE.Vector3(0, 0, 10),
      spread: 8,
      color: new THREE.Color(1, 1, 1),
      size: 0.5,
      life: 1,
    });
    const position = debris.object.geometry.getAttribute("position");
    const color = debris.object.geometry.getAttribute("color");
    expect(position.count).toBe(20 * 3);

    for (let t = 0; t < 1; t += 1 / 60) debris.update(1 / 60);
    for (let i = 0; i < position.count; i++) {
      expect(position.getY(i)).toBeGreaterThan(-0.5); // bounced, not through the road
    }
    for (let t = 0; t < 1; t += 1 / 60) debris.update(1 / 60);
    expect(Math.max(...color.array)).toBe(0);
  });

  it("leaves lasting shards lying on the road", () => {
    const debris = createDebris(17.7);
    debris.burst(new THREE.Vector3(0, 1, 0), {
      count: 10,
      velocity: new THREE.Vector3(0, 0, 10),
      spread: 8,
      color: new THREE.Color(1, 1, 1),
      size: 0.5,
      life: Infinity,
    });
    for (let t = 0; t < 10; t += 1 / 60) debris.update(1 / 60);
    const position = debris.object.geometry.getAttribute("position");
    const lying = position.clone();
    debris.update(1 / 60);
    for (let i = 0; i < position.count; i++) expect(position.getY(i)).toBeCloseTo(lying.getY(i), 6);
    expect(Math.min(...debris.object.geometry.getAttribute("color").array)).toBeGreaterThan(0);
  });

  it("sends the GPU only the shards still moving, its buffers kept from burst to burst", () => {
    const debris = createDebris(17.7);
    const burst = (/** @type {number} */ count) =>
      debris.burst(new THREE.Vector3(0, 1, 0), {
        count,
        velocity: new THREE.Vector3(0, 0, 10),
        spread: 8,
        color: new THREE.Color(1, 1, 1),
        size: 0.5,
        life: Infinity,
      });
    const { geometry } = debris.object;
    const points = () => /** @type {THREE.BufferAttribute} */ (geometry.getAttribute("position"));
    burst(10);
    for (let t = 0; t < 10; t += 1 / 60) debris.update(1 / 60);
    const position = points();
    const { version } = position;
    debris.update(1 / 60);
    expect(position.version).toBe(version); // all lying on the road: nothing sent again
    burst(5); // 15: the buffers grow, with room to spare
    const grown = points();
    expect(grown).not.toBe(position);
    burst(5); // 20: room for it
    expect(geometry.getAttribute("position")).toBe(grown);
    expect(geometry.drawRange.count).toBe(20 * 3);
    const sent = grown.version;
    debris.update(1 / 60);
    expect(grown.version).toBeGreaterThan(sent); // the new ones, and the old ones moved up
  });
});
