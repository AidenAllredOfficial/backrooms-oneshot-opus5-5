// src/textures/grime.ts — 512^2 tileable grime texture (RGBA8, linear) sampled in world space by WP9 (WP8).
//   r: tide/stain field: warped fbm with gentle terraces, so a threshold against the WP7 mask gives irregular stain
//      fronts with tide lines;
//   g: speckle / mould clusters;
//   b: scuffs (elongated, mostly horizontal marks);
//   a: vertical drip streaks.
// Every channel is a continuous 0..1 field meant to be thresholded (smoothstep) against lmMask.

import { buildStandaloneFragment } from './glsl/common.ts';

export const GRIME_SIZE = 512;

export const GRIME_GLSL = /* glsl */ `
vec4 texel(vec2 uv) {
  vec2 w = warp(uv, ivec2(3), 4, 11, 0.12);
  float f = fbm(w, ivec2(4), 6, 12);
  float base = sat(0.5 + 0.8 * f);
  float rings = 0.5 + 0.5 * cos(base * 6.2831853 * 7.0);
  float r = sat(base + 0.035 * (rings - 0.5));

  float dens = fbmV(uv, ivec2(6), 4, 21);
  Cell c = worley(uv, ivec2(110), 0.9, 22);
  float dotS = 1.0 - smoothstep(0.1, 0.35 + 0.2 * hashf(c.id, 23), c.f1);
  float g = sat(dotS * smoothstep(0.35, 0.75, dens + 0.3 * (hashf(c.id, 24) - 0.5)) + 0.3 * smoothstep(0.5, 0.9, dens));

  float sc = gnoise(warp(uv, ivec2(5), 2, 31, 0.03), ivec2(6, 60), 32);
  float b = sat(smoothstep(0.3, 0.8, sc) * smoothstep(0.2, 0.7, fbmV(uv, ivec2(4), 3, 33)));

  float st = fbmV(uv, ivec2(48, 2), 3, 41);
  float st2 = vnoise(uv, ivec2(128, 3), 42);
  float len = fbmV(uv, ivec2(8, 3), 3, 43);
  float a = sat(smoothstep(0.5, 0.75, 0.7 * st + 0.3 * st2) * smoothstep(0.3, 0.7, len));
  return vec4(r, g, b, a);
}
`;

export const GRIME_FRAGMENT = buildStandaloneFragment(GRIME_GLSL, true);
