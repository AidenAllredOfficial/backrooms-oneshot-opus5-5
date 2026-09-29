// src/textures/registry.ts — one GLSL recipe per material layer (index = MatId, length MAT_COUNT) (WP8).
//
// Recipes live in the family files layers/*.ts (surfaces), signage.ts (SIGNAGE) and decals.ts (DECAL_ATLAS), each
// row with its albedo calibration trim, its SurfacePhys (chunks/params.ts builds the layer tables and the BR_L_* GLSL
// arrays from them) and its channel conventions (aux kind, aux2, generator frame; layers/types.ts). Each GLSL snippet
// defines `void gen(vec2 uv, inout Surf s)`; the environment (Surf, noise, helpers, FRAME, TABLE_*) is described in
// glsl/common.ts. `heightScale` = metres of relief per unit of Surf.height; `normalStrength` multiplies the physical
// height gradient in the normal pass.

import { MAT_COUNT, type MatId } from '../core/ids.ts';
import { LAYER_DEFS, layerRepeatY } from '../core/materials.ts';
import { CEILING_RECIPES } from './layers/ceiling.ts';
import { CONCRETE_RECIPES } from './layers/concrete.ts';
import { TEXTILE_RECIPES } from './layers/carpet.ts';
import { MASONRY_RECIPES } from './layers/masonry.ts';
import { METAL_RECIPES } from './layers/metal.ts';
import { MISC_RECIPES } from './layers/misc.ts';
import { TILE_RECIPES } from './layers/tile.ts';
import type { AuxKind, RecipeBody, RecipeTable, SurfacePhys } from './layers/types.ts';
import { WALL_RECIPES } from './layers/wallpaper.ts';
import { DECAL_RECIPES } from './decals.ts';
import { SIGNAGE_RECIPES } from './signage.ts';

export interface LayerRecipe { layer: MatId; glsl: string; normalStrength: number; heightScale: number } // glsl defines `void gen(vec2 uv, inout Surf s)`

/** Internal view of a recipe: the albedo calibration trim, the surface physics and the channel conventions, with
 * every optional RecipeBody field resolved to its default. */
export interface LayerRecipeFull extends LayerRecipe {
  trim: readonly [number, number, number];
  phys: SurfacePhys;
  aux: AuxKind;
  aux2: boolean;
  /** generator frame (metres): RecipeBody.frame or [repeat, repeatY] */
  frame: readonly [number, number];
}

const TABLES: readonly RecipeTable[] = [
  WALL_RECIPES, TEXTILE_RECIPES, CEILING_RECIPES, CONCRETE_RECIPES, MASONRY_RECIPES, TILE_RECIPES, METAL_RECIPES,
  MISC_RECIPES, SIGNAGE_RECIPES, DECAL_RECIPES,
];

/** A family file's recipe row with every optional field resolved to its default (trim 1, aux 'none', no aux2, the
 * generator frame repeat x repeatY). */
export function resolveRecipe(id: MatId, body: RecipeBody): LayerRecipeFull {
  const d = LAYER_DEFS[id];
  return {
    layer: id,
    glsl: body.glsl,
    normalStrength: body.normalStrength,
    heightScale: body.heightScale,
    trim: body.trim ?? [1, 1, 1],
    phys: body.phys,
    aux: body.aux ?? 'none',
    aux2: body.aux2 ?? false,
    frame: body.frame ?? [d.repeat, layerRepeatY(d)],
  };
}

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
    out.push(resolveRecipe(id as MatId, body));
  }
  return out;
}

const FULL: readonly LayerRecipeFull[] = build();
export const LAYER_RECIPES: readonly LayerRecipe[] = FULL;
export const LAYER_RECIPES_FULL: readonly LayerRecipeFull[] = FULL;
