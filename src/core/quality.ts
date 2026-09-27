// src/core/quality.ts — quality presets. `quality=auto` resolves via WEBGL_debug_renderer_info (WP14):
// SwiftShader/llvmpipe/Software -> low; Intel/Mali/Adreno/Apple integrated -> medium; else high.

import type { LmTpc } from './constants.ts';

export type QualityName = 'low' | 'medium' | 'high' | 'ultra';
export const QUALITY_NAMES: readonly QualityName[] = ['low', 'medium', 'high', 'ultra'];

export interface QualityConfig {
  name: QualityName;
  streamRadius: number; // chunks (Chebyshev) kept resident around the player's chunk
  lmTpc: LmTpc; // lightmap texels per cell (8 -> 0.15 m, 12 -> 0.1 m); invariant LM_TEXEL <= WALL_T
  bakeShadowSamples: 1 | 2 | 4 | 6; // stratified emitter samples for PARTIAL pairs
  probeRays: 32 | 64 | 96 | 128;
  // The bake is memory-bandwidth bound: on a 16-core laptop throughput plateaus at ~4 workers (4: 3.4 s to ready,
  // 6: 3.7 s, 10: 4.3 s) while each worker costs ~155 MB, so the caps are small.
  bakeWorkers: number; // upper bound; actual = max(1, min(bakeWorkers, hardwareConcurrency - 4, max(2, deviceMemory GB))) (stream/WorkerPool poolSizeFor)
  textureSize: 512 | 1024;
  anisotropy: number;
  /** AO sample count level (post/PostStack.ts AO_SAMPLES: 8 / 10 / 12 / 16 per texel) */
  ao: 'off' | 'Performance' | 'Low' | 'Medium' | 'High';
  /** AO at half the drawing-buffer resolution (depth-aware upsampling; visually identical to full resolution in the
   * September 2026 comparison at a quarter of the cost) */
  aoHalfRes: boolean;
  aa: 'fxaa' | 'smaa' | 'off'; // off (low): no AA pass; the lens pass's MTF softness and the grain hide aliasing
  smaaPreset: 'LOW' | 'MEDIUM' | 'HIGH' | 'ULTRA';
  bloomLevels: number;
  planarReflectionScale: number; // x the drawing buffer; 0 = off (water uses floor-emission + env tint only)
  floorReflections: boolean; // emission-map glossy floor reflections
  flashlightShadow: 512 | 1024 | 2048; // shadow map size; castShadow is ALWAYS true (constant light/program set)
  renderScale: number; // > 1 = supersampling (ultra); dynamic resolution works in [0.6, renderScale]
  dynamicResolution: boolean;
  maxDpr: number; // devicePixelRatio cap (the applied pixel ratio is also capped at 2, post/DynamicResolution.ts)
  propDistance: number; // m, props meshes hidden beyond
  humVoices: number;
  hrtf: boolean;
  uploadBudgetMs: number;
  fogAirlight: boolean; // analytic flashlight beam in haze
  /** 'lite' (low): the surface shader drops its per-pixel world features (anti-tiling blend, macro noise, carpet
   * blotches / pile sheen / broadloom seams / wall soiling, wallpaper fades): ~2x cheaper on weak iGPUs */
  shaderDetail: 'lite' | 'full';

  // ---- graphics-realism flags (A.0 contract). One field per line in every preset below, so each owning package
  // flips its own lines. Until the owner lands, a flag stays off (0 / false / 'off' / 'basic'). Final values are
  // listed low/medium/high/ultra; the shader defines they select are materials/shared.ts qualityDefinesOf.
  /** D: screen-space reflections into the MRT G-buffer; final off/off/half/half */
  ssr: 'off' | 'half';
  /** D: SSR roughness cut-off; final 0/0/0.45/0.6 */
  ssrMaxRoughness: number;
  /** D: SSR ray-march steps; final 0/0/48/56 */
  ssrSteps: number;
  /** D: 9-tap bilateral SSR filter; final false/false/false/true */
  ssrFilter: boolean;
  /** D: box-projected reflection probe cube size (0 = off); final 0/0/128/256 */
  reflectionProbe: 0 | 128 | 256;
  /** A: opaque colour + linear depth pyramid, level 0 = this x the buffer (0 = no split frames); final 0/0/1/0.67 */
  colorPyramidScale: number;
  /** A: screen-space contact-shadow steps (0 = off; needs ao); final 0/0/8/8 */
  contactShadowSteps: number;
  /** B: height-filled puddles in wet patches; final F/T/T/T */
  wetPuddles: boolean;
  /** B: LEAN detail-map array (uBrDetail); final F/F/T/T */
  detailMaps: boolean;
  /** B: parallax occlusion mapping on the shell (1 = steps only, 2 = + self-shadow); final 0/0/1/2 */
  pom: 0 | 1 | 2;
  /** B: textile sheen lobe (USE_SHEEN); final F/T/T/T */
  clothSheen: boolean;
  /** B: normal-variance specular anti-aliasing; final F/T/T/T */
  specularAA: boolean;
  /** C: motion-blur taps (0 = off); final 0/6/8/10 */
  motionBlurTaps: number;
  /** C: glare star streaks; final F/F/T/T */
  glareStreaks: boolean;
  /** C: glare ghosts; final F/F/F/T */
  glareGhosts: boolean;
  /** E: water refraction march steps (0 = legacy premultiplied water); final 0/0/8/10 */
  waterRefractionSteps: number;
  /** E: analytic surface waves (0 = normal-map only); final 0/3/6/8 */
  waterWaves: number;
  /** E: ripple simulation grid size (0 = off); final 0/128/256/512 */
  waterRippleRes: number;
  /** E: ripple texel size in metres (0 = off); final 0/0.06/0.04/0.03 */
  waterRippleTexel: number;
  /** E: dust film, flecks and the wall wet band; final F/T/T/T */
  waterDebris: boolean;
  /** E: 'full' adds above-water caustics and the flashlight caustic hook; final basic/basic/full/full */
  waterCaustics: 'basic' | 'full';
  /** E: in-water light cones (lights integrated per water pixel; 0 = off); final 0/0/2/4 */
  waterVolumetrics: number;
  /** F: froxel volumetric haze grid; final off/off/high/ultra */
  volumetrics: 'off' | 'high' | 'ultra';
  /** F: dust motes (points on LAYER_LATE); final 0/0/3000/6000 */
  dustMotes: number;
  /** F: flashlight bounce VPLs (0 = off); final 0/1/4/8 */
  flashlightBounce: number;
  /** F: bake near-field gather rays (0 = off; BakeQuality.nearRays); final 0/0/16/32 */
  bakeNearRays: number;
}

export const QUALITY: Readonly<Record<QualityName, QualityConfig>> = {
  low: {
    name: 'low', streamRadius: 1, lmTpc: 8, bakeShadowSamples: 1, probeRays: 32, bakeWorkers: 3, textureSize: 512,
    anisotropy: 4, ao: 'off', aoHalfRes: true, aa: 'off', smaaPreset: 'LOW', bloomLevels: 5, planarReflectionScale: 0,
    floorReflections: false, flashlightShadow: 512, renderScale: 0.75, dynamicResolution: true, maxDpr: 1,
    propDistance: 20, humVoices: 4, hrtf: false, uploadBudgetMs: 2, fogAirlight: false, shaderDetail: 'lite',
    ssr: 'off',
    ssrMaxRoughness: 0,
    ssrSteps: 0,
    ssrFilter: false,
    reflectionProbe: 0,
    colorPyramidScale: 0,
    contactShadowSteps: 0,
    wetPuddles: false,
    detailMaps: false,
    pom: 0,
    clothSheen: false,
    specularAA: false,
    motionBlurTaps: 0,
    glareStreaks: false,
    glareGhosts: false,
    waterRefractionSteps: 0,
    waterWaves: 0,
    waterRippleRes: 0,
    waterRippleTexel: 0,
    waterDebris: false,
    waterCaustics: 'basic',
    waterVolumetrics: 0,
    volumetrics: 'off',
    dustMotes: 0,
    flashlightBounce: 0,
    bakeNearRays: 0,
  },
  medium: {
    name: 'medium', streamRadius: 2, lmTpc: 8, bakeShadowSamples: 2, probeRays: 64, bakeWorkers: 4, textureSize: 1024,
    anisotropy: 8, ao: 'Low', aoHalfRes: true, aa: 'smaa', smaaPreset: 'MEDIUM', bloomLevels: 6, planarReflectionScale: 0.35,
    floorReflections: true, flashlightShadow: 1024, renderScale: 0.9, dynamicResolution: true, maxDpr: 1,
    propDistance: 30, humVoices: 8, hrtf: true, uploadBudgetMs: 2.5, fogAirlight: false, shaderDetail: 'full',
    ssr: 'off',
    ssrMaxRoughness: 0,
    ssrSteps: 0,
    ssrFilter: false,
    reflectionProbe: 0,
    colorPyramidScale: 0,
    contactShadowSteps: 0,
    wetPuddles: false,
    detailMaps: false,
    pom: 0,
    clothSheen: false,
    specularAA: false,
    motionBlurTaps: 0,
    glareStreaks: false,
    glareGhosts: false,
    waterRefractionSteps: 0,
    waterWaves: 0,
    waterRippleRes: 0,
    waterRippleTexel: 0,
    waterDebris: false,
    waterCaustics: 'basic',
    waterVolumetrics: 0,
    volumetrics: 'off',
    dustMotes: 0,
    flashlightBounce: 0,
    bakeNearRays: 0,
  },
  high: {
    name: 'high', streamRadius: 2, lmTpc: 12, bakeShadowSamples: 4, probeRays: 96, bakeWorkers: 4, textureSize: 1024,
    anisotropy: 16, ao: 'Medium', aoHalfRes: true, aa: 'smaa', smaaPreset: 'HIGH', bloomLevels: 8, planarReflectionScale: 0.5,
    floorReflections: true, flashlightShadow: 1024, renderScale: 1, dynamicResolution: true, maxDpr: 1.5,
    propDistance: 45, humVoices: 10, hrtf: true, uploadBudgetMs: 3, fogAirlight: true, shaderDetail: 'full',
    ssr: 'off',
    ssrMaxRoughness: 0,
    ssrSteps: 0,
    ssrFilter: false,
    reflectionProbe: 0,
    colorPyramidScale: 1,
    contactShadowSteps: 0,
    wetPuddles: false,
    detailMaps: false,
    pom: 0,
    clothSheen: false,
    specularAA: false,
    motionBlurTaps: 0,
    glareStreaks: false,
    glareGhosts: false,
    waterRefractionSteps: 0,
    waterWaves: 0,
    waterRippleRes: 0,
    waterRippleTexel: 0,
    waterDebris: false,
    waterCaustics: 'basic',
    waterVolumetrics: 0,
    volumetrics: 'off',
    dustMotes: 0,
    flashlightBounce: 0,
    bakeNearRays: 0,
  },
  ultra: {
    name: 'ultra', streamRadius: 3, lmTpc: 12, bakeShadowSamples: 6, probeRays: 128, bakeWorkers: 6, textureSize: 1024,
    // reflection 0.67 of the 1.5x supersampled buffer = about the display resolution (1.0 cost 2.25x as much for a
    // mirror image that roughness mips and ripples blur anyway)
    anisotropy: 16, ao: 'High', aoHalfRes: true, aa: 'smaa', smaaPreset: 'ULTRA', bloomLevels: 9, planarReflectionScale: 0.67,
    // ultra spends the GPU headroom on pixels: 1.5x supersampling (2.25x samples: clean wallpaper stripes, carpet and
    // tile grout at distance) under the load-driven dynamic resolution (R2 B9)
    floorReflections: true, flashlightShadow: 2048, renderScale: 1.5, dynamicResolution: true, maxDpr: 2,
    propDistance: 60, humVoices: 12, hrtf: true, uploadBudgetMs: 3, fogAirlight: true, shaderDetail: 'full',
    ssr: 'off',
    ssrMaxRoughness: 0,
    ssrSteps: 0,
    ssrFilter: false,
    reflectionProbe: 0,
    colorPyramidScale: 0.67,
    contactShadowSteps: 0,
    wetPuddles: false,
    detailMaps: false,
    pom: 0,
    clothSheen: false,
    specularAA: false,
    motionBlurTaps: 0,
    glareStreaks: false,
    glareGhosts: false,
    waterRefractionSteps: 0,
    waterWaves: 0,
    waterRippleRes: 0,
    waterRippleTexel: 0,
    waterDebris: false,
    waterCaustics: 'basic',
    waterVolumetrics: 0,
    volumetrics: 'off',
    dustMotes: 0,
    flashlightBounce: 0,
    bakeNearRays: 0,
  },
};

/** Bake parameters derived from a preset (sent to workers in the init message). nearRays (package F's near-field
 * gather) is present only when > 0, so presets without it send byte-identical worker inputs. */
export interface BakeQuality { tpc: LmTpc; shadowSamples: 1 | 2 | 4 | 6; probeRays: 32 | 64 | 96 | 128; nearRays?: number }
export const bakeQualityOf = (q: QualityConfig): BakeQuality => {
  const b: BakeQuality = { tpc: q.lmTpc, shadowSamples: q.bakeShadowSamples, probeRays: q.probeRays };
  if (q.bakeNearRays > 0) b.nearRays = q.bakeNearRays;
  return b;
};
