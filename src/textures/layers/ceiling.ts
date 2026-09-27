// src/textures/layers/ceiling.ts — CEILING_TILE, PANEL_LENS, PLENUM (WP8).

import { Mat } from '../../core/ids.ts';
import type { RecipeTable } from './types.ts';

/** Drop ceiling: 2 x 2 mineral-fibre tiles of 0.6 m in a raised 24 mm off-white T-bar grid. Fissures are
 * thresholded warped ridged noise ("worm holes"), plus pinholes and a sanded stipple; per-tile brightness +-3 %.
 * The whole layer is symmetric under the 90-degree tile rotations WP9 applies for anti-tiling. */
const CEILING_TILE = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  TileInfo t = tiles(m, vec2(0.6));
  float e = t.edge;
  float w = 0.7 * aaM();
  float bar = 1.0 - smoothstep(0.012 - w, 0.012 + w, e);
  // fissures: two families of short worm-like grooves
  vec2 wuv = warp(uv, PM(9.0), 3, 1, 0.014);
  float rid = ridged(wuv, PM(26.0), 3, 7);
  float brk = vnoise(uv, PM(20.0), 8);
  float fis = smoothstep(0.8, 0.9, rid) * smoothstep(0.38, 0.62, brk);
  float rid2 = ridged(warp(uv, PM(18.0), 2, 21, 0.007), PM(58.0), 2, 22);
  float fis2 = 0.75 * smoothstep(0.84, 0.93, rid2) * smoothstep(0.45, 0.7, vnoise(uv, PM(42.0), 23));
  float fissure = max(fis, fis2);
  // pinholes (~1 mm)
  Cell ph = worley(uv, PM(150.0), 0.9, 13);
  float pin = step(hashf(ph.id, 14), 0.32) * (1.0 - smoothstep(0.09, 0.2, ph.f1));
  float st = fbm(uv, PM(240.0), 3, 15);
  float yel = fbm(uv, PM(3.0), 3, 16);
  float tb = 1.0 + 0.03 * (tileRand(t.id, 21) * 2.0 - 1.0);
  // cut edge of the tile beside the grid: a thin shadowed reveal
  float cut = 1.0 - smoothstep(0.012, 0.0175, e);
  vec3 tileCol = TABLE_ALBEDO * tb * (1.0 + 0.03 * st);
  tileCol *= mix(vec3(1.0), vec3(1.0, 0.985, 0.95), sat(yel * 1.5));
  tileCol *= 1.0 - 0.42 * fissure - 0.45 * pin;
  tileCol *= 1.0 - 0.12 * cut;
  vec3 barCol = srgb8(232.0, 230.0, 222.0) * (1.0 + 0.01 * st);
  s.albedo = mix(tileCol, barCol, bar);
  float barRound = smoothstep(0.0, 0.0035, 0.012 - e);
  float hTile = 0.42 + 0.05 * st - 0.2 * fissure - 0.22 * pin - 0.08 * cut;
  s.height = mix(hTile, 0.88 + 0.1 * barRound, bar);
  s.rough = mix(0.9 + 0.04 * st + 0.05 * fissure, 0.45, bar);
  s.metal = 0.3 * bar;
}
`;

/** Troffer prismatic lens: 4 mm pyramid grid in the normal map and two tube hot-stripes in the emissive mask
 * (ormh.a, used only by the low / lite path; medium and up shape lenses analytically, chunks/emitters.ts). One
 * continuous sheet: no frame or rim shade per 0.6 m repeat (a 2x4 lens used to read as two squares with a divider,
 * a sky panel as four). The stripe mask is scaled so the lens mean stays what the old framed texture had. */
const PANEL_LENS = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  TileInfo t = tiles(m, FRAME);
  vec2 pc = fract(m / 0.004) - 0.5;
  float pyr = 1.0 - 2.0 * max(abs(pc.x), abs(pc.y));
  float lx = t.local.x;
  float tube = gauss((lx + 0.1) / 0.035) + gauss((lx - 0.1) / 0.035);
  s.emissive = 0.848 * (0.62 + 0.38 * sat(tube));
  s.albedo = TABLE_ALBEDO * (1.0 + 0.03 * (pyr - 0.5));
  s.height = 0.3 + 0.25 * pyr;
  s.rough = 0.22;
}
`;

/** Plenum: the dark void above missing ceiling tiles: sprayed fireproofing lumps over a deck, dust. */
const PLENUM = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  float a = fbm(uv, PM(1.5), 4, 3);
  float b = fbm(uv, PM(12.0), 3, 4);
  Cell l = worley(uv, PM(40.0), 1.0, 5);
  float lump = 1.0 - smoothstep(0.0, 0.9, l.f1);
  float dust = smoothstep(0.15, 0.6, fbmV(uv, PM(3.0), 4, 6));
  vec3 col = TABLE_ALBEDO * (1.0 + 0.25 * a + 0.1 * b + 0.1 * (lump - 0.5));
  col = mix(col, TABLE_ALBEDO * vec3(1.6, 1.55, 1.45), dust * 0.45);
  s.albedo = col;
  s.height = 0.4 + 0.3 * lump + 0.1 * b;
  s.rough = 0.95;
}
`;

export const CEILING_RECIPES: RecipeTable = {
  [Mat.CEILING_TILE]: { glsl: CEILING_TILE, normalStrength: 1.0, heightScale: 0.008 },
  [Mat.PANEL_LENS]: { glsl: PANEL_LENS, normalStrength: 3.0, heightScale: 0.002 },
  [Mat.PLENUM]: { glsl: PLENUM, normalStrength: 1.0, heightScale: 0.01 },
};
