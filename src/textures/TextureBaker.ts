// src/textures/TextureBaker.ts — GPU generation of the 28-layer PBR texture arrays + grime/water/cookie (WP8).
//
// Procedure (DESIGN WP8):
//  - three single-attachment WebGLArrayRenderTargets (albedo SRGB8_ALPHA8, normal RGBA8, ormh RGBA8), mipmapped
//    filtering, repeat wrap, anisotropy, generateMipmaps = false until the final draw into each target;
//  - a HalfFloat R scratch target holds the height of the layer being generated (packed RGBA8 fallback when the
//    context cannot render to float colour buffers);
//  - one program per recipe (uOut int uniform) + the Sobel normal pass, all compiled up front with compileAsync;
//  - per layer: HEIGHT -> scratch, ALBEDO -> albedo[L], ORMH (cavity AO from the scratch) -> ormh[L],
//    normal (wrap-sampled Scharr over the scratch x heightScale x normalStrength) -> normal[L];
//  - yield to the main thread every 4 layers; progress reported;
//  - grime (512^2 RGBA8), water normals (512^2 RG8), cookie (256^2 RGBA8).
// Compile and generation times are logged separately (textures.compileMs / textures.genMs).

import * as THREE from 'three';
import { MAT_COUNT } from '../core/ids.ts';
import type { TextureSet } from '../core/runtime.ts';
import { COOKIE_SIZE } from './cookie.ts';
import { GRIME_SIZE } from './grime.ts';
import { createGenerator, OUT_ALBEDO, OUT_HEIGHT, OUT_ORMH } from './programs.ts';
import { WATER_NORMALS_SIZE } from './waterNormals.ts';

export interface TextureBakeStats {
  size: 512 | 1024;
  /** parallel compile of every generator program (ms) */
  compileMs: number;
  /** GPU generation of every layer + grime/water/cookie, including the per-4-layer yields (ms) */
  genMs: number;
  /** wall time of generateTextures (ms) */
  totalMs: number;
  programs: number;
  /** true when the height scratch used the packed RGBA8 fallback (no float colour buffers) */
  packedScratch: boolean;
}

let lastStats: TextureBakeStats | null = null;
/** Timings of the most recent generateTextures call (null before the first). */
export function textureBakeStats(): TextureBakeStats | null { return lastStats; }

const nextFrame = (): Promise<void> => new Promise((res) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => res());
  else setTimeout(res, 0);
});

function arrayTarget(S: number, srgb: boolean, anisotropy: number): THREE.WebGLArrayRenderTarget {
  const rt = new THREE.WebGLArrayRenderTarget(S, S, MAT_COUNT, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    anisotropy,
  });
  rt.texture.name = srgb ? 'br-albedo' : 'br-array';
  return rt;
}

function flatTarget(S: number, format: THREE.PixelFormat, wrap: THREE.Wrapping, anisotropy: number, name: string): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(S, S, {
    type: THREE.UnsignedByteType,
    format,
    colorSpace: THREE.NoColorSpace,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: wrap,
    wrapT: wrap,
    anisotropy,
  });
  rt.texture.name = name;
  return rt;
}

export async function generateTextures(renderer: THREE.WebGLRenderer, size: 512 | 1024, anisotropy: number,
  onProgress?: (fraction: number) => void): Promise<TextureSet> {
  const t0 = performance.now();
  const S = size;
  const albedoRT = arrayTarget(S, true, anisotropy);
  const normalRT = arrayTarget(S, false, anisotropy);
  const ormhRT = arrayTarget(S, false, anisotropy);
  normalRT.texture.name = 'br-normal';
  ormhRT.texture.name = 'br-ormh';
  const grimeRT = flatTarget(GRIME_SIZE, THREE.RGBAFormat, THREE.RepeatWrapping, anisotropy, 'br-grime');
  const waterRT = flatTarget(WATER_NORMALS_SIZE, THREE.RGFormat, THREE.RepeatWrapping, anisotropy, 'br-water-normals');
  const cookieRT = flatTarget(COOKIE_SIZE, THREE.RGBAFormat, THREE.ClampToEdgeWrapping, 1, 'br-cookie');

  const gen = createGenerator(renderer, S);
  const packedScratch = gen.packedScratch;
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  onProgress?.(0);

  let compileMs = 0;
  let genMs = 0;
  try {
    compileMs = await gen.compile();
    onProgress?.(0.1);

    const tg = performance.now();
    const steps = MAT_COUNT + 3;
    for (let L = 0; L < MAT_COUNT; L++) {
      const last = L === MAT_COUNT - 1;
      gen.pass(L, OUT_HEIGHT, gen.scratch);
      if (last) albedoRT.texture.generateMipmaps = true; // the final draw generates the whole mip chain
      gen.pass(L, OUT_ALBEDO, albedoRT, L);
      if (last) ormhRT.texture.generateMipmaps = true;
      gen.pass(L, OUT_ORMH, ormhRT, L);
      if (last) normalRT.texture.generateMipmaps = true;
      gen.normalPass(L, normalRT, L);
      if ((L + 1) % 4 === 0 && !last) {
        renderer.setRenderTarget(null);
        onProgress?.(0.1 + 0.9 * (L + 1) / steps);
        await nextFrame();
      }
    }
    gen.standalone(gen.grime, grimeRT, GRIME_SIZE);
    gen.standalone(gen.water, waterRT, WATER_NORMALS_SIZE);
    gen.standalone(gen.cookie, cookieRT, COOKIE_SIZE);
    renderer.setRenderTarget(null);
    // wait for the GPU so genMs measures the work, not just its submission
    const probe = new Uint8Array(4);
    renderer.readRenderTargetPixels(cookieRT, 0, 0, 1, 1, probe);
    genMs = performance.now() - tg;
  } catch (e) {
    albedoRT.dispose(); normalRT.dispose(); ormhRT.dispose();
    grimeRT.dispose(); waterRT.dispose(); cookieRT.dispose();
    throw e;
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    gen.dispose();
  }
  onProgress?.(1);

  const totalMs = performance.now() - t0;
  lastStats = { size, compileMs, genMs, totalMs, programs: MAT_COUNT + 4, packedScratch };
  console.info(`[textures] size=${size} textures.compileMs=${compileMs.toFixed(0)} textures.genMs=${genMs.toFixed(0)} total=${totalMs.toFixed(0)}`);

  return {
    size,
    albedo: albedoRT.texture,
    normal: normalRT.texture,
    ormh: ormhRT.texture,
    grime: grimeRT.texture,
    waterNormals: waterRT.texture,
    cookie: cookieRT.texture,
    dispose(): void {
      albedoRT.dispose(); normalRT.dispose(); ormhRT.dispose();
      grimeRT.dispose(); waterRT.dispose(); cookieRT.dispose();
    },
  };
}
