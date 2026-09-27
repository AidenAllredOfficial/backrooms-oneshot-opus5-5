// src/textures/detail.ts — close-range detail maps (package B): 12 procedural recipes baked into one LEAN-packed
// sampler2DArray (textures/DetailBaker.ts, uBrDetail in the surface shaders) that the shaders tile over a 0.3 m
// world repeat on top of the base layers (materials/chunks/params.ts SURFACE_PHYS det / detS picks the layer).
//
// Why: within ~3 m every base layer is magnified past its texels (1.2-4.7 mm per texel at 1024), so carpet reads as
// felt and concrete as flat grey. A 512^2 detail texel is 0.59 mm. The pack keeps the first and second moments of
// the slope (LEAN): up close the detail is resolved relief, far away the same data becomes micro-roughness (no
// sparkle, no fade band), and the albedo multiplier is divided by the layer mean in the shader, so the detail never
// shifts a surface's mean colour.
//
// Recipes use the layer recipe environment (textures/glsl/common.ts) with FRAME = DETAIL_REPEAT x DETAIL_REPEAT,
// TABLE_ALBEDO = 1: `s.albedo.r` is the albedo multiplier (1 = neutral), `s.height` the relief (x heightScale metres),
// `s.ao` an extra occlusion folded into the multiplier. Everything is periodic with integer periods (PM()), and
// statistically homogeneous: no feature larger than ~5 mm may stand out, or the 0.3 m repeat would show.
// Pure strings (no three): chunks/params.ts imports the slope / roughness tables for its GLSL constants.

/** Texels per side of every detail layer. */
export const DETAIL_SIZE = 512;
/** Metres per detail repeat: divides NOISE_WRAP (4096 x), STOREY_PITCH (10 x) and TILE_SIZE (64 x). */
export const DETAIL_REPEAT = 0.3;

export interface DetailRecipe {
  name: string;
  /** GLSL defining `void gen(vec2 uv, inout Surf s)` over the DETAIL_REPEAT frame. */
  glsl: string;
  /** Metres of relief per unit of Surf.height. */
  heightScale: number;
  /** Slope normalisation S of the pack: rg = E[slope] / S (clamped to +-1), a = E[|slope|^2] / (2 S^2). About 4 x the
   * layer's rms slope (harness stats().detailMoments): larger wastes the 8-bit moments, smaller clips the relief. */
  slope: number;
  /** Roughness added per unit of albedo darkening (pits, pores and gaps hold dirt and are rougher). */
  roughK: number;
  /** Exponent of the generator's cavity AO folded into the albedo multiplier (0 = none). */
  cavity: number;
}

/** D0 cut pile (Level 0 carpet): tufts of twisted yarn ~3.8 mm across with lit crowns, dark gaps and a lean each;
 * individual fibre ends as a fine speckle. */
const CUT_PILE = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 wuv = warp(uv, PM(40.0), 2, 11, 0.004);
  Cell t = worley(wuv, PM(260.0), 0.9, 3);
  vec4 th = hash4f(t.id, 4);
  float crown = 1.0 - smoothstep(0.0, 0.65, t.f1);
  float gap = smoothstep(0.0, 0.2, t.f2 - t.f1);
  float tip = vnoise(uv, PM(560.0), 5);
  float lean = dot(t.rel, (th.zw - 0.5) * 0.8);
  s.height = 0.2 + 0.6 * crown * mix(0.35, 1.0, gap) + 0.12 * (tip - 0.5) + 0.12 * lean * crown;
  s.albedo = vec3(0.62 + 0.5 * crown * gap + 0.2 * (th.x - 0.5) + 0.14 * (tip - 0.5));
}
`;

/** D1 level loop pile (office carpet tiles): rows of yarn loops 2.7 mm apart, each row shifted by a random fraction of
 * a loop (tufting needles are not in register), each loop a rounded arch with its own height, width and tone; fibre
 * fuzz on top. Low tone contrast: a strong row pattern reads as corduroy from a few metres. */
const LOOP_PILE = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 g = uv * 110.0;
  g.y += 0.45 * gnoise(uv, PM(14.0), 7) + 0.2 * gnoise(uv, PM(40.0), 8); // rows wander: no ruled lines at a distance
  float row = floor(g.y);
  float gx = g.x + hashf(wrapCell(vec2(row, 0.0), vec2(110.0, 1.0)), 5);
  vec2 cell = wrapCell(vec2(floor(gx), row), vec2(110.0));
  vec4 r = hash4f(cell, 3);
  vec2 f = vec2(fract(gx), fract(g.y)) - 0.5 + (r.zw - 0.5) * vec2(0.2, 0.15);
  float arch = sqrt(sat(1.0 - 4.0 * (f.x * f.x / mix(0.65, 0.9, r.z) + f.y * f.y / 0.95)));
  float fuzz = vnoise(uv, PM(480.0), 4);
  s.height = 0.25 + 0.5 * arch * (0.7 + 0.6 * r.x) + 0.1 * (fuzz - 0.5);
  s.albedo = vec3(0.88 + 0.14 * arch + 0.16 * (r.y - 0.5) + 0.1 * (fuzz - 0.5));
}
`;

/** D2 embossed vinyl wallpaper: a pebbled emboss (~4 mm) over a faint linen crosshatch and paper fibre. */
const VINYL_PAPER = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  Cell e = worley(uv, PM(250.0), 0.9, 3);
  float peb = 1.0 - smoothstep(0.1, 0.75, e.f1);
  float fib = fbm(uv, PM(160.0), 3, 5);
  float lin = 0.5 * gnoise(uv, PMxy(300.0, 40.0), 7) + 0.5 * gnoise(uv, PMxy(40.0, 300.0), 8);
  s.height = 0.5 + 0.25 * peb + 0.15 * fib + 0.12 * lin;
  s.albedo = vec3(1.0 + 0.03 * fib + 0.025 * (peb - 0.5));
}
`;

/** D3 rolled paint (trim, drywall, CMU, painted metal): soft orange peel with the finer stipple of the roller nap. */
const PAINT = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  float peel = fbm(uv, PM(90.0), 3, 3);
  Cell st = worley(uv, PM(330.0), 0.9, 4);
  float stip = 1.0 - smoothstep(0.05, 0.7, st.f1);
  s.height = 0.5 + 0.35 * peel + 0.2 * stip;
  s.albedo = vec3(1.0 - 0.02 * (stip - 0.5));
}
`;

/** D4 fine concrete (floors, walls, soffits, plenum, rust, terrazzo matrix): ~2 mm sand grains with their own tone in
 * a cement paste, and sparse 1-3 mm pinholes (entrapped air) that hold dirt. */
const CONCRETE_FINE = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  Cell g = worley(uv, PM(500.0), 0.9, 3);
  float gh = hashf(g.id, 4);
  float grain = 1.0 - smoothstep(0.2, 0.55, g.f1);
  float paste = fbm(uv, PM(60.0), 3, 5);
  Cell ph = worley(uv, PM(90.0), 0.9, 6);
  float pr = mix(0.1, 0.24, hashf(ph.id, 7));
  float pin = step(hashf(ph.id, 8), 0.02) * (1.0 - smoothstep(pr * 0.55, pr, ph.f1));
  s.height = 0.55 + 0.25 * grain * (0.6 + 0.4 * gh) + 0.1 * paste - 0.5 * pin;
  s.albedo = vec3((1.0 + 0.18 * (gh - 0.5) * grain + 0.04 * paste) * (1.0 - 0.25 * pin));
  s.ao = 1.0 - 0.3 * pin;
}
`;

/** D5 mineral fibre board (ceiling tiles): a felted, granular fibre surface with small pits (the base layer holds the
 * fissures). */
const MINERAL_FIBRE = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  float fib = ridged(uv, PM(150.0), 3, 3);
  float gran = vnoise(uv, PM(480.0), 4);
  Cell p = worley(uv, PM(120.0), 0.9, 5);
  float pit = step(hashf(p.id, 6), 0.25) * (1.0 - smoothstep(0.1, 0.28, p.f1));
  s.height = 0.5 + 0.3 * fib + 0.15 * (gran - 0.5) - 0.45 * pit;
  s.albedo = vec3((1.0 + 0.06 * (fib - 0.5) + 0.05 * (gran - 0.5)) * (1.0 - 0.3 * pit));
}
`;

/** D6 glaze waviness (pool tile, mosaic, VCT wax): smooth, albedo neutral; tilts reflections by a few tenths of a
 * degree so they wobble across a glazed wall instead of mirroring perfectly. */
const GLAZE = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  s.height = 0.5 + 0.3 * gnoise(uv, PM(40.0), 3) + 0.2 * gnoise(uv, PM(90.0), 4);
}
`;

/** D7 basket weave (cubicle partition fabric): 2 x 2 threads crossing over together, 2.5 mm per thread, with fibre
 * fuzz (the base layer's weave is below its texel limit and keeps only the mean). */
const WEAVE = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 g = uv * 120.0;
  vec2 ci = floor(g);
  vec2 f = fract(g) - 0.5;
  float over = mod(floor(ci.x * 0.5) + floor(ci.y * 0.5), 2.0);
  float warpT = 1.0 - 4.0 * f.x * f.x;
  float weftT = 1.0 - 4.0 * f.y * f.y;
  float bulgeWarp = 0.75 + 0.25 * cos(3.14159 * (mod(ci.y, 2.0) - 0.5 + f.y) * 0.5);
  float bulgeWeft = 0.75 + 0.25 * cos(3.14159 * (mod(ci.x, 2.0) - 0.5 + f.x) * 0.5);
  float prof = over > 0.5 ? warpT * bulgeWarp : weftT * bulgeWeft;
  float fuzz = vnoise(uv, PM(480.0), 3);
  s.height = 0.3 + 0.5 * prof + 0.1 * (fuzz - 0.5);
  s.albedo = vec3(0.85 + 0.25 * prof + 0.1 * (fuzz - 0.5));
}
`;

/** D8 rolled / brushed sheet (metal deck): fine streaks along u and a few long, faint scratches. */
const BRUSHED = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  float st = gnoise(uv, PMxy(3.0, 420.0), 3) * 0.6 + gnoise(uv, PMxy(4.0, 500.0), 4) * 0.4;
  float sc = ridged(vec2(uv.x, uv.y + 0.02 * gnoise(uv, PM(8.0), 5)), PMxy(2.0, 60.0), 2, 6);
  float scratch = smoothstep(0.93, 0.99, sc);
  s.height = 0.5 + 0.3 * st - 0.3 * scratch;
  s.albedo = vec3(1.0 + 0.04 * st + 0.08 * scratch);
}
`;

/** D9 open wood grain: pores elongated along u, gathered in the latewood bands; they hold dirt (darker, rougher). */
const WOOD_PORE = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  float band = 0.5 + 0.5 * gnoise(uv, PMxy(2.0, 30.0), 3);
  float pn = vnoise(uv, PMxy(60.0, 600.0), 4);
  float pore = smoothstep(0.72, 0.85, pn) * mix(0.4, 1.0, band);
  s.height = 0.6 - 0.5 * pore;
  s.albedo = vec3(1.0 - 0.35 * pore);
}
`;

/** D10 haircell (moulded plastic, rubber): rounded ~2.5 mm pebbles with narrow valleys; the pebble tops polish. */
const HAIRCELL = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  Cell c = worley(uv, PM(400.0), 0.85, 3);
  float peb = 1.0 - smoothstep(0.0, 0.8, c.f1);
  float edge = smoothstep(0.0, 0.15, c.f2 - c.f1);
  s.height = 0.3 + 0.5 * peb * edge;
  s.albedo = vec3(0.97 + 0.06 * peb);
}
`;

/** D11 ripple (standing water; sampled at twice the repeat and drifting): smooth gradient noise with 3-7 cm
 * wavelengths (finer ripples alias into reflection noise at a few metres), slope only, albedo exactly neutral (no
 * cavity). The shader uses the normalised slope (rg) directly, scaled by TUNE.RIPPLE. */
const RIPPLE = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  s.height = 0.5 + 0.35 * fbm(uv, PM(30.0), 2, 3);
}
`;

/** Index = detail layer id (SURFACE_PHYS.det; DETAIL_RIPPLE for puddles). */
export const DETAIL_RECIPES: readonly DetailRecipe[] = [
  { name: 'CUT_PILE', glsl: CUT_PILE, heightScale: 0.003, slope: 1.2, roughK: 0, cavity: 1 },
  { name: 'LOOP_PILE', glsl: LOOP_PILE, heightScale: 0.002, slope: 1.0, roughK: 0, cavity: 1 },
  { name: 'VINYL_PAPER', glsl: VINYL_PAPER, heightScale: 0.0003, slope: 0.1, roughK: 0.05, cavity: 0.5 },
  { name: 'PAINT', glsl: PAINT, heightScale: 0.00012, slope: 0.04, roughK: 0.1, cavity: 0.3 },
  { name: 'CONCRETE_FINE', glsl: CONCRETE_FINE, heightScale: 0.0008, slope: 0.35, roughK: 0.25, cavity: 1 },
  { name: 'MINERAL_FIBRE', glsl: MINERAL_FIBRE, heightScale: 0.0006, slope: 0.2, roughK: 0, cavity: 1 },
  { name: 'GLAZE', glsl: GLAZE, heightScale: 0.00008, slope: 0.008, roughK: 0, cavity: 0 },
  { name: 'WEAVE', glsl: WEAVE, heightScale: 0.0006, slope: 0.4, roughK: 0, cavity: 1 },
  { name: 'BRUSHED', glsl: BRUSHED, heightScale: 0.00005, slope: 0.01, roughK: 0.05, cavity: 0 },
  { name: 'WOOD_PORE', glsl: WOOD_PORE, heightScale: 0.0002, slope: 0.08, roughK: 0.15, cavity: 0.5 },
  { name: 'HAIRCELL', glsl: HAIRCELL, heightScale: 0.0001, slope: 0.07, roughK: 0.1, cavity: 0.5 },
  { name: 'RIPPLE', glsl: RIPPLE, heightScale: 0.05, slope: 1.0, roughK: 0, cavity: 0 },
];

/** Number of detail layers (array depth). */
export const DETAIL_COUNT = DETAIL_RECIPES.length;
/** The puddle micro-ripple layer. */
export const DETAIL_RIPPLE = 11;

/** One texel's pack (twin of glsl/common.ts DETAIL_MAIN): [r, g, a] of the slope (sx, sy) in metres per metre. */
export function detailPackSlope(sx: number, sy: number, slope: number): [number, number, number] {
  const ex = Math.min(1, Math.max(-1, sx / slope));
  const ey = Math.min(1, Math.max(-1, sy / slope));
  return [ex * 0.5 + 0.5, ey * 0.5 + 0.5, 0.5 * (ex * ex + ey * ey)];
}

/** The unresolved slope variance E[|s|^2] - |E[s]|^2 of a packed (possibly box-filtered) texel: the LEAN term the
 * surface shader adds to alpha^2 (twin of the chunks/surface.ts detail block, before the strength^2 factor). */
export function detailVariance(r: number, g: number, a: number, slope: number): number {
  const sx = (r * 2 - 1) * slope;
  const sy = (g * 2 - 1) * slope;
  return Math.max(a * 2 * slope * slope - sx * sx - sy * sy, 0);
}
