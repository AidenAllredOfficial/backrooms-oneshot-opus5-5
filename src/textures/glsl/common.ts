// src/textures/glsl/common.ts — shared GLSL for the GPU texture generator (WP8).
//
// Program layout of one layer recipe (RawShaderMaterial, GLSL 3.00 es; assembled by buildRecipeFragment):
//   RECIPE_HEADER  precision, per-layer defines (FRAME, NOISE_FRAME, TABLE_*), generator uniforms, output
//   NOISE_GLSL     periodic noise library (glsl/noise.ts)
//   COMMON_GLSL    Surf, colour and SDF helpers, tile helpers, PM() period helper
//   recipe.glsl    `void gen(vec2 uv, inout Surf s)` (may `#define SS 4` for 4x box-filtered supersampling)
//   RECIPE_MAIN    evaluates gen at the texel (or 4 sub-samples) and writes HEIGHT / ALBEDO / ORMH per `uOut`
//
// Conventions for recipe authors:
//   - uv in [0,1) spans FRAME metres (repeat x layerRepeatY). `m = uv * FRAME` gives metres.
//   - Surf.albedo is LINEAR; write sRGB byte constants through srgb8(r, g, b) / srgbToLinear().
//   - Surf.height is unitless 0..1 (0.5 rest); heightScale (metres per unit) turns it into relief for the normal
//     pass and the cavity AO. Surf.ao is the recipe's own occlusion (the generator multiplies in cavity AO).
//   - Everything must be periodic in uv with period 1: use the periodic noise with integer periods (PM(perMetre)
//     rounds FRAME * density to integers) and geometry whose pitch divides FRAME.
//   - `uOut` tells which output is being produced (OUT_HEIGHT / OUT_ALBEDO / OUT_ORMH); recipes may skip work.

import { NOISE_GLSL } from './noise.ts';

export const OUT_HEIGHT = 0;
export const OUT_ALBEDO = 1;
export const OUT_ORMH = 2;

export const FULLSCREEN_VERTEX = /* glsl */ `
precision highp float;
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const COMMON_GLSL = /* glsl */ `
// ---------------------------------------------------------------- COMMON_GLSL (WP8)
const float PI = 3.14159265359;

struct Surf {
  vec3 albedo;   // linear
  float alpha;   // decal / sign / grate alpha
  float height;  // 0..1, 0.5 rest; relief = height * heightScale metres
  float rough;
  float metal;
  float ao;      // recipe occlusion (multiplied by the generator's cavity AO)
  float emissive;// emissive mask (ormh.a)
};

float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 sat3(vec3 x) { return clamp(x, 0.0, 1.0); }
float remap01(float x, float a, float b) { return sat((x - a) / (b - a)); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float gauss(float x) { return exp(-x * x); } // never pow(x, 2.0): pow of a negative base is undefined in GLSL

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 srgb8(float r, float g, float b) { return srgbToLinear(vec3(r, g, b) / 255.0); }
// scale saturation around luma
vec3 saturation(vec3 c, float s) { float l = luma(c); return max(vec3(0.0), mix(vec3(l), c, s)); }

// Band limit for EXPLICIT regular grids (loop pile, weaves, threads) of CYCLES periods per frame: 1 well below
// the TEXEL Nyquist limit (0.5 cycles per texel), 0 at it. The 4x supersampling box filter attenuates such a grid by
// only ~sinc(cycles / uRes), so a regular pattern near or above Nyquist still beats into moire; it must fade by the
// texel, not by the sub-sample (br_bandLimit, used by the noise octaves, measures the sub-sample).
float bandLimitPx(float cycles) { return 1.0 - smoothstep(0.3, 0.48, cycles / uRes); }

// integer periods for a feature density (cells per metre) over the noise frame
#define PM(d) br_PM(NOISE_FRAME, vec2(d))
#define PMxy(dx, dy) br_PM(NOISE_FRAME, vec2(dx, dy))
ivec2 br_PM(vec2 frame, vec2 d) { return ivec2(max(vec2(1.0), floor(frame * d + 0.5))); }

// metres covered by one sample (average of both axes): anti-aliasing width for metric SDFs
float aaM() { return 0.5 * (FRAME.x * br_texel.x + FRAME.y * br_texel.y); }
// coverage of an SDF (metres, < 0 inside), filtered over ~one sample
float fillM(float d) { float w = 0.7 * aaM(); return 1.0 - smoothstep(-w, w, d); }
// coverage of a band of half-width hw (metres) around an SDF zero line
float lineM(float d, float hw) { return fillM(abs(d) - hw); }
// soft coverage with an explicit feather (metres)
float softM(float d, float feather) { float w = max(feather, 0.7 * aaM()); return 1.0 - smoothstep(-w, w, d); }

// ---- SDFs (metres or any consistent unit)
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sdRoundBox(vec2 p, vec2 b, float r) { return sdBox(p, b - vec2(r)) - r; }
float sdCircle(vec2 p, float r) { return length(p) - r; }
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = sat(dot(pa, ba) / dot(ba, ba));
  return length(pa - ba * h);
}
float sdEllipse(vec2 p, vec2 r) { float k = length(p / r); return (k - 1.0) * min(r.x, r.y); }
float sdTri(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
  vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 pq0 = v0 - e0 * sat(dot(v0, e0) / dot(e0, e0));
  vec2 pq1 = v1 - e1 * sat(dot(v1, e1) / dot(e1, e1));
  vec2 pq2 = v2 - e2 * sat(dot(v2, e2) / dot(e2, e2));
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                   vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                   vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}
float smin(float a, float b, float k) { float h = sat(0.5 + 0.5 * (b - a) / k); return mix(b, a, h) - k * h * (1.0 - h); }
vec2 rot2(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }

// ---- tiles: size must divide FRAME. local = metres from the tile centre; id wrapped to the frame's tile count
struct TileInfo { vec2 local; vec2 id; vec2 count; float edge; };
TileInfo tiles(vec2 m, vec2 size) {
  TileInfo t;
  vec2 c = floor(m / size);
  t.count = floor(FRAME / size + 0.5);
  t.id = wrapCell(c, t.count);
  t.local = m - (c + 0.5) * size;
  vec2 a = 0.5 * size - abs(t.local);
  t.edge = min(a.x, a.y); // distance to the nearest tile edge (metres)
  return t;
}
float tileRand(vec2 id, int seed) { return hashf(ivec2(id), seed); }
vec4 tileRand4(vec2 id, int seed) { return hash4f(ivec2(id), seed); }

// distance (metres) to the nearest line x = k * pitch (pitch divides FRAME.x)
float distLines(float x, float pitch) { float f = x / pitch; return abs(f - floor(f + 0.5)) * pitch; }
`;

/** Generator support shared by the layer (RECIPE_MAIN) and detail (DETAIL_MAIN) programs: Surf init/accumulate, the
 * scratch height and the cavity AO. */
const RECIPE_SUPPORT = /* glsl */ `
// ---------------------------------------------------------------- RECIPE_MAIN (WP8)
void br_init(out Surf s) {
  s.albedo = TABLE_ALBEDO; s.alpha = 1.0; s.height = 0.5; s.rough = TABLE_ROUGH; s.metal = TABLE_METAL;
  s.ao = 1.0; s.emissive = 0.0;
}
void br_add(inout Surf a, Surf b) {
  a.albedo += b.albedo; a.alpha += b.alpha; a.height += b.height; a.rough += b.rough; a.metal += b.metal;
  a.ao += b.ao; a.emissive += b.emissive;
}
float br_h(vec2 p) { vec4 t = texelFetch(uScratch, ivec2(mod(p, vec2(uRes))), 0); return uHPackIn == 1 ? br_unpackH(t) : t.r; }
// cavity AO from the scratch height: the cosine-weighted visibility of the horizon (horizon-based AO). Along 8
// azimuths the horizon is the steepest rise tan(h) = max(dh * heightScale / distance) over 7 radii from 1 to 16
// texels (a 1-2 texel fissure, pore or pile gap and a joint's far wall are both found); an azimuth whose horizon
// stands h above the plane hides sin^2(h) of its cosine-weighted share, so V = 1 - mean(sin^2 h), with
// sin^2(atan t) = t^2 / (1 + t^2). (It replaced a mean of s / (1 + s) over 16 slopes at radii 2 and 7, which diluted
// narrow grooves: high-pass correlation 0.86-0.95 with a ray-marched reference.)
float br_cavity(vec2 px) {
  vec2 texM = FRAME / uRes;
  float h0 = br_h(px);
  float occ = 0.0;
  for (int k = 0; k < 8; k++) {
    float a = float(k) * 0.785398;
    vec2 dir = vec2(cos(a), sin(a));
    float t = 0.0;
    for (int r = 0; r < 7; r++) {
      float rad = r == 0 ? 1.0 : r == 1 ? 2.0 : r == 2 ? 3.0 : r == 3 ? 5.0 : r == 4 ? 8.0 : r == 5 ? 12.0 : 16.0;
      vec2 o = floor(dir * rad + 0.5);
      t = max(t, (br_h(px + o) - h0) * uHeightM / max(length(o * texM), 1e-6));
    }
    occ += t * t / (1.0 + t * t);
  }
  return 1.0 - occ / 8.0;
}
`;

export const RECIPE_MAIN = RECIPE_SUPPORT + /* glsl */ `void main() {
  vec2 px = gl_FragCoord.xy + uOrigin; // texel centre in full-texture coordinates (may lie outside [0,S))
  Surf s;
#ifdef SS
  br_texel = vec2(0.5 / uRes);
  br_init(s);
  s.albedo = vec3(0.0); s.alpha = 0.0; s.height = 0.0; s.rough = 0.0; s.metal = 0.0; s.ao = 0.0; s.emissive = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = i == 0 ? vec2(0.125, 0.375) : i == 1 ? vec2(0.375, -0.125) : i == 2 ? vec2(-0.125, -0.375) : vec2(-0.375, 0.125);
    Surf t; br_init(t);
    gen((px + o) / uRes, t);
    br_add(s, t);
  }
  s.albedo *= 0.25; s.alpha *= 0.25; s.height *= 0.25; s.rough *= 0.25; s.metal *= 0.25; s.ao *= 0.25; s.emissive *= 0.25;
#else
  br_texel = vec2(1.0 / uRes);
  br_init(s);
  gen(px / uRes, s);
#endif
  if (uOut == OUT_HEIGHT) {
    fragColor = uHPackOut == 1 ? br_packH(s.height) : vec4(s.height, 0.0, 0.0, 1.0);
  } else if (uOut == OUT_ALBEDO) {
    fragColor = vec4(max(s.albedo * ALBEDO_TRIM, vec3(0.0)), sat(s.alpha));
  } else {
    fragColor = vec4(sat(s.ao * br_cavity(floor(px) + 0.5)), clamp(s.rough, 0.03, 1.0), sat(s.metal), sat(s.emissive));
  }
}
`;

/** 16-bit height packing for the RGBA8 scratch fallback (used when neither EXT_color_buffer_float nor
 * EXT_color_buffer_half_float is available): height in [-0.5, 1.5] -> two bytes (r high, g low). */
export const HEIGHT_PACK_GLSL = /* glsl */ `
vec4 br_packH(float h) {
  float q = floor(clamp((h + 0.5) * 0.5, 0.0, 1.0) * 65535.0 + 0.5);
  float hi = floor(q / 256.0);
  return vec4(hi / 255.0, (q - hi * 256.0) / 255.0, 0.0, 1.0);
}
float br_unpackH(vec4 t) {
  float q = floor(t.r * 255.0 + 0.5) * 256.0 + floor(t.g * 255.0 + 0.5);
  return q / 65535.0 * 2.0 - 0.5;
}
`;

/** Scharr gradient of the wrap-sampled scratch height at the texel centre p, in metres of relief per metre, for texM
 * metres per texel and `scale` metres per height unit. Needs `float br_h(vec2 p)` (the scratch height). Shared by the
 * normal pass and the detail-map pack pass (DETAIL_MAIN). */
export const SLOPE_GLSL = /* glsl */ `
vec2 br_slope(vec2 p, vec2 texM, float scale) {
  float gx = 3.0 * (br_h(p + vec2(1, -1)) - br_h(p + vec2(-1, -1))) + 10.0 * (br_h(p + vec2(1, 0)) - br_h(p + vec2(-1, 0)))
           + 3.0 * (br_h(p + vec2(1, 1)) - br_h(p + vec2(-1, 1)));
  float gy = 3.0 * (br_h(p + vec2(-1, 1)) - br_h(p + vec2(-1, -1))) + 10.0 * (br_h(p + vec2(0, 1)) - br_h(p + vec2(0, -1)))
           + 3.0 * (br_h(p + vec2(1, 1)) - br_h(p + vec2(1, -1)));
  return vec2(gx, gy) / 16.0 / (2.0 * texM) * scale;
}
`;

/** Sobel/Scharr normal pass over the wrap-sampled scratch height (one program shared by every layer). */
export const NORMAL_FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uScratch;
uniform float uRes;
uniform vec2 uTexelM;   // metres per texel (u, v)
uniform float uScale;   // heightScale * normalStrength (metres per height unit)
uniform vec2 uOrigin;
uniform int uHPackIn;   // 1: RGBA8 scratch with packed height
layout(location = 0) out highp vec4 fragColor;
${HEIGHT_PACK_GLSL}
float br_h(vec2 p) { vec4 t = texelFetch(uScratch, ivec2(mod(p, vec2(uRes))), 0); return uHPackIn == 1 ? br_unpackH(t) : t.r; }
${SLOPE_GLSL}
void main() {
  vec2 p = floor(gl_FragCoord.xy + uOrigin) + 0.5;
  vec2 d = br_slope(p, uTexelM, uScale); // metres of relief per metre
  vec3 n = normalize(vec3(-d, 1.0));
  fragColor = vec4(n * 0.5 + 0.5, clamp(br_h(p), 0.0, 1.0));
}
`;

const f = (x: number): string => {
  const s = x.toFixed(6);
  return s.includes('.') ? s : s + '.0';
};
const v2 = (a: number, b: number): string => `vec2(${f(a)}, ${f(b)})`;
const v3 = (a: readonly number[]): string => `vec3(${f(a[0])}, ${f(a[1])}, ${f(a[2])})`;

export interface RecipeHeaderParams {
  layer: number;
  frame: [number, number]; // metres (repeat, layerRepeatY)
  albedo: readonly [number, number, number];
  rough: number;
  metal: number;
  trim?: readonly [number, number, number]; // albedo calibration multiplier (default 1)
}

/** Full fragment source of one layer recipe program. */
export function buildRecipeFragment(p: RecipeHeaderParams, recipeGlsl: string): string {
  const trim = p.trim ?? [1, 1, 1];
  return /* glsl */ `precision highp float;
precision highp int;
precision highp sampler2D;
#define LAYER ${p.layer}
#define FRAME ${v2(p.frame[0], p.frame[1])}
#define NOISE_FRAME FRAME
#define TABLE_ALBEDO ${v3(p.albedo)}
#define TABLE_ROUGH ${f(p.rough)}
#define TABLE_METAL ${f(p.metal)}
#define ALBEDO_TRIM ${v3(trim)}
#define OUT_HEIGHT ${OUT_HEIGHT}
#define OUT_ALBEDO ${OUT_ALBEDO}
#define OUT_ORMH ${OUT_ORMH}
uniform int uOut;
uniform float uRes;
uniform vec2 uOrigin;
uniform sampler2D uScratch;
uniform float uHeightM;
uniform int uHPackIn;  // 1: the scratch is RGBA8 with 16-bit packed height (no colour-buffer-float support)
uniform int uHPackOut; // 1: this HEIGHT pass writes packed height (into that RGBA8 scratch)
layout(location = 0) out highp vec4 fragColor;
${NOISE_GLSL}
${HEIGHT_PACK_GLSL}
${COMMON_GLSL}
// ---------------------------------------------------------------- recipe (layer ${p.layer})
${recipeGlsl}
${RECIPE_MAIN}`;
}

/** Main of a detail-map recipe (package B, textures/detail.ts; the layer recipe environment with FRAME = the detail
 * repeat). uOut == OUT_HEIGHT writes the scratch height; any other value is the pack pass (LEAN moments):
 *   rg = E[slope] / DETAIL_S * 0.5 + 0.5, b = albedo multiplier x recipe AO x cavity^DETAIL_CAVITY / 2 (0.5 neutral),
 *   a = E[|slope|^2] / (2 DETAIL_S^2).
 * The texel stores one slope, so its variance is 0; the box-filtered mips then hold exact first and second moments, and
 * the shader recovers the unresolved variance E[s^2] - |E[s]|^2 at any distance (LEAN mapping, Olano & Baker 2010). */
export const DETAIL_MAIN = RECIPE_SUPPORT + SLOPE_GLSL + /* glsl */ `
void main() {
  vec2 px = gl_FragCoord.xy + uOrigin;
  Surf s;
#ifdef SS
  br_texel = vec2(0.5 / uRes);
  br_init(s);
  s.albedo = vec3(0.0); s.alpha = 0.0; s.height = 0.0; s.rough = 0.0; s.metal = 0.0; s.ao = 0.0; s.emissive = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = i == 0 ? vec2(0.125, 0.375) : i == 1 ? vec2(0.375, -0.125) : i == 2 ? vec2(-0.125, -0.375) : vec2(-0.375, 0.125);
    Surf t; br_init(t);
    gen((px + o) / uRes, t);
    br_add(s, t);
  }
  s.albedo *= 0.25; s.height *= 0.25; s.ao *= 0.25;
#else
  br_texel = vec2(1.0 / uRes);
  br_init(s);
  gen(px / uRes, s);
#endif
  if (uOut == OUT_HEIGHT) {
    fragColor = uHPackOut == 1 ? br_packH(s.height) : vec4(s.height, 0.0, 0.0, 1.0);
  } else {
    vec2 c = floor(px) + 0.5;
    vec2 sE = clamp(br_slope(c, FRAME / uRes, uHeightM) / DETAIL_S, -1.0, 1.0);
    float cav = DETAIL_CAVITY > 0.0 ? pow(br_cavity(c), DETAIL_CAVITY) : 1.0;
    fragColor = vec4(sE * 0.5 + 0.5, sat(0.5 * s.albedo.r * s.ao * cav), 0.5 * dot(sE, sE));
  }
}
`;

export interface DetailHeaderParams {
  layer: number;
  repeat: number; // metres (square frame)
  slope: number; // DETAIL_S: slope normalisation of the pack
  cavity: number; // exponent of the cavity AO folded into the albedo multiplier (0 = none)
}

/** Full fragment source of one detail recipe program (the layer recipe environment, neutral table values). */
export function buildDetailFragment(p: DetailHeaderParams, recipeGlsl: string): string {
  return /* glsl */ `precision highp float;
precision highp int;
precision highp sampler2D;
#define DETAIL ${p.layer}
#define FRAME ${v2(p.repeat, p.repeat)}
#define NOISE_FRAME FRAME
#define TABLE_ALBEDO vec3(1.0)
#define TABLE_ROUGH 0.0
#define TABLE_METAL 0.0
#define DETAIL_S ${f(p.slope)}
#define DETAIL_CAVITY ${f(p.cavity)}
#define OUT_HEIGHT ${OUT_HEIGHT}
#define OUT_ALBEDO ${OUT_ALBEDO}
#define OUT_ORMH ${OUT_ORMH}
uniform int uOut;
uniform float uRes;
uniform vec2 uOrigin;
uniform sampler2D uScratch;
uniform float uHeightM;
uniform int uHPackIn;
uniform int uHPackOut;
layout(location = 0) out highp vec4 fragColor;
${NOISE_GLSL}
${HEIGHT_PACK_GLSL}
${COMMON_GLSL}
// ---------------------------------------------------------------- detail recipe (D${p.layer})
${recipeGlsl}
${DETAIL_MAIN}`;
}

/** Fragment source for a standalone 2D generator (grime, water normals, cookie): noise + common + body.
 * The body defines `vec4 texel(vec2 uv)`; FRAME is 1 x 1 (unit square). */
export function buildStandaloneFragment(body: string, ss = false): string {
  return /* glsl */ `precision highp float;
precision highp int;
precision highp sampler2D;
#define FRAME vec2(1.0, 1.0)
#define NOISE_FRAME FRAME
uniform float uRes;
uniform vec2 uOrigin;
layout(location = 0) out highp vec4 fragColor;
${NOISE_GLSL}
${COMMON_GLSL}
${body}
void main() {
  vec2 px = gl_FragCoord.xy + uOrigin;
${ss ? `  br_texel = vec2(0.5 / uRes);
  vec4 c = vec4(0.0);
  c += texel((px + vec2(0.125, 0.375)) / uRes);
  c += texel((px + vec2(0.375, -0.125)) / uRes);
  c += texel((px + vec2(-0.125, -0.375)) / uRes);
  c += texel((px + vec2(-0.375, 0.125)) / uRes);
  fragColor = c * 0.25;` : `  br_texel = vec2(1.0 / uRes);
  fragColor = texel(px / uRes);`}
}
`;
}
