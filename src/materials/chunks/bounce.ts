// src/materials/chunks/bounce.ts — package F: flashlight bounce from CPU-placed VPLs (uniform arrays uFbP/uFbN/uFbC/
// uFbBox, uFbOn; BR_BOUNCE_N lights), no samplers.
// A.0 stub (owner F): no code yet. FRAG_BOUNCE_GLSL is inlined by chunks/lighting.ts right after the ambient lines
// (irradiance / iblIrradiance / radiance); its diffuse bounce is multiplied by brSsC.

/** Appended to the fragment common block. */
export const BOUNCE_GLSL = /* glsl */ `
// ---- flashlight bounce (package F)
`;

/** Inline block in FRAG_LIGHTS_GLSL after the ambient lines. */
export const FRAG_BOUNCE_GLSL = /* glsl */ `
`;
