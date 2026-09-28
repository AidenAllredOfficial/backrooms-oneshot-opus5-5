// src/textures/detail.ts — close-range detail maps (package B): 21 procedural recipes baked into one LEAN-packed
// sampler2DArray (textures/DetailBaker.ts, uBrDetail in the surface shaders) that the shaders tile over a 0.3 m
// world repeat on top of the base layers (the layer recipes' SurfacePhys det / detS pick the layer).
// This file is the index: the recipes live in detailRecipes/{textile,mineral,walls,masonry,props}.ts (one file per
// texture realism v2 family, ids in detailRecipes/types.ts Det); D11 RIPPLE stays here. D12-D20 are reserved slots,
// neutral placeholders until their lanes fill them.
//
// Why: within ~3 m every base layer is magnified past its texels (1.2-4.7 mm per texel at 1024), so carpet reads as
// felt and concrete as flat grey. A 512^2 detail texel is 0.59 mm. The pack keeps the first and second moments of
// the slope (LEAN): up close the detail is resolved relief, far away the same data becomes micro-roughness (no
// sparkle, no fade band), and the albedo multiplier is divided by the layer mean in the shader, so the detail never
// shifts a surface's mean colour.
//
// Recipes use the layer recipe environment (textures/glsl/common.ts) with FRAME = DETAIL_REPEAT x DETAIL_REPEAT,
// TABLE_ALBEDO = 1: `s.albedo.r` is the albedo multiplier (1 = neutral), `s.height` the relief (x heightScale metres),
// `s.ao` an extra occlusion folded into the multiplier. Everything is periodic with integer periods (PM()), and
// statistically homogeneous: no feature larger than ~5 mm may stand out, or the 0.3 m repeat would show.
// Pure strings (no three): chunks/params.ts imports the slope / roughness tables for its GLSL constants.

import { MASONRY_DETAILS } from './detailRecipes/masonry.ts';
import { MINERAL_DETAILS } from './detailRecipes/mineral.ts';
import { PROP_DETAILS } from './detailRecipes/props.ts';
import { TEXTILE_DETAILS } from './detailRecipes/textile.ts';
import { Det, type DetailRecipe, type DetailTable, type DetId } from './detailRecipes/types.ts';
import { WALL_DETAILS } from './detailRecipes/walls.ts';

export { Det, type DetailRecipe, type DetId };

/** Texels per side of every detail layer. */
export const DETAIL_SIZE = 512;
/** Metres per detail repeat: divides NOISE_WRAP (4096 x), STOREY_PITCH (10 x) and TILE_SIZE (64 x). */
export const DETAIL_REPEAT = 0.3;

/** D11 ripple (standing water; sampled at twice the repeat and drifting): smooth gradient noise with 3-7 cm
 * wavelengths (finer ripples alias into reflection noise at a few metres), slope only, albedo exactly neutral (no
 * cavity). The shader uses the normalised slope (rg) directly, scaled by TUNE.RIPPLE. */
const RIPPLE = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  s.height = 0.5 + 0.35 * fbm(uv, PM(30.0), 2, 3);
}
`;

const INDEX_DETAILS: DetailTable = {
  [Det.RIPPLE]: { name: 'RIPPLE', glsl: RIPPLE, heightScale: 0.05, slope: 1.0, roughK: 0, cavity: 0 },
};

function build(): DetailRecipe[] {
  const tables: readonly DetailTable[] = [
    TEXTILE_DETAILS, MINERAL_DETAILS, WALL_DETAILS, MASONRY_DETAILS, PROP_DETAILS, INDEX_DETAILS,
  ];
  const ids = Object.values(Det);
  return ids.map((id, i) => {
    if (id !== i) throw new Error(`textures/detail: detail ids must be 0..${ids.length - 1} in order`);
    const found = tables.map((t) => t[id]).filter((r): r is DetailRecipe => r !== undefined);
    if (found.length !== 1) throw new Error(`textures/detail: D${id} defined ${found.length} times`);
    return found[0];
  });
}

/** Index = detail layer id (SurfacePhys.det; DETAIL_RIPPLE for puddles). */
export const DETAIL_RECIPES: readonly DetailRecipe[] = build();

/** Number of detail layers (array depth). */
export const DETAIL_COUNT = DETAIL_RECIPES.length;
/** The puddle micro-ripple layer. */
export const DETAIL_RIPPLE = Det.RIPPLE;

/** One texel's pack (twin of glsl/common.ts DETAIL_MAIN): [r, g, a] of the slope (sx, sy) in metres per metre. */
export function detailPackSlope(sx: number, sy: number, slope: number): [number, number, number] {
  const ex = Math.min(1, Math.max(-1, sx / slope));
  const ey = Math.min(1, Math.max(-1, sy / slope));
  return [ex * 0.5 + 0.5, ey * 0.5 + 0.5, 0.5 * (ex * ex + ey * ey)];
}

/** The unresolved slope variance E[|s|^2] - |E[s]|^2 of a packed (possibly box-filtered) texel: the LEAN term the
 * surface shader adds to alpha^2 (twin of the chunks/surface.ts detail block, before the strength^2 factor). */
export function detailVariance(r: number, g: number, a: number, slope: number): number {
  const sx = (r * 2 - 1) * slope;
  const sy = (g * 2 - 1) * slope;
  return Math.max(a * 2 * slope * slope - sx * sx - sy * sy, 0);
}
