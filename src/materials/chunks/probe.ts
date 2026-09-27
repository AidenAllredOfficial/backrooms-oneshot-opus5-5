// src/materials/chunks/probe.ts — package D: the box-projected reflection probe (uBrProbe: GGX-prefiltered cube;
// uBrProbeMin/Max/Pos camera-relative world metres) under BR_PROBE.
// A.0 stub (owner D): neutral bodies (weight 0 = no probe), so every program compiles with BR_PROBE on.

/** Appended to the fragment common block. */
export const PROBE_GLSL = /* glsl */ `
#ifdef BR_PROBE
// influence of the probe at camera-relative world position pc (0 outside its box or while no probe exists)
float brProbeWeight( vec3 pc ) { return 0.0; }
// cube lookup direction for the world reflection vector r (box projection fading to r with roughness)
vec3 brProbeDir( vec3 pc, vec3 r, float rough ) { return r; }
// normalisation of the probe radiance to the local baked irradiance eLocal at world normal nW
float brProbeNorm( vec3 nW, vec3 eLocal, float rough ) { return 1.0; }
#endif
`;
