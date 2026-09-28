// src/textures/layers/metal.ts — METAL_PAINTED, METAL_RUST, METAL_GRATE, METAL_DECK, METAL_BARE (WP8).

import { Mat } from '../../core/ids.ts';
import { phys, type RecipeTable } from './types.ts';

/** Painted steel (frame 1.2 x 1.0 m): orange peel, chips through to red-oxide primer and bare steel, fine
 * horizontal scratches. Paint is dielectric; only exposed steel is metallic. */
const METAL_PAINTED = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  float op = fbm(uv, PM(180.0), 3, 3);
  vec2 wv = warp(uv, PM(6.0), 3, 4, 0.03);
  float chipN = fbm(wv, PM(9.0), 5, 5) + 0.25 * fbm(uv, PM(60.0), 2, 6);
  // R2 integration: fewer, smaller chips (was 0.4 / 0.5): scattered over pale locker / door paint, frequent red chips
  // read as blood spatter under the camcorder grade
  float chip = smoothstep(0.47, 0.5, chipN);
  float bare = smoothstep(0.55, 0.58, chipN);
  float scr = smoothstep(0.8, 0.92, ridged(warp(uv, PM(4.0), 2, 7, 0.01), PMxy(2.0, 70.0), 2, 8))
            * smoothstep(0.45, 0.75, vnoise(uv, PM(5.0), 9));
  vec3 paint = TABLE_ALBEDO * (1.0 + 0.02 * op + 0.035 * fbm(uv, PM(3.0), 3, 10));
  vec3 primer = srgb8(112.0, 80.0, 62.0); // weathered oxide primer (was a saturated 122, 64, 46)
  vec3 steel = srgb8(150.0, 150.0, 152.0);
  float metalMask = max(bare, 0.8 * scr);
  vec3 col = mix(paint, primer, chip);
  col = mix(col, steel, metalMask);
  s.albedo = col;
  s.metal = metalMask;
  s.rough = mix(mix(0.42 + 0.06 * op, 0.7, chip), 0.33, metalMask);
  s.height = 0.6 + 0.05 * op - 0.14 * chip - 0.06 * bare - 0.05 * scr;
}
`;

/** Rusted steel: rust mask from warped fbm plus downward (vertical) run streaks, flaking scale, pitting, remnants
 * of old grey-green paint and a little bare steel. */
const METAL_RUST = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  vec2 wv = warp(uv, PM(4.0), 4, 3, 0.04);
  float f = fbm(wv, PM(5.0), 5, 4);
  float str = fbm(uv, PMxy(30.0, 2.0), 3, 5);
  float str2 = gnoise(uv, PMxy(80.0, 4.0), 6);
  float rustM = smoothstep(-0.25, 0.0, f + 0.35 * str + 0.1 * str2);
  float heavy = smoothstep(0.1, 0.4, f + 0.2 * str);
  float bareM = (1.0 - rustM) * smoothstep(0.1, 0.3, fbm(uv, PM(12.0), 3, 11) - 0.1);
  Cell pt = worley(uv, PM(90.0), 0.9, 7);
  float pit = step(hashf(pt.id, 8), 0.5) * (1.0 - smoothstep(0.1, 0.35, pt.f1)) * rustM;
  float cv = fbmV(uv, PM(25.0), 4, 9);
  vec3 orange = srgb8(166.0, 104.0, 64.0);
  vec3 brown = srgb8(124.0, 88.0, 64.0);
  vec3 dark = srgb8(70.0, 52.0, 42.0);
  vec3 rust = mix(brown, orange, smoothstep(0.35, 0.7, cv));
  rust = mix(rust, dark, heavy * 0.7);
  rust *= 1.0 - 0.3 * pit;
  vec3 paint = srgb8(112.0, 118.0, 110.0) * (1.0 + 0.03 * fbm(uv, PM(40.0), 2, 10));
  vec3 steel = srgb8(140.0, 138.0, 136.0);
  vec3 col = mix(paint, rust, rustM);
  col = mix(col, steel, bareM);
  // run-off stains over the paint
  col = mix(col, col * vec3(0.8, 0.64, 0.52), smoothstep(0.1, 0.6, str) * (1.0 - rustM) * 0.6);
  s.albedo = col;
  s.metal = bareM + 0.15 * (1.0 - rustM);
  s.rough = mix(mix(0.5, 0.35, bareM), 0.85 + 0.1 * heavy, rustM);
  s.height = 0.45 + 0.15 * heavy * rustM + 0.08 * rustM + 0.05 * f - 0.25 * pit;
}
`;

/** Close-mesh bar grating: bearing bars 5 mm @ 15 mm, cross bars 5 mm @ 50 mm; dark holes (alpha 0 for the
 * alpha-tested DECAL flag), walked-on bar tops polished. */
const METAL_GRATE = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  float bearing = fillM(distLines(m.x, 0.015) - 0.0025);
  float crossB = fillM(distLines(m.y, 0.05) - 0.0025);
  float bar = max(bearing, crossB);
  float wear = fbmV(uv, PM(6.0), 3, 3);
  float polish = smoothstep(0.55, 0.8, wear);
  vec3 steel = srgb8(150.0, 152.0, 152.0) * (0.9 + 0.2 * vnoise(uv, PM(120.0), 4));
  steel = mix(steel, srgb8(182.0, 184.0, 184.0), polish * 0.5);
  vec3 hole = srgb8(66.0, 64.0, 62.0);
  s.albedo = mix(hole, steel, bar);
  s.alpha = bar;
  s.metal = 0.9 * bar;
  s.rough = mix(0.9, 0.55 - 0.2 * polish, bar);
  s.height = max(bearing, 0.85 * crossB);
  s.ao = mix(0.35, 1.0, bar);
}
`;

/** Corrugated roof deck (frame 1.2 m): trapezoidal ribs every 0.15 m, galvanised spangle, dull oxidised patches,
 * faint rust in the rib bottoms. */
const METAL_DECK = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  float x = mod(m.x, 0.15);
  float h = sat((x - 0.04) / 0.035) - sat((x - 0.115) / 0.035);
  float bottom = 1.0 - h;
  Cell sp = worley(uv, PM(32.0), 0.9, 3);
  float sh = hashf(sp.id, 4);
  float sEdge = smoothstep(0.0, 0.06, sp.f2 - sp.f1);
  vec3 zinc = TABLE_ALBEDO * (0.9 + 0.2 * sh) * mix(0.93, 1.0, sEdge);
  float dull = smoothstep(-0.1, 0.6, fbm(uv, PM(4.0), 4, 5));
  float rustN = fbm(uv, PMxy(20.0, 3.0), 4, 6) + 0.3 * fbm(uv, PM(2.0), 3, 7);
  float rust = bottom * smoothstep(0.2, 0.55, rustN);
  vec3 rustCol = srgb8(120.0, 76.0, 46.0);
  vec3 col = zinc * mix(0.98, 1.05, dull);
  col = mix(col, rustCol, rust * 0.6);
  s.albedo = col;
  s.metal = mix(0.8, 0.55, dull) * (1.0 - 0.8 * rust);
  s.rough = mix(0.4 + 0.12 * sh, 0.58, dull) + 0.25 * rust;
  s.height = h;
}
`;

/** METAL_BARE (reserved, texture realism v2; not placed in the world yet): placeholder flat metal at the table
 * values. */
const METAL_BARE = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
}
`;

// trim: albedo calibration (layerAlbedoCheck at 1024); phys: SurfacePhys (types.ts)
export const METAL_RECIPES: RecipeTable = {
  [Mat.METAL_PAINTED]: {
    glsl: METAL_PAINTED, normalStrength: 1.0, heightScale: 0.0008, trim: [1.012, 1.017, 1.016],
    phys: phys(0.05, { det: 3, detS: 0.6 }),
  },
  [Mat.METAL_RUST]: {
    glsl: METAL_RUST, normalStrength: 1.0, heightScale: 0.0015, trim: [1.116, 1.099, 0.991],
    phys: phys(0.4, { det: 4, detS: 0.6 }),
  },
  [Mat.METAL_GRATE]: {
    glsl: METAL_GRATE, normalStrength: 0.35, heightScale: 0.02, trim: [1.259, 1.246, 1.261],
    phys: phys(0),
  },
  [Mat.METAL_DECK]: {
    glsl: METAL_DECK, normalStrength: 1.0, heightScale: 0.038, trim: [1.018, 1.022, 1.024],
    phys: phys(0.02, { pomTop: 1, tok: 0.7, det: 8, detS: 0.6 }),
  },
  [Mat.METAL_BARE]: { glsl: METAL_BARE, normalStrength: 1.0, heightScale: 0.0002, phys: phys(0) },
};
