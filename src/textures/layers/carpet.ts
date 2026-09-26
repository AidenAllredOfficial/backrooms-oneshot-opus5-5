// src/textures/layers/carpet.ts — textiles: CARPET_L0, CARPET_OFFICE, FABRIC_PARTITION (WP8).

import { Mat } from '../../core/ids.ts';
import type { RecipeTable } from './types.ts';

/** Level 0 carpet: damp mustard pile. Three scales of structure, each representable at the texel grid:
 *  - pile clusters (~2.6 cm): neighbouring tufts lean together and part along irregular creases (warped Worley
 *    F2-F1); each cluster leans a different way, so its sheen / value shifts slightly;
 *  - tufts (~9.5 mm, >= 4 texels at 1024): yarn bundles with a lighter crown and dark gaps (Worley);
 *  - the 3 mm loop grid and individual strands are below the texel Nyquist limit: supersampled, the texture keeps
 *    their filtered mean (the loop grid fades by the texel with bandLimitPx).
 *  Colour: per-tuft yarn shade (heathered dye lots), +-6 % mottling, low-contrast pile crush. Isotropic (the layer
 *  uses hex tiling without rotation). Macro blotches and damp stains come from the WP7 mask. */
const CARPET_L0 = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  // ---- pile clusters: tufts that lean together, parted along soft, broken creases (only some cluster borders
  // open up); the lean direction varies smoothly, which shifts sheen / value without hard-edged patches
  vec2 cuv = warp(uv, PM(14.0), 2, 21, 0.0035);
  Cell cl = worley(cuv, PM(38.0), 0.9, 22);
  float parted = smoothstep(0.05, 0.45, fbm(uv, PM(16.0), 2, 25) + 0.15);
  float crease = (1.0 - smoothstep(0.0, 0.24, cl.f2 - cl.f1)) * parted; // pile parting line
  float clump = 1.0 - smoothstep(0.15, 1.0, cl.f1);                        // cluster crown
  float lean = fbm(cuv, PM(30.0), 2, 24);                                   // smooth lean / sheen field
  // ---- tufts (yarn bundles); at 512 they approach 2 texels: keep a reduced, random (non-moire) contrast
  float tb = mix(0.4, 1.0, bandLimitPx(252.0));
  Cell t = worley(uv, PM(105.0), 0.9, 3);
  vec4 th = hash4f(t.id, 4);
  float dome = 1.0 - smoothstep(0.08, 0.72, t.f1);
  float gap = smoothstep(0.0, 0.22, t.f2 - t.f1);
  float tuft = mix(0.55, dome * mix(0.55, 1.0, gap), tb);
  // ---- loop-pile micro grid (3 mm, 800 per 2.4 m), rows offset by half a loop: below Nyquist, the mean remains
  vec2 g = uv * 800.0;
  float loops = (0.5 + 0.5 * cos(6.2831853 * g.x)) * (0.5 + 0.5 * cos(6.2831853 * (g.y + 0.5 * floor(g.x))));
  loops = mix(0.25, loops, bandLimitPx(800.0));
  // ---- individual strands: fine isotropic speckle, faded as it approaches the texel
  float strand = mix(0.5, vnoise(uv, PM(200.0), 7), mix(0.35, 1.0, bandLimitPx(480.0)));
  // ---- colour
  float yarn = 0.68 * th.y + 0.32 * strand;                             // per-tuft dye-lot shade dominates
  vec3 base = TABLE_ALBEDO;
  vec3 dark = base * vec3(0.88, 0.86, 0.83);
  vec3 light = base * vec3(1.08, 1.07, 1.03);
  vec3 col = mix(dark, base, smoothstep(0.12, 0.45, yarn));
  col = mix(col, light, smoothstep(0.62, 0.92, yarn));
  col = mix(base, col, mix(0.55, 1.0, tb));
  // tuft crowns catch light, gaps and creases are shadowed pile
  col *= mix(0.93, 1.03, tuft) * (1.0 - 0.12 * crease) * mix(0.96, 1.02, loops);
  // cluster lean: sheen / value shift (+-4 %), slightly warmer where the pile leans toward the viewer
  col *= 1.0 + 0.04 * lean;
  col *= mix(vec3(1.0), vec3(1.015, 1.0, 0.97), sat(0.5 + lean));
  // colour mottling +-6 %
  float mot = fbm(uv, PM(9.0), 4, 9);
  float mot2 = fbm(uv, PM(2.0), 3, 10);
  col *= 1.0 + 0.06 * mot + 0.025 * mot2;
  col *= mix(vec3(1.0), vec3(1.02, 1.0, 0.94), sat(mot2));
  // pile crush / matting: irregular, low contrast (flattened pile reads slightly darker and a bit smoother)
  float crush = smoothstep(0.1, 0.6, fbm(warp(uv, PM(4.0), 3, 11, 0.04), PM(6.0), 4, 12));
  col *= 1.0 - 0.05 * crush;
  s.albedo = col;
  s.height = 0.22 + 0.38 * tuft + 0.16 * clump * (0.8 + 0.2 * lean) - 0.14 * crease + 0.06 * loops
           + 0.05 * (strand - 0.5) - 0.06 * crush;
  s.rough = 0.95 + 0.03 * (th.z - 0.5) - 0.02 * crush - 0.015 * lean;
}
`;

/** Office carpet tiles (0.6 m): quarter-turn installation (pile direction alternates per tile, which changes the
 * sheen: roughness + directional ridges), blue-grey speckle yarn, dark tile seams. */
const CARPET_OFFICE = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  TileInfo t = tiles(m, vec2(0.6));
  float dir = mod(t.id.x + t.id.y, 2.0);
  vec2 puv = dir < 0.5 ? uv : uv.yx; // pile frame (FRAME is square)
  float rows = gnoise(puv, ivec2(14, 640), 3) * 0.6 + gnoise(puv, ivec2(30, 1100), 4) * 0.4; // gnoise is band limited
  Cell c = worley(uv, PM(240.0), 0.9, 5);
  float hsh = hashf(c.id, 6);
  vec3 navy = srgb8(62.0, 68.0, 84.0);
  vec3 slate = srgb8(92.0, 98.0, 108.0);
  vec3 lgrey = srgb8(150.0, 154.0, 160.0);
  vec3 teal = srgb8(56.0, 96.0, 104.0);
  vec3 col = mix(navy, slate, smoothstep(0.35, 0.65, hsh));
  col = mix(col, mix(slate, lgrey, 0.55), step(0.93, hsh));
  col = mix(col, teal, step(0.985, hsh));
  col *= 0.9 + 0.2 * vnoise(uv, PM(560.0), 7);
  col *= 1.0 + 0.07 * rows;
  col *= 1.0 + 0.03 * (tileRand(t.id, 8) - 0.5) + 0.03 * fbm(uv, PM(6.0), 3, 9);
  float seam = 1.0 - smoothstep(0.0005, 0.0014, t.edge);
  col *= 1.0 - 0.45 * seam;
  s.albedo = col;
  float bump = 1.0 - smoothstep(0.1, 0.8, c.f1);
  s.height = 0.45 + 0.22 * bump + 0.14 * rows - 0.3 * seam;
  s.rough = (dir < 0.5 ? 0.935 : 0.97) - 0.02 * rows;
}
`;

/** Cubicle partition fabric: basket-woven heathered yarn (2.5 mm), fuzz, fully rough. */
const FABRIC_PARTITION = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 g = uv * 480.0;
  vec2 ci = floor(g);
  vec2 f = fract(g) - 0.5;
  // 2x2 basket weave: pairs of threads cross over together
  float over = mod(floor(ci.x * 0.5) + floor(ci.y * 0.5), 2.0);
  float warpT = 1.0 - pow(abs(f.x) * 2.0, 2.0);
  float weftT = 1.0 - pow(abs(f.y) * 2.0, 2.0);
  float bulgeWarp = 0.75 + 0.25 * cos(3.14159 * (mod(ci.y, 2.0) - 0.5 + f.y) * 0.5);
  float bulgeWeft = 0.75 + 0.25 * cos(3.14159 * (mod(ci.x, 2.0) - 0.5 + f.x) * 0.5);
  float prof = over > 0.5 ? warpT * bulgeWarp : weftT * bulgeWeft;
  prof = mix(0.6, prof, bandLimitPx(480.0)); // 2.5 mm weave is at the texel Nyquist limit at 1024: mean only (no moire)
  float cWarp = vnoise(uv, ivec2(480, 120), 3);
  float cWeft = vnoise(uv, ivec2(120, 480), 4);
  float heather = vnoise(uv, PM(240.0), 6); // isotropic heather (fibre blend), no directional streaks
  float yarn = mix(over > 0.5 ? cWarp : cWeft, heather, 0.45);
  vec3 base = TABLE_ALBEDO;
  vec3 dark = base * vec3(0.82, 0.83, 0.86);
  vec3 light = base * vec3(1.15, 1.15, 1.17);
  vec3 col = mix(dark, base, smoothstep(0.2, 0.45, yarn));
  col = mix(col, light, smoothstep(0.72, 0.92, yarn));
  col *= 0.82 + 0.18 * prof;
  float fuzz = fbm(uv, PM(30.0), 3, 5);
  col *= 1.0 + 0.03 * fuzz;
  s.albedo = col;
  s.height = 0.3 + 0.45 * prof + 0.05 * fuzz;
  s.rough = 1.0;
}
`;

export const TEXTILE_RECIPES: RecipeTable = {
  [Mat.CARPET_L0]: { glsl: CARPET_L0, normalStrength: 1.0, heightScale: 0.0025 },
  [Mat.CARPET_OFFICE]: { glsl: CARPET_OFFICE, normalStrength: 0.9, heightScale: 0.003 },
  [Mat.FABRIC_PARTITION]: { glsl: FABRIC_PARTITION, normalStrength: 0.6, heightScale: 0.0008 },
};
