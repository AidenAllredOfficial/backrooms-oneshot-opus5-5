// src/textures/registry.ts — one GLSL recipe per material layer (index = MatId, length MAT_COUNT) (WP8).
//
// Recipes live in layers/*.ts (surfaces), signage.ts (SIGNAGE) and decals.ts (DECAL_ATLAS). Each GLSL snippet
// defines `void gen(vec2 uv, inout Surf s)`; the environment (Surf, noise, helpers, FRAME, TABLE_*) is described
// in glsl/common.ts. `heightScale` = metres of relief per unit of Surf.height; `normalStrength` multiplies the
// physical height gradient in the normal pass.

import { MAT_COUNT, type MatId } from '../core/ids.ts';
import { LAYER_DEFS } from '../core/materials.ts';
import { CEILING_RECIPES } from './layers/ceiling.ts';
import { CONCRETE_RECIPES } from './layers/concrete.ts';
import { TEXTILE_RECIPES } from './layers/carpet.ts';
import { METAL_RECIPES } from './layers/metal.ts';
import { MISC_RECIPES } from './layers/misc.ts';
import { TILE_RECIPES } from './layers/tile.ts';
import type { RecipeBody, RecipeTable } from './layers/types.ts';
import { WALL_RECIPES } from './layers/wallpaper.ts';
import { DECAL_RECIPES } from './decals.ts';
import { SIGNAGE_RECIPES } from './signage.ts';

export interface LayerRecipe { layer: MatId; glsl: string; normalStrength: number; heightScale: number } // glsl defines `void gen(vec2 uv, inout Surf s)`

/** Internal view of a recipe (adds the albedo calibration trim). */
export interface LayerRecipeFull extends LayerRecipe { trim: readonly [number, number, number] }

const TABLES: readonly RecipeTable[] = [
  WALL_RECIPES, TEXTILE_RECIPES, CEILING_RECIPES, CONCRETE_RECIPES, TILE_RECIPES, METAL_RECIPES, MISC_RECIPES,
  SIGNAGE_RECIPES, DECAL_RECIPES,
];

/** Albedo calibration (linear multipliers) measured with layerAlbedoCheck at 1024 so every layer's mean matches
 * LAYER_DEFS.albedoMean; 1 where the recipe already hits the table. */
const TRIM: Partial<Record<MatId, readonly [number, number, number]>> = {
  0: [1.016, 1.027, 1.052], 1: [1.073, 1.088, 1.122], 2: [1.012, 1.012, 1.006], 3: [0.978, 0.978, 0.983],
  4: [1.007, 1.01, 1.005], 5: [1.012, 1.015, 1.02], 6: [1.462, 1.363, 1.204], 7: [1.007, 1.005, 1.005],
  8: [0.994, 1.004, 1.02], 9: [1.023, 1.02, 1.016], 10: [1.005, 1.014, 1.028], 11: [1.017, 1.017, 1.017],
  12: [1.021, 1.021, 1.02], 13: [1.013, 1.012, 1.013], 14: [0.946, 1.025, 1.041], 15: [1.012, 1.017, 1.016],
  16: [1.116, 1.099, 0.991], 17: [1.259, 1.246, 1.261], 18: [0.997, 1.039, 1.103], 19: [0.999, 0.997, 0.998],
  20: [1.106, 1.105, 1.097], 21: [0.827, 0.838, 0.864], 22: [0.811, 0.82, 0.828],
  // 23 SIGNAGE: no trim (a multiplier would tint the white/yellow artwork). The atlas palette itself (colour-coded
  // P1/P2 stencils, aged whites, amber B1/B2 and caution plates, blue stair plate) is chosen to hit the table; slot
  // margins are the dilated slot edges (no hidden calibration colour).
  24: [0.936, 0.965, 0.921], 25: [1.052, 1.052, 1.052], 26: [1.043, 1.064, 1.088], 27: [1.018, 1.022, 1.024],
};

function build(): LayerRecipeFull[] {
  const out: LayerRecipeFull[] = [];
  for (let id = 0; id < MAT_COUNT; id++) {
    let body: RecipeBody | undefined;
    for (const t of TABLES) {
      const b = t[id as MatId];
      if (b) {
        if (body) throw new Error(`textures/registry: layer ${id} (${LAYER_DEFS[id].name}) defined twice`);
        body = b;
      }
    }
    if (!body) throw new Error(`textures/registry: no recipe for layer ${id} (${LAYER_DEFS[id].name})`);
    out.push({
      layer: id as MatId,
      glsl: body.glsl,
      normalStrength: body.normalStrength,
      heightScale: body.heightScale,
      trim: TRIM[id as MatId] ?? body.trim ?? [1, 1, 1],
    });
  }
  return out;
}

const FULL: readonly LayerRecipeFull[] = build();
export const LAYER_RECIPES: readonly LayerRecipe[] = FULL;
export const LAYER_RECIPES_FULL: readonly LayerRecipeFull[] = FULL;
