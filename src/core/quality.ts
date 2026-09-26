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
  ao: 'off' | 'Performance' | 'Low' | 'Medium' | 'High';
  aoHalfRes: boolean;
  aa: 'fxaa' | 'smaa' | 'off'; // off (low): no AA pass; the lens pass's MTF softness and the grain hide aliasing
  smaaPreset: 'LOW' | 'MEDIUM' | 'HIGH' | 'ULTRA';
  bloomLevels: number;
  planarReflectionScale: number; // 0 = off (water uses floor-emission + env tint only)
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
}

export const QUALITY: Readonly<Record<QualityName, QualityConfig>> = {
  low: {
    name: 'low', streamRadius: 1, lmTpc: 8, bakeShadowSamples: 1, probeRays: 32, bakeWorkers: 3, textureSize: 512,
    anisotropy: 4, ao: 'off', aoHalfRes: true, aa: 'off', smaaPreset: 'LOW', bloomLevels: 5, planarReflectionScale: 0,
    floorReflections: false, flashlightShadow: 512, renderScale: 0.75, dynamicResolution: true, maxDpr: 1,
    propDistance: 20, humVoices: 4, hrtf: false, uploadBudgetMs: 2, fogAirlight: false, shaderDetail: 'lite',
  },
  medium: {
    name: 'medium', streamRadius: 2, lmTpc: 8, bakeShadowSamples: 2, probeRays: 64, bakeWorkers: 4, textureSize: 1024,
    anisotropy: 8, ao: 'Low', aoHalfRes: true, aa: 'smaa', smaaPreset: 'MEDIUM', bloomLevels: 6, planarReflectionScale: 0.35,
    floorReflections: true, flashlightShadow: 1024, renderScale: 0.9, dynamicResolution: true, maxDpr: 1,
    propDistance: 30, humVoices: 8, hrtf: true, uploadBudgetMs: 2.5, fogAirlight: false, shaderDetail: 'full',
  },
  high: {
    name: 'high', streamRadius: 2, lmTpc: 12, bakeShadowSamples: 4, probeRays: 96, bakeWorkers: 4, textureSize: 1024,
    anisotropy: 16, ao: 'Medium', aoHalfRes: false, aa: 'smaa', smaaPreset: 'HIGH', bloomLevels: 8, planarReflectionScale: 0.5,
    floorReflections: true, flashlightShadow: 1024, renderScale: 1, dynamicResolution: true, maxDpr: 1.5,
    propDistance: 45, humVoices: 10, hrtf: true, uploadBudgetMs: 3, fogAirlight: true, shaderDetail: 'full',
  },
  ultra: {
    name: 'ultra', streamRadius: 3, lmTpc: 12, bakeShadowSamples: 6, probeRays: 128, bakeWorkers: 6, textureSize: 1024,
    anisotropy: 16, ao: 'High', aoHalfRes: false, aa: 'smaa', smaaPreset: 'ULTRA', bloomLevels: 9, planarReflectionScale: 1,
    // ultra spends the GPU headroom on pixels: 1.5x supersampling (2.25x samples: clean wallpaper stripes, carpet and
    // tile grout at distance) under the load-driven dynamic resolution (R2 B9)
    floorReflections: true, flashlightShadow: 2048, renderScale: 1.5, dynamicResolution: true, maxDpr: 2,
    propDistance: 60, humVoices: 12, hrtf: true, uploadBudgetMs: 3, fogAirlight: true, shaderDetail: 'full',
  },
};

/** Bake parameters derived from a preset (sent to workers in the init message). */
export interface BakeQuality { tpc: LmTpc; shadowSamples: 1 | 2 | 4 | 6; probeRays: 32 | 64 | 96 | 128 }
export const bakeQualityOf = (q: QualityConfig): BakeQuality => ({ tpc: q.lmTpc, shadowSamples: q.bakeShadowSamples, probeRays: q.probeRays });
