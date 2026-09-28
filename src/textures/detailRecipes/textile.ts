// src/textures/detailRecipes/textile.ts — textile detail maps: D0 CUT_PILE, D1 LOOP_PILE, D7 WEAVE (package B;
// texture realism v2 lane A).

import { Det, type DetailTable } from './types.ts';

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

export const TEXTILE_DETAILS: DetailTable = {
  [Det.CUT_PILE]: { name: 'CUT_PILE', glsl: CUT_PILE, heightScale: 0.003, slope: 1.2, roughK: 0, cavity: 1 },
  [Det.LOOP_PILE]: { name: 'LOOP_PILE', glsl: LOOP_PILE, heightScale: 0.002, slope: 1.0, roughK: 0, cavity: 1 },
  [Det.WEAVE]: { name: 'WEAVE', glsl: WEAVE, heightScale: 0.0006, slope: 0.4, roughK: 0, cavity: 1 },
};
