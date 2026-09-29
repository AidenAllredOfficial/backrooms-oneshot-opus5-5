// src/textures/layers/misc.ts — WOOD, PLASTIC, RUBBER (WP8).

import { Mat } from '../../core/ids.ts';
import { phys, type RecipeTable } from './types.ts';

/** Finished flat-sawn wood (desks, doors, benches, crates; texture realism v2, lane E; frame 1.2 m, grain along u).
 * The frame is split across v into boards of hashed width 90-300 mm. Each board is cut from its own log: the pith
 * lies d = 2-25 cm under the face and off to one side, so the face cuts the near-coaxial ring cones along
 * R = sqrt(d^2 + z^2) + t x (z across the board, x along it from the board's butt joint, t the grain slope of 20-60 mm
 * of radius per metre, either way, plus a +-3 mm sweep of the pith): nested cathedral arches pointing along the board
 * where the rings surface, straight grain on the flanks. Every board has a butt joint at a hashed u (the slope restarts
 * there, so the frame tiles); ring width 3-8 mm per board (finer rings fade out at 1.2 mm texels), +-40 % from ring to
 * ring, earlywood grading into a darker latewood that ends abruptly at the next ring; hue and value vary per board.
 * Rings finer than ~3 samples fade to their mean (no moire). ormh.a = the finish-wear threshold (runtime: lighter, less
 * saturated, rougher where hands and objects wore the finish off). */
const WOOD = /* glsl */ `
float wn1(float x, int seed) {
  float i = floor(x), f = x - i;
  return mix(hashf(ivec2(int(i), 7), seed), hashf(ivec2(int(i) + 1, 7), seed), f * f * (3.0 - 2.0 * f));
}
float cdfN(float x) { return 1.0 / (1.0 + exp(-1.702 * x)); }
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  // the board under this sample: widths 90-300 mm packed across v; the last board takes the remainder so the frame tiles,
  // and the packing starts half a board below the frame edge, so the wrap falls inside a board (no joint on the seam)
  float w0h = 0.5 * (0.09 + 0.21 * hashf(ivec2(0, 3), 30));
  m.y = mod(m.y + w0h, FRAME.y);
  float y0 = 0.0, bw = FRAME.y;
  int bid = 0;
  for (int k = 0; k < 12; k++) {
    float wk = 0.09 + 0.21 * hashf(ivec2(k, 3), 30);
    if (y0 + wk + 0.09 > FRAME.y) wk = FRAME.y - y0;
    bid = k; bw = wk;
    if (m.y < y0 + wk) break;
    y0 += wk;
  }
  vec4 bh = hash4f(ivec2(bid, 5), 31);
  vec4 bh2 = hash4f(ivec2(bid, 6), 32);
  float d = 0.02 + 0.23 * bh.x * bh.x;          // pith depth under the face (m)
  float zc = (bh.y - 0.5) * 1.6 * bw;            // pith offset across the board
  float w0 = 0.003 + 0.005 * bh.z;               // ring width
  float k = 6.2832 / FRAME.x;
  float tr = (0.02 + 0.04 * bh.w) * (bh2.y < 0.5 ? 1.0 : -1.0); // grain slope (m of radius per m of length)
  vec2 xw = m + 0.004 * vec2(0.0, fbm(uv, PMxy(3.0, 8.0), 3, 33)); // slight wander of the grain
  float z = xw.y - y0 - 0.5 * bw - zc;
  float xl = mod(xw.x - bh2.x * FRAME.x, FRAME.x); // along the board from its butt joint
  // the grain slope, a slow wobble and the pith's sweep (+-3 mm over ~20 cm: the arch tips fall irregularly)
  float tap = tr * xl + 0.002 * sin(k * xw.x + 6.2832 * bh2.z) + 0.006 * (wn1(xl * 5.0, 40 + bid) - 0.5);
  float R = sqrt(d * d + z * z) + tap;
  float t = R / w0;
  t += 2.2 * (wn1(t * 0.18, 34 + bid) - 0.5); // ring widths +-40 %
  float ph = fract(t);
  // earlywood grading into latewood, which ends abruptly at the next ring
  float late = smoothstep(0.45, 0.9, ph) * (1.0 - smoothstep(0.95, 1.0, ph));
  // band limit: rings per sample from the ring coordinate's gradient (finite difference over one sample)
  float e = aaM();
  float Rx = sqrt(d * d + z * z) + tap + (tr + 0.002 * k * cos(k * xw.x + 6.2832 * bh2.z)) * e;
  float Rz = sqrt(d * d + (z + e) * (z + e)) + tap;
  float rps = length(vec2(Rx - R, Rz - R)) / w0; // rings per sample
  float con = 1.0 - smoothstep(0.2, 0.4, rps);
  late = mix(0.3, late, con);
  float fib = gnoise(xw / FRAME, PMxy(4.0, 300.0), 6) + 1.2 * gnoise(xw / FRAME, PMxy(2.0, 45.0), 38); // fibre and mineral streaks
  vec3 tint = vec3(1.0 + 0.06 * (bh2.z - 0.5), 1.0, 1.0 - 0.06 * (bh2.z - 0.5)) * (0.9 + 0.2 * bh2.w);
  vec3 early = TABLE_ALBEDO * vec3(1.14, 1.12, 1.08);
  vec3 lateC = TABLE_ALBEDO * vec3(0.66, 0.55, 0.45);
  vec3 col = mix(early, lateC, late) * tint * (1.0 + 0.04 * fib + 0.04 * fbm(uv, PM(2.0), 3, 7));
  // board joints: a faint glue line along, a tight butt joint across
  float jd = min(m.y - y0, y0 + bw - m.y);
  float jx = min(xl, FRAME.x - xl);
  col *= 1.0 - 0.25 * (1.0 - smoothstep(0.0003, 0.0009, jd)) - 0.35 * (1.0 - smoothstep(0.0003, 0.0009, jx));
  s.albedo = col;
  s.rough = 0.35 + 0.035 * fbm(uv, PM(6.0), 3, 35) + 0.02 * late;
  s.height = 0.5 + 0.06 * late + 0.03 * fib;
  // finish-wear threshold: soft patches (hands, objects) over the fine grain, rank-normalised
  s.aux = cdfN((0.7 * fbm(uv, PM(8.0), 4, 36) / 0.18 + 0.3 * fbm(uv, PMxy(20.0, 90.0), 2, 37) / 0.2) / 0.76);
}
`;

/** Moulded plastic (chairs, bins, housings; texture realism v2, lane E; frame 0.6 m). Pigment through the bulk under
 * an F0 0.04 skin: flow-line gloss bands (a warped field at 20-60 mm), sink-mark dips over ribs (0.1 mm, ~10 % of
 * 7 cm cells) and a faint pigment mottle; the EDM haircell is detail D10. ormh.a = the scuff threshold (angular 3-20 mm
 * blobs and short streaks; the runtime whitens them where edges and the kick zone wear, and chalks up-facing faces). */
const PLASTIC = /* glsl */ `
float cdfN(float x) { return 1.0 / (1.0 + exp(-1.702 * x)); }
void gen(vec2 uv, inout Surf s) {
  vec2 w = warp(uv, PM(3.0), 3, 3, 0.05);
  float flow = sin(6.2832 * (w.x * 15.0 + 1.5 * fbm(w, PM(4.0), 2, 4))); // 15 bands per frame: ~40 mm
  Cell sk = worley(uv, PM(15.0), 0.8, 5);
  float sink = step(hashf(sk.id, 6), 0.1) * (1.0 - smoothstep(0.0, 0.6, sk.f1));
  s.albedo = TABLE_ALBEDO * (1.0 + 0.02 * fbm(uv, PM(8.0), 3, 7));
  s.rough = 0.4 + 0.045 * flow * smoothstep(-0.2, 0.3, fbm(uv, PM(2.0), 2, 8)) + 0.02 * sink;
  s.height = 0.5 - 0.35 * sink;
  Cell sc = worley(uv, PM(60.0), 1.0, 9);
  float blob = hashf(sc.id, 10) - 0.5;
  float streak = ridged(warp(uv, PM(4.0), 2, 11, 0.03), PMxy(3.0, 60.0), 2, 12);
  s.aux = cdfN((0.5 * fbm(uv, PM(10.0), 3, 13) / 0.2 + 0.5 * blob / 0.29 - 0.5 * (streak - 0.45) / 0.2) / 0.87);
}
`;

/** Black rubber (cove base, treads, mats, hoses; lane E; frame 1.2 m): carbon-black SBR / EPDM at 0.03, a mottle of
 * waxy antiozonant bloom (ormh.a: the runtime greys it on up-facing and old parts), ozone crazing (fine dark cracks,
 * ~3 %), roughness 0.62 +- 0.08 with rubbed glossier patches (0.45); the haircell detail at half strength. */
const RUBBER = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  float mid = fbm(uv, PM(20.0), 3, 4);
  float craze = smoothstep(0.93, 0.985, ridged(warp(uv, PM(6.0), 2, 5, 0.02), PM(160.0), 2, 6))
              * smoothstep(0.1, 0.5, fbm(uv, PM(3.0), 2, 7));
  float rub = smoothstep(0.35, 0.6, fbm(uv, PM(4.0), 3, 8));
  s.albedo = TABLE_ALBEDO * (1.0 + 0.12 * mid) * (1.0 - 0.5 * craze);
  s.rough = mix(0.64 + 0.06 * mid, 0.45, rub) + 0.1 * craze;
  s.height = 0.5 + 0.05 * mid - 0.3 * craze;
  s.aux = clamp(0.5 + 0.9 * fbm(uv, PM(5.0), 3, 9), 0.0, 1.0); // bloom mottle (a 'mask')
}
`;

// trim: albedo calibration (layerAlbedoCheck at 1024); phys: SurfacePhys (types.ts)
export const MISC_RECIPES: RecipeTable = {
  [Mat.WOOD]: {
    glsl: WOOD, normalStrength: 1.0, heightScale: 0.0003, trim: [0.975, 1.026, 1.095], aux: 'wear',
    phys: phys(0.25, { det: 9, detS: 1 }),
  },
  [Mat.PLASTIC]: {
    glsl: PLASTIC, normalStrength: 1.0, heightScale: 0.0003, trim: [0.999, 0.997, 0.998], aux: 'wear',
    phys: phys(0.02, { det: 10, detS: 1 }),
  },
  [Mat.RUBBER]: {
    glsl: RUBBER, normalStrength: 1.0, heightScale: 0.0003, trim: [1.01, 1.01, 1.01], aux: 'mask',
    phys: phys(0.02, { det: 10, detS: 0.5, sigma: 0.3 }),
  },
};
