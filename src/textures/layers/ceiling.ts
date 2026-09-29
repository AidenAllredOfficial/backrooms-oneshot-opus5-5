// src/textures/layers/ceiling.ts — CEILING_TILE, PANEL_LENS, PLENUM (WP8).

import { Mat } from '../../core/ids.ts';
import { phys, type RecipeTable } from './types.ts';

/** Drop ceiling: 2 x 2 wet-felted mineral-fibre tiles of 0.6 m (fine fissured) in a 24 mm white baked-enamel T-bar
 * grid. The fissuring roll punches short tapered, crescent-bent slots (3-18 mm long, 0.6-1.8 mm wide, 1.5-3 mm deep,
 * ~12 % of the face) before the board dries; the factory latex covers their walls, so they read by occlusion (the
 * cavity AO, 0.35-0.6 in the slots), not by colour (albedo only -12 %). They are a capsule scatter on two jittered
 * cell grids (7 mm and 11 mm), each capsule with a hashed angle, length, bend, tapered half-width and depth, and ragged
 * walls, plus a sparse family of longer fissures (22 mm cells, up to ~35 mm) that stay resolvable at 2-3 m, where the
 * short ones are sub-pixel and average into a uniform cavity term; the punching density varies in 8 cm patches
 * (x0.55-1.45). Between them: the granular paint-over-fibre surface (0.3-1.5 mm grains; the finer grain and the pinholes are
 * D5) and the forming undulation (~40 mm). The bar is a dielectric enamel face (roughness 0.33) 1.3 mm proud of the
 * tile with a rounded hem, and the tile's cut mineral core shows as a thin darker line beside it. Per-tile brightness
 * +-3 %, slight yellowing. ormh.a is the detail mask (1 - bar): the D5 fibre never lands on the steel. The whole layer
 * is symmetric under the 90-degree tile rotations WP9 applies for anti-tiling. */
const CEILING_TILE = /* glsl */ `
#define SS 4
// one fissure family: capsules on a jittered grid of P cells per frame, a cell occupied with probability occ (x the
// clustering field). Each capsule stays inside the 3 x 3 cells around its own (centre jitter +-0.4, half-length <= 0.8
// cell, sideways bow <= 0.5 half-lengths), so the query loops over the neighbours only. The axis bows into a crescent
// (k t^2) or an S (t (1 - t^2)); the half-width tapers to points with a hashed fullness and swells or pinches along the
// slot. cov: coverage, dep: coverage x depth (0.5..1 of the full 2.2 mm)
void ctFissures(vec2 uv, ivec2 P, float occ, int seed, float rag, inout float cov, inout float dep) {
  vec2 Pf = vec2(P);
  vec2 p = uv * Pf;
  vec2 ip = floor(p);
  float cellM = FRAME.x / Pf.x;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 c = ip + vec2(float(x), float(y));
      ivec2 w = ivec2(wrapCell(c, Pf));
      vec4 h = hash4f(w, seed);
      if (h.x > occ) continue;
      vec4 g = hash4f(w, seed + 1);
      vec4 k = hash4f(w, seed + 2);
      vec2 ctr = c + 0.5 + 0.8 * (h.yz - 0.5);
      float a = h.w * PI;
      vec2 dir = vec2(cos(a), sin(a));
      float hl = 0.5 * mix(0.003, 1.6 * cellM, pow(g.x, 1.6)); // half-length (m)
      vec2 d = (p - ctr) * cellM;
      float t = dot(d, dir) / hl;
      float tc = clamp(t, -1.0, 1.0);
      float bow = (k.x - 0.5) * 0.6 * tc * tc + (k.y - 0.5) * 0.9 * tc * (1.0 - tc * tc);
      float n = dot(d, vec2(-dir.y, dir.x)) - bow * hl;
      float prof = pow(max(1.0 - tc * tc, 0.0), mix(0.25, 0.6, k.z)) * (1.0 + 0.35 * sin(6.2831853 * (tc * mix(0.6, 1.4, k.w) + g.y)));
      float hw = mix(0.00035, 0.0011, g.z * g.z) * prof;
      float sd = length(vec2(max(abs(t) - 1.0, 0.0) * hl, n)) - hw + rag;
      float f = 1.0 - smoothstep(-0.0003, 0.0003, sd);
      cov = max(cov, f);
      dep = max(dep, f * mix(0.5, 1.0, g.w));
    }
  }
}
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  TileInfo t = tiles(m, vec2(0.6));
  float e = t.edge;
  float w = 0.7 * aaM();
  float bar = 1.0 - smoothstep(0.012 - w, 0.012 + w, e);
  // fissures (ragged walls: +-0.15 mm)
  float rag = 0.0003 * (vnoise(uv, PM(700.0), 3) - 0.5);
  float clus = 0.55 + 0.9 * fbmV(uv, PM(12.0), 2, 5); // the roll punches unevenly: denser and sparser patches
  float cov = 0.0, dep = 0.0;
  ctFissures(uv, PM(143.0), 0.6 * clus, 11, rag, cov, dep);
  ctFissures(uv, PM(91.0), 0.4 * clus, 23, rag, cov, dep);
  ctFissures(uv, PM(45.0), 0.3 * clus, 37, rag, cov, dep);
  // painted fibre surface: grains and the forming undulation
  float gran = fbm(uv, PM(160.0), 3, 15);
  float und = fbm(uv, PM(25.0), 2, 17);
  float yel = fbm(uv, PM(3.0), 3, 16);
  float tb = 1.0 + 0.03 * (tileRand(t.id, 21) * 2.0 - 1.0);
  // cut edge of the tile beside the grid: a 0.6-1 mm line of the tile's mineral core
  float cut = 1.0 - smoothstep(0.0122, 0.0131, e);
  vec3 tileCol = TABLE_ALBEDO * tb * (1.0 + 0.02 * gran);
  tileCol *= mix(vec3(1.0), vec3(1.0, 0.985, 0.95), sat(yel * 1.5));
  tileCol *= 1.0 - 0.12 * cov;
  tileCol = mix(tileCol, srgb8(150.0, 146.0, 138.0), 0.8 * cut * (1.0 - bar));
  vec3 barCol = srgb8(236.0, 234.0, 228.0) * (1.0 + 0.006 * gran);
  s.albedo = mix(tileCol, barCol, bar);
  // bar: 0.95 with a 1.2 mm hem roundover (a quarter circle down to the tile face); tile face ~0.62
  float hem = sat((0.012 - e) / 0.0012);
  float hBar = 0.62 + 0.33 * sqrt(max(1.0 - (1.0 - hem) * (1.0 - hem), 0.0));
  float hTile = 0.62 + 0.05 * gran + 0.05 * und - 0.55 * dep - 0.06 * cut;
  s.height = mix(hTile, hBar, bar);
  s.rough = mix(0.92 + 0.05 * cov + 0.02 * gran, 0.33, bar);
  // a slot narrower than a texel only half-deepens its texel's height, so the cavity pass sees a shallow dip; the rest
  // of its occlusion (a 1 x 2 mm slot's floor sees ~20 % of the sky) goes into the recipe AO (harness ormh.r: mean
  // 0.94, 22 % of texels < 0.9, cores ~0.55: under a bulb's grazing light, g ~2, the cores go dark)
  s.ao = 1.0 - 0.3 * cov * (1.0 - bar);
  s.metal = 0.0;
  s.aux = 1.0 - bar;
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

// trim: albedo calibration (layerAlbedoCheck at 1024); phys: SurfacePhys (types.ts)
export const CEILING_RECIPES: RecipeTable = {
  [Mat.CEILING_TILE]: {
    glsl: CEILING_TILE, normalStrength: 1.5, heightScale: 0.004, trim: [0.997, 0.994, 0.985],
    phys: phys(0.9, { tok: 0.8, det: 5, detS: 0.8, sigma: 0.6 }), aux: 'detailMask',
  },
  [Mat.PANEL_LENS]: {
    glsl: PANEL_LENS, normalStrength: 3.0, heightScale: 0.002, trim: [0.978, 0.978, 0.983],
    phys: phys(0), aux: 'emissive',
  },
  [Mat.PLENUM]: {
    glsl: PLENUM, normalStrength: 1.0, heightScale: 0.01, trim: [0.827, 0.838, 0.864],
    phys: phys(0.8, { det: 4, detS: 1, sigma: 0.6 }),
  },
};
