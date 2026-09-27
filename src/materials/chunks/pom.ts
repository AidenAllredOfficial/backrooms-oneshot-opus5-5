// src/materials/chunks/pom.ts — package B: parallax occlusion mapping of the shell (BR_POM = 1 steps only, 2 with
// self-shadow) and the directional-light visibility terms (micro-shadowing, POM self-shadow).
// A.0 stub (owner B): no code yet. FRAG_DIRVIS_GLSL is inlined by chunks/lighting.ts inside `if ( brW > 0.0 )`,
// after the contact shadow and before RE_Direct: it may only multiply `float brDirVis` (brLv, brNg, brNgL in scope).

/** Appended to the fragment common block. */
export const POM_PARS_GLSL = /* glsl */ `
// ---- parallax occlusion mapping (package B)
`;

/** Inline block in FRAG_LIGHTS_GLSL: multiplies brDirVis (the baked directional light's visibility). */
export const FRAG_DIRVIS_GLSL = /* glsl */ `
`;
