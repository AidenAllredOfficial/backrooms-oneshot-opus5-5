// src/textures/detailRecipes/walls.ts — wall and ceiling detail maps: D2 VINYL_PAPER (vinyl fabric emboss), D3 PAINT, D5 MINERAL_FIBRE,
// D16 ROLLER_STIPPLE, D17 LINEN (package B; texture realism v2 lane D).

import { Det, type DetailTable } from './types.ts';

/** D2 vinyl fabric emboss (WALLPAPER_L0, at detRep 0.5: a 0.15 m repeat, 0.29 mm texels): a plain-weave linen look
 * embossed into the vinyl, warp and weft threads at 1.8 mm pitch (84 per repeat, 6 texels each: at the 0.3 m repeat
 * a thread was 3 texels and the Sobel slope kept 40 % of it) passing over and under each other, their widths slubbed
 * +-25 % along each thread at 12-40 mm. rms slope ~0.07 (the emboss is ~0.1 mm deep): it breaks the satin sheen into
 * grain up close and under the torch and becomes roughness (LEAN) farther away. No pebbles. */
const VINYL_PAPER = /* glsl */ `
#define SS 4
// one thread family across x: profile of thread i (index), slubbed width along y
float vfThread(vec2 uv, float N, int seed, out float idx) {
  float fx = uv.x * N;
  idx = floor(fx + 0.5);
  float slub = vnoise(vec2(idx / N, uv.y), ivec2(int(N), 4), seed) * 0.6 + vnoise(vec2(idx / N, uv.y), ivec2(int(N), 12), seed + 1) * 0.4;
  float wid = 0.8 + 0.5 * slub; // 0.8..1.3 of the pitch (+-25 % around 1.05)
  return sat(cos(3.14159265 * (fx - idx) / wid));
}
void gen(vec2 uv, inout Surf s) {
  const float N = 84.0; // even: the over-under parity must repeat with the texture
  float i, j;
  float px = vfThread(uv, N, 3, i);
  float py = vfThread(uv.yx, N, 5, j);
  // over-under: at crossing (i, j) the warp is on top where i + j is even
  float warpH = px * (0.6 + 0.4 * cos(3.14159265 * (uv.y * N + i)));
  float weftH = py * (0.6 - 0.4 * cos(3.14159265 * (uv.x * N + j)));
  float h = max(warpH, weftH);
  h = mix(0.5, h, bandLimitPx(N));
  s.height = 0.5 + 0.5 * (h - 0.5);
  s.albedo = vec3(1.0 + 0.04 * (h - 0.5));
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

/** D5 mineral fibre board (ceiling tiles; the base layer holds the fissures and the tile's detail mask keeps it off
 * the T-bar): the latex-over-fibre grain (Worley domes of ~1.4 mm cells, 0.02-0.05 mm high, plus a finer granular
 * noise) and the pinholes, 0.4-0.9 mm across at 3-6 per cm2, clustered by a coarse field and irregular (a lobed
 * radius). A pinhole is 2-4 mm deep but only 1-1.5 detail texels wide, so its occlusion goes into the recipe AO (0.35
 * inside), not into a cavity the height field could not resolve. */
const MINERAL_FIBRE = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  Cell g = worley(uv, PM(700.0), 0.9, 3);
  float gh = hashf(g.id, 4);
  float grain = (1.0 - smoothstep(0.0, 0.75, g.f1)) * (0.55 + 0.45 * gh);
  float fine = vnoise(uv, PM(1400.0), 5);
  float clus = fbmV(uv, PM(15.0), 2, 6);
  Cell p = worley(uv, PM(600.0), 0.8, 8);
  vec4 ph = hash4f(ivec2(p.id), 9);
  float occ = mix(0.03, 0.22, smoothstep(0.35, 0.7, clus));
  float rC = mix(0.2, 0.45, ph.y * ph.y) * 0.6; // radius in cells (1.67 mm)
  rC *= 1.0 + 0.3 * sin(3.0 * atan(p.rel.y, p.rel.x) + 6.2831853 * ph.z);
  float pin = step(ph.x, occ) * (1.0 - smoothstep(0.6 * rC, rC, p.f1));
  s.height = 0.5 + 0.35 * grain + 0.1 * (fine - 0.5) - 0.6 * pin;
  s.ao = 1.0 - 0.65 * pin;
  s.albedo = vec3(1.0 + 0.05 * (gh - 0.5) * grain + 0.03 * (fine - 0.5));
}
`;

/** D16 roller stipple (DRYWALL): the orange peel a 3/8" nap roller leaves in latex eggshell, 1.5-3 mm across and
 * 30-60 um high (rms slope ~0.05, 2-5 degrees): shallow F1 craters where the nap's air cells burst (1.8 x 2.3 mm
 * cells), between soft peaks (2.5 x 3.1 mm), both stretched 1.25x along the roller's travel (vertical) and at least
 * 3 detail texels across (finer stipple only reached the pack as a tenth of its slope). Invisible face-on, a fine
 * sandpaper grain under raking light and in the sheen. */
const ROLLER_STIPPLE = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  Cell cr = worley(uv, PMxy(550.0, 440.0), 0.9, 3);
  float crater = (1.0 - smoothstep(0.0, 0.6, cr.f1)) * (0.5 + 0.5 * hashf(cr.id, 4));
  Cell pk = worley(uv, PMxy(400.0, 320.0), 0.9, 5);
  float peak = 1.0 - smoothstep(0.0, 0.75, pk.f1);
  float lap = fbm(uv, PM(40.0), 2, 6); // nap load: the stipple is deeper where the roller was fuller
  s.height = 0.5 + (0.6 + 0.3 * lap) * (0.45 * peak - 0.4 * crater);
  s.albedo = vec3(1.0 - 0.012 * crater);
}
`;

/** D17 linen emboss (WALLPAPER_MANILA, at detRep 0.5: a 0.15 m repeat, 0.29 mm texels): a grasscloth-look linen,
 * threads at ~1.8 mm (84 per repeat, 6 texels each) crossing over and under, each thread's position jittered, its
 * width slubbed +-30 % and its height +-20 % along its length; rms slope ~0.06. The pack's slopes are in the 0.3 m
 * generator frame and the shader applies them as packed, so at the 0.15 m repeat the relief they stand for is half
 * of heightScale. */
const LINEN = /* glsl */ `
#define SS 4
float lnThread(vec2 uv, float N, int seed, out float idx, out float amp) {
  float fx = uv.x * N;
  idx = floor(fx + 0.5);
  vec2 q = vec2(idx / N, uv.y);
  float jit = 0.15 * (hashf(ivec2(int(mod(idx, N)), 0), seed) - 0.5);
  float slub = vnoise(q, ivec2(int(N), 9), seed + 1) * 0.5 + vnoise(q, ivec2(int(N), 25), seed + 2) * 0.5;
  amp = 0.8 + 0.4 * vnoise(q, ivec2(int(N), 6), seed + 3);
  float wid = 0.75 + 0.6 * slub;
  return sat(cos(3.14159265 * (fx - idx - jit) / wid));
}
void gen(vec2 uv, inout Surf s) {
  const float N = 84.0; // even: the over-under parity repeats with the texture
  float i, j, ai, aj;
  float px = lnThread(uv, N, 3, i, ai);
  float py = lnThread(uv.yx, N, 7, j, aj);
  float warpH = ai * px * (0.7 + 0.3 * cos(3.14159265 * (uv.y * N + i)));
  float weftH = aj * py * (0.7 - 0.3 * cos(3.14159265 * (uv.x * N + j)));
  float h = max(warpH, weftH);
  s.height = 0.5 + 0.5 * (h - 0.5);
  s.albedo = vec3(1.0 + 0.05 * (h - 0.5));
}
`;

// slope (the pack's normalisation) is ~2.5x each map's rms slope: at 0.2-0.45 the RGBA8 variance channel rounded to 0
// and the slope channels kept 3-8 levels (harness extra=detail reports the rms slope)
export const WALL_DETAILS: DetailTable = {
  [Det.VINYL_PAPER]: { name: 'VINYL_PAPER', glsl: VINYL_PAPER, heightScale: 0.00047, slope: 0.18, roughK: 0.08, cavity: 0.4 },
  [Det.PAINT]: { name: 'PAINT', glsl: PAINT, heightScale: 0.00036, slope: 0.12, roughK: 0.1, cavity: 0.3 },
  [Det.MINERAL_FIBRE]: { name: 'MINERAL_FIBRE', glsl: MINERAL_FIBRE, heightScale: 0.0001, slope: 0.04, roughK: 0, cavity: 1 },
  [Det.ROLLER_STIPPLE]: { name: 'ROLLER_STIPPLE', glsl: ROLLER_STIPPLE, heightScale: 0.0004, slope: 0.12, roughK: 0.05, cavity: 0.2 },
  [Det.LINEN]: { name: 'LINEN', glsl: LINEN, heightScale: 0.0004, slope: 0.15, roughK: 0.06, cavity: 0.4 },
};
