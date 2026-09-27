// src/textures/cookie.ts — 512^2 flashlight cookie (SpotLight.map) (WP8; package F optics): the LED reflector beam
// of lighting/flashlightOptics.ts (a softly square ~9 deg hotspot with a faint phosphor ring, a smooth halo, a dim
// wide spill and a soft outer edge) times lens dirt and a thumb smudge, with a cool core, warm spill and a yellow
// phosphor ring. Linear RGBA16F (HalfFloat: no 8-bit banding in the 3 % spill gradient), clamped, mipmapped, not
// tileable.
//
// Projection: three maps the cookie through the spot shadow camera (fov = 2 * angle * focus, focus = MAP_FOCUS), so
// the point p = (uv - 0.5) * 2 lies at tan(theta) = |p| * tan(CONE * MAP_FOCUS) off the beam axis; the beam ends at
// |p| = tan(RIM.out) / tan(CONE * MAP_FOCUS) (~0.80) and the margin beyond it stays black.

import { beamProfileGlsl, FLASHLIGHT_OPTICS } from '../lighting/flashlightOptics.ts';
import { f } from '../materials/chunks/params.ts';
import { buildStandaloneFragment } from './glsl/common.ts';

export const COOKIE_SIZE = 512;

const O = FLASHLIGHT_OPTICS;
const PT = O.PHOSPHOR.tint;
/** Strength of the phosphor ring's colour shift (0..1 at the ring's centre). */
const PHOS_TINT = 0.6;

export const COOKIE_GLSL = /* glsl */ `
${beamProfileGlsl()}
vec4 texel(vec2 uv) {
  vec2 p = (uv - 0.5) * 2.0;
  float r = length(p);
  if (r >= 1.0) return vec4(0.0, 0.0, 0.0, 1.0);
  float tc = ${f(Math.tan(O.CONE * O.MAP_FOCUS))};
  float th = atan(r * tc);
  // the die image is slightly square: the core uses a blend of the round and the Chebyshev radius
  float ths = atan(mix(r, max(abs(p.x), abs(p.y)) * 1.03, 0.07) * tc);
  float I = brBeam(th, ths);
  // lens dirt: low-frequency blotches everywhere, darker specks in the spill, a thumb smudge off-centre
  float dirt = 1.0 + 0.04 * fbm(uv, ivec2(6), 4, 61)
             - 0.08 * smoothstep(0.6, 0.9, fbmV(uv, ivec2(20), 3, 62)) * smoothstep(0.25, 0.4, r);
  dirt *= 1.0 - 0.07 * gauss(length((p - vec2(0.18, -0.12)) * vec2(3.0, 4.5)));
  // cool die core, warm spill, yellow phosphor ring at the edge of the hotspot
  vec3 tint = mix(vec3(0.97, 1.0, 1.05), vec3(1.0, 0.97, 0.92), smoothstep(0.08, 0.3, r));
  tint = mix(tint, vec3(${f(PT[0])}, ${f(PT[1])}, ${f(PT[2])}), ${f(PHOS_TINT)} * brBeamPhos(th));
  return vec4(max(I * dirt, 0.0) * tint, 1.0);
}
`;

export const COOKIE_FRAGMENT = buildStandaloneFragment(COOKIE_GLSL, true);
