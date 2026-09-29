// src/textures/layers/carpet.ts — textiles: CARPET_L0, CARPET_OFFICE, FABRIC_PARTITION (WP8).

import { Mat } from '../../core/ids.ts';
import { phys, type RecipeTable } from './types.ts';

/** Level 0 carpet: a worn commercial cut pile (saxony, ~3 mm gauge, 6-10 mm pile) in mustard nylon, over a 1.2 m
 * frame (hex tiled at 0.6 m). Under overhead light pile reads as pile through occlusion, not normals: the texture
 * stores the pile visibility V in ormh.r (s.ao: the share of a view down into the pile that meets lit tips rather
 * than the dark gaps between them; family/textile.ts shades Dv = 1 - kp (1 - V) mu_v^kv, which shows the gaps looking
 * down and hides them at grazing) and the pile lean in ormh.b / ormh.a (aux 'lean', for the nap shading). Structure:
 *  - clumps (~20 mm, warped Voronoi): neighbouring tufts lean together; where two clumps lean apart the pile parts
 *    along their border in short runs (a dark 1-2 mm parting, V x 0.6), where they lean together the tips meet in a
 *    low crest; clumps differ in fullness (+-15 %) and thin out toward their rims;
 *  - tufts (3.3 mm, ~2.8 texels): each tuft's tip disc, shifted along its lean, covers most of the top; the cracks
 *    along tuft borders and the holes where three meet are dark (V 0.16). Supersampled, a texel holds its coverage;
 *  - matted patches (~20 %): flattened pile with closed valleys and fibres lying along the lean field;
 *  - colour: per-clump +-5 % and per-tuft +-7 % value / +-2 % hue, heathered off-shade tufts (olive-brown, straw,
 *    near-black), paler tips over a richer inside, +-4 % mottle, sparse lint.
 * The albedo carries no crown / crease shading (that is V now): it stays the fibre colour the bake bounces with.
 * Larger structure (nap, broadloom widths, reversal patches, wear, stains) is world-space (family/textile.ts). */
const CARPET_L0 = /* glsl */ `
#define SS 4
// Worley that also returns the second-nearest point (its id and offset): a clump border is decided by the pair
struct Cell2 { float f1; float f2; vec2 id1; vec2 id2; vec2 r1; vec2 r2; };
Cell2 worley2(vec2 uv, ivec2 Pi, float jitter, int seed) {
  vec2 P = vec2(Pi);
  vec2 p = uv * P;
  vec2 i = floor(p);
  vec2 f = p - i;
  Cell2 c;
  c.f1 = 64.0; c.f2 = 64.0; c.id1 = vec2(0.0); c.id2 = vec2(0.0); c.r1 = vec2(0.0); c.r2 = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 w = wrapCell(i + o, P);
      vec2 d = o + 0.5 + jitter * (hash2f(ivec2(w), seed) - 0.5) - f;
      float dd = dot(d, d);
      if (dd < c.f1) { c.f2 = c.f1; c.id2 = c.id1; c.r2 = c.r1; c.f1 = dd; c.id1 = w; c.r1 = d; }
      else if (dd < c.f2) { c.f2 = dd; c.id2 = w; c.r2 = d; }
    }
  }
  c.f1 = sqrt(c.f1); c.f2 = sqrt(c.f2);
  return c;
}
// a clump's own lean: hashed direction, magnitude 0.3-0.8
vec2 clumpLean(vec2 id) {
  vec2 h = hash2f(id, 23);
  float a = 6.2831853 * h.x;
  return mix(0.3, 0.8, h.y) * vec2(cos(a), sin(a));
}
void gen(vec2 uv, inout Surf s) {
  // ---- clumps: the lean is half the clump's own, half a smooth 12 cm field (neighbouring clumps lean alike)
  ivec2 CP = PM(50.0);
  Cell2 cl = worley2(warp(uv, PM(14.0), 2, 21, 0.009), CP, 0.9, 22);
  vec2 field = vec2(fbm(uv, PM(8.0), 2, 24), fbm(uv, PM(8.0), 2, 25)) * 1.0;
  vec2 l1 = clumpLean(cl.id1);
  vec2 nAB = (cl.r2 - cl.r1) / max(length(cl.r2 - cl.r1), 1e-5); // toward the neighbouring clump
  float dB = dot(0.5 * (cl.r1 + cl.r2), nAB) * FRAME.x / float(CP.x); // metres to the border
  float apart = dot(clumpLean(cl.id2) - l1, nAB); // > 0: the two clumps lean away from each other
  // a parting opens only where the lean diverges strongly, in short runs (a border is ~1-2 cm long)
  float parting = smoothstep(0.3, 0.7, apart) * smoothstep(0.45, 0.7, vnoise(uv, PM(80.0), 27))
                * fillM(dB - mix(0.0005, 0.0011, sat(apart)));
  float meet = sat(-apart * 2.0) * fillM(dB - 0.0012); // leaning together: the tips meet in a low crest
  float crown = 1.0 - smoothstep(0.1, 0.85, cl.f1);
  vec2 lean = 0.5 * (l1 + field) - nAB * (0.35 * parting); // tufts at a parting lean away from it
  // ---- matted patches: flattened pile (closed valleys, fibres lying along the field)
  float mat = smoothstep(0.2, 0.6, fbm(warp(uv, PM(4.0), 2, 11, 0.03), PM(6.0), 3, 12));
  lean += mat * 0.4 * field / max(length(field), 0.05);
  // ---- tufts: the tip disc shifts along the lean; cracks along the tuft borders, holes where three tufts meet
  Cell t = worley(uv, PM(300.0), 0.85, 3);
  vec4 th = hash4f(t.id, 4);
  float tip = (1.0 - smoothstep(0.3, 0.74, length(t.rel + 0.28 * lean))) * mix(0.3, 1.0, smoothstep(0.03, 0.2, t.f2 - t.f1));
  // clumps differ in tip density (some stand fuller than others, +-15 %) and thin out toward their rims: a soft
  // mottle (dark lines along every clump border read as cracked mud at a few metres)
  float V = mix(0.12, 1.0, tip) * (1.0 - 0.4 * parting) * mix(0.88, 1.04, crown) * mix(0.85, 1.15, hashf(cl.id1, 27));
  V = mix(V, 0.85, 0.45 * mat);
  // each pass evaluates only what it writes (12 gen() calls per texel: 3 passes x 4 sub-samples)
  if (uOut == OUT_HEIGHT) {
    s.height = 0.5 + 0.25 * tip + 0.15 * crown + 0.06 * meet - 0.35 * parting + 0.08 * fbm(uv, PM(6.0), 3, 30) - 0.15 * mat;
    return;
  }
  if (uOut == OUT_ORMH) {
    s.ao = V;
    s.lean = clamp(0.6 * lean, -1.0, 1.0); // the clumps' own lean is shaded softly (full strength read as a leopard mottle)
    s.rough = mix(1.0, 0.86, tip * min(length(lean), 1.0)) - 0.06 * mat;
    return;
  }
  // ---- colour: the fibre colour of the dye lot, varied per clump and per tuft
  vec3 col = TABLE_ALBEDO * (1.0 + 0.05 * (hashf(cl.id1, 26) * 2.0 - 1.0) + 0.07 * (th.y * 2.0 - 1.0));
  float hue = 0.02 * (th.z * 2.0 - 1.0);
  col *= vec3(1.0 + hue, 1.0, 1.0 - hue);
  // heather: tufts spun from off-shade fibre (5 % olive-brown, 3 % straw, 1 % near-black)
  col *= th.x < 0.05 ? vec3(0.68, 0.70, 0.72) : th.x < 0.08 ? vec3(1.20, 1.17, 1.05) : th.x < 0.09 ? vec3(0.4) : vec3(1.0);
  // tips are paler (light-faded, and a fibre end scatters less colour back), the inside of the pile richer
  col = saturation(col * mix(0.90, 1.04, tip), mix(1.12, 0.96, tip));
  col *= (1.0 + 0.04 * fbm(uv, PM(9.0), 3, 9)) * (1.0 + 0.03 * mat);
  // lint and fluff: sparse 1-3 mm specks, half buried in the pile
  ivec2 LP = PM(70.0);
  Cell lc = worley(uv, LP, 0.8, 31);
  vec3 lh = hash4f(lc.id, 32).xyz;
  float lint = lh.x < 0.035 ? fillM(lc.f1 * FRAME.x / float(LP.x) - mix(0.0006, 0.0014, lh.y)) : 0.0;
  s.albedo = mix(col, vec3(0.75, 0.73, 0.68) * mix(0.5, 0.9, lh.z), 0.6 * lint);
}
`;

/** Office carpet tiles: commercial level-loop tiles (solution-dyed nylon, 1/10 in gauge: 2.54 mm rows, ~2.7 mm loops,
 * 3-4 mm pile) in a tweed blend, 0.6 m tiles over a 1.2 m frame. The loop rows run along u in every tile; the shader's
 * per-tile rotation lays them quarter-turn / random (rotated physical tiles), and the view along or across the rows
 * shades them (family/textile.ts; the lean channels hold the row direction x 0.3). Structure:
 *  - tweed flecks: each row carries flecks of the blend's colours (charcoal, slate, light grey, black, a teal or rust
 *    accent), 5-15 mm long along the row and tapered at their ends (a round-blob speckle read as granite);
 *  - row streaks (the tufting needles' yarn tension) along the rows, +-5 % and +-4 %;
 *  - the rows themselves are below the texel limit (V 0.78 on average from the row gaps; the loop-pile detail map D1
 *    resolves them up close);
 *  - per tile: dye +-3 %, a fine seam (1 texel x 0.45, 2 texels x 0.85) that the pile hides in places.
 * Per-tile replacement dye lots and the world seam line are world-space (family/textile.ts). */
const CARPET_OFFICE = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  TileInfo t = tiles(m, vec2(0.6));
  // tweed flecks: rows of 2.34 mm (whole texels at 1024 and 512: a row pitch off the texel grid beat into moire), each
  // row shifted, fleck cells ~10.5 mm along the row
  ivec2 FP = ivec2(PM(95.0).x, 512);
  vec2 fg = uv * vec2(FP);
  float fr = wrapCell(vec2(floor(fg.y)), vec2(float(FP.y))).x;
  float fx = fg.x + hashf(ivec2(int(fr), 0), 21) * float(FP.x);
  vec2 fid = wrapCell(vec2(floor(fx), fr), vec2(FP));
  vec4 fh = hash4f(fid, 22);
  float along = fract(fx);
  // a fleck covers part of its cell (5-15 mm), tapered; the rest of the cell is the row's heathered ground
  float len = mix(0.45, 1.0, fh.y);
  float fl = sat((0.5 * len - abs(along - 0.5)) / (0.5 * len));
  float taper = sqrt(sin(1.5707963 * fl));
  vec3 charcoal = srgb8(67.0, 71.0, 78.0), slate = srgb8(109.0, 114.0, 125.0), lgrey = srgb8(168.0, 170.0, 174.0);
  vec3 black = srgb8(36.0, 38.0, 42.0);
  vec3 accent = fh.z < 0.5 ? srgb8(63.0, 108.0, 112.0) : srgb8(129.0, 73.0, 50.0);
  float k = fh.x;
  vec3 fc = k < 0.45 ? charcoal : k < 0.78 ? slate : k < 0.91 ? lgrey : k < 0.98 ? black : accent;
  vec3 ground = mix(charcoal, slate, 0.45);
  vec3 col = mix(ground, fc, taper);
  // row streaks (yarn tension): a value per row that drifts over ~10 cm along it. Constant across a row, so the
  // rows (2.2 texels) average into random texel noise, not the moire of a sampled sinusoid
  float su = uv.x * 12.0;
  float si = floor(su);
  float streak = 0.1 * (mix(hashf(wrapCell(vec2(si, fr), vec2(12.0, float(FP.y))), 23), hashf(wrapCell(vec2(si + 1.0, fr), vec2(12.0, float(FP.y))), 23),
    smoothstep(0.0, 1.0, su - si)) - 0.5);
  col *= 1.0 + streak;
  // per tile (texture tiles; the shader adds world-space dye lots): +-3 % value, +-1.5 % hue
  vec4 tr = tileRand4(t.id, 8);
  col *= (1.0 + 0.06 * (tr.x - 0.5)) * vec3(1.0 + 0.03 * (tr.y - 0.5), 1.0, 1.0 - 0.03 * (tr.y - 0.5));
  col *= 1.0 + 0.025 * fbm(uv, PM(6.0), 3, 9);
  // seams: a fine dark line, hidden by the pile in 10-40 mm runs
  float vis = smoothstep(0.3, 0.55, vnoise(uv, PM(40.0), 17));
  float s1 = fillM(t.edge - 0.0006) * mix(0.35, 1.0, vis);
  float s2 = fillM(t.edge - 0.0018);
  col *= (1.0 - 0.55 * s1) * (1.0 - 0.15 * s2);
  s.albedo = col;
  // loops stand at slightly different heights (row gaps: V 0.78 on average)
  float lh = fh.w - 0.5;
  s.ao = (0.78 + 0.12 * lh + 0.2 * streak) * (1.0 - 0.5 * s1);
  s.height = 0.5 + 0.12 * lh + 0.6 * streak - 0.35 * s1;
  s.rough = mix(0.86, 0.92, fh.w);
  s.lean = vec2(0.3, 0.0);
}
`;

/** Cubicle partition fabric: polyester in a fine basket weave (1.6 mm threads, below the 1.17 mm texel: the weave
 * itself is the detail map D7's) with two-tone heathered yarn, seen at 1-3 m as a fuzzy mottle rather than a pattern.
 * The base holds what the texel can: faint horizontal barre streaks (weft yarns of slightly different thickness and
 * dye uptake, +-3 % and +-2 %), the heather (a dark and a light yarn, x 0.82 / x 1.14, softened along the thread
 * axes), sparse slubs (thick yarn segments 4-10 mm long) and pills (1.5-3 mm fuzz balls), and the soft waviness of
 * the stretched cloth (0.8 mm over 5-20 cm, which shows in the grazing sheen). Pile visibility 0.88 on average (the
 * weave's interstices), fully rough. The layer also dresses upholstery, seats, bags and mattresses. */
const FABRIC_PARTITION = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  // barre: streaks across the panel, along u
  float barre = 0.03 * gnoise(uv, PMxy(3.0, 420.0), 3) + 0.02 * gnoise(uv, PMxy(6.0, 210.0), 4);
  // heather: two yarn tones, blended along the thread axes (value noise interpolates along u and v)
  float ht = smoothstep(0.38, 0.62, vnoise(uv, PM(500.0), 6));
  // slubs: thick weft segments (rows of 1.3 mm, cells of 12.5 mm along u, 2 % of them)
  ivec2 SP = PMxy(80.0, 770.0);
  vec2 sg = uv * vec2(SP);
  float sr = wrapCell(vec2(floor(sg.y)), vec2(float(SP.y))).x;
  float sx = sg.x + hashf(ivec2(int(sr), 0), 11) * float(SP.x);
  vec4 sh = hash4f(wrapCell(vec2(floor(sx), sr), vec2(SP)), 12);
  float sl = sh.x < 0.02 ? sat((0.5 * mix(0.32, 0.8, sh.y) - abs(fract(sx) - 0.5)) * 8.0) : 0.0;
  // pills: fuzz balls on 2 % of 17 mm cells
  ivec2 PP = PM(60.0);
  Cell pc = worley(uv, PP, 0.8, 13);
  vec3 ph = hash4f(pc.id, 14).xyz;
  float pill = ph.x < 0.02 ? 1.0 - smoothstep(0.4, 1.0, pc.f1 * FRAME.x / float(PP.x) / mix(0.00075, 0.0015, ph.y)) : 0.0;
  vec3 col = TABLE_ALBEDO * mix(0.82, 1.14, ht) * (1.0 + barre) * (1.0 + 0.1 * (sh.z - 0.5) * sl * 2.0) * (1.0 + 0.12 * pill);
  s.albedo = col;
  s.ao = 0.88 + 0.03 * (ht - 0.5) + 0.06 * max(sl, pill);
  s.height = 0.5 + 0.45 * fbm(uv, PM(6.0), 3, 5) + 0.25 * sl + 0.3 * pill + 1.5 * barre;
  s.rough = 1.0;
}
`;

// trim: albedo calibration (layerAlbedoCheck at 1024); phys: SurfacePhys (types.ts)
export const TEXTILE_RECIPES: RecipeTable = {
  [Mat.CARPET_L0]: {
    glsl: CARPET_L0, normalStrength: 0.45, heightScale: 0.004, trim: [1.027, 1.031, 1.058], aux: 'lean',
    phys: phys(1, { det: 0, detS: 1, sheen: 0.3, sheenR: 0.42, pile: [1.0, 0.8], sigma: 0.75 }),
  },
  [Mat.CARPET_OFFICE]: {
    glsl: CARPET_OFFICE, normalStrength: 0.9, heightScale: 0.003, trim: [1.035, 1.032, 1.011], aux: 'lean',
    phys: phys(1, { det: 1, detS: 0.8, sheen: 0.3, sheenR: 0.55, pile: [1.0, 1.2], sigma: 0.5 }),
  },
  [Mat.FABRIC_PARTITION]: {
    glsl: FABRIC_PARTITION, normalStrength: 2.0, heightScale: 0.0008, trim: [1.021, 1.021, 1.021],
    phys: phys(1, { det: 7, detS: 1, sheen: 0.45, sheenR: 0.65, pile: [0.6, 1.5], sigma: 0.4 }),
  },
};
