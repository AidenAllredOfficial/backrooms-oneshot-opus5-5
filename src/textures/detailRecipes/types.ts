// src/textures/detailRecipes/types.ts — detail-map recipe type, the detail layer ids and the neutral placeholder
// (package B; texture realism v2 split the recipes into one file per family, textures/detail.ts is the index).

/** A detail-map recipe (textures/detail.ts). */
export interface DetailRecipe {
  name: string;
  /** GLSL defining `void gen(vec2 uv, inout Surf s)` over the DETAIL_REPEAT frame. */
  glsl: string;
  /** Metres of relief per unit of Surf.height. */
  heightScale: number;
  /** Slope normalisation S of the pack: rg = E[slope] / S (clamped to +-1), a = E[|slope|^2] / (2 S^2). About 4 x the
   * layer's rms slope (harness stats().detailMoments): larger wastes the 8-bit moments, smaller clips the relief. */
  slope: number;
  /** Roughness added per unit of albedo darkening (pits, pores and gaps hold dirt and are rougher). */
  roughK: number;
  /** Exponent of the generator's cavity AO folded into the albedo multiplier (0 = none). */
  cavity: number;
}

/** Detail layer ids (array layer of uBrDetail; SurfacePhys.det). D11 is the puddle ripple (not a surface detail).
 * D12-D20 are the texture realism v2 slots, reserved as neutral placeholders until their lanes fill them: B (SLAB,
 * POLISH), C (CMU_FACE, CMU_RAW), D (ROLLER_STIPPLE, LINEN), E (ENAMEL, RUST_GRAIN, KRAFT). */
export const Det = {
  CUT_PILE: 0, LOOP_PILE: 1, VINYL_PAPER: 2, PAINT: 3, CONCRETE_FINE: 4, MINERAL_FIBRE: 5, GLAZE: 6, WEAVE: 7,
  BRUSHED: 8, WOOD_PORE: 9, HAIRCELL: 10, RIPPLE: 11,
  SLAB: 12, POLISH: 13, CMU_FACE: 14, CMU_RAW: 15, ROLLER_STIPPLE: 16, LINEN: 17, ENAMEL: 18, RUST_GRAIN: 19, KRAFT: 20,
} as const;
export type DetId = (typeof Det)[keyof typeof Det];

export type DetailTable = Partial<Record<DetId, DetailRecipe>>;

/** A reserved slot: flat (height 0.5), albedo multiplier exactly 1, no cavity; a small slope scale keeps the pack
 * well conditioned. */
export const neutralDetail = (name: string): DetailRecipe => ({
  name, glsl: /* glsl */ `
void gen(vec2 uv, inout Surf s) {
}
`, heightScale: 1e-4, slope: 0.05, roughK: 0, cavity: 0,
});
