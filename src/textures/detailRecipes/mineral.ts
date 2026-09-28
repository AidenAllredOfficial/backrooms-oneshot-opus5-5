// src/textures/detailRecipes/mineral.ts — concrete detail maps: D4 CONCRETE_FINE, D12 SLAB, D13 POLISH (package B;
// texture realism v2 lane B; D12 / D13 are reserved placeholders).

import { Det, neutralDetail, type DetailTable } from './types.ts';

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

export const MINERAL_DETAILS: DetailTable = {
  [Det.CONCRETE_FINE]: { name: 'CONCRETE_FINE', glsl: CONCRETE_FINE, heightScale: 0.0008, slope: 0.35, roughK: 0.25, cavity: 1 },
  [Det.SLAB]: neutralDetail('SLAB'),
  [Det.POLISH]: neutralDetail('POLISH'),
};
