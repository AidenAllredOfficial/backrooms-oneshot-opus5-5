// src/textures/layers/types.ts — recipe body shared by the layers/*.ts files (WP8), and the per-layer surface
// physics (SurfacePhys, package B + texture realism v2) that the family recipe files declare next to their GLSL.
// Pure data (no three): chunks/params.ts builds the layer tables and the BR_L_* GLSL const arrays from these rows.

import type { MatId } from '../../core/ids.ts';

/**
 * What a layer stores in ormh.a (texture realism v2 channel convention; generator Surf.aux / Surf.lean):
 * - 'none': 0 (every layer before v2 except the emissive ones);
 * - 'emissive': the emissive mask Surf.emissive (PANEL_LENS, SIGNAGE);
 * - 'detailMask': Surf.aux 0..1 (default 1) multiplies the detail-map strength;
 * - 'lean': Surf.lean (vec2 in [-1, 1], pile / fibre lean in the uv frame) -> ormh.b = x 0.5 + 0.5, ormh.a =
 *   y 0.5 + 0.5; such a layer has no metalness (the shader forces it to 0);
 * - 'wear': Surf.aux as a rank-normalised wear threshold field (P(W < x) = x);
 * - 'mask': Surf.aux as a family-defined 0..1 mask.
 */
export type AuxKind = 'none' | 'emissive' | 'detailMask' | 'lean' | 'wear' | 'mask';
/** GLSL ids of the aux kinds (BR_AUX_KIND[] in the surface shaders, AUX_KIND in the generator). */
export const AUX_KIND_ID: Readonly<Record<AuxKind, number>> = { none: 0, emissive: 1, detailMask: 2, lean: 3, wear: 4, mask: 5 };

/**
 * Physical surface parameters per layer (package B; uBrLayerC/D/E, and the BR_L_* const arrays of v2):
 * - por: porosity 0..1 (Lagarde 2013 wetness: how much a wet layer darkens / saturates, and how late its water
 *   film forms; textiles 1, glazes and sealed plastics ~0);
 * - pomTop: normalised top height of the relief for parallax occlusion mapping (0 = off; never on hex-tiled or
 *   alpha-tested layers). It must cover the per-texel maximum, not only the harness heightMax (32x32 cell means): a
 *   texel above the top (a raised tilted-tile corner) casts false self-shadows on ultra;
 * - tok: weight of the Toksvig (mip-filtered normal) variance in the roughness (1 = all of it is lobe broadening;
 *   < 1 where most of the filtered variance is structural: grout bevels, tilted tiles, joints, ribs);
 * - det / detS: detail-map layer (textures/detail.ts D0..D20 except the ripple D11, -1 = none) and strength;
 * - sheen / sheenR: textile sheen amount and roughness (USE_SHEEN);
 * - glaze / roughComp: two-lobe unmixing of bimodal layers (glaze lobe roughness and rough-component roughness:
 *   the mip-filtered roughness is their coverage mixture); 0 = single lobe.
 * Texture realism v2 (all neutral by default; package 0b shades them):
 * - sigma: EON diffuse roughness (0 = exact Lambert);
 * - pile: [kp, kv] pile shading (0 = off; kp > 0 also skips the baked-light cavity visibility term);
 * - detRep: detail repeat scale (1 = the 0.3 m repeat; the repeat must still divide 19.2, 3.0 and NOISE_WRAP);
 * - detTint: how much of the detail albedo multiplier tints per channel (0 = grey multiplier as today);
 * - detSO: share of the detail cavity folded into the inline specular occlusion (0 = none);
 * - dirt / wear: [r, g, b, amount] of the relief-aware dirt (concavities) and wear (convexities), amount 0 = off;
 * - reliefM: metres of height above the layer mean that count as fully convex.
 */
export interface SurfacePhys {
  por: number; pomTop: number; tok: number; det: number; detS: number; sheen: number; sheenR: number; glaze: number; roughComp: number;
  sigma: number;
  pile: readonly [number, number];
  detRep: number;
  detTint: readonly [number, number, number];
  detSO: number;
  dirt: readonly [number, number, number, number];
  wear: readonly [number, number, number, number];
  reliefM: number;
}

/** A SurfacePhys row: porosity plus overrides, every other field at its neutral default. */
export const phys = (por: number, o: Partial<Omit<SurfacePhys, 'por'>> = {}): SurfacePhys => ({
  por, pomTop: 0, tok: 1, det: -1, detS: 0, sheen: 0, sheenR: 1, glaze: 0, roughComp: 0,
  sigma: 0, pile: [0, 0], detRep: 1, detTint: [0, 0, 0], detSO: 0, dirt: [0, 0, 0, 0], wear: [0, 0, 0, 0], reliefM: 0.001,
  ...o,
});

export interface RecipeBody {
  /** GLSL defining `void gen(vec2 uv, inout Surf s)` (see glsl/common.ts for the environment). */
  glsl: string;
  /** Normal-map strength multiplier applied to the physical height gradient. */
  normalStrength: number;
  /** Metres of relief per unit of Surf.height. */
  heightScale: number;
  /** Albedo calibration multiplier (linear), measured with layerAlbedoCheck so the mean hits LAYER_DEFS (default 1). */
  trim?: readonly [number, number, number];
  /** Surface physics of the layer (package B and v2 shading parameters). */
  phys: SurfacePhys;
  /** What ormh.a holds (default 'none'). */
  aux?: AuxKind;
  /** albedo.a = Surf.alpha is a second aux channel (brAux2). Never on the alpha-tested layers (METAL_GRATE, SIGNAGE,
   * DECAL_ATLAS, FLOOR_PAINT). */
  aux2?: boolean;
  /** Generator-only frame [w, h] metres: the recipe FRAME, the normal pass and the cavity metric (default [repeat,
   * repeatY]). The mesher's UVs still follow LAYER_DEFS (horizontal faces repeat x repeat, vertical faces repeat x
   * repeatY), so the frame only says which of the two the texture is authored for: a floor layer can be square
   * ([repeat, repeat]) while its tower walls keep repeatY 3.0. */
  frame?: readonly [number, number];
}

export type RecipeTable = Partial<Record<MatId, RecipeBody>>;
