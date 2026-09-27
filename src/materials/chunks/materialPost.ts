// src/materials/chunks/materialPost.ts — package B: material edits after three's lights_physical_fragment (which
// fills `material`) and before lights_fragment_begin computes material.dfg, so every light path sees them. Fixed
// order: wet F0 -> glaze coverage -> sheen (USE_SHEEN) -> clearcoat fields (USE_CLEARCOAT, props) -> spec AA
// (BR_SPEC_AA, on roughness and clearcoatRoughness) last.
// A.0 stub (owner B): no code yet (material.clearcoat stays 0 and sheenColor stays black: both lobes are inert).

/** Injected after `#include <lights_physical_fragment>`. */
export const FRAG_MATERIAL_POST_GLSL = /* glsl */ `
`;
