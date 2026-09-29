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
  s.rough = 0.4 + 0.15 * fbm(uv, PM(8.0), 3, 11) + 0.08 * fbm(uv, PM(40.0), 2, 15); // +-0.035 blotches, finer mottle
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

/** Corroding painted steel (texture realism v2, lane E; frame 1.2 m). Isotropic in uv: gravity comes from the world at
 * runtime (run-off below rusty areas, pipe undersides and joints). ormh.a = C, the corrosion order (rank-normalised:
 * warped clusters plus blister discs); the stages follow C downward: paint (C > 0.62, applied at runtime with the
 * part's paint colour, so the recipe stores the rust it would show), blisters and their orange halo (0.55-0.62, a
 * 0.3 mm dome with a cracked rim), lifted flakes (0.35-0.55: Voronoi plates of 8-30 mm, each tilted and lifted
 * 0.2-1 mm at a hashed edge, with a fresh-orange gap along their borders) and deep rust (< 0.35: dark scale,
 * tubercles and log-normally sized pits that crowd where C is lowest). Rust is a dielectric at roughness 0.88-0.95;
 * the paint remnants' roughness is set at runtime. Albedo is the corrosion palette: fresh FeOOH (0.40, 0.12, 0.03),
 * mid (0.20, 0.08, 0.03), old scale (0.07, 0.04, 0.025), pits (0.03, 0.02, 0.015). */
const METAL_RUST = /* glsl */ `
#define SS 4
${CDF_N}
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  vec2 wv = warp(uv, PM(3.0), 3, 3, 0.05);
  float lf = fbm(wv, PM(3.0), 4, 4);
  float mf = fbm(wv, PM(12.0), 3, 5);
  // rust spots (r 5-25 mm, a third of the 4 cm cells) that coalesce where the fields corrode, and blisters (discs of
  // r 3-10 mm in clusters, Worley 40/m where the mid field is corroding)
  Cell sc = worley(wv, PM(25.0), 0.9, 22);
  vec4 sh = hash4f(sc.id, 23);
  float spot = (1.0 - smoothstep(0.2 + 0.4 * sh.x, 0.3 + 0.5 * sh.x, sc.f1)) * step(sh.y, 0.35);
  Cell bc = worley(uv, PM(40.0), 0.9, 6);
  vec4 bh = hash4f(bc.id, 7);
  float br = 0.003 + 0.007 * bh.x;
  float bd = bc.f1 / 40.0; // metres from the blister centre
  float blister = (1.0 - smoothstep(br * 0.85, br, bd)) * step(bh.y, 0.55) * smoothstep(-0.1, 0.25, mf);
  float C = cdfN((0.45 * lf / 0.18 + 0.55 * mf / 0.2 - 1.1 * spot - 0.9 * blister + 0.13) / 0.8);
  s.aux = C;
  float fresh = smoothstep(0.55, 0.62, C); // halo and just-exposed rust: the paint's edge
  float flakeZ = smoothstep(0.33, 0.37, C) * (1.0 - smoothstep(0.53, 0.57, C));
  float deep = 1.0 - smoothstep(0.33, 0.37, C);
  // lifted flakes: Voronoi plates of ~8-30 mm, tilted +-4 deg about a hashed direction, lifted at their downhill edge
  vec3 fe = worleyEdge(uv, PM(55.0), 1.0, 8);
  vec4 fh = hash4f(ivec2(fe.yz), 9);
  Cell fc = worley(uv, PM(55.0), 1.0, 8);
  vec2 fdir = vec2(cos(fh.x * 6.2832), sin(fh.x * 6.2832));
  float tilt = (0.3 + 0.7 * fh.y) * 0.07 * dot(fc.rel / 55.0, fdir); // metres (tan 4 deg ~ 0.07)
  float lift = 0.0002 + 0.0008 * fh.z;
  float gap = 1.0 - smoothstep(0.02, 0.07, fe.x); // the plate border: a 1-2 mm gap of fresh oxide
  // deep rust: tubercles (1-3 mm) and pits in three log-spaced octaves, denser where C is lowest
  Cell tc = worley(uv, PM(420.0), 1.0, 10);
  float tub = (1.0 - smoothstep(0.0, 0.8, tc.f1)) * step(hashf(tc.id, 11), 0.6);
  float pit = 0.0;
  for (int k = 0; k < 3; k++) {
    float d = k == 0 ? 150.0 : k == 1 ? 300.0 : 600.0;
    Cell pc = worley(uv, PM(d), 0.9, 12 + k);
    float dens = (0.03 + 0.15 * (1.0 - C)) * (k == 0 ? 0.35 : k == 1 ? 0.7 : 1.0);
    float rr = 0.25 + 0.3 * hashf(pc.id, 20 + k);
    pit = max(pit, (1.0 - smoothstep(rr * 0.6, rr, pc.f1)) * step(hashf(pc.id, 16 + k), dens));
  }
  float tone = fbm(uv, PM(30.0), 3, 21);
  float crust = fbm(wv, PM(20.0), 3, 24); // thick scale crusts (dark) against looser oxide (orange-brown) in deep rust
  vec3 cFresh = vec3(0.40, 0.12, 0.03), cMid = vec3(0.20, 0.08, 0.03), cOld = vec3(0.07, 0.04, 0.025);
  vec3 col = mix(cMid, cFresh, clamp(0.5 + 1.5 * tone, 0.0, 1.0) * 0.5 + 0.5 * fresh);
  col = mix(col, mix(cMid * (0.8 + 0.4 * fh.w), cOld, 0.3), flakeZ * (1.0 - gap));
  col = mix(col, cFresh * (0.85 + 0.3 * tone), flakeZ * gap);
  vec3 deepC = mix(mix(cMid, cFresh, 0.35 * clamp(0.5 + 2.0 * tone, 0.0, 1.0)), cOld, smoothstep(-0.05, 0.25, crust));
  col = mix(col, mix(deepC, cMid * 1.2, 0.3 * tub), deep);
  col = mix(col, vec3(0.03, 0.02, 0.015), pit * (0.4 + 0.6 * deep));
  s.albedo = col;
  s.metal = 0.0;
  s.rough = 0.88 + 0.05 * deep + 0.02 * tone;
  // relief (heightScale 3 mm per unit): paint flat, blister domes +0.3 mm with a cracked rim, flakes lifted and tilted,
  // deep rust sunk with tubercles on it, pits
  float h = 0.5 + 0.1 * blister * (1.0 - 0.6 * smoothstep(0.7, 1.0, bd / br)) * step(0.55, C);
  h += flakeZ * (1.0 - gap) * (lift + tilt) / 0.003;
  h += deep * (-0.05 + 0.04 * tub);
  h -= 0.15 * pit;
  s.height = h;
}
`;

/** Hot-dip galvanised bar grating (19-W-4; lane E): 5 mm bearing bars at 30 mm, 5 mm cross rods at 100 mm, under a
 * dull zinc oxide (F0 ~0.36 at roughness ~0.6) with spangle-scale mottle, walked-on bar tops a little brighter, ~2 %
 * white-rust flecks (zinc hydroxide: dielectric, chalky) and dirt packed at the junctions. The holes are dark (a pit
 * or the cabinet behind: alpha 0 on alpha-tested faces). */
const METAL_GRATE = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  float bearing = fillM(distLines(m.x, 0.03) - 0.0025);
  float crossB = fillM(distLines(m.y, 0.1) - 0.0025);
  float bar = max(bearing, crossB);
  float junction = bearing * crossB;
  float wear = fbmV(uv, PM(6.0), 3, 3);
  float polish = smoothstep(0.55, 0.8, wear);
  vec3 zinc = vec3(0.36, 0.36, 0.35) * (0.9 + 0.2 * vnoise(uv, PM(60.0), 4));
  zinc = mix(zinc, vec3(0.45, 0.45, 0.44), polish * 0.4);
  Cell wr = worley(uv, PM(40.0), 0.9, 5);
  float white = step(hashf(wr.id, 6), 0.08) * (1.0 - smoothstep(0.15, 0.4, wr.f1));
  zinc = mix(zinc, vec3(0.55, 0.55, 0.53), white);
  zinc *= 1.0 - 0.45 * junction * smoothstep(0.3, 0.7, fbmV(uv, PM(20.0), 2, 7));
  vec3 hole = srgb8(40.0, 39.0, 38.0);
  s.albedo = mix(hole, zinc, bar);
  s.alpha = bar;
  s.metal = 0.8 * bar * (1.0 - white);
  s.rough = mix(0.95, mix(0.6 - 0.1 * polish, 0.9, white), bar);
  s.height = max(bearing, 0.85 * crossB);
  s.ao = mix(0.25, 1.0, bar);
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
  // lane E: white-rust bloom (zinc hydroxide, chalky, ~5 %) and dark drip lines along the rib bottoms
  float wr = smoothstep(0.62, 0.75, fbmV(warp(uv, PM(3.0), 2, 8, 0.03), PM(10.0), 4, 9));
  col = mix(col, vec3(0.5, 0.5, 0.48), wr * 0.7);
  float drip = bottom * smoothstep(0.55, 0.85, vnoise(uv, PMxy(60.0, 1.5), 10)) * (1.0 - smoothstep(0.004, 0.01, abs(x - 0.075)));
  col *= 1.0 - 0.45 * drip;
  s.albedo = col;
  s.metal = mix(0.8, 0.55, dull) * (1.0 - 0.8 * rust) * (1.0 - wr);
  s.rough = mix(0.4 + 0.12 * sh, 0.58, dull) + 0.25 * rust + 0.35 * wr + 0.15 * drip;
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
    glsl: METAL_RUST, normalStrength: 1.5, heightScale: 0.003, trim: [0.991, 1.0, 0.984], aux: 'wear',
    phys: phys(0.4, { det: 19, detS: 1, sigma: 0.5 }),
  },
  [Mat.METAL_GRATE]: {
    glsl: METAL_GRATE, normalStrength: 0.35, heightScale: 0.02, trim: [1.02, 1.03, 1.06],
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
