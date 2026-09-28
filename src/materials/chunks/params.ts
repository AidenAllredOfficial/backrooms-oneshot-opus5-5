// src/materials/chunks/params.ts — WP9 tuning constants and the per-layer parameter tables (uLayerA..E; C/D/E from
// SURFACE_PHYS, package B) and the texture realism v2 per-layer GLSL const arrays (BR_L_*, BR_AUX_KIND).
// SURFACE_PHYS rows live with the recipes (textures/layers/*.ts RecipeBody.phys); this file only collects them.
// Pure data (no three). Every number that shapes the look of the surface shaders lives here or in the other
// chunks/*.ts files, so tuning never touches the material factory.

import { EMISSION, HDR_CLAMP, LV, NOISE_WRAP, PHOTOMETRY, STOREY_PITCH, TILE_SIZE } from '../../core/constants.ts';
import { Mat, MAT_COUNT, VFlag } from '../../core/ids.ts';
import type { MatId } from '../../core/ids.ts';
import { DYN_SLOT_OFFSETS } from '../../core/mesh.ts';
import { LAYER_DEFS, layerRepeatY } from '../../core/materials.ts';
import type { GrimeProfile } from '../../core/materials.ts';
import { DETAIL_RECIPES, DETAIL_REPEAT, DETAIL_RIPPLE, DETAIL_SIZE } from '../../textures/detail.ts';
import { AUX_KIND_ID, type SurfacePhys } from '../../textures/layers/types.ts';
import { LAYER_RECIPES_FULL } from '../../textures/registry.ts';

export type { SurfacePhys };

/** GLSL float literal (always has a decimal point). */
export const f = (v: number): string => {
  const s = String(v);
  return /[.eE]/.test(s) ? s : s + '.0';
};

/** Grime profile ids of the branches in chunks/surface.ts (each owned by a chunks/family/*.ts file: carpet textile,
 * wallpaper and paint walls, ceilingTile ceiling, concrete concrete, tile tile, metal props, masonry masonry). */
export const GRIME_ID: Readonly<Record<GrimeProfile, number>> = {
  none: 0, carpet: 1, wallpaper: 2, ceilingTile: 3, concrete: 4, tile: 5, metal: 6, paint: 7, masonry: 8,
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

/** Physical surface parameters per layer (layers/types.ts SurfacePhys; the rows live with the recipes). */
export const SURFACE_PHYS: Readonly<Record<MatId, SurfacePhys>> = Object.fromEntries(
  LAYER_RECIPES_FULL.map((r) => [r.layer, r.phys]),
) as Record<MatId, SurfacePhys>;

export interface LayerTable { a: Float32Array; b: Float32Array; c: Float32Array; d: Float32Array; e: Float32Array }
/**
 * uLayerA[i] = (rotation cells per uv unit in u, in v (0 = off), hex cell metres (0 = off), grime profile id)
 * uLayerB[i] = (repeat m, repeatY m, normal strength, macro amount)
 * uLayerC[i] = (texture heightScale m per height unit, pomTop, porosity, Toksvig weight)
 * uLayerD[i] = (detail layer (-1 = none), detail strength, sheen amount, sheen roughness)
 * uLayerE[i] = (glaze lobe roughness (0 = single lobe), rough-component roughness, 0, 0)
 */
export function buildLayerTable(): LayerTable {
  const a = new Float32Array(MAT_COUNT * 4);
  const b = new Float32Array(MAT_COUNT * 4);
  const c = new Float32Array(MAT_COUNT * 4);
  const d4 = new Float32Array(MAT_COUNT * 4);
  const e = new Float32Array(MAT_COUNT * 4);
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
    const p = SURFACE_PHYS[d.id];
    c.set([LAYER_RECIPES_FULL[i].heightScale, p.pomTop, p.por, p.tok], i * 4);
    d4.set([p.det, p.detS, p.sheen, p.sheenR], i * 4);
    e.set([p.glaze, p.roughComp, 0, 0], i * 4);
  }
  return { a, b, c, d: d4, e };
}

/**
 * Two-lobe unmixing of a bimodal layer (twin of FRAG_ROUGHNESS_GLSL): a mip-filtered roughness `r` is the coverage
 * mixture (1 - cov) gz + cov rx of the glaze lobe gz and the rough component rx, so cov is the rough component's
 * coverage (the specular weight is 1 - cov) and the lobe keeps the glaze roughness (texels glossier than gz keep their
 * own). `variance` = the layer-weighted Toksvig variance.
 */
export function glazeUnmix(r: number, gz: number, rx: number, variance = 0): { cov: number; lobe: number } {
  const cov = Math.min(1, Math.max(0, (r - gz) / Math.max(rx - gz, 1e-3)));
  const g = Math.min(r, gz);
  return { cov, lobe: Math.sqrt(g * g + TUNE.GLAZE_TOKSVIG * variance) };
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
  CARPET_PILE_SHADE: 0.035, // view-dependent pile lean shading (albedo x (1 ± this)); the sheen lobe does the rest
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
  // --- metal
  // R2 integration: browner, less saturated oxide (was [0.2, 0.085, 0.03]: scattered on pale painted lockers and
  // doors the orange-red blotches read as blood spatter under the camcorder grade)
  RUST_COLOR: [0.15, 0.085, 0.045] as const,
  // --- wetness (package B; Lagarde 2013): W = the mask's wet field; P = SURFACE_PHYS porosity
  WET_DARK: 0.45, // absorbed water darkens porous albedo by up to this (carpet x0.55, concrete x0.73, tile x0.96)
  WET_SAT: 0.35, // ...and raises its saturation by up to this
  WET_FILM_ROUGH: 0.07, // water film roughness on a sealed surface
  WET_FILM_ROUGH_POROUS: 0.25, // ...plus this x porosity (the film is thin and broken over open pores / pile)
  // ...plus this on textiles (porosity >= 0.95): the fibre tips break the film into menisci, a broad faint sheen (a
  // glossy 0.32 lobe caught the ceiling lamps through the SSR as bright blotches on soaked carpet)
  WET_FILM_ROUGH_PILE: 0.3,
  WET_FILM_F0: 0.7, // share of the film that is optically water (F0 0.02 / F90 1; puddles: all of it)
  WET_CLUMP: 0.3, // damp (unsaturated) pile / fibre relief clumps: normal strength x (1 + this)
  SOAK_FLAT: 0.5, // a saturated film flattens porous relief by up to this
  PUDDLE_W0: 0.5, // standing water only above this wetness...
  PUDDLE_W1: 0.95, // ...and the water level reaches PUDDLE_HI here
  PUDDLE_PILE_W0: 0.92, // textiles (porosity >= 0.95): water stands over the pile only once the floor is saturated
  PUDDLE_PILE_W1: 0.99,
  PUDDLE_LO: -0.0012, // m, water level relative to the layer's mean relief plane at W0 (cracks, grout, joints fill)
  PUDDLE_HI: 0.0015, // m, at W1 (everything but the highest relief covered)
  PUDDLE_EDGE: 0.0002, // m, shoreline smoothing (grows with the texel footprint up to 8 texels)
  PUDDLE_ROUGH: 0.03,
  PUDDLE_TINT: [0.94, 0.9, 0.82] as const, // murky standing water over the substrate
  // --- two-lobe (glaze) layers: share of the filtered-normal variance that broadens the glaze lobe (the tilt part)
  GLAZE_TOKSVIG: 0.25,
  // --- clearcoat (props with the coat bit; USE_CLEARCOAT)
  COAT_ROUGH: 0.04,
  // --- textile sheen: pile lean widens / narrows the sheen lobe by this x the lean seen from the camera
  SHEEN_LEAN_ROUGH: 0.12,
  // --- geometric specular AA (Tokuyoshi & Kaplanyan 2019): alpha^2 += min(2 SIGMA2 (|dn/dx|^2 + |dn/dy|^2), KAPPA)
  SAA_SIGMA2: 0.25,
  SAA_KAPPA: 0.18,
  // --- detail maps (uBrDetail, textures/detail.ts): full detail up to FAR0 detail texels per pixel, faded to the
  // layer mean (pure LEAN micro-roughness) by FAR1 (~4 m at 1080p, ~6 m at ultra)
  DETAIL_FAR0: 8,
  DETAIL_FAR1: 16,
  // --- puddle micro-ripples (detail layer DETAIL_RIPPLE): normalised slope x this, one repeat per RIPPLE_SCALE
  // metres (divides NOISE_WRAP), drifting at RIPPLE_DRIFT repeats per second (frozen under time=)
  RIPPLE: 0.004, // ~0.13 degrees rms: still water that only trembles (drips, draughts)
  RIPPLE_SCALE: 0.6,
  RIPPLE_DRIFT: [0.004, -0.003] as const,
  RIPPLE_NEAR0: 1.5, // ripple texels per pixel: full ripples up to here (~1 m at 1080p)...
  RIPPLE_NEAR1: 4, // ...none from here
  // --- parallax occlusion mapping (shell, pomTop layers): steps follow the visible parallax in pixels
  POM_GAIN: 1.0, // relief depth x this
  POM_MIN_PX: 0.5, // no POM below this much parallax (pixels)...
  POM_FULL_PX: 1.5, // ...full depth from here
  POM_PX_PER_STEP: 1.5, // linear-search step length (pixels), then one secant refinement
  POM_PX_PER_STEP_2: 2.25, // BR_POM 2 (ultra, 1.5 display pixels at the 1.5x it rendered at until the perf pass; 1.6 at 1.4x)
  POM_MIN_STEPS: 2, // fewest march steps (plus the start sample and the secant): the step length bounds the error
  POM_MAX_1: 12, // steps, BR_POM 1 (high)
  POM_MAX_2: 16, // steps, BR_POM 2 (ultra)
  POM_SH_STEPS: 4, // most self-shadow steps toward the baked light (BR_POM 2), one per march step length
  POM_SH_K: 8.0, // occlusion per unit of normalised height above the shadow ray
  // --- prop dust (aux.z bits 2-7 = dust level from the anchor cell's decay, props/tileProps.ts)
  DUST_COLOR: [0.36, 0.34, 0.3] as const, // linear (sRGB ~161/157/149)
  DUST_MAX: 0.7,
  DUST_SIDE: 0.15, // faint film on vertical faces
  DUST_ROUGH: 0.92,
  DUST_CELL: 0.3, // m, clump lattice (4096 per NOISE_WRAP)
  // --- world features (hashed per world cell)
  FEATURE_CELL: 2.4, // m (512 per NOISE_WRAP)
  FEATURE_CELL_Y: 1.5, // m (2 per storey pitch)
  // --- lighting
  DIRECT_MIN_ROUGH: 0.25, // baked dominant-direction specular never sharper than this (it is an area estimate)
  NG_MIN: 0.2,
  // props: an up-facing surface drops the light-volume level below it once that level lies this far (m) behind its
  // plane (common.ts brLvK, TS twin lvLevels): a seat top 0.16 m over the 0.2 m level (the samples under its own
  // frame) reads the 0.8 m level alone; a surface right at a level still reads it
  LV_BACK_D: 0.1,
  // ... gated (chunks/lighting.ts lvBackGate / lvGatePoint), both levels read LV_GATE_OFF (m) behind the surface in
  // xz: a sloped surface (n.y <= NY0) drops as the level above gives an up-facing receiver from LO to HI times the
  // light of the level below (a lounge chair's frame shadow is 16-100x at high, ~13x at low / medium; a room's own
  // vertical gradient 1-1.8x, a car hood corner in front of its windshield ~1.5x), a flat top (n.y >= NY1) from 1 to
  // FLAT_HI times (no transition to squeeze); a level below that is brighter (a rack deck's load) is always kept
  LV_GATE_LO: 1.5,
  LV_GATE_HI: 3.0,
  LV_GATE_FLAT_HI: 1.35,
  LV_GATE_NY0: 0.75,
  LV_GATE_NY1: 0.95,
  LV_GATE_OFF: 0.3,
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
  CAUSTIC_STRENGTH: 1.1,
  CAUSTIC_FLOOD: 0.12, // strength multiplier for flooded rooms (WaterRect kind 1; film kind 2: none)
  CAUSTIC_FLOOD_SCALE: 2, // flooded rooms: caustic cells x this (shallow water focuses far below its surface)
  CAUSTIC_FLOOD_SPEED: 0.4,
  CAUSTIC_SRC_TAN: 0.35, // tan of the light sources' angular half size (troffers): softens deep caustics
  CAUSTIC_DEPTH_K: 0.35, // 1/m
  // --- water surface
  WATER_ENV_ALBEDO: 0.45, // room-average reflectance used for the uniform-environment reflection
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

/**
 * Texture realism v2 per-layer constants (GLSL const arrays indexed by the layer: no uniform vectors), from the recipe
 * rows (SurfacePhys and the channel conventions; see layers/types.ts):
 *   BR_L_SIGMA (EON sigma), BR_L_PILE (kp, kv), BR_L_DETREP (detail repeat scale), BR_L_DETTINT (detail tint),
 *   BR_L_DETSO (detail cavity into specular occlusion), BR_L_DIRT / BR_L_WEAR (rgb, amount), BR_L_RELIEF (metres of
 *   full convexity), BR_AUX_KIND (ormh.a kind, BR_AUX_* ids), BR_L_AUX2 (albedo.a is aux2).
 */
export function glslLayerArrays(): string {
  const n = MAT_COUNT;
  const rows = LAYER_RECIPES_FULL;
  const vec = (k: number, v: readonly number[]): string => `vec${k}(${v.map(f).join(', ')})`;
  const arr = (type: string, name: string, items: readonly string[]): string => `const ${type} ${name}[${n}] = ${type}[${n}](${items.join(', ')});`;
  return [
    ...Object.entries(GRIME_ID).map(([k, v]) => `#define BR_G_${k.toUpperCase()} ${v}`),
    ...Object.entries(AUX_KIND_ID).map(([k, v]) => `#define BR_AUX_${k.toUpperCase()} ${v}`),
    arr('float', 'BR_L_SIGMA', rows.map((r) => f(r.phys.sigma))),
    arr('vec2', 'BR_L_PILE', rows.map((r) => vec(2, r.phys.pile))),
    arr('float', 'BR_L_DETREP', rows.map((r) => f(r.phys.detRep))),
    arr('vec3', 'BR_L_DETTINT', rows.map((r) => vec(3, r.phys.detTint))),
    arr('float', 'BR_L_DETSO', rows.map((r) => f(r.phys.detSO))),
    arr('vec4', 'BR_L_DIRT', rows.map((r) => vec(4, r.phys.dirt))),
    arr('vec4', 'BR_L_WEAR', rows.map((r) => vec(4, r.phys.wear))),
    arr('float', 'BR_L_RELIEF', rows.map((r) => f(r.phys.reliefM))),
    arr('int', 'BR_AUX_KIND', rows.map((r) => String(AUX_KIND_ID[r.aux]))),
    arr('bool', 'BR_L_AUX2', rows.map((r) => String(r.aux2))),
  ].join('\n') + '\n';
}

/** Derived GLSL #defines shared by every WP9 shader. */
export function glslConstants(): string {
  const lut = slotLut();
  const wrapCells = (cell: number): number => Math.round(NOISE_WRAP / cell);
  const yCells = (cell: number): number => Math.round(STOREY_PITCH / cell);
  const v3 = (c: readonly number[]): string => `vec3(${c.map(f).join(', ')})`;
  const nd = DETAIL_RECIPES.length;
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
#define BR_RUST ${v3(TUNE.RUST_COLOR)}
#define BR_WET_DARK ${f(TUNE.WET_DARK)}
#define BR_WET_SAT ${f(TUNE.WET_SAT)}
#define BR_WET_FILM_ROUGH ${f(TUNE.WET_FILM_ROUGH)}
#define BR_WET_FILM_ROUGH_POROUS ${f(TUNE.WET_FILM_ROUGH_POROUS)}
#define BR_WET_FILM_ROUGH_PILE ${f(TUNE.WET_FILM_ROUGH_PILE)}
#define BR_WET_FILM_F0 ${f(TUNE.WET_FILM_F0)}
#define BR_WET_CLUMP ${f(TUNE.WET_CLUMP)}
#define BR_SOAK_FLAT ${f(TUNE.SOAK_FLAT)}
#define BR_PUDDLE_W0 ${f(TUNE.PUDDLE_W0)}
#define BR_PUDDLE_W1 ${f(TUNE.PUDDLE_W1)}
#define BR_PUDDLE_PILE_W0 ${f(TUNE.PUDDLE_PILE_W0)}
#define BR_PUDDLE_PILE_W1 ${f(TUNE.PUDDLE_PILE_W1)}
#define BR_PUDDLE_LO ${f(TUNE.PUDDLE_LO)}
#define BR_PUDDLE_HI ${f(TUNE.PUDDLE_HI)}
#define BR_PUDDLE_EDGE ${f(TUNE.PUDDLE_EDGE)}
#define BR_PUDDLE_ROUGH ${f(TUNE.PUDDLE_ROUGH)}
#define BR_PUDDLE_TINT ${v3(TUNE.PUDDLE_TINT)}
#define BR_GLAZE_TOKSVIG ${f(TUNE.GLAZE_TOKSVIG)}
#define BR_COAT_ROUGH ${f(TUNE.COAT_ROUGH)}
#define BR_SHEEN_LEAN_ROUGH ${f(TUNE.SHEEN_LEAN_ROUGH)}
#define BR_SAA_SIGMA2 ${f(TUNE.SAA_SIGMA2)}
#define BR_SAA_KAPPA ${f(TUNE.SAA_KAPPA)}
#define BR_DUST_COLOR ${v3(TUNE.DUST_COLOR)}
#define BR_DUST_MAX ${f(TUNE.DUST_MAX)}
#define BR_DUST_SIDE ${f(TUNE.DUST_SIDE)}
#define BR_DUST_ROUGH ${f(TUNE.DUST_ROUGH)}
#define BR_DUST_CELL ${f(TUNE.DUST_CELL)}
#define BR_DUST_P ${wrapCells(TUNE.DUST_CELL)}
#define BR_DETAIL_REPEAT ${f(DETAIL_REPEAT)}
#define BR_DETAIL_RES ${f(DETAIL_SIZE)}
#define BR_DETAIL_FAR0 ${f(TUNE.DETAIL_FAR0)}
#define BR_DETAIL_FAR1 ${f(TUNE.DETAIL_FAR1)}
#define BR_DETAIL_RIPPLE ${f(DETAIL_RIPPLE)}
#define BR_RIPPLE ${f(TUNE.RIPPLE)}
#define BR_RIPPLE_SCALE ${f(TUNE.RIPPLE_SCALE)}
#define BR_RIPPLE_DRIFT vec2(${TUNE.RIPPLE_DRIFT.map(f).join(', ')})
#define BR_RIPPLE_NEAR0 ${f(TUNE.RIPPLE_NEAR0)}
#define BR_RIPPLE_NEAR1 ${f(TUNE.RIPPLE_NEAR1)}
#define BR_POM_GAIN ${f(TUNE.POM_GAIN)}
#define BR_POM_MIN_PX ${f(TUNE.POM_MIN_PX)}
#define BR_POM_FULL_PX ${f(TUNE.POM_FULL_PX)}
#define BR_POM_PX_PER_STEP ${f(TUNE.POM_PX_PER_STEP)}
#define BR_POM_PX_PER_STEP_2 ${f(TUNE.POM_PX_PER_STEP_2)}
#define BR_POM_MIN_STEPS ${TUNE.POM_MIN_STEPS}
#define BR_POM_MAX_1 ${TUNE.POM_MAX_1}
#define BR_POM_MAX_2 ${TUNE.POM_MAX_2}
#define BR_POM_SH_STEPS ${TUNE.POM_SH_STEPS}
#define BR_POM_SH_K ${f(TUNE.POM_SH_K)}
#define BR_DIRECT_MIN_ROUGH ${f(TUNE.DIRECT_MIN_ROUGH)}
#define BR_NG_MIN ${f(TUNE.NG_MIN)}
#define BR_LV_BACK_D ${f(TUNE.LV_BACK_D)}
#define BR_LV_GATE_LO ${f(TUNE.LV_GATE_LO)}
#define BR_LV_GATE_HI ${f(TUNE.LV_GATE_HI)}
#define BR_LV_GATE_OFF ${f(TUNE.LV_GATE_OFF)}
#define BR_LV_GATE_FLAT_HI ${f(TUNE.LV_GATE_FLAT_HI)}
#define BR_LV_GATE_NY0 ${f(TUNE.LV_GATE_NY0)}
#define BR_LV_GATE_NY1 ${f(TUNE.LV_GATE_NY1)}
#define BR_EM_LOD ${f(TUNE.EM_LOD_PER_ROUGH)}
#define BR_EM_ROUGH_CUT ${f(TUNE.EM_ROUGH_CUT)}
#define BR_EM_ROUGH_END ${f(TUNE.EM_ROUGH_END)}
#define BR_REFL_LOD ${f(TUNE.REFL_LOD_PER_ROUGH)}
#define BR_PLANE_EPS ${f(TUNE.PLANE_EPS)}
#define BR_REFL_DISTORT ${f(TUNE.REFL_DISTORT)}
#define BR_CAUSTIC_STRENGTH ${f(TUNE.CAUSTIC_STRENGTH)}
#define BR_CAUSTIC_DEPTH_K ${f(TUNE.CAUSTIC_DEPTH_K)}
#define BR_CAUSTIC_FLOOD ${f(TUNE.CAUSTIC_FLOOD)}
#define BR_CAUSTIC_FLOOD_SCALE ${f(TUNE.CAUSTIC_FLOOD_SCALE)}
#define BR_CAUSTIC_FLOOD_SPEED ${f(TUNE.CAUSTIC_FLOOD_SPEED)}
#define BR_CAUSTIC_SRC_TAN ${f(TUNE.CAUSTIC_SRC_TAN)}
#define BR_WATER_ENV_ALBEDO ${f(TUNE.WATER_ENV_ALBEDO)}
#define BR_WATER_EMIT_H ${f(TUNE.WATER_EMIT_PLANE_H)}
#define BR_AIR_STEPS ${TUNE.AIRLIGHT_STEPS}
#define BR_AIR_MIN_H ${f(TUNE.AIRLIGHT_MIN_H)}
#define BR_AIR_GAIN ${f(TUNE.AIRLIGHT_GAIN)}
#define BR_REFL_PROP_DIST ${f(TUNE.REFL_PROP_DIST)}
#define BR_DEBUG_NITS ${f(TUNE.DEBUG_NITS)}
#define BR_DEBUG_LUX ${f(TUNE.DEBUG_LUX)}
const int BR_SLOT_LUT[9] = int[9](${lut.join(', ')});
const float BR_LV_Y[${LV.NY}] = float[${LV.NY}](${LV.Y.map(f).join(', ')});
const float BR_DETAIL_SLOPE[${nd}] = float[${nd}](${DETAIL_RECIPES.map((r) => f(r.slope)).join(', ')});
const float BR_DETAIL_ROUGH_K[${nd}] = float[${nd}](${DETAIL_RECIPES.map((r) => f(r.roughK)).join(', ')});
${glslLayerArrays()}${waterMediaGlsl()}`;
}

// ---------------------------------------------------------------- package E: water media and caustics

/** Per-kind water media, indexed by WaterRect kind (0 pool, 1 flooded room, 2 film); SI units (1/m).
 * SA absorption, SS scattering, G the forward Henyey-Greenstein lobe of the dual phase function (phaseWater: a BACK
 * share of a backward lobe G_BACK), TINT the scatterers' colour, BLUR the forward-scatter blur factor of the
 * refraction pass. Pool: pure-water absorption (red goes first: the tile turns cyan, then blue with depth) and a
 * little fine scattering. Flooded Level 0 rooms: dissolved organic matter (humic stains absorb blue: yellow-brown
 * with depth) and silt that scatters strongly forward but backscatters little, so the water body stays dark and the
 * carpet shows through near the camera, blurred and browned. Film: the same water, 1-2 cm of it.
 * The legacy submerged-surface path (chunks/haze.ts; medium, low, the mirror pass) attenuates along the refracted
 * view path with the transport coefficient SA + (1 - G) SS: without the blur of the refraction pass the
 * forward-scattered light arrives along the view ray. */
export const WATER_MEDIA = {
  SA: [[0.35, 0.065, 0.03], [0.9, 1.6, 3.4], [0.9, 1.6, 3.4]],
  SS: [0.12, 1.2, 1.0],
  G: [0.9, 0.92, 0.9],
  BACK: [0.1, 0.07, 0.05],
  G_BACK: -0.3,
  TINT: [[0.85, 0.96, 1.0], [1.0, 0.88, 0.66], [1.0, 0.9, 0.72]],
  BLUR: [0, 0.035, 0.02],
  /** downwelling attenuation of the baked light reaching a submerged surface: exp(-DOWN * kappa * depth),
   * kappa = SA + (1 - G) SS; DOWN < 1.25 because part of the floor light comes from the pool's own wall lights */
  DOWN: 0.8,
  IOR: 1.333,
} as const;

/** Henyey-Greenstein phase (1/sr) at mu = cos(scattering angle). */
export const phaseHG = (mu: number, g: number): number => (1 - g * g) / (4 * Math.PI * Math.pow(1 + g * g - 2 * g * mu, 1.5));
/** The water's dual-lobe phase function (1/sr; integrates to 1): the forward lobe G[kind] plus a BACK[kind] share of
 * a backward lobe (a local copy until package F's phase.ts lands; GLSL twin brPhaseW). */
export const phaseWater = (mu: number, kind: number): number =>
  (1 - WATER_MEDIA.BACK[kind]) * phaseHG(mu, WATER_MEDIA.G[kind]) + WATER_MEDIA.BACK[kind] * phaseHG(mu, WATER_MEDIA.G_BACK);

/** Exact dielectric Fresnel reflectance air -> water (unpolarised) at the cosine of incidence ci (GLSL twin
 * brFresnelW: F(1) = 0.0204, 1 at grazing). */
export function fresnelWater(ci: number): number {
  const n = WATER_MEDIA.IOR;
  const c = Math.min(Math.max(ci, 0), 1);
  const ct = Math.sqrt(Math.max(1 - (1 - c * c) / (n * n), 0));
  const rs = (c - n * ct) / (c + n * ct), rp = (n * c - ct) / (n * c + ct);
  return 0.5 * (rs * rs + rp * rp);
}

/**
 * Phase share of diffuse downwelling light for a view ray going up through the water at cosV (to the vertical):
 * the in-scattered source is SS * PHI * E / pi. A diffuse field of radiance E / pi above the surface enters the water
 * compressed into Snell's window (the 48.6 deg cone around the nadir) with radiance n^2 (1 - F) E / pi, so
 * PHI = n^2 * integral over the window of (1 - F) phase(mu) d omega. A viewer above the water sees that light
 * backscattered (the phase past 90 deg), which the dual lobe keeps small for silt: dark murky water, not milk.
 * Numeric (Simpson in theta, midpoint in phi).
 */
export function downwellPhi(kind: number, cosV: number, nt = 96, np = 96): number {
  const n = WATER_MEDIA.IOR, n2 = n * n;
  const thc = Math.asin(1 / n);
  const sv = Math.sqrt(Math.max(1 - cosV * cosV, 0));
  const h = thc / nt;
  let acc = 0;
  for (let i = 0; i <= nt; i++) {
    const th = i * h;
    const wS = i === 0 || i === nt ? 1 : i & 1 ? 4 : 2;
    const sT = Math.sin(th), cT = Math.cos(th);
    const tr = 1 - fresnelWater(Math.sqrt(Math.max(1 - n2 * sT * sT, 0))); // the air-side angle has sin = n sin(th)
    let ring = 0;
    for (let j = 0; j < np; j++) {
      const ph = ((j + 0.5) / np) * 2 * Math.PI;
      ring += phaseWater(sT * Math.cos(ph) * sv - cT * cosV, kind); // down (sT cos ph, -cT, sT sin ph) . up (sv, cosV, 0)
    }
    acc += wS * tr * ring * ((2 * Math.PI) / np) * sT;
  }
  return (n2 * acc * h) / 3;
}

/** PHI per kind as the shaders use it (a typical view, 25 deg off the vertical in the water: PHI varies < 10 %
 * over the refracted view cone). */
export const WATER_PHI: readonly number[] = [0, 1, 2].map((k) => downwellPhi(k, Math.cos((25 * Math.PI) / 180)));

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
  /** flashlight caustic through the surface, mean-preserving: 1 + SPOT_CONTRAST * (pattern / mean - 1). A torch is
   * not a point: its 3-4 cm reflector and the beam's own spread fill the cells, so the floor between the filaments
   * keeps 1 - SPOT_CONTRAST of the mean (it went black at 1 - 1.2 mean before) */
  SPOT_CONTRAST: 0.4,
} as const;

/** GLSL constants and helpers of WATER_MEDIA / WATER_CAUSTICS (const arrays indexed by kind; brFresnelW,
 * brPhaseW). */
export function waterMediaGlsl(): string {
  const v3 = (c: readonly number[]): string => `vec3(${c.map(f).join(', ')})`;
  const M = WATER_MEDIA, C = WATER_CAUSTICS;
  const n = M.IOR;
  return `const vec3 BR_WM_SA[3] = vec3[3](${M.SA.map(v3).join(', ')});
const float BR_WM_SS[3] = float[3](${M.SS.map(f).join(', ')});
const float BR_WM_G[3] = float[3](${M.G.map(f).join(', ')});
const float BR_WM_BACK[3] = float[3](${M.BACK.map(f).join(', ')});
const vec3 BR_WM_TINT[3] = vec3[3](${M.TINT.map(v3).join(', ')});
const float BR_WM_BLUR[3] = float[3](${M.BLUR.map(f).join(', ')});
const float BR_WM_PHI[3] = float[3](${WATER_PHI.map((x) => f(Number(x.toPrecision(5)))).join(', ')});
#define BR_WM_GB ${f(M.G_BACK)}
#define BR_WM_DOWN ${f(M.DOWN)}
// exact dielectric Fresnel air -> water at the cosine of incidence ci (params.ts fresnelWater: F(1) = 0.0204)
float brFresnelW( float ci ) {
	float c = clamp( ci, 0.0, 1.0 );
	float ct = sqrt( max( 1.0 - ( 1.0 - c * c ) * ${f(1 / (n * n))}, 0.0 ) );
	float rs = ( c - ${f(n)} * ct ) / ( c + ${f(n)} * ct );
	float rp = ( ${f(n)} * c - ct ) / ( ${f(n)} * c + ct );
	return 0.5 * ( rs * rs + rp * rp );
}
// the water's dual-lobe phase function (1/sr) at mu = cos(scattering angle) (params.ts phaseWater)
float brHGW( float mu, float g ) { float d = 1.0 + g * g - 2.0 * g * mu; return ( 1.0 - g * g ) / ( 12.566371 * d * sqrt( d ) ); }
float brPhaseW( float mu, int kind ) { return mix( brHGW( mu, BR_WM_G[ kind ] ), brHGW( mu, BR_WM_GB ), BR_WM_BACK[ kind ] ); }
#define BR_CAUSTIC_WALL ${f(C.WALL)}
#define BR_CAUSTIC_CEIL ${f(C.CEIL)}
#define BR_CAUSTIC_ABOVE_WALL ${f(C.ABOVE_WALL)}
#define BR_CAUSTIC_MAGNIFY ${f(C.MAGNIFY)}
#define BR_CAUSTIC_FADE ${f(C.FADE)}
#define BR_CAUSTIC_LEVEL ${f(C.LEVEL)}
#define BR_CAUSTIC_SPOT_CONTRAST ${f(C.SPOT_CONTRAST)}
`;
}
