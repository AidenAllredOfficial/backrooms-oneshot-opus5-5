// src/textures/programs.ts — GPU plumbing shared by the texture baker and the GPU checks (WP8).
//
// A Generator owns one RawShaderMaterial per layer recipe (uOut is an int uniform: 0 HEIGHT, 1 ALBEDO, 2 ORMH),
// the Sobel normal program, the grime / water / cookie programs, the scratch height target and the signage
// canvases. All programs are compiled together with renderer.compileAsync (KHR_parallel_shader_compile).

import * as THREE from 'three';
import { MAT_COUNT, Mat } from '../core/ids.ts';
import { LAYER_DEFS, layerRepeatY } from '../core/materials.ts';
import { COOKIE_FRAGMENT } from './cookie.ts';
import { buildRecipeFragment, FULLSCREEN_VERTEX, NORMAL_FRAGMENT, OUT_ALBEDO, OUT_HEIGHT, OUT_ORMH } from './glsl/common.ts';
import { GRIME_FRAGMENT } from './grime.ts';
import { LAYER_RECIPES_FULL } from './registry.ts';
import { drawSignageAtlas } from './signage.ts';
import { WATER_NORMALS_FRAGMENT } from './waterNormals.ts';

export { OUT_ALBEDO, OUT_HEIGHT, OUT_ORMH };

/** Full-screen triangle drawer. `draw` renders `mat` into `target` (array layer `layer`) with its viewport. */
export interface Blitter {
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  readonly geometry: THREE.BufferGeometry;
  draw(mat: THREE.Material, target: THREE.WebGLRenderTarget | null, layer?: number): void;
  dispose(): void;
}

export function createBlitter(renderer: THREE.WebGLRenderer): Blitter {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  const scene = new THREE.Scene();
  scene.matrixWorldAutoUpdate = false;
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return {
    scene, camera, geometry,
    draw(mat, target, layer = 0) {
      mesh.material = mat;
      renderer.setRenderTarget(target, layer);
      renderer.render(scene, camera);
    },
    dispose() { geometry.dispose(); },
  };
}

/** Full-screen generator material (GLSL 3.00, no depth, no blending). */
export const rawMaterial = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.RawShaderMaterial =>
  new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });

export interface Generator {
  readonly size: number;
  readonly blit: Blitter;
  /** Height of the layer being generated: HalfFloat R, or RGBA8 with 16-bit packed height when the context
   * cannot render to float colour buffers (`packedScratch`). */
  readonly scratch: THREE.WebGLRenderTarget;
  readonly packedScratch: boolean;
  readonly recipes: readonly THREE.RawShaderMaterial[]; // index = MatId
  readonly normal: THREE.RawShaderMaterial;
  readonly grime: THREE.RawShaderMaterial;
  readonly water: THREE.RawShaderMaterial;
  readonly cookie: THREE.RawShaderMaterial;
  /** Compile every program (29 layer programs + normal + grime/water/cookie) in parallel; returns elapsed ms. */
  compile(): Promise<number>;
  /** Draw pass `out` of layer L into `target` (array layer `layer`); `origin` offsets the texel coordinates. */
  pass(L: number, out: number, target: THREE.WebGLRenderTarget | null, layer?: number, originX?: number, originY?: number): void;
  /** Normal pass of layer L (reads the scratch height) into `target`. */
  normalPass(L: number, target: THREE.WebGLRenderTarget | null, layer?: number): void;
  /** Standalone generator draw (grime/water/cookie) at resolution res. */
  standalone(mat: THREE.RawShaderMaterial, target: THREE.WebGLRenderTarget, res: number): void;
  dispose(): void;
}

let forcePackedScratch = false;
/** Test hook (harness `packh=1`): use the packed RGBA8 height scratch even when float colour buffers exist. */
export function setForcePackedScratch(on: boolean): void { forcePackedScratch = on; }

/** True when a HalfFloat colour attachment is renderable (WebGL2 + EXT_color_buffer_float, or the half-float
 * extension some implementations expose instead). */
export function scratchFloatRenderable(renderer: THREE.WebGLRenderer): boolean {
  if (forcePackedScratch) return false;
  const ext = renderer.extensions;
  return ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
}

/** The height scratch of a generator: HalfFloat R, or RGBA8 with 16-bit packed height (`packed`) when the context
 * cannot render to float colour buffers. Nearest filtering, repeat wrap (the Scharr / cavity taps wrap). */
export function createHeightScratch(renderer: THREE.WebGLRenderer, size: number): { scratch: THREE.WebGLRenderTarget; packed: boolean } {
  const packed = !scratchFloatRenderable(renderer);
  const scratch = new THREE.WebGLRenderTarget(size, size, {
    type: packed ? THREE.UnsignedByteType : THREE.HalfFloatType,
    format: packed ? THREE.RGBAFormat : THREE.RedFormat,
    colorSpace: THREE.NoColorSpace, depthBuffer: false, stencilBuffer: false,
    generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
  });
  if (packed) console.warn('[textures] no float colour buffers: height scratch falls back to packed RGBA8');
  return { scratch, packed };
}

export function createGenerator(renderer: THREE.WebGLRenderer, size: number): Generator {
  const blit = createBlitter(renderer);
  const { scratch, packed: packedScratch } = createHeightScratch(renderer, size);
  const dummy = new THREE.DataTexture(new Uint8Array([128, 0, 0, 255]), 1, 1);
  dummy.needsUpdate = true;

  // signage artwork (SIGNAGE recipe samplers)
  const canv = drawSignageAtlas(size);
  const signColor = new THREE.CanvasTexture(canv.color as HTMLCanvasElement);
  signColor.colorSpace = THREE.SRGBColorSpace;
  const signMask = new THREE.CanvasTexture(canv.mask as HTMLCanvasElement);
  signMask.colorSpace = THREE.NoColorSpace;
  for (const t of [signColor, signMask]) {
    t.flipY = true; // canvas top -> high v
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
  }

  // shared uniform objects (same object in every recipe material)
  const uOut = { value: 0 };
  const uRes = { value: size };
  const uOrigin = { value: new THREE.Vector2() };
  const uScratch: THREE.IUniform<THREE.Texture> = { value: dummy };
  const uHPackIn = { value: packedScratch ? 1 : 0 };
  const uHPackOut = { value: 0 };

  const recipes = LAYER_RECIPES_FULL.map((r) => {
    const d = LAYER_DEFS[r.layer];
    const frag = buildRecipeFragment({
      layer: r.layer, frame: [d.repeat, layerRepeatY(d)], albedo: d.albedoMean, rough: d.roughness, metal: d.metal, trim: r.trim,
    }, r.glsl);
    const uniforms: Record<string, THREE.IUniform> = { uOut, uRes, uOrigin, uScratch, uHPackIn, uHPackOut, uHeightM: { value: r.heightScale } };
    if (r.layer === Mat.SIGNAGE) {
      uniforms.uSignColor = { value: signColor };
      uniforms.uSignMask = { value: signMask };
    }
    const m = rawMaterial(frag, uniforms);
    m.name = `br-tex-${d.name}`;
    return m;
  });
  const normal = rawMaterial(NORMAL_FRAGMENT, {
    uScratch: { value: scratch.texture }, uRes, uOrigin, uHPackIn, uTexelM: { value: new THREE.Vector2() }, uScale: { value: 1 },
  });
  normal.name = 'br-tex-normal';
  const sRes = { value: 512 };
  const sOrigin = { value: new THREE.Vector2() };
  const grime = rawMaterial(GRIME_FRAGMENT, { uRes: sRes, uOrigin: sOrigin });
  const water = rawMaterial(WATER_NORMALS_FRAGMENT, { uRes: sRes, uOrigin: sOrigin });
  const cookie = rawMaterial(COOKIE_FRAGMENT, { uRes: sRes, uOrigin: sOrigin });
  grime.name = 'br-tex-grime'; water.name = 'br-tex-water'; cookie.name = 'br-tex-cookie';

  const all: THREE.RawShaderMaterial[] = [...recipes, normal, grime, water, cookie];

  return {
    size, blit, scratch, packedScratch, recipes, normal, grime, water, cookie,
    async compile() {
      const scene = new THREE.Scene();
      for (const m of all) {
        const mesh = new THREE.Mesh(blit.geometry, m);
        mesh.frustumCulled = false;
        scene.add(mesh);
      }
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(scratch); // compile with a render target bound, as drawn
      const t0 = performance.now();
      await renderer.compileAsync(scene, blit.camera);
      const ms = performance.now() - t0;
      renderer.setRenderTarget(prev);
      return ms;
    },
    pass(L, out, target, layer = 0, originX = 0, originY = 0) {
      uOut.value = out;
      uRes.value = size;
      uOrigin.value.set(originX, originY);
      // never bind the scratch as a sampler while it is the render target (feedback loop)
      uScratch.value = out === OUT_HEIGHT ? dummy : scratch.texture;
      // packed height only goes into the RGBA8 scratch; other HEIGHT consumers (seam check rows) get plain r
      uHPackOut.value = packedScratch && out === OUT_HEIGHT && target === scratch ? 1 : 0;
      blit.draw(recipes[L], target, layer);
    },
    normalPass(L, target, layer = 0) {
      const d = LAYER_DEFS[L];
      const r = LAYER_RECIPES_FULL[L];
      uRes.value = size;
      uOrigin.value.set(0, 0);
      (normal.uniforms.uTexelM.value as THREE.Vector2).set(d.repeat / size, layerRepeatY(d) / size);
      normal.uniforms.uScale.value = r.heightScale * r.normalStrength;
      blit.draw(normal, target, layer);
    },
    standalone(mat, target, res) {
      sRes.value = res;
      sOrigin.value.set(0, 0);
      blit.draw(mat, target, 0);
    },
    dispose() {
      for (const m of all) m.dispose();
      scratch.dispose();
      dummy.dispose();
      signColor.dispose();
      signMask.dispose();
      blit.dispose();
    },
  };
}

export const LAYER_COUNT = MAT_COUNT;
