// src/textures/detailRecipes/walls.ts — wall and ceiling detail maps: D2 VINYL_PAPER, D3 PAINT, D5 MINERAL_FIBRE,
// D16 ROLLER_STIPPLE, D17 LINEN (package B; texture realism v2 lane D; D16 / D17 are reserved placeholders).

import { Det, neutralDetail, type DetailTable } from './types.ts';

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

export const WALL_DETAILS: DetailTable = {
  [Det.VINYL_PAPER]: { name: 'VINYL_PAPER', glsl: VINYL_PAPER, heightScale: 0.0006, slope: 0.2, roughK: 0.05, cavity: 0.5 },
  [Det.PAINT]: { name: 'PAINT', glsl: PAINT, heightScale: 0.00036, slope: 0.12, roughK: 0.1, cavity: 0.3 },
  [Det.MINERAL_FIBRE]: { name: 'MINERAL_FIBRE', glsl: MINERAL_FIBRE, heightScale: 0.0006, slope: 0.2, roughK: 0, cavity: 1 },
  [Det.ROLLER_STIPPLE]: neutralDetail('ROLLER_STIPPLE'),
  [Det.LINEN]: neutralDetail('LINEN'),
};
