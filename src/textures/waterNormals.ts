// src/textures/waterNormals.ts — 512^2 tileable water slope map (WP8; package E). rg = the slope (dh/du, dh/dv) of
// a two-octave periodic gradient-noise height field (8 and 19 cells per repeat, the finer octave at 0.6 of the
// coarse one's slope), stored as s = (v * 2 - 1) * WATER_SLOPE_SCALE. The water shader (materials/chunks/water.ts
// brWaterSlope) samples three drifting octaves of it (1.2 m, 0.96 m axis-swapped, 1.92 m rotated) with per-kind
// gains; its mips average the slopes of sub-pixel ripples away, and the shader moves that variance into roughness.

import { buildStandaloneFragment } from './glsl/common.ts';

export const WATER_NORMALS_SIZE = 512;
/** stored slope range: s = (v * 2 - 1) * WATER_SLOPE_SCALE (materials/chunks/water.ts TEX_SCALE) */
export const WATER_SLOPE_SCALE = 0.25;
/** stored slope per unit uv-gradient of the noise height (vector RMS ~0.085, peaks well inside the range) */
export const WATER_SLOPE_K = 0.065;

export const WATER_NORMALS_GLSL = /* glsl */ `
float wh(vec2 uv) { return gnoise(uv, ivec2(8), 51) / 8.0 + 0.6 * gnoise(uv, ivec2(19), 52) / 19.0; }
vec4 texel(vec2 uv) {
  float e = 0.5 / uRes;
  float hx = (wh(uv + vec2(e, 0.0)) - wh(uv - vec2(e, 0.0))) / (2.0 * e);
  float hy = (wh(uv + vec2(0.0, e)) - wh(uv - vec2(0.0, e))) / (2.0 * e);
  vec2 s = vec2(hx, hy) * ${WATER_SLOPE_K.toFixed(4)}; // calm-water slope of the reference field
  return vec4(clamp(s / ${WATER_SLOPE_SCALE.toFixed(4)}, -1.0, 1.0) * 0.5 + 0.5, 0.0, 1.0);
}
`;

export const WATER_NORMALS_FRAGMENT = buildStandaloneFragment(WATER_NORMALS_GLSL, false);
