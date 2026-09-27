// src/materials/chunks/water.ts — package E: water code shared with the surface programs (the wet band above a water
// line, the in-water flashlight hook) and, later, the water shader's own wave / optics chunks.
// A.0 stub (owner E): neutral bodies, so every surface program compiles with BR_WATER_WETBAND / BR_CAUSTICS_FULL on.

/** Appended to the surface fragment common block. brWaterWetBand is called from package B's wetness block. */
export const WATER_SURF_GLSL = /* glsl */ `
#ifdef BR_WATER_WETBAND
// wetness (0..1) of a fragment just above a water line (tile-local position, world geometric normal)
float brWaterWetBand( vec3 local, vec3 nWg, bool horiz ) { return 0.0; }
#endif
`;

/** Appended to the surface clipping_planes_pars_fragment injection (after three's light pars: SpotLight,
 * getSpotLightInfo): the in-water flashlight redirect target. */
export const WATER_SPOT_GLSL = /* glsl */ `
`;
