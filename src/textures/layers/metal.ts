// src/textures/layers/metal.ts — METAL_PAINTED, METAL_RUST, METAL_GRATE, METAL_DECK, METAL_BARE (WP8).

import { Mat } from '../../core/ids.ts';
import { phys, type RecipeTable } from './types.ts';

/** Shared by the wear-ready recipes: the logistic approximation of the normal CDF (max error ~0.01), which
 * rank-normalises a sum of noises of known deviation into a threshold field with P(W < x) ~ x. */
const CDF_N = /* glsl */ `
float cdfN(float x) { return 1.0 / (1.0 + exp(-1.702 * x)); }
`;

/** Painted steel (frame 1.2 x 1.0 m), a wear-ready topcoat (texture realism v2, lane E). The colour is the neutral
 * topcoat only: the prop tint colours it, and the runtime wear (chunks/family/props.ts) exposes primer and steel where
 * the wear level passes W. Relief is oil-canning (sheet waviness that bends tube reflections); the orange peel is
 * detail D18 ENAMEL. Channels: ormh.a = W, the wear threshold (17 cm clusters, angular 8 mm flakes that break first
 * along their borders, fine grain; rank-normalised); albedo.a = S, the scratch field (0-2 segments of 8-80 mm per
 * 60 mm cell, 60 % within 15 degrees of u, value = depth class 0.3-1). */
const METAL_PAINTED = /* glsl */ `
#define SS 4
${CDF_N}
float scratchField(vec2 uv) {
  vec2 P = vec2(PM(16.7));
  vec2 p = uv * P;
  vec2 ci = floor(p);
  vec2 m = uv * FRAME;
  float S = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 c = ci + vec2(float(x), float(y));
      ivec2 w = ivec2(wrapCell(c, P));
      for (int k = 0; k < 2; k++) {
        vec4 h = hash4f(w, 40 + 7 * k);
        if (h.x > (k == 0 ? 0.5 : 0.22)) continue;
        vec4 g = hash4f(w, 61 + 7 * k);
        vec2 cen = (c + h.yz) / P * FRAME;
        float len = 0.008 * pow(10.0, g.x);
        float ang = g.y < 0.6 ? (g.z - 0.5) * 0.52 : g.z * PI;
        vec2 d = vec2(cos(ang), sin(ang)) * (0.5 * len);
        vec2 pa = m - (cen - d), ba = 2.0 * d;
        float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
        float dist = length(pa - ba * t);
        float hw = (0.2 + 0.4 * g.w) * 0.001 * (1.0 - 0.6 * abs(2.0 * t - 1.0)); // tapered ends
        S = max(S, lineM(dist, hw) * (0.3 + 0.7 * h.w));
      }
    }
  }
  return S;
}
void gen(vec2 uv, inout Surf s) {
  s.albedo = TABLE_ALBEDO * (1.0 + 0.1 * fbm(uv, PM(4.0), 3, 10)); // coat thickness +-3 %
  s.height = 0.5 + 1.3 * fbm(uv, PM(3.0), 2, 3); // oil-canning, ~+-0.45 mm
  s.rough = 0.36 + 0.15 * fbm(uv, PM(8.0), 3, 11) + 0.08 * fbm(uv, PM(40.0), 2, 15); // +-0.035 blotches, finer mottle
  s.metal = 0.0;
  vec2 wv = warp(uv, PM(3.0), 3, 4, 0.04);
  float lf = fbm(wv, PM(6.0), 4, 5);
  float mf = fbm(wv, PM(40.0), 3, 14);
  Cell fc = worley(uv, PM(120.0), 1.0, 6);
  float fl = hashf(fc.id, 7) - 0.5 - 0.3 * (1.0 - smoothstep(0.0, 0.1, fc.f2 - fc.f1));
  float fine = fbm(uv, PM(250.0), 2, 8);
  s.aux = cdfN((0.45 * lf / 0.18 + 0.35 * mf / 0.2 + 0.2 * fl / 0.3 + 0.05 * fine / 0.22) / 0.606);
  s.alpha = scratchField(uv);
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

/** METAL_BARE (texture realism v2, lane E; frame 0.6 m): bare metal of prop hardware, the albedo is F0 (the tint makes
 * chrome, stainless, aluminium, brass; the part's roughness override scales the lobe). Brushing along u (F0 and
 * roughness streaks; D8 carries the fine lines), a +-2 % low-frequency F0, water-spot rings (limescale: a dielectric
 * film) and sparse dark pits. ormh.a = the smudge threshold field (15 x 20 mm sebum clusters: the runtime puts them in
 * the hand band and near edges, rougher and a little darker). */
const METAL_BARE = /* glsl */ `
#define SS 4
${CDF_N}
void gen(vec2 uv, inout Surf s) {
  float lo = fbm(uv, PM(3.0), 3, 3);
  float br = gnoise(uv, PMxy(3.0, 350.0), 4) * 0.6 + gnoise(uv, PMxy(6.0, 170.0), 5) * 0.4;
  // water spots: thin Worley rings (r 2-5 mm) in ~2 % of the cells, in clusters
  Cell sp = worley(uv, PM(90.0), 0.9, 6);
  float rr = (0.35 + 0.5 * hashf(sp.id, 7)) * 0.5;
  float ring = (1.0 - smoothstep(0.0, 0.06, abs(sp.f1 - rr))) + 0.25 * (1.0 - smoothstep(0.0, rr, sp.f1));
  float spot = ring * step(hashf(sp.id, 8), 0.05) * smoothstep(0.1, 0.5, fbm(uv, PM(4.0), 2, 9));
  Cell pc = worley(uv, PM(400.0), 1.0, 10);
  float pit = step(hashf(pc.id, 11), 0.02) * (1.0 - smoothstep(0.1, 0.35, pc.f1));
  vec3 f0 = TABLE_ALBEDO * (1.0 + 0.06 * lo + 0.02 * br);
  s.albedo = mix(mix(f0, vec3(0.5, 0.49, 0.47), 0.6 * spot), f0 * 0.25, pit);
  s.metal = 1.0 - 0.7 * spot - 0.5 * pit;
  s.rough = clamp(0.3 + 0.03 * br + 0.02 * lo + 0.35 * spot + 0.3 * pit, 0.2, 1.0);
  s.height = 0.5 + 0.04 * br - 0.4 * pit + 0.05 * spot;
  // smudge field: oval sebum clusters (15 x 20 mm) over a soft cloud, rank-normalised
  float sm = fbm(uv, PMxy(55.0, 42.0), 3, 12);
  s.aux = cdfN((0.6 * sm / 0.2 + 0.4 * fbm(uv, PM(6.0), 3, 13) / 0.2) / 0.72);
}
`;

// trim: albedo calibration (layerAlbedoCheck at 1024); phys: SurfacePhys (types.ts)
export const METAL_RECIPES: RecipeTable = {
  [Mat.METAL_PAINTED]: {
    glsl: METAL_PAINTED, normalStrength: 1.0, heightScale: 0.0008, trim: [1.012, 1.017, 1.016], aux: 'wear', aux2: true,
    phys: phys(0.05, { det: 18, detS: 1 }),
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
  [Mat.METAL_BARE]: {
    glsl: METAL_BARE, normalStrength: 1.0, heightScale: 0.0001, aux: 'wear', phys: phys(0, { det: 8, detS: 1 }),
  },
};
