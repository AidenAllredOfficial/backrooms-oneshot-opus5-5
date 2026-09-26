// src/textures/cookie.ts — 256^2 flashlight cookie (SpotLight.map) (WP8): hot centre, soft reflector rings,
// lens-dirt noise, warm fringe, falling to 0 at the edge. Linear RGBA8, clamped, not tileable.

import { buildStandaloneFragment } from './glsl/common.ts';

export const COOKIE_SIZE = 256;

export const COOKIE_GLSL = /* glsl */ `
vec4 texel(vec2 uv) {
  vec2 p = (uv - 0.5) * 2.0;
  float r = length(p);
  float hot = exp(-r * r / 0.05);
  float body = 1.0 - smoothstep(0.3, 0.95, r);
  float rings = 0.1 * gauss((r - 0.42) / 0.04) + 0.08 * gauss((r - 0.63) / 0.05) + 0.05 * gauss((r - 0.8) / 0.035)
              - 0.07 * gauss((r - 0.24) / 0.03);
  float dirt = 1.0 + 0.06 * fbm(uv, ivec2(6), 4, 61) - 0.1 * smoothstep(0.6, 0.9, fbmV(uv, ivec2(20), 3, 62));
  float I = (0.62 * body + 0.4 * hot + rings) * dirt;
  I *= 1.0 - smoothstep(0.86, 0.99, r);
  vec3 tint = mix(vec3(1.0), vec3(1.0, 0.92, 0.8), smoothstep(0.5, 0.95, r));
  return vec4(clamp(I * tint, 0.0, 1.0), 1.0);
}
`;

export const COOKIE_FRAGMENT = buildStandaloneFragment(COOKIE_GLSL, true);
