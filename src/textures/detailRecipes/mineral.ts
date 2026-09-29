// src/textures/detailRecipes/mineral.ts — concrete detail maps: D4 CONCRETE_FINE, D12 SLAB, D13 POLISH (package B;
// texture realism v2 lane B).

import { Det, type DetailTable } from './types.ts';

/** D4 fine concrete (cast walls, soffits, plenum, rust, CMU): ~2 mm sand grains with their own tone (+-15 %) in a
 * cement paste, and 1.3-3 mm pinholes (entrapped air, 4 % of a 3.3 mm lattice) that hold dirt: the bug-hole fines
 * below the base texel. */
const CONCRETE_FINE = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  Cell g = worley(uv, PM(500.0), 0.9, 3);
  float gh = hashf(g.id, 4);
  float grain = 1.0 - smoothstep(0.2, 0.55, g.f1);
  float paste = fbm(uv, PM(60.0), 3, 5);
  Cell ph = worley(uv, PM(90.0), 0.9, 6);
  float pr = mix(0.13, 0.31, hashf(ph.id, 7));
  float pin = step(hashf(ph.id, 8), 0.04) * (1.0 - smoothstep(pr * 0.55, pr, ph.f1));
  s.height = 0.55 + 0.25 * grain * (0.6 + 0.4 * gh) + 0.1 * paste - 0.5 * pin;
  s.albedo = vec3((1.0 + 0.3 * (gh - 0.5) * grain + 0.04 * paste) * (1.0 - 0.25 * pin));
  s.ao = 1.0 - 0.3 * pin;
}
`;

/** D12 troweled slab (CONCRETE_FLOOR; the FLOOR_PAINT decals fetch it too, so the stripes carry the slab's speckle):
 * the paste between the grains is burnished smooth (tens of microns), so the texture is tone, not relief: two sand
 * populations on a 1.4 mm lattice (light quartz / limestone grains +40 % on 30 % of the cells, dark mineral and dirt
 * specks -55 % on 8 %) over coarse 2-3 mm sand (+30 % / -45 %), 0.4-2 mm pinholes (7 % of a 17 mm lattice: ~250 / m^2) with dark dirty cores, steep walls
 * and a paler lip, and ~8 dragged micro-scratches per tile (1-4 cm, 0.05-0.1 mm half-width) that the traffic lanes
 * turn into LEAN roughness. */
const SLAB = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  Cell g = worley(uv, PM(700.0), 0.9, 3);
  vec2 gh = hash2f(g.id, 4);
  float core = 1.0 - smoothstep(0.2, 0.5, g.f1);
  float light = step(0.7, gh.x) * core * (0.6 + 0.4 * gh.y);
  float dark = step(gh.x, 0.08) * core;
  Cell ph = worley(uv, PM(60.0), 0.9, 6);
  vec2 pr = hash2f(ph.id, 7);
  float on = step(pr.x, 0.07);
  float r = mix(0.025, 0.12, pr.y * pr.y);
  float pin = on * (1.0 - smoothstep(r * 0.7, r, ph.f1));
  float lip = on * gauss((ph.f1 - r * 1.2) / (r * 0.3 + 0.01)) * (1.0 - pin);
  // coarse sand (2-3 mm grains on a 3.3 mm lattice): the grains that still read at 1-2 m
  Cell cg = worley(uv, PM(300.0), 0.9, 12);
  vec2 ch = hash2f(cg.id, 13);
  float cc = 1.0 - smoothstep(0.22, 0.42, cg.f1 + 0.08 * vnoise(uv, PM(1400.0), 14));
  float cLight = step(0.62, ch.x) * cc * (0.5 + 0.5 * ch.y);
  float cDark = step(ch.x, 0.1) * cc;
  float paste = fbm(uv, PM(120.0), 3, 8);
  float scr = 0.0;
  {
    ivec2 P = PM(10.0);
    vec2 cs = FRAME / vec2(P);
    vec2 c0 = floor(m / cs);
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 c = c0 + vec2(float(x), float(y));
        vec4 h = hash4f(wrapCell(c, vec2(P)), 9);
        if (h.w > 0.85) continue;
        vec2 a = (c + h.xy) * cs;
        float ang = h.z * 6.2831853;
        vec2 b = a + vec2(cos(ang), sin(ang)) * mix(0.01, 0.04, fract(h.w * 7.31));
        scr = max(scr, fillM(sdSeg(m, a, b) - mix(0.00005, 0.0001, fract(h.z * 13.7))));
      }
    }
  }
  s.height = 0.5 + 0.04 * paste + 0.05 * light - 1.0 * pin + 0.08 * lip - 0.2 * scr;
  s.albedo = vec3((1.0 + 0.4 * light - 0.55 * dark + 0.08 * paste) * (1.0 + 0.3 * cLight - 0.45 * cDark)
    * (1.0 - 0.65 * pin) * (1.0 + 0.03 * lip) * (1.0 + 0.05 * scr));
}
`;

/** D13 polished terrazzo: the grinding and buffing scratches of the polish (random directions, 5-40 mm, sub-texel
 * wide) and faint buffing-pad swirls; albedo nearly neutral. The scratches are far narrower than a texel, so their
 * slope variance is carried by an exaggerated heightScale (the texel-scale rms slope ~0.01 stands for the unresolved
 * micro-scratches): a faint sheen up close, LEAN micro-roughness farther away (r 0.09 -> ~0.1), which the traffic
 * lanes scale up (chunks/family/concrete.ts). */
const POLISH = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  float scr = 0.0;
  ivec2 P = PM(40.0);
  vec2 cs = FRAME / vec2(P);
  vec2 c0 = floor(m / cs);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 c = c0 + vec2(float(x), float(y));
      vec2 w = wrapCell(c, vec2(P));
      for (int k = 0; k < 2; k++) {
        vec4 h = hash4f(w, 11 + k);
        if (h.w > 0.6) continue;
        vec2 a = (c + h.xy) * cs;
        float ang = h.z * 6.2831853;
        vec2 b = a + vec2(cos(ang), sin(ang)) * mix(0.005, 0.04, h.w / 0.6);
        scr = max(scr, fillM(sdSeg(m, a, b) - 0.00004) * mix(0.4, 1.0, fract(h.z * 11.3)));
      }
    }
  }
  float swirl = gnoise(warp(uv, PM(8.0), 2, 14, 0.04), PMxy(3.0, 60.0), 15);
  s.height = 0.5 - 1.0 * scr + 0.15 * swirl;
  s.albedo = vec3(1.0 + 0.03 * scr);
}
`;

export const MINERAL_DETAILS: DetailTable = {
  [Det.CONCRETE_FINE]: { name: 'CONCRETE_FINE', glsl: CONCRETE_FINE, heightScale: 0.0008, slope: 0.35, roughK: 0.25, cavity: 1 },
  // slope S (harness extra=detail stats().detailMoments): POLISH ~3 x its rms slope (0.015); SLAB's slopes are heavy
  // tailed (flat paste, steep pinhole walls: rms 0.015 unclipped), so S keeps the pinhole walls up to ~8 degrees
  [Det.SLAB]: { name: 'SLAB', glsl: SLAB, heightScale: 0.0006, slope: 0.15, roughK: 0.3, cavity: 1 },
  [Det.POLISH]: { name: 'POLISH', glsl: POLISH, heightScale: 0.0008, slope: 0.045, roughK: 0, cavity: 0 },
};
