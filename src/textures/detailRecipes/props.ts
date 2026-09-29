// src/textures/detailRecipes/props.ts — prop detail maps: D8 BRUSHED, D9 WOOD_PORE, D10 HAIRCELL, D18 ENAMEL,
// D19 RUST_GRAIN, D20 KRAFT (package B; texture realism v2 lane E; D18-D20 are reserved placeholders).

import { Det, neutralDetail, type DetailTable } from './types.ts';

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

/** D18 baked enamel (METAL_PAINTED; lane E): orange peel of 2-4 mm cells at +-6 um, the waviness that makes lamp
 * reflections in satin paint crawl, plus faint buffing swirls (long arcs, slightly glossier and a little deeper). */
const ENAMEL = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 w = warp(uv, PM(40.0), 2, 3, 0.004);
  float peel = fbm(w, PM(330.0), 2, 4);
  float sw = ridged(warp(uv, PM(5.0), 2, 5, 0.06), PMxy(2.0, 70.0), 2, 6);
  float swirl = smoothstep(0.9, 0.99, sw) * smoothstep(0.35, 0.7, vnoise(uv, PM(8.0), 7));
  s.height = 0.5 + peel - 0.1 * swirl;
  s.albedo = vec3(1.0 + 0.02 * swirl);
}
`;

export const PROP_DETAILS: DetailTable = {
  [Det.BRUSHED]: { name: 'BRUSHED', glsl: BRUSHED, heightScale: 0.00005, slope: 0.01, roughK: 0.05, cavity: 0 },
  [Det.WOOD_PORE]: { name: 'WOOD_PORE', glsl: WOOD_PORE, heightScale: 0.0002, slope: 0.08, roughK: 0.15, cavity: 0.5 },
  [Det.HAIRCELL]: { name: 'HAIRCELL', glsl: HAIRCELL, heightScale: 0.0001, slope: 0.07, roughK: 0.1, cavity: 0.5 },
  [Det.ENAMEL]: { name: 'ENAMEL', glsl: ENAMEL, heightScale: 0.000012, slope: 0.02, roughK: 0, cavity: 0 },
  [Det.RUST_GRAIN]: neutralDetail('RUST_GRAIN'),
  [Det.KRAFT]: neutralDetail('KRAFT'),
};
