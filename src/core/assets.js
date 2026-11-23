import * as THREE from "three";
import { FanFBXLoader } from "./fbx.js";

/**
 * @typedef {object} Manifest
 * @property {Record<string, string>} [models] key -> FBX url
 * @property {Record<string, string>} [textures] key -> image url
 */

/**
 * Loads every asset exactly once through a single LoadingManager.
 *
 * @param {Manifest} manifest
 * @param {THREE.LoadingManager} [manager] pass one in to observe progress
 * @returns {Promise<{ models: Record<string, THREE.Group>, textures: Record<string, THREE.Texture> }>}
 */
export async function loadAssets(manifest, manager = new THREE.LoadingManager()) {
  const [models, textures] = await Promise.all([
    loadAll(new FanFBXLoader(manager), manifest.models),
    loadAll(new THREE.TextureLoader(manager), manifest.textures),
  ]);
  return { models, textures };
}

/**
 * @template T
 * @param {{ loadAsync(url: string): Promise<T> }} loader
 * @param {Record<string, string>} [entries]
 * @returns {Promise<Record<string, T>>}
 */
async function loadAll(loader, entries = {}) {
  const loaded = await Promise.all(
    Object.entries(entries).map(async ([key, url]) => [key, await loader.loadAsync(url)]),
  );
  return Object.fromEntries(loaded);
}
