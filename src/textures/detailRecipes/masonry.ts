// src/textures/detailRecipes/masonry.ts — masonry and tile detail maps: D6 GLAZE, D14 CMU_FACE, D15 CMU_RAW
// (package B; texture realism v2 lane C).

import { Det, type DetailTable } from './types.ts';

/** D6 glaze (pool tile, mosaic, VCT wax): long-wave waviness (25 and 12 mm; a few tenths of a degree, so lamp
 * reflections bend smoothly instead of tearing) and sparse pinholes: 0.3-0.6 mm craters in ~8 % of 5.5 mm cells,
 * 0.04 mm deep and a little dirty, which is what makes a glaze read as fired ceramic rather than CG glass up close. */
const GLAZE = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  float h = 0.5 + 0.3 * gnoise(uv, PM(40.0), 3) + 0.2 * gnoise(uv, PM(80.0), 4);
  Cell p = worley(uv, PM(180.0), 0.9, 5);
  float pr = mix(0.028, 0.055, hashf(p.id, 6)); // radius in cells (5.5 mm): 0.15-0.3 mm
  float pin = step(hashf(p.id, 7), 0.08) * (1.0 - smoothstep(0.6 * pr, pr, p.f1));
  s.height = h - 0.33 * pin;
  s.albedo = vec3(1.0 - 0.15 * pin);
}
`;

/**
 * The face of a concrete block (vibro-compacted zero-slump concrete): packed ~1.6 mm sand and ~3.3 mm grit whose
 * rounded crowns stand out of the cement paste, interstitial crevices where three grits meet, and 0.8-2.5 mm voids
 * between the grains, clustered in under-compacted 'open' patches of a few cm where the paste also sits lower. Shared
 * by D14 (painted: block filler and two latex coats level the relief, round the crowns and bridge voids under ~0.9 mm;
 * the larger voids stay open as shallow paint-lined pits in the face colour, so they read through shading and the
 * cavity, not through dark albedo) and D15 (raw: the full relief, deep voids, a salt-and-pepper tone per grain).
 */
const cmuFace = (painted: boolean): string => /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  float open = smoothstep(-0.25, 0.45, fbm(uv, PM(14.0), 3, 3));
  // grit (3.3 mm cells) and sand (1.6 mm): parabolic crowns of random height; the low ones stay under the paste
  Cell a = worley(warp(uv, PM(50.0), 2, 5, 0.0025), PM(300.0), 0.95, 6);
  float ga = 0.2 + 0.65 * hashf(a.id, 7) - 3.0 * a.f1 * a.f1;
  Cell b = worley(uv, PM(620.0), 0.95, 8);
  float gb = 0.28 + 0.35 * hashf(b.id, 9) - 2.4 * b.f1 * b.f1;
  // the paste between them is itself fine sand: never a flat plateau
  float paste = 0.36 - 0.16 * open + 0.05 * fbm(uv, PM(120.0), 2, 10) + 0.14 * gnoise(uv, PM(450.0), 24);
  // crevices where three grits meet (far from every grain centre, on a cell border), deeper in open patches
  float vtx = smoothstep(0.5, 0.75, a.f1) * (1.0 - smoothstep(0.0, 0.1, a.f2 - a.f1)) * smoothstep(0.2, 0.6, open + 0.3);
  // voids between the grains: two overlapping discs with a ragged rim, more of them in open patches
  Cell v = worley(warp(uv, PM(35.0), 2, 11, 0.004), PM(150.0), 0.9, 12);
  float vr = mix(0.12, 0.4, hashf(v.id, 13));
  vec2 vo = (hash2f(v.id, 22) - 0.5) * vr * 1.4;
  float vf = min(length(v.rel), 1.2 * length(v.rel + vo)) + 0.06 * gnoise(uv, PM(900.0), 15);
  float vm = step(hashf(v.id, ${painted ? 14 : 23}), ${painted ? '0.14 + 0.36' : '0.24 + 0.4'} * open) * (1.0 - smoothstep(0.6 * vr, vr, vf));
${painted ? `  // paint: the film rounds the crowns and fills between them (smooth max), halves the relief, bridges the voids
  // under ~0.9 mm and lines the rest (shallow floors); crevices mostly filled
  float h = -smin(-max(ga, gb), -paste, 0.08) + 0.1 * gnoise(uv, PM(560.0), 25);
  h = 0.5 + 0.6 * (h - 0.5);
  vm *= smoothstep(0.14, 0.2, vr);
  float hole = max(vm, 0.4 * vtx);
  s.height = mix(h, 0.25 + 0.05 * vnoise(uv, PM(400.0), 16), hole);
  s.albedo = vec3(1.0 - 0.05 * hole);` : `  float h = max(max(ga, gb), paste) + 0.1 * gnoise(uv, PM(560.0), 25);
  float hole = max(vm, vtx);
  s.height = mix(h, 0.05 * vnoise(uv, PM(400.0), 16), hole);
  // salt and pepper: each grain its own mineral tone, a few dark and light grains, the paste a flat grey
  float ta = 1.0 + 0.35 * (hashf(a.id, 17) - 0.5), tb = 1.0 + 0.25 * (hashf(b.id, 18) - 0.5);
  ta *= mix(1.0, 0.6, step(hashf(a.id, 19), 0.06)) * mix(1.0, 1.25, step(0.95, hashf(a.id, 20)));
  float tone = ga >= max(gb, paste) ? ta : gb >= paste ? tb : 1.0 + 0.04 * fbm(uv, PM(200.0), 2, 21);
  s.albedo = vec3(tone * (1.0 - 0.35 * hole));`}
}
`;

export const MASONRY_DETAILS: DetailTable = {
  [Det.GLAZE]: { name: 'GLAZE', glsl: GLAZE, heightScale: 0.00018, slope: 0.02, roughK: 0.1, cavity: 0.3 },
  [Det.CMU_FACE]: { name: 'CMU_FACE', glsl: cmuFace(true), heightScale: 0.0044, slope: 1.6, roughK: 0.2, cavity: 0.6 },
  [Det.CMU_RAW]: { name: 'CMU_RAW', glsl: cmuFace(false), heightScale: 0.0028, slope: 1.8, roughK: 0.25, cavity: 0.7 },
};
