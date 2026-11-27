import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { BLOOM, WIRE } from "../config.js";

const mixShader = {
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D baseTexture;
    uniform sampler2D bloomTexture;
    varying vec2 vUv;
    void main() {
      gl_FragColor = texture2D(baseTexture, vUv) + vec4(texture2D(bloomTexture, vUv).rgb, 0.0);
    }
  `,
};

/**
 * Selective bloom: only objects on BLOOM.layer (the wireframe twins) glow, each as strong as its
 * material's `userData.glow` (0..1, per layer; dimmer lines are drawn with dimmed copies). The
 * scene is drawn once, into a multisampled target; the glow pass then draws only what is on the
 * layer (the lights are on it too), against that pass's depth, so the solids hide the lines
 * behind them without being drawn again; with black fog and no background (far lines glow less,
 * the sky not at all). The result is blurred and added to the normal render.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 */
export function createBloom(renderer, scene, camera) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const depth = new THREE.DepthTexture(size.x, size.y);
  // multisampled like the canvas (the renderer is created with antialias), its depth resolved into
  // `depth`, which the glow pass tests against
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: 4,
    depthTexture: depth,
  });
  const lines = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    depthTexture: depth,
  });
  const glow = new UnrealBloomPass(size, BLOOM.strength, BLOOM.radius, 0);
  const mix = new FullScreenQuad(
    new THREE.ShaderMaterial({
      ...mixShader,
      uniforms: {
        baseTexture: { value: target.texture },
        bloomTexture: { value: lines.texture },
      },
    }),
  );

  /** @type {Map<THREE.Mesh, THREE.Material | THREE.Material[]>} */
  const swapped = new Map();
  const fogColor = new THREE.Color();
  /** @type {WeakMap<THREE.Material, THREE.Material & { color: THREE.Color }>} */
  const dimmed = new WeakMap();

  /**
   * @param {THREE.Material & { color: THREE.Color }} material
   * @param {number} factor
   */
  function dimmedFor(material, factor) {
    let dim = dimmed.get(material);
    if (!dim) {
      dim = /** @type {THREE.Material & { color: THREE.Color }} */ (material.clone());
      // clone() carries a class's shader changes, not ones set on the material itself
      dim.onBeforeCompile = material.onBeforeCompile;
      dimmed.set(material, dim);
    }
    dim.color.copy(material.color).multiplyScalar(factor); // follows GUI color changes
    dim.opacity = material.opacity;
    dim.visible = material.visible;
    return dim;
  }

  /** Lines glowing less than fully: their dimmed copies. @param {THREE.Object3D} object */
  function dim(object) {
    if (!(object instanceof THREE.Mesh)) return;
    const { material } = object;
    if (!object.layers.isEnabled(BLOOM.layer) || Array.isArray(material)) return;
    const factor = material.userData.glow ?? WIRE.glow;
    if (factor >= 1 || !("color" in material)) return;
    swapped.set(object, material);
    object.material = dimmedFor(/** @type {any} */ (material), factor);
  }

  return {
    /** Switched from the GUI and with G. */
    enabled: BLOOM.enabled,

    get strength() {
      return glow.strength;
    },
    set strength(value) {
      glow.strength = value;
    },
    get radius() {
      return glow.radius;
    },
    set radius(value) {
      glow.radius = value;
    },

    /** @param {number} width @param {number} height drawing buffer size */
    setSize(width, height) {
      target.setSize(width, height);
      lines.setSize(width, height);
      glow.setSize(width, height);
    },

    render() {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);

      const { background } = scene;
      const fog = /** @type {THREE.Fog | null} */ (scene.fog);
      const { mask } = camera.layers;
      scene.traverse(dim);
      scene.background = null;
      if (fog) (fogColor.copy(fog.color), fog.color.set(0x000000));
      camera.layers.set(BLOOM.layer);
      // lines only: no shadows to draw (the pass above did), the depth of the scene kept
      const { shadowMap } = renderer;
      const [updating, clearDepth] = [shadowMap.autoUpdate, renderer.autoClearDepth];
      shadowMap.autoUpdate = renderer.autoClearDepth = false;
      renderer.setRenderTarget(lines);
      renderer.render(scene, camera);
      shadowMap.autoUpdate = updating;
      renderer.autoClearDepth = clearDepth;

      camera.layers.mask = mask;
      for (const [object, material] of swapped) object.material = material;
      swapped.clear();
      scene.background = background;
      if (fog) fog.color.copy(fogColor);

      // blurred, added onto the lines (no write buffer)
      glow.render(renderer, lines, lines, 0, false);
      renderer.setRenderTarget(null);
      mix.render(renderer);
    },
  };
}
