// src/textures/detailRecipes/textile.ts — textile detail maps: D0 CUT_PILE, D1 LOOP_PILE, D7 WEAVE (package B;
// texture realism v2 lane A).
//
// All three are regular lattices (tufting rows, loop rows, a weave), and a regular pattern whose period is not a
// power-of-two number of texels beats in the box-filtered mip chain: a 94-row pile at 5.4 texels per row drew
// horizontal streaks across the floor 1-2 m away, where the footprint selects mip 1-2 (rows bowed by +-0.35 of a row
// still did). So every regular period here is 2, 4 or 8 texels of the 512^2 map (0.3 m / 128 = 2.34 mm tufting rows and
// loop pitch, 256 weave threads of 1.17 mm): each mip level then averages whole periods, and the jitter, row offsets
// and per-cell variation remain as noise. Only the D0 stitch pitch along a row keeps 96 (3.13 mm): each row's stitches
// are shifted by a hashed fraction, so that direction has no coherent period.

import { Det, type DetailTable } from './types.ts';

/** D0 cut pile (Level 0 carpet), seen from above: each tuft is the cut end of a 2-ply twisted yarn, a ~2.7 x 2.1 mm
 * "coffee bean" of two plies with a split between them, on a tufting lattice of 128 rows x 96 stitches per 0.3 m
 * (2.34 mm rows, 3.13 mm stitches; each row shifted by a hashed fraction of a stitch, tufts jittered +-0.3 of a cell,
 * twisted at a hashed angle, sized +-12 %). The tips lean 0.2-0.7 mm along a smooth 15 mm field, so neighbours lean
 * together; the side facing the lean is lit, the other shadowed. Between the tips the cracks are narrow and nearly black
 * (AO 0.15 plus the cavity), the split between the plies half dark (0.75). Per-tuft tone +-12 % and fibre ends (a fine
 * bright speckle on the tips). No feature exceeds a tuft, so the 0.3 m repeat stays invisible. */
const CUT_PILE = /* glsl */ `
#define SS 4
// one ply of a cut tuft: a flattened dome over an ellipse (half-sizes hs mm along / across the twist axis a)
float ply(vec2 p, vec2 c, vec2 a, vec2 hs) {
  vec2 d = p - c;
  vec2 q = vec2(dot(d, a), dot(d, vec2(-a.y, a.x))) / hs;
  return pow(sat(1.0 - dot(q, q)), 0.4);
}
void gen(vec2 uv, inout Surf s) {
  const vec2 G = vec2(96.0, 128.0); // stitches (u) x rows (v) per repeat: 3.13 x 2.34 mm (rows: 4 texels)
  vec2 mm = FRAME * 1000.0 / G; // mm per lattice cell
  vec2 g = uv * G;
  vec2 p = g * mm; // the sample, mm
  // tip lean: a smooth field (neighbours lean together)
  vec2 lf = vec2(fbm(uv, PM(20.0), 2, 11), fbm(uv, PM(20.0), 2, 12));
  vec2 ld = lf / max(length(lf), 1e-3);
  vec2 lo = ld * mix(0.2, 0.7, sat(length(lf) * 2.0));
  float h = 0.0, grv = 0.0;
  vec4 bh = vec4(0.5);
  vec2 rel = vec2(0.0);
  for (int dy = -1; dy <= 1; dy++) {
    float r = floor(g.y) + float(dy);
    float rw = wrapCell(vec2(r), vec2(G.y)).x;
    float off = hashf(ivec2(int(rw), 0), 5); // needles are not in register: each row is shifted
    for (int dx = -1; dx <= 1; dx++) {
      float c = floor(g.x - off) + float(dx);
      vec2 id = wrapCell(vec2(c, rw), G);
      vec4 h1 = hash4f(id, 6);
      vec4 h2 = hash4f(id, 7);
      vec2 ctr = (vec2(c + off, r) + 0.5 + (h1.xy - 0.5) * 0.6) * mm + lo;
      float th = 6.2831853 * h1.z;
      vec2 a = vec2(cos(th), sin(th));
      float sz = mix(0.88, 1.12, h1.w);
      vec2 hs = vec2(0.85, 1.05) * sz;
      float t1 = ply(p, ctr + a * (0.52 * sz), a, hs);
      float t2 = ply(p, ctr - a * (0.52 * sz), a, hs);
      float t = max(t1, t2) * mix(0.88, 1.12, h2.x);
      if (t > h) {
        h = t;
        bh = h2;
        rel = p - ctr;
        grv = smoothstep(0.35, 0.9, min(t1, t2) / max(max(t1, t2), 1e-3)); // 1 in the split between the plies
      }
    }
  }
  float crown = smoothstep(0.0, 0.5, h);
  s.height = h * (1.0 - 0.2 * grv);
  s.ao = mix(0.15, 1.0, crown) * mix(1.0, 0.75, grv);
  // per-tuft tone +-12 %, fibre-end speckle on the tips (+18 % on ~20 % of them), the lean-facing side lit
  float sp = smoothstep(0.62, 0.72, vnoise(uv, PM(600.0), 13)) * step(0.5, h);
  float side = dot(rel / max(length(rel), 1e-3), ld) * crown;
  s.albedo = vec3((1.0 + 0.24 * (bh.y - 0.5)) * mix(1.0, 1.05, crown) * (1.0 + 0.18 * sp) * (1.0 + 0.06 * side));
}
`;

/** D1 level loop pile (office carpet tiles), seen from above: straight rows along u (128 rows x 128 loops per 0.3 m:
 * 2.34 mm gauge and stitch; each row shifted by a hashed fraction of a stitch, rows wander <= 0.08 of a row). Each
 * loop is an elongated bead ~2.1 x 1.24 mm (half-axes 1.05 x 0.62 mm) with its own height (+-12 %) and tone (+-10 %);
 * the yarn dips into the backing between loops (a pinch: height 0.55, AO 0.65) and the rows are separated by dark
 * gaps (height 0, AO 0.3). Fibre fuzz on top. The shader turns the map with its carpet tile. */
const LOOP_PILE = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  const vec2 G = vec2(128.0, 128.0); // loops (u) x rows (v) per repeat: 4 texels per cell
  vec2 mm = FRAME * 1000.0 / G;
  vec2 g = uv * G;
  g.y += 0.08 * gnoise(uv, PM(12.0), 7);
  float row = wrapCell(vec2(floor(g.y)), vec2(G.y)).x;
  float gx = g.x + hashf(ivec2(int(row), 0), 5) * G.x;
  vec4 r = hash4f(wrapCell(vec2(floor(gx), row), G), 3);
  vec2 f = (vec2(fract(gx), fract(g.y)) - 0.5) * mm; // mm from the loop's cell centre
  vec2 q = (f - vec2(0.0, 0.1 * (r.z - 0.5))) / vec2(1.05, 0.62);
  float loop = sqrt(sat(1.0 - dot(q, q)));
  float inRow = 1.0 - smoothstep(0.85, 1.1, abs(q.y)); // across the row: yarn (loop or pinch) vs the row gap
  float pinch = inRow * (1.0 - smoothstep(0.0, 0.35, loop));
  float fuzz = vnoise(uv, PM(700.0), 4);
  s.height = max(loop * mix(0.88, 1.12, r.x), 0.55 * pinch) + 0.06 * (fuzz - 0.5);
  s.ao = mix(0.3, mix(0.65, 1.0, smoothstep(0.0, 0.4, loop)), inRow);
  s.albedo = vec3((1.0 + 0.2 * (r.y - 0.5)) * (1.0 + 0.1 * (fuzz - 0.5)));
}
`;

/** D7 basket weave (cubicle partition fabric; the base layer cannot hold it): a 2 x 2 basket of 1.17 mm threads (256
 * per 0.3 m), each thread a cosine section with a flattened crown that bulges mid-float. Every thread's float in a
 * block is spun from the darker or the lighter of two yarns (x 0.8 / x 1.15: crossing heather, not a clean graphic
 * grid); 3 % of the weft carries slubs, 5-12 mm segments 40 % wider and higher. Fuzz of 1 mm cells, the interstices in
 * shadow (AO 0.6). */
const WEAVE = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  const float N = 256.0; // threads per repeat: 2 texels per thread, 8 per basket repeat
  vec2 g = uv * N;
  vec2 ci = wrapCell(floor(g), vec2(N));
  vec2 f = fract(g) - 0.5;
  vec2 blk = floor(ci * 0.5);
  float over = mod(blk.x + blk.y, 2.0); // 1: the warp (running along v) floats on top in this block
  // weft slubs: per weft thread, 12 mm cells along u (each row shifted), 3 % of them hold a 5-12 mm thick segment
  float cx = uv.x * 25.0 + hashf(ivec2(int(ci.y), 0), 21) * 25.0;
  vec4 sh = hash4f(wrapCell(vec2(floor(cx), ci.y), vec2(25.0, N)), 22);
  float slub = sh.x < 0.03 ? sat((0.5 * mix(0.42, 1.0, sh.y) - abs(fract(cx) - 0.5)) * 6.0) : 0.0;
  float warpT = sqrt(max(cos(3.14159 * f.x), 0.0));
  float weftT = sqrt(max(cos(3.14159 * clamp(f.y / (1.0 + 0.4 * slub), -0.5, 0.5)), 0.0));
  float bulgeWarp = 0.75 + 0.25 * cos(3.14159 * (mod(ci.y, 2.0) - 0.5 + f.y) * 0.5);
  float bulgeWeft = 0.75 + 0.25 * cos(3.14159 * (mod(ci.x, 2.0) - 0.5 + f.x) * 0.5);
  float hWarp = warpT * bulgeWarp * (over > 0.5 ? 1.0 : 0.55);
  float hWeft = (weftT * bulgeWeft + 0.25 * slub) * (over > 0.5 ? 0.55 : 1.0);
  float h = max(hWarp, hWeft);
  // crossing heather: the visible thread's yarn tone for this float
  vec2 key = hWarp >= hWeft ? vec2(ci.x, blk.y) : vec2(blk.x, ci.y + N);
  float tone = hashf(key, 31) < 0.5 ? 0.8 : 1.15;
  float fuzz = vnoise(uv, PM(1000.0), 3);
  s.height = h + 0.05 * (fuzz - 0.5);
  s.ao = mix(0.6, 1.0, smoothstep(0.1, 0.5, h));
  s.albedo = vec3(tone * (1.0 + 0.1 * (fuzz - 0.5)) * (1.0 + 0.1 * (sh.z - 0.5) * slub));
}
`;

export const TEXTILE_DETAILS: DetailTable = {
  [Det.CUT_PILE]: { name: 'CUT_PILE', glsl: CUT_PILE, heightScale: 0.004, slope: 2.0, roughK: 0, cavity: 1 },
  [Det.LOOP_PILE]: { name: 'LOOP_PILE', glsl: LOOP_PILE, heightScale: 0.0025, slope: 1.5, roughK: 0, cavity: 1 },
  [Det.WEAVE]: { name: 'WEAVE', glsl: WEAVE, heightScale: 0.0006, slope: 1.0, roughK: 0, cavity: 1 },
};
