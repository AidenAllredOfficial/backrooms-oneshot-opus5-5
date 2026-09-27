# Contract change proposals — WP8

## 2026-09-24 — SIGNAGE albedoMean re-declared to the measured atlas mean — WITHDRAWN
- **Status:** WITHDRAWN by WP8 (2026-09-24). No change to `src/core/materials.ts` is needed: please do NOT apply it.
- **Why withdrawn:** the SIGNAGE atlas palette was reworked inside WP8 (colour-coded P1 red / P2 blue level
  stencils, aged off-white plates, amber B1/B2 stencils, and the invisible slot-margin colour as the final
  calibration knob). `layerAlbedoCheck` now measures SIGNAGE at (0.487, 0.306, 0.247) at 1024 and
  (0.486, 0.304, 0.246) at 512 against the table value (0.5, 0.3, 0.25), so all 28 layers pass at both sizes.
  Applying the old proposal now would make SIGNAGE fail again.

## 2026-09-25 — note (no contract change): SIGNAGE calibration without a hidden margin colour
- The slot margins of the SIGNAGE atlas are now the clamp-to-edge dilation of each slot's own artwork (no shared
  calibration colour under alpha 0, so far mips no longer bleed a foreign colour into signs). The table value is met
  through the palette alone (STAIRS plate blue, caution plate amber): measured (0.491, 0.319, 0.252) at 1024 and
  (0.490, 0.318, 0.251) at 512 against (0.5, 0.3, 0.25). Still no change to `src/core/materials.ts` needed.

## 2026-09-25 — B3 surfaces: four albedoMean values changed in `src/core/materials.ts` (numeric only) — APPLIED
- **Status:** APPLIED by B3 (surfaces batch). Numeric edits of `albedoMean` only (no ids, no new layers, no other fields).
- **Changes (linear):**
  | layer | old | new | why |
  |---|---|---|---|
  | `CARPET_L0` | [0.33, 0.25, 0.10] | [0.22, 0.17, 0.08] | darker brown-mustard pile (materials critic) with a slightly less saturated bounce, so L0 ceilings are less ochre (lighting critic); the recipe's yarn / tuft contrast was lowered at the same time (no "sandpaper"). The fixer first set [0.27, 0.21, 0.10]. The B3 verifier lowered it further: the baked floor irradiance is about 1.33x the wall irradiance, so at 0.27 the lit carpet rendered at the same value as the wallpaper. The recipe derives its colour from TABLE_ALBEDO (purely multiplicative), so the TRIM entry is unchanged |
  | `CEILING_TILE` | [0.60, 0.56, 0.44] | [0.70, 0.67, 0.56] | off-white mineral-fibre tiles (both critics); per-tile ageing now comes from the mesher tint (aged / NEW / DIRTY) and WP9 stains |
  | `TRIM_PAINT` | [0.45, 0.40, 0.30] | [0.72, 0.70, 0.64] | the T-bar grid and troffer frames are white enamel and must read lighter than the tiles; baseboards, casings and thresholds keep their aged cream through a mesher tint (mesh/trims.ts `TRIM_AGED` = old / new) |
  | `POOL_TILE` | [0.72, 0.76, 0.76] | [0.78, 0.79, 0.78] | white glazed tile without the cyan cast (lighting critic); grout re-coloured light grey in the recipe |
- **Calibration:** `layerAlbedoCheck` (harness/materials.html, 1024) after the recipe edits measured every layer within
  3 % of the table; `TRIM` in `src/textures/registry.ts` was then re-derived (new = old x declared / measured) for
  WALLPAPER_L0, CARPET_L0, CEILING_TILE, TRIM_PAINT, WALLPAPER_MANILA, POOL_TILE and FABRIC_PARTITION.
- **Other consumers:** props that use TRIM_PAINT with their own tint (props/misc.ts door frame v0, door leaf v1,
  fallen T-bar debris) become ~1.6x lighter; that reads as painted wood / enamel and was left as is (B3 does not own
  props/). The baker's bounce colour for trims follows the new mean automatically.

## 2026-09-26 — graphics-realism package B: three mean roughness values in `src/core/materials.ts` (numeric only) — APPLIED
- **Status:** APPLIED by package B (materials recipe pass). Numeric edits of `roughness` only; no `albedoMean`, ids or
  other fields changed.
- **Changes:**
  | layer | old | new | why |
  |---|---|---|---|
  | `WALLPAPER_L0` | 0.8 | 0.7 | satin vinyl-coated paper (recipe roughness 0.63-0.72 instead of 0.78-0.85) |
  | `WALLPAPER_MANILA` | 0.8 | 0.72 | same, for the paper-backed vinyl |
  | `TERRAZZO` | 0.25 | 0.16 | polished terrazzo is ~0.12-0.18; the recipe base went from 0.22 to 0.13 (its two-lobe glaze value is 0.13) |
- **Other consumers:** `LAYER_DEFS.roughness` only seeds `TABLE_ROUGH` for recipes that do not set `s.rough` (all three
  do) and the dev harness fake textures. The bake does not read it.
- **Calibration:** the albedo means are unaffected; `layerAlbedoCheck` passes for all 28 layers at 1024, and `TRIM` was
  re-derived for the recipes whose colour changed (CONCRETE_FLOOR, CMU_PAINTED, POOL_TILE). The new
  `layerAlbedoRangeCheck` (2nd / 98th percentile of the 32x32 cell luminance within [0.02, 0.9]) passes for every
  opaque layer.
