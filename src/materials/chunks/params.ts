// src/materials/chunks/params.ts — WP9 tuning constants and the per-layer parameter table (uLayerA/uLayerB).
// Pure data (no three). Every number that shapes the look of the surface shaders lives here or in the other
// chunks/*.ts files, so tuning never touches the material factory.

import { EMISSION, HDR_CLAMP, LV, NOISE_WRAP, PHOTOMETRY, STOREY_PITCH, TILE_SIZE } from '../../core/constants.ts';
import { Mat, MAT_COUNT, VFlag } from '../../core/ids.ts';
import type { MatId } from '../../core/ids.ts';
import { DYN_SLOT_OFFSETS } from '../../core/mesh.ts';
import { LAYER_DEFS, layerRepeatY } from '../../core/materials.ts';
import type { GrimeProfile } from '../../core/materials.ts';

/** GLSL float literal (always has a decimal point). */
export const f = (v: number): string => {
  const s = String(v);
  return /[.eE]/.test(s) ? s : s + '.0';
};

/** Grime profile ids used by the `switch` in chunks/surface.ts. */
export const GRIME_ID: Readonly<Record<GrimeProfile, number>> = {
  none: 0, carpet: 1, wallpaper: 2, ceilingTile: 3, concrete: 4, tile: 5, metal: 6,
};

/** Per-layer normal-map strength multiplier (WP8 already bakes `normalStrength`; this is a shading trim). */
const NORMAL_STRENGTH: Partial<Record<MatId, number>> = {
  [Mat.CARPET_L0]: 1.15, [Mat.CARPET_OFFICE]: 1.1, [Mat.WALLPAPER_L0]: 1.1, [Mat.WALLPAPER_MANILA]: 1.1,
  [Mat.PANEL_LENS]: 0.6, [Mat.SIGNAGE]: 0.5, [Mat.DECAL_ATLAS]: 0.8,
};
/** Macro variation amount (1 = full ±6 % value / ±2 % hue). Lenses, signs and decals stay exact. */
const MACRO_AMOUNT: Partial<Record<MatId, number>> = {
  // aged room finishes: ±~10 % value / ±~3 % hue (B3: the reference photo's walls, carpet and tiles are blotchy)
  [Mat.WALLPAPER_L0]: 1.65, [Mat.WALLPAPER_MANILA]: 1.65, [Mat.CARPET_L0]: 1.65, [Mat.CARPET_OFFICE]: 1.65,
  [Mat.CEILING_TILE]: 1.65, [Mat.DRYWALL]: 1.65,
  [Mat.PANEL_LENS]: 0, [Mat.SIGNAGE]: 0, [Mat.DECAL_ATLAS]: 0, [Mat.FLOOR_PAINT]: 0.5, [Mat.PLASTIC]: 0.4,
  [Mat.RUBBER]: 0.3, [Mat.PLENUM]: 0.5, [Mat.POOL_TILE]: 0.6, [Mat.POOL_MOSAIC]: 0.6,
};

export interface LayerTable { a: Float32Array; b: Float32Array }
/**
 * uLayerA[i] = (rotation cells per uv unit in u, in v (0 = off), hex cell metres (0 = off), grime profile id)
 * uLayerB[i] = (repeat m, repeatY m, normal strength, macro amount)
 */
export function buildLayerTable(): LayerTable {
  const a = new Float32Array(MAT_COUNT * 4);
  const b = new Float32Array(MAT_COUNT * 4);
  for (let i = 0; i < MAT_COUNT; i++) {
    const d = LAYER_DEFS[i];
    const ry = layerRepeatY(d);
    a[i * 4] = d.tileSize > 0 ? Math.round(d.repeat / d.tileSize) : 0;
    a[i * 4 + 1] = d.tileSize > 0 ? Math.round(ry / d.tileSize) : 0;
    a[i * 4 + 2] = d.hexTile ?? 0;
    a[i * 4 + 3] = GRIME_ID[d.grime];
    b[i * 4] = d.repeat;
    b[i * 4 + 1] = ry;
    b[i * 4 + 2] = NORMAL_STRENGTH[d.id] ?? 1;
    b[i * 4 + 3] = MACRO_AMOUNT[d.id] ?? 1;
  }
  return { a, b };
}

/** Slot lookup (dx+1) + 3*(dz+1) -> DYN_SLOT_OFFSETS index, generated from the contract table. */
export function slotLut(): number[] {
  const lut = new Array<number>(9).fill(0);
  DYN_SLOT_OFFSETS.forEach(([dx, dz], i) => { lut[(dx + 1) + 3 * (dz + 1)] = i; });
  return lut;
}

/** Sheared hex-lattice dimensions (mirrored exactly by the GLSL in chunks/surface.ts). */
export interface HexLattice { cellX: number; row: number; px: number; pz: number }
/**
 * Stochastic-tiling lattice for a layer with hex cell `hexM` metres. Vertices sit at (i·cellX + j·cellX/2, j·row).
 * Horizontal faces: cellX = hexM, row = HEX_ROW·hexM, periodic over NOISE_WRAP on both axes (px, pz lattice steps).
 * Vertical faces (along, storey-relative y): the row count per STOREY_PITCH is even (a y shift of one pitch is then a
 * lattice translation of the sheared lattice), and cellX is the nearest divisor of NOISE_WRAP to row/HEX_ROW.
 */
export function hexLattice(hexM: number, vertical: boolean): HexLattice {
  if (!vertical) {
    const row = hexM * TUNE.HEX_ROW;
    return { cellX: hexM, row, px: Math.floor(NOISE_WRAP / hexM + 0.5), pz: Math.floor(NOISE_WRAP / row + 0.5) };
  }
  const pz = Math.max(2, 2 * Math.floor(STOREY_PITCH / (2 * hexM * TUNE.HEX_ROW) + 0.5));
  const row = STOREY_PITCH / pz;
  const px = Math.floor((NOISE_WRAP * TUNE.HEX_ROW) / row + 0.5);
  return { cellX: NOISE_WRAP / px, row, px, pz };
}

/** Tuning constants (all in SI / photometric units unless noted). */
export const TUNE = {
  // --- anti-tiling
  HEX_FEATHER: 0.15, // m, feathered edge of the stochastic (hex) blend
  HEX_ROW: 0.8, // row spacing / hexTile of the sheared lattice (equilateral: 0.866; 0.8 keeps NOISE_WRAP/(0.8·hexTile) even)
  // --- Toksvig
  TOKSVIG_DEADZONE: 0.006, // (1-|n|)/|n| below this is 8-bit normal quantisation, not real variance
  TOKSVIG_MAX_VAR: 0.35,
  // --- macro variation (world noise cells must divide NOISE_WRAP; vertical cells must divide STOREY_PITCH)
  MACRO_VALUE: 0.06,
  MACRO_HUE: 0.02,
  MACRO_CELL: 4.8, // m horizontal (256 per NOISE_WRAP)
  MACRO_CELL_Y: 1.5, // m vertical (2 per storey pitch)
  MACRO_MIP: 6.0,
  MACRO_TEX_SCALE: 9.6, // m per coarse-mip lookup repeat (horizontal)
  // --- grime texture world mapping
  GRIME_SCALE_A: 3.072, // m (400 per NOISE_WRAP)
  GRIME_SCALE_B: 1.92, // m (640 per NOISE_WRAP)
  GRIME_SCALE_Y_A: 3.0, // m (divides STOREY_PITCH)
  GRIME_SCALE_Y_B: 1.5,
  // --- carpet
  CARPET_WET_DARKEN: 0.65,
  CARPET_WET_ROUGH: 0.95, // damp pile: darker and saturated, still matte (a sheen reads as a grey cut-out)
  CARPET_SOAK_ROUGH: 0.5, // standing water in the pile (mask B > 0.9): a soft sheen
  CARPET_PILE_SHADE: 0.07, // view-dependent pile lean shading (albedo x (1 ± this))
  CARPET_PILE_CELL: 1.2, // m, world lattice of the pile lean direction (1024 per NOISE_WRAP)
  CARPET_BROADLOOM: 3.84, // m, broadloom width between seams (320 per NOISE_WRAP)
  CARPET_WEAR_LIGHTEN: 0.08,
  CARPET_WEAR_NORMAL: 0.55,
  // --- wallpaper
  WALL_STAIN_COLOR: [0.72, 0.58, 0.36] as const,
  WALL_TIDE_COLOR: [0.42, 0.3, 0.16] as const,
  WALL_BACKING: [0.6, 0.56, 0.46] as const,
  WALL_ROLL: 0.6, // m, wallpaper roll width (2048 per NOISE_WRAP): per-roll shade / pattern offset
  WALL_DIRT_COLOR: [0.66, 0.6, 0.48] as const, // mask G (dirt, dust, hand smudges) on wall coverings
  CEIL_STAIN_P: 0.04, // fraction of 0.6 m ceiling tiles with old procedural ring stains
  CONCRETE_JOINT: 4.8, // m, saw-cut control joint grid on concrete floors (256 per NOISE_WRAP)
  // --- tile / concrete / metal
  TILE_WET_ROUGH: 0.5,
  CONCRETE_WET_ROUGH: 0.3,
  CONCRETE_WET_DARKEN: 0.72,
  // R2 integration: browner, less saturated oxide (was [0.2, 0.085, 0.03]: scattered on pale painted lockers and
  // doors the orange-red blotches read as blood spatter under the camcorder grade)
  RUST_COLOR: [0.15, 0.085, 0.045] as const,
  // --- wet albedo (generic porous darkening)
  WET_DARKEN: 0.8,
  // --- world features (hashed per world cell)
  FEATURE_CELL: 2.4, // m (512 per NOISE_WRAP)
  FEATURE_CELL_Y: 1.5, // m (2 per storey pitch)
  // --- lighting
  DIRECT_MIN_ROUGH: 0.25, // baked dominant-direction specular never sharper than this (it is an area estimate)
  NG_MIN: 0.2,
  // --- emission-map reflections
  EM_LOD_PER_ROUGH: 5.0,
  EM_ROUGH_CUT: 0.5, // emission-map reflections at full weight below this roughness (spec gate)
  EM_ROUGH_END: 0.6, // ...fading to zero here (soft tail: no per-pixel on/off speckle; damp carpet at 0.55 keeps a sheen)
  // Emission-map reflections fade by the HORIZONTAL offset between the reflecting fragment and the hit point, over
  // the last EM_FADE_BAND metres of the reach = min(EMISSION.FADE + distance(fragment, nearest tile line), EM_MAX_REACH).
  // EMISSION.FADE = EMISSION.MARGIN, so every accepted hit lies inside the 88^2 map, and the reach is continuous
  // across tile lines (no seams) while tile interiors see long wet-floor streaks.
  EM_FADE_START_FRAC: 0.5, // fade band = FADE * (1 - this)
  EM_MAX_REACH: 12, // m
  EM_LOBE: 4.0, // glossy lobe radius per alpha (alpha = roughness^2) for the streak footprint (GGX tails are long)
  EM_MAX_STREAK: 5.0, // m, longest streak footprint along the reflection direction
  UNDERWATER_REFL: 0.1, // emission-map reflections on submerged surfaces (tile/water F0 ~0.004 vs tile/air 0.04)
  REFL_LOD_PER_ROUGH: 6.0,
  PLANE_EPS: 0.02, // m, planar reflection plane match
  REFL_DISTORT: 0.02,
  // --- submerged surfaces
  WATER_SIGMA: [0.45, 0.09, 0.06] as const, // 1/m absorption
  WATER_INSCATTER: 0.02,
  WATER_INSCATTER_TINT: [0.3, 0.75, 0.8] as const,
  CAUSTIC_STRENGTH: 1.1,
  CAUSTIC_FLOOD: 0.12, // strength multiplier for flooded rooms (WaterRect kind 1; film kind 2: none)
  CAUSTIC_FLOOD_SCALE: 2, // flooded rooms: caustic cells x this (shallow water focuses far below its surface)
  CAUSTIC_FLOOD_SPEED: 0.4,
  CAUSTIC_SRC_TAN: 0.35, // tan of the light sources' angular half size (troffers): softens deep caustics
  CAUSTIC_DEPTH_K: 0.35, // 1/m
  // --- water surface
  WATER_F0: 0.02,
  WATER_ROUGH: 0.06,
  WATER_NORMAL_A: 2.4, // m per repeat (512 per NOISE_WRAP)
  WATER_NORMAL_B: 1.2,
  WATER_NORMAL_STRENGTH: 0.16,
  WATER_ENV_ALBEDO: 0.45, // room-average reflectance used for the uniform-environment reflection
  WATER_ENV_TINT: [0.85, 0.97, 1.0] as const,
  WATER_EMIT_PLANE_H: 3.4, // m above the water: emitter plane assumed for emission-map reflections on water
  // --- airlight (flashlight beam in haze)
  AIRLIGHT_STEPS: 6,
  AIRLIGHT_MIN_H: 0.3, // m, perpendicular-distance floor (keeps the lens glare finite)
  AIRLIGHT_GAIN: 1.0,
  // --- props in the planar reflection pass
  REFL_PROP_DIST: 20,
  // --- debug views: value v is emitted as v * DEBUG_NITS so it reads as v at the L0 reference exposure
  DEBUG_NITS: 1.2 * Math.pow(2, PHOTOMETRY.EV100_L0),
  DEBUG_LUX: 600, // lux shown as 1.0 in view=lightmap / flicker / lv
} as const;

/** Derived GLSL #defines shared by every WP9 shader. */
export function glslConstants(): string {
  const lut = slotLut();
  const wrapCells = (cell: number): number => Math.round(NOISE_WRAP / cell);
  const yCells = (cell: number): number => Math.round(STOREY_PITCH / cell);
  const v3 = (c: readonly number[]): string => `vec3(${c.map(f).join(', ')})`;
  return `
#define BR_PI 3.141592653589793
#define BR_HDR_CLAMP ${f(HDR_CLAMP)}
#define BR_TILE ${f(TILE_SIZE)}
#define BR_HALF_TILE ${f(TILE_SIZE / 2)}
#define BR_NOISE_WRAP ${f(NOISE_WRAP)}
#define BR_PITCH ${f(STOREY_PITCH)}
#define BR_EM_RES ${f(EMISSION.RES)}
#define BR_EM_TEXEL ${f(EMISSION.TEXEL)}
#define BR_EM_MARGIN ${f(EMISSION.MARGIN)}
#define BR_EM_FADE ${f(EMISSION.FADE)}
#define BR_EM_FADE_BAND ${f(EMISSION.FADE * (1 - TUNE.EM_FADE_START_FRAC))}
#define BR_EM_MAX_REACH ${f(TUNE.EM_MAX_REACH)}
#define BR_EM_LOBE ${f(TUNE.EM_LOBE)}
#define BR_EM_MAX_STREAK ${f(TUNE.EM_MAX_STREAK)}
#define BR_UNDERWATER_REFL ${f(TUNE.UNDERWATER_REFL)}
#define BR_LV_NX ${f(LV.NX)}
#define BR_LV_NY ${f(LV.NY)}
#define BR_LV_STEP ${f(LV.STEP)}
#define BR_F_DYN_EMIT ${VFlag.DYN_EMIT}
#define BR_F_SHIMMER ${VFlag.SHIMMER}
#define BR_F_NO_GRIME ${VFlag.NO_GRIME}
#define BR_F_UNDERWATER ${VFlag.UNDERWATER}
#define BR_F_REFLECTIVE ${VFlag.REFLECTIVE}
#define BR_F_DECAL ${VFlag.DECAL}
#define BR_F_FLOOR_AUX ${VFlag.FLOOR_AUX}
#define BR_F_PROP_AUX ${VFlag.PROP_AUX}
#define BR_M_PANEL_LENS ${Mat.PANEL_LENS}
#define BR_M_SIGNAGE ${Mat.SIGNAGE}
#define BR_M_DECAL_ATLAS ${Mat.DECAL_ATLAS}
#define BR_M_FLOOR_PAINT ${Mat.FLOOR_PAINT}
#define BR_M_WALLPAPER_L0 ${Mat.WALLPAPER_L0}
#define BR_M_WALLPAPER_MANILA ${Mat.WALLPAPER_MANILA}
#define BR_M_CARPET_L0 ${Mat.CARPET_L0}
#define BR_M_CONCRETE_FLOOR ${Mat.CONCRETE_FLOOR}
#define BR_M_CONCRETE_WALL ${Mat.CONCRETE_WALL}
#define BR_M_POOL_TILE ${Mat.POOL_TILE}
#define BR_MAT_COUNT ${MAT_COUNT}
#define BR_HEX_FEATHER ${f(TUNE.HEX_FEATHER)}
#define BR_HEX_ROW ${f(TUNE.HEX_ROW)}
#define BR_TOKSVIG_DEADZONE ${f(TUNE.TOKSVIG_DEADZONE)}
#define BR_TOKSVIG_MAX_VAR ${f(TUNE.TOKSVIG_MAX_VAR)}
#define BR_MACRO_VALUE ${f(TUNE.MACRO_VALUE)}
#define BR_MACRO_HUE ${f(TUNE.MACRO_HUE)}
#define BR_MACRO_CELL ${f(TUNE.MACRO_CELL)}
#define BR_MACRO_CELL_Y ${f(TUNE.MACRO_CELL_Y)}
#define BR_MACRO_P ${wrapCells(TUNE.MACRO_CELL)}
#define BR_MACRO_PY ${yCells(TUNE.MACRO_CELL_Y)}
#define BR_MACRO_MIP ${f(TUNE.MACRO_MIP)}
#define BR_MACRO_TEX_SCALE ${f(TUNE.MACRO_TEX_SCALE)}
#define BR_GRIME_A ${f(TUNE.GRIME_SCALE_A)}
#define BR_GRIME_B ${f(TUNE.GRIME_SCALE_B)}
#define BR_GRIME_YA ${f(TUNE.GRIME_SCALE_Y_A)}
#define BR_GRIME_YB ${f(TUNE.GRIME_SCALE_Y_B)}
#define BR_FEATURE_CELL ${f(TUNE.FEATURE_CELL)}
#define BR_FEATURE_P ${wrapCells(TUNE.FEATURE_CELL)}
#define BR_FEATURE_CELL_Y ${f(TUNE.FEATURE_CELL_Y)}
#define BR_FEATURE_PY ${yCells(TUNE.FEATURE_CELL_Y)}
#define BR_CARPET_WET_DARKEN ${f(TUNE.CARPET_WET_DARKEN)}
#define BR_CARPET_WET_ROUGH ${f(TUNE.CARPET_WET_ROUGH)}
#define BR_CARPET_SOAK_ROUGH ${f(TUNE.CARPET_SOAK_ROUGH)}
#define BR_CARPET_PILE_SHADE ${f(TUNE.CARPET_PILE_SHADE)}
#define BR_CARPET_PILE_CELL ${f(TUNE.CARPET_PILE_CELL)}
#define BR_CARPET_PILE_P ${wrapCells(TUNE.CARPET_PILE_CELL)}
#define BR_CARPET_BROADLOOM ${f(TUNE.CARPET_BROADLOOM)}
#define BR_CARPET_BROADLOOM_P ${wrapCells(TUNE.CARPET_BROADLOOM)}
#define BR_WALL_ROLL ${f(TUNE.WALL_ROLL)}
#define BR_WALL_ROLL_P ${wrapCells(TUNE.WALL_ROLL)}
#define BR_WALL_DIRT ${v3(TUNE.WALL_DIRT_COLOR)}
#define BR_CEIL_STAIN_P ${f(TUNE.CEIL_STAIN_P)}
#define BR_CONCRETE_JOINT ${f(TUNE.CONCRETE_JOINT)}
#define BR_CONCRETE_JOINT_P ${wrapCells(TUNE.CONCRETE_JOINT)}
#define BR_CARPET_WEAR_LIGHTEN ${f(TUNE.CARPET_WEAR_LIGHTEN)}
#define BR_CARPET_WEAR_NORMAL ${f(TUNE.CARPET_WEAR_NORMAL)}
#define BR_WALL_STAIN ${v3(TUNE.WALL_STAIN_COLOR)}
#define BR_WALL_TIDE ${v3(TUNE.WALL_TIDE_COLOR)}
#define BR_WALL_BACKING ${v3(TUNE.WALL_BACKING)}
#define BR_TILE_WET_ROUGH ${f(TUNE.TILE_WET_ROUGH)}
#define BR_CONCRETE_WET_ROUGH ${f(TUNE.CONCRETE_WET_ROUGH)}
#define BR_CONCRETE_WET_DARKEN ${f(TUNE.CONCRETE_WET_DARKEN)}
#define BR_RUST ${v3(TUNE.RUST_COLOR)}
#define BR_WET_DARKEN ${f(TUNE.WET_DARKEN)}
#define BR_DIRECT_MIN_ROUGH ${f(TUNE.DIRECT_MIN_ROUGH)}
#define BR_NG_MIN ${f(TUNE.NG_MIN)}
#define BR_EM_LOD ${f(TUNE.EM_LOD_PER_ROUGH)}
#define BR_EM_ROUGH_CUT ${f(TUNE.EM_ROUGH_CUT)}
#define BR_EM_ROUGH_END ${f(TUNE.EM_ROUGH_END)}
#define BR_REFL_LOD ${f(TUNE.REFL_LOD_PER_ROUGH)}
#define BR_PLANE_EPS ${f(TUNE.PLANE_EPS)}
#define BR_REFL_DISTORT ${f(TUNE.REFL_DISTORT)}
#define BR_WATER_SIGMA ${v3(TUNE.WATER_SIGMA)}
#define BR_WATER_INSCATTER ${f(TUNE.WATER_INSCATTER)}
#define BR_WATER_INSCATTER_TINT ${v3(TUNE.WATER_INSCATTER_TINT)}
#define BR_CAUSTIC_STRENGTH ${f(TUNE.CAUSTIC_STRENGTH)}
#define BR_CAUSTIC_DEPTH_K ${f(TUNE.CAUSTIC_DEPTH_K)}
#define BR_CAUSTIC_FLOOD ${f(TUNE.CAUSTIC_FLOOD)}
#define BR_CAUSTIC_FLOOD_SCALE ${f(TUNE.CAUSTIC_FLOOD_SCALE)}
#define BR_CAUSTIC_FLOOD_SPEED ${f(TUNE.CAUSTIC_FLOOD_SPEED)}
#define BR_CAUSTIC_SRC_TAN ${f(TUNE.CAUSTIC_SRC_TAN)}
#define BR_WATER_F0 ${f(TUNE.WATER_F0)}
#define BR_WATER_ROUGH ${f(TUNE.WATER_ROUGH)}
#define BR_WATER_NA ${f(TUNE.WATER_NORMAL_A)}
#define BR_WATER_NB ${f(TUNE.WATER_NORMAL_B)}
#define BR_WATER_NS ${f(TUNE.WATER_NORMAL_STRENGTH)}
#define BR_WATER_ENV_ALBEDO ${f(TUNE.WATER_ENV_ALBEDO)}
#define BR_WATER_ENV_TINT ${v3(TUNE.WATER_ENV_TINT)}
#define BR_WATER_EMIT_H ${f(TUNE.WATER_EMIT_PLANE_H)}
#define BR_AIR_STEPS ${TUNE.AIRLIGHT_STEPS}
#define BR_AIR_MIN_H ${f(TUNE.AIRLIGHT_MIN_H)}
#define BR_AIR_GAIN ${f(TUNE.AIRLIGHT_GAIN)}
#define BR_REFL_PROP_DIST ${f(TUNE.REFL_PROP_DIST)}
#define BR_DEBUG_NITS ${f(TUNE.DEBUG_NITS)}
#define BR_DEBUG_LUX ${f(TUNE.DEBUG_LUX)}
const int BR_SLOT_LUT[9] = int[9](${lut.join(', ')});
const float BR_LV_Y[${LV.NY}] = float[${LV.NY}](${LV.Y.map(f).join(', ')});
${waterMediaGlsl()}`;
}

// ---------------------------------------------------------------- package E: water media and caustics

/** Per-kind water media, indexed by WaterRect kind (0 pool, 1 flooded room, 2 film); SI units (1/m).
 * SA absorption, SS scattering, G the Henyey-Greenstein asymmetry, TINT the in-scatter colour, BLUR the
 * forward-scatter blur factor (the refraction pass). The legacy submerged-surface path (chunks/haze.ts) attenuates
 * along the refracted view path with the transport coefficient SA + (1 - G) SS: without the blur of the refraction
 * pass the forward-scattered light arrives along the view ray, so it is kept. */
export const WATER_MEDIA = {
  SA: [[0.35, 0.065, 0.03], [0.6, 0.9, 1.8], [0.6, 0.9, 1.8]],
  SS: [0.04, 1.6, 1.2],
  G: [0.9, 0.85, 0.85],
  TINT: [[0.55, 0.85, 0.95], [1.0, 0.85, 0.58], [1.0, 0.9, 0.7]],
  BLUR: [0, 0.06, 0.02],
  /** downwelling attenuation of the baked light reaching a submerged surface: exp(-DOWN * kappa * depth),
   * kappa = SA + (1 - G) SS; DOWN < 1.25 because part of the floor light comes from the pool's own wall lights */
  DOWN: 0.8,
} as const;

/** Caustic strengths (package E; the pattern is chunks/common.ts brCausticsW): submerged walls (x the floors'
 * CAUSTIC_STRENGTH), and the zero-mean modulation of ceilings / walls above pool water. */
export const WATER_CAUSTICS = {
  WALL: 0.6,
  CEIL: 0.45,
  ABOVE_WALL: 0.2,
  /** the above-water net magnifies with the height h above the water (cells x (1 + MAGNIFY h)) and fades as
   * 1 / (1 + FADE h) */
  MAGNIFY: 0.33,
  FADE: 0.15,
  /** ratio of the discrete magnification levels the above-water net steps through (chunks/water.ts
   * brCausticsAbove: a continuously varying scale would slide the world-anchored net into noise) */
  LEVEL: 1.3,
  /** flashlight caustic through the surface: 1 + GAIN * (pattern - mean) */
  SPOT_GAIN: 1.2,
} as const;

/** GLSL constants of WATER_MEDIA / WATER_CAUSTICS (const arrays indexed by kind). */
export function waterMediaGlsl(): string {
  const v3 = (c: readonly number[]): string => `vec3(${c.map(f).join(', ')})`;
  const M = WATER_MEDIA, C = WATER_CAUSTICS;
  return `const vec3 BR_WM_SA[3] = vec3[3](${M.SA.map(v3).join(', ')});
const float BR_WM_SS[3] = float[3](${M.SS.map(f).join(', ')});
const float BR_WM_G[3] = float[3](${M.G.map(f).join(', ')});
const vec3 BR_WM_TINT[3] = vec3[3](${M.TINT.map(v3).join(', ')});
const float BR_WM_BLUR[3] = float[3](${M.BLUR.map(f).join(', ')});
#define BR_WM_DOWN ${f(M.DOWN)}
#define BR_CAUSTIC_WALL ${f(C.WALL)}
#define BR_CAUSTIC_CEIL ${f(C.CEIL)}
#define BR_CAUSTIC_ABOVE_WALL ${f(C.ABOVE_WALL)}
#define BR_CAUSTIC_MAGNIFY ${f(C.MAGNIFY)}
#define BR_CAUSTIC_FADE ${f(C.FADE)}
#define BR_CAUSTIC_LEVEL ${f(C.LEVEL)}
#define BR_CAUSTIC_SPOT_GAIN ${f(C.SPOT_GAIN)}
`;
}
