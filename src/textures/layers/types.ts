// src/textures/layers/types.ts — recipe body shared by the layers/*.ts files (WP8).

import type { MatId } from '../../core/ids.ts';

export interface RecipeBody {
  /** GLSL defining `void gen(vec2 uv, inout Surf s)` (see glsl/common.ts for the environment). */
  glsl: string;
  /** Normal-map strength multiplier applied to the physical height gradient. */
  normalStrength: number;
  /** Metres of relief per unit of Surf.height. */
  heightScale: number;
  /** Albedo calibration multiplier (linear), measured with layerAlbedoCheck so the mean hits LAYER_DEFS. */
  trim?: readonly [number, number, number];
}

export type RecipeTable = Partial<Record<MatId, RecipeBody>>;
