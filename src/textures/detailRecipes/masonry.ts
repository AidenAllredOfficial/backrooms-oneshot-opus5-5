// src/textures/detailRecipes/masonry.ts — masonry and tile detail maps: D6 GLAZE, D14 CMU_FACE, D15 CMU_RAW
// (package B; texture realism v2 lane C; D14 / D15 are reserved placeholders).

import { Det, neutralDetail, type DetailTable } from './types.ts';

/** D6 glaze waviness (pool tile, mosaic, VCT wax): smooth, albedo neutral; tilts reflections by a few tenths of a
 * degree so they wobble across a glazed wall instead of mirroring perfectly. */
const GLAZE = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  s.height = 0.5 + 0.3 * gnoise(uv, PM(40.0), 3) + 0.2 * gnoise(uv, PM(90.0), 4);
}
`;

export const MASONRY_DETAILS: DetailTable = {
  [Det.GLAZE]: { name: 'GLAZE', glsl: GLAZE, heightScale: 0.00008, slope: 0.008, roughK: 0, cavity: 0 },
  [Det.CMU_FACE]: neutralDetail('CMU_FACE'),
  [Det.CMU_RAW]: neutralDetail('CMU_RAW'),
};
