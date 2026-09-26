// src/textures/waterNormals.ts — 512^2 tileable RG water normal map (2 octaves of periodic gradient noise) (WP8).
// rg = tangent-space normal xy * 0.5 + 0.5 (z = sqrt(1 - x^2 - y^2)); WP9 scrolls two layers of it.

import { buildStandaloneFragment } from './glsl/common.ts';

export const WATER_NORMALS_SIZE = 512;

export const WATER_NORMALS_GLSL = /* glsl */ `
float wh(vec2 uv) { return 0.65 * gnoise(uv, ivec2(6), 51) + 0.35 * gnoise(uv, ivec2(13), 52); }
vec4 texel(vec2 uv) {
  float e = 0.5 / uRes;
  float hx = (wh(uv + vec2(e, 0.0)) - wh(uv - vec2(e, 0.0))) / (2.0 * e);
  float hy = (wh(uv + vec2(0.0, e)) - wh(uv - vec2(0.0, e))) / (2.0 * e);
  vec3 n = normalize(vec3(-hx * 0.012, -hy * 0.012, 1.0)); // calm pool water: ~11 deg max tilt, ~4 deg typical
  return vec4(n.xy * 0.5 + 0.5, 0.0, 1.0);
}
`;

export const WATER_NORMALS_FRAGMENT = buildStandaloneFragment(WATER_NORMALS_GLSL, false);
