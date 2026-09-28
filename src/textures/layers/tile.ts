// src/textures/layers/tile.ts — tiled floors and walls: VINYL_VCT, POOL_TILE, POOL_MOSAIC (WP8).
// All three are physical tiles that WP9 rotates/flips per tile (tileSize), so every tile's content is self-contained.

import { Mat } from '../../core/ids.ts';
import type { RecipeTable } from './types.ts';

/** Vinyl composition tile, 0.3 m: +-4 % tint per tile, directional marbling and flecks, dirty hairline joints,
 * chipped edges, wax sheen (roughness 0.3-0.45) with scuffs. */
const VINYL_VCT = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  TileInfo t = tiles(m, vec2(0.3));
  vec4 r = tileRand4(t.id, 5);
  vec3 base = TABLE_ALBEDO * (1.0 + 0.08 * (r.x - 0.5)) * mix(vec3(1.0), vec3(1.025, 1.0, 0.955), r.y);
  vec2 tuv = uv + floor(r.zw * 64.0) / 16.0; // per-tile pattern offset (keeps periodicity: multiples of 1/16)
  vec2 wv = warp(tuv, PM(6.0), 3, 11, 0.05);
  float marb = fbm(wv, PMxy(8.0, 32.0), 4, 12);
  float streakL = smoothstep(0.22, 0.6, marb);
  float streakD = 1.0 - smoothstep(-0.6, -0.25, marb);
  Cell fl = worley(tuv, PM(210.0), 0.9, 13);
  float fh = hashf(fl.id, 14);
  float fleck = 1.0 - smoothstep(0.17, 0.3, fl.f1);
  vec3 col = base;
  col = mix(col, base * vec3(1.2, 1.18, 1.13), streakL * 0.55);
  col = mix(col, base * vec3(0.7, 0.68, 0.66), streakD * 0.5);
  col = mix(col, base * 0.55, fleck * step(fh, 0.1));
  col = mix(col, base * 1.3, fleck * step(0.9, fh));
  float joint = 1.0 - smoothstep(0.00025, 0.0009, t.edge);
  float chipN = vnoise(uv, PM(40.0), 15);
  float chip = (1.0 - smoothstep(0.002, 0.0055, t.edge)) * smoothstep(0.74, 0.82, chipN);
  col *= 1.0 - 0.55 * joint;
  col = mix(col, col * 0.62, chip);
  s.albedo = col;
  s.height = 0.6 - 0.3 * joint - 0.25 * chip + 0.02 * marb;
  float wax = fbmV(uv, PM(4.0), 3, 16);
  float scuff = smoothstep(0.55, 0.85, gnoise(warp(uv, PM(3.0), 2, 18, 0.03), PMxy(14.0, 90.0), 17))
              * smoothstep(0.35, 0.7, fbmV(uv, PM(3.0), 2, 19));
  s.rough = mix(0.3, 0.45, wax) + 0.12 * scuff + 0.3 * joint + 0.2 * chip;
}
`;

/** Pool tile, 0.15 m white glaze (roughness 0.06-0.12) with cushion edges, a slight pillow and a per-tile tilt of
 * +-0.5 degrees per axis (lippage: +-0.7 mm across a tile, as set tiles have; +-1.5 degrees scattered the lamps into a
 * field of single-tile glints, each near-mirror tile picking its own probe texel); glaze crazing on a quarter of the
 * tiles and a hazy (rougher, greyer) glaze rim next to the 3 mm light grey grout (roughness 0.7). Every feature is
 * tile-local (the shader rotates / flips whole tiles). */
const POOL_TILE = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  TileInfo t = tiles(m, vec2(0.15));
  vec4 r = tileRand4(t.id, 3);
  float e = t.edge;
  float w = 0.7 * aaM();
  float grout = 1.0 - smoothstep(0.0015 - w, 0.0015 + w, e);
  float cush = sat((e - 0.0015) / 0.004);
  float cushH = 1.0 - (1.0 - cush) * (1.0 - cush);
  vec2 slope = (r.xy - 0.5) * 2.0 * 0.009;
  float tiltM = dot(t.local, slope);
  float wav = fbm(uv, PM(22.0), 2, 4) * 0.00012;
  vec3 glaze = TABLE_ALBEDO * (1.0 + 0.06 * (r.z - 0.5)) * (1.0 + 0.008 * fbm(uv, PM(40.0), 2, 5));
  glaze *= mix(vec3(1.0), vec3(0.975, 0.955, 0.9), step(0.98, r.w)); // a few off-white tiles from another batch
  vec3 groutCol = srgb8(192.0, 198.0, 194.0) * (0.88 + 0.2 * vnoise(uv, PM(500.0), 6));
  // crazing: a fine crack net in the glaze of a quarter of the tiles (pattern offset per tile)
  vec3 cz = worleyEdge(uv + floor(r.zw * 16.0) / 8.0, PM(45.0), 0.9, 30);
  float crz = step(r.w, 0.25) * lineM(cz.x * FRAME.x / float(PM(45.0).x), 0.00008);
  glaze *= 1.0 - 0.2 * crz;
  // grout haze: the glaze rim next to the joint is filmed over (cement residue, cleaning chemicals)
  float haze = (1.0 - smoothstep(0.0015, 0.006, e)) * (1.0 - grout);
  glaze = mix(glaze, groutCol, 0.08 * haze);
  s.albedo = mix(glaze, groutCol, grout);
  s.rough = mix(0.06 + 0.06 * fbmV(uv, PM(10.0), 2, 7) + 0.12 * crz + 0.1 * haze, 0.7, grout);
  // pillow: the face bulges ~0.1 mm toward its centre (reflections bend across each tile)
  float pillow = 0.012 * (1.0 - dot(t.local, t.local) / (2.0 * 0.075 * 0.075));
  float hTile = 0.3 + 0.25 * cushH + pillow + (tiltM + wav) / 0.008;
  s.height = mix(hTile, 0.08 + 0.03 * vnoise(uv, PM(300.0), 8), grout);
}
`;

/** 2.5 cm glass mosaic in mixed aqua shades, 2 mm light grout, per-chip tilt (+-0.5 degrees per axis). */
const POOL_MOSAIC = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  TileInfo t = tiles(m, vec2(0.025));
  vec4 r = tileRand4(t.id, 3);
  float e = t.edge;
  float w = 0.7 * aaM();
  float grout = 1.0 - smoothstep(0.001 - w, 0.001 + w, e);
  float cush = 1.0 - (1.0 - sat((e - 0.001) / 0.0025)) * (1.0 - sat((e - 0.001) / 0.0025));
  vec3 T = TABLE_ALBEDO;
  float p = r.x;
  vec3 col = p < 0.34 ? T
           : p < 0.58 ? T * vec3(1.3, 1.13, 1.09)
           : p < 0.78 ? T * vec3(0.72, 0.88, 0.9)
           : p < 0.9 ? T * vec3(1.6, 1.28, 1.22)
           : T * vec3(0.48, 0.72, 0.8);
  col *= 1.0 + 0.06 * fbm(uv + floor(r.zw * 32.0) / 8.0, PM(90.0), 2, 4);
  vec3 groutCol = srgb8(176.0, 184.0, 182.0);
  s.albedo = mix(col, groutCol, grout);
  vec2 slope = (r.yz - 0.5) * 2.0 * 0.009;
  s.height = mix(0.3 + 0.35 * cush + dot(t.local, slope) / 0.004, 0.1, grout);
  s.rough = mix(0.08 + 0.04 * r.w, 0.7, grout);
}
`;

export const TILE_RECIPES: RecipeTable = {
  [Mat.VINYL_VCT]: { glsl: VINYL_VCT, normalStrength: 1.0, heightScale: 0.0015 },
  [Mat.POOL_TILE]: { glsl: POOL_TILE, normalStrength: 1.0, heightScale: 0.008 },
  [Mat.POOL_MOSAIC]: { glsl: POOL_MOSAIC, normalStrength: 1.0, heightScale: 0.004 },
};
