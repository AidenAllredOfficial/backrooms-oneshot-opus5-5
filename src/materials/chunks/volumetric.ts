// src/materials/chunks/volumetric.ts — package F: the froxel volume lookup (uVolTex: integrated in-scatter rgb and
// transmittance a, slices tiled into a 2D atlas; uVolGrid, uVolZ, uVolScreen) under BR_VOLUMETRIC.
// A.0 stub (owner F): a neutral lookup (no in-scatter, full transmittance). The haze API brHaze / brHazeT
// (chunks/common.ts) dispatches to it once F lands.

/** Appended to the fragment common block. */
export const VOLUMETRIC_GLSL = /* glsl */ `
#ifdef BR_VOLUMETRIC
// in-scatter (rgb) and transmittance (a) from the camera to view-space position viewPos
vec4 brVolLookup( vec3 viewPos ) { return vec4( 0.0, 0.0, 0.0, 1.0 ); }
#endif
`;
