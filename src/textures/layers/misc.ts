// src/textures/layers/misc.ts — WOOD, PLASTIC, RUBBER (WP8).

import { Mat } from '../../core/ids.ts';
import type { RecipeTable } from './types.ts';

/** Varnished flat-sawn wood (doors, desks, pallets): warped growth rings along u, open pores, fibre streaks. */
const WOOD = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 w = warp(uv, PMxy(1.5, 4.0), 4, 3, 0.025);
  float rc = w.y * 70.0 + 2.5 * fbm(w, PMxy(1.0, 3.0), 3, 4);
  float ring = fract(rc);
  float late = smoothstep(0.55, 0.82, ring) * (1.0 - smoothstep(0.9, 1.0, ring));
  float pores = smoothstep(0.7, 0.9, vnoise(w, PMxy(30.0, 800.0), 5));
  float fib = gnoise(w, PMxy(6.0, 480.0), 6);
  float fig = fbm(uv, PM(2.0), 3, 7);
  vec3 early = TABLE_ALBEDO * vec3(1.12, 1.1, 1.05);
  vec3 lateC = TABLE_ALBEDO * vec3(0.7, 0.6, 0.52);
  vec3 col = mix(early, lateC, late);
  col *= 1.0 + 0.045 * fib + 0.05 * fig;
  col *= 1.0 - 0.3 * pores * (0.4 + 0.6 * late);
  s.albedo = col;
  s.rough = 0.5 + 0.1 * pores + 0.05 * late;
  s.height = 0.5 + 0.08 * late + 0.04 * fib - 0.2 * pores;
}
`;

/** Aged textured ABS (chairs, bins, fixtures): fine haircell stipple, light scratches. */
const PLASTIC = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  Cell c = worley(uv, PM(600.0), 1.0, 3);
  float stip = 1.0 - smoothstep(0.0, 0.8, c.f1);
  stip = mix(0.4, stip, br_bandLimit(vec2(PM(600.0)))); // 1.7 mm haircell: 1.4 texels at 512^2, keep the mean there
  float fine = fbm(uv, PM(300.0), 3, 4);
  float scr = smoothstep(0.86, 0.95, ridged(warp(uv, PM(3.0), 2, 5, 0.05), PMxy(4.0, 40.0), 2, 6)) * 0.6;
  s.albedo = TABLE_ALBEDO * (1.0 + 0.012 * fine + 0.025 * fbm(uv, PM(4.0), 3, 7)) * (1.0 + 0.06 * scr);
  s.height = 0.5 + 0.15 * stip + 0.05 * fine - 0.1 * scr;
  s.rough = 0.38 + 0.08 * stip - 0.08 * scr;
}
`;

/** Black rubber (cove base, treads, tyres): fine matte texture, dusty bloom. */
const RUBBER = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  float fine = fbm(uv, PM(400.0), 3, 3);
  float mid = fbm(uv, PM(20.0), 3, 4);
  float dust = smoothstep(0.2, 0.7, fbmV(uv, PM(4.0), 3, 5));
  s.albedo = TABLE_ALBEDO * (1.0 + 0.1 * fine + 0.1 * mid) + vec3(0.018, 0.017, 0.016) * dust;
  s.rough = 0.66 + 0.1 * dust + 0.05 * fine;
  s.height = 0.5 + 0.1 * fine + 0.05 * mid;
}
`;

export const MISC_RECIPES: RecipeTable = {
  [Mat.WOOD]: { glsl: WOOD, normalStrength: 1.0, heightScale: 0.0006 },
  [Mat.PLASTIC]: { glsl: PLASTIC, normalStrength: 1.0, heightScale: 0.0003 },
  [Mat.RUBBER]: { glsl: RUBBER, normalStrength: 1.0, heightScale: 0.0004 },
};
