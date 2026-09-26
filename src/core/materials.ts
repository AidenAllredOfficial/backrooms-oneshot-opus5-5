// src/core/materials.ts — material layer table. Layer index == MatId == texture-array layer.
// albedoMean is AUTHORITATIVE for the baker's bounce colour; WP8 must generate textures whose measured mean
// (1x1 mip, linear) is within 10% per channel (layerAlbedoCheck). WP8 may edit NUMERIC values in this table
// (albedoMean, roughness) via docs/contract-changes/WP8.md; nobody else edits it.
// repeat: metres per texture repeat; MUST divide TILE_SIZE (19.2) so tile-local material UVs are seamless.
// repeatY: metres per repeat in v on VERTICAL shell faces (v = y / repeatY); default = repeat. Horizontal faces use
// (x, z) / repeat. WP8 authors a layer's texture over a frame of repeat (u) x repeatY (v) metres. Layers used by
// periodic stair towers (TOWER_LAYERS) MUST have STOREY_PITCH / repeatY integral (tested) so walls are 3 m-periodic.

import { Mat, type MatId, SurfaceSound, type SurfaceSoundId } from './ids.ts';

export type GrimeProfile = 'carpet' | 'wallpaper' | 'ceilingTile' | 'concrete' | 'tile' | 'metal' | 'none';

export interface MaterialLayerDef {
  id: MatId;
  name: string;
  repeat: number; // m
  repeatY?: number; // m, vertical-face repeat (default repeat)
  tileSize: number; // m, per-tile hashed rotation/flip cell for anti-tiling (0 = off). ONLY for physical tiles.
  hexTile?: number; // m, offset-only stochastic (hex) tiling cell with feathered blend, for non-tiled layers (0/undefined = off)
  albedoMean: readonly [number, number, number]; // linear
  roughness: number; // mean
  metal: number;
  grime: GrimeProfile;
  sound: SurfaceSoundId;
  absorption: number; // Sabine alpha (mid band)
  reflective: boolean; // default for VFlag.REFLECTIVE on up-facing surfaces
}

const S = SurfaceSound;
export const LAYER_DEFS: readonly MaterialLayerDef[] = [
  { id: 0, name: 'WALLPAPER_L0', repeat: 1.2, tileSize: 0, albedoMean: [0.42, 0.34, 0.12], roughness: 0.8, metal: 0, grime: 'wallpaper', sound: S.CARPET, absorption: 0.1, reflective: false },
  { id: 1, name: 'CARPET_L0', repeat: 2.4, tileSize: 0, hexTile: 1.2, albedoMean: [0.22, 0.17, 0.08], roughness: 0.95, metal: 0, grime: 'carpet', sound: S.CARPET, absorption: 0.35, reflective: true },
  { id: 2, name: 'CEILING_TILE', repeat: 1.2, tileSize: 0.6, albedoMean: [0.7, 0.67, 0.56], roughness: 0.9, metal: 0, grime: 'ceilingTile', sound: S.CARPET, absorption: 0.6, reflective: false },
  { id: 3, name: 'PANEL_LENS', repeat: 0.6, tileSize: 0, albedoMean: [0.7, 0.7, 0.68], roughness: 0.3, metal: 0, grime: 'none', sound: S.METAL, absorption: 0.05, reflective: false },
  { id: 4, name: 'TRIM_PAINT', repeat: 1.2, tileSize: 0, albedoMean: [0.72, 0.7, 0.64], roughness: 0.5, metal: 0, grime: 'wallpaper', sound: S.WOOD, absorption: 0.05, reflective: false },
  { id: 5, name: 'WALLPAPER_MANILA', repeat: 1.2, tileSize: 0, albedoMean: [0.5, 0.42, 0.28], roughness: 0.8, metal: 0, grime: 'wallpaper', sound: S.CARPET, absorption: 0.1, reflective: false },
  { id: 6, name: 'CARPET_OFFICE', repeat: 2.4, tileSize: 0.6, albedoMean: [0.12, 0.13, 0.15], roughness: 0.95, metal: 0, grime: 'carpet', sound: S.CARPET, absorption: 0.3, reflective: false },
  { id: 7, name: 'DRYWALL', repeat: 2.4, tileSize: 0, albedoMean: [0.62, 0.6, 0.55], roughness: 0.85, metal: 0, grime: 'wallpaper', sound: S.CONCRETE, absorption: 0.08, reflective: false },
  { id: 8, name: 'VINYL_VCT', repeat: 1.2, tileSize: 0.3, albedoMean: [0.45, 0.43, 0.38], roughness: 0.35, metal: 0, grime: 'tile', sound: S.VINYL, absorption: 0.03, reflective: true },
  { id: 9, name: 'CONCRETE_FLOOR', repeat: 4.8, repeatY: 3.0, tileSize: 0, hexTile: 2.4, albedoMean: [0.3, 0.29, 0.27], roughness: 0.6, metal: 0, grime: 'concrete', sound: S.CONCRETE, absorption: 0.02, reflective: true },
  { id: 10, name: 'CONCRETE_WALL', repeat: 2.4, repeatY: 1.5, tileSize: 0, albedoMean: [0.35, 0.34, 0.32], roughness: 0.85, metal: 0, grime: 'concrete', sound: S.CONCRETE, absorption: 0.03, reflective: false },
  { id: 11, name: 'CONCRETE_CEIL', repeat: 4.8, repeatY: 3.0, tileSize: 0, albedoMean: [0.33, 0.32, 0.3], roughness: 0.9, metal: 0, grime: 'concrete', sound: S.CONCRETE, absorption: 0.03, reflective: false },
  { id: 12, name: 'CMU_PAINTED', repeat: 2.4, repeatY: 1.0, tileSize: 0, albedoMean: [0.5, 0.5, 0.46], roughness: 0.5, metal: 0, grime: 'concrete', sound: S.CONCRETE, absorption: 0.05, reflective: false },
  { id: 13, name: 'POOL_TILE', repeat: 1.2, tileSize: 0.15, albedoMean: [0.78, 0.79, 0.78], roughness: 0.08, metal: 0, grime: 'tile', sound: S.TILE, absorption: 0.02, reflective: true },
  { id: 14, name: 'POOL_MOSAIC', repeat: 0.6, tileSize: 0.3, albedoMean: [0.35, 0.6, 0.65], roughness: 0.1, metal: 0, grime: 'tile', sound: S.TILE, absorption: 0.02, reflective: true },
  { id: 15, name: 'METAL_PAINTED', repeat: 1.2, repeatY: 1.0, tileSize: 0, albedoMean: [0.4, 0.4, 0.38], roughness: 0.45, metal: 0.2, grime: 'metal', sound: S.METAL, absorption: 0.03, reflective: false },
  { id: 16, name: 'METAL_RUST', repeat: 1.2, tileSize: 0, albedoMean: [0.25, 0.14, 0.08], roughness: 0.75, metal: 0.4, grime: 'metal', sound: S.METAL, absorption: 0.03, reflective: false },
  { id: 17, name: 'METAL_GRATE', repeat: 1.2, tileSize: 0, albedoMean: [0.2, 0.2, 0.2], roughness: 0.55, metal: 0.8, grime: 'metal', sound: S.GRATE, absorption: 0.1, reflective: false },
  { id: 18, name: 'WOOD', repeat: 1.2, tileSize: 0, albedoMean: [0.35, 0.22, 0.12], roughness: 0.55, metal: 0, grime: 'none', sound: S.WOOD, absorption: 0.08, reflective: false },
  { id: 19, name: 'PLASTIC', repeat: 0.6, tileSize: 0, albedoMean: [0.55, 0.53, 0.48], roughness: 0.4, metal: 0, grime: 'none', sound: S.VINYL, absorption: 0.05, reflective: false },
  { id: 20, name: 'FABRIC_PARTITION', repeat: 1.2, tileSize: 0, albedoMean: [0.3, 0.3, 0.32], roughness: 1.0, metal: 0, grime: 'none', sound: S.CARPET, absorption: 0.5, reflective: false },
  { id: 21, name: 'PLENUM', repeat: 2.4, tileSize: 0, albedoMean: [0.08, 0.07, 0.06], roughness: 0.95, metal: 0, grime: 'none', sound: S.CONCRETE, absorption: 0.3, reflective: false },
  { id: 22, name: 'RUBBER', repeat: 1.2, tileSize: 0, albedoMean: [0.05, 0.05, 0.05], roughness: 0.7, metal: 0, grime: 'none', sound: S.VINYL, absorption: 0.05, reflective: false },
  { id: 23, name: 'SIGNAGE', repeat: 1.2, tileSize: 0, albedoMean: [0.5, 0.3, 0.25], roughness: 0.4, metal: 0, grime: 'none', sound: S.METAL, absorption: 0.03, reflective: false },
  { id: 24, name: 'DECAL_ATLAS', repeat: 1.2, tileSize: 0, albedoMean: [0.2, 0.18, 0.14], roughness: 0.7, metal: 0, grime: 'none', sound: S.CONCRETE, absorption: 0.03, reflective: false },
  { id: 25, name: 'FLOOR_PAINT', repeat: 1.2, tileSize: 0, albedoMean: [0.65, 0.6, 0.2], roughness: 0.5, metal: 0, grime: 'concrete', sound: S.CONCRETE, absorption: 0.02, reflective: false },
  { id: 26, name: 'TERRAZZO', repeat: 2.4, tileSize: 0, albedoMean: [0.5, 0.48, 0.44], roughness: 0.25, metal: 0, grime: 'tile', sound: S.TILE, absorption: 0.02, reflective: true },
  { id: 27, name: 'METAL_DECK', repeat: 1.2, tileSize: 0, albedoMean: [0.3, 0.3, 0.29], roughness: 0.5, metal: 0.6, grime: 'metal', sound: S.METAL, absorption: 0.05, reflective: false },
];
export const layerRepeatY = (d: MaterialLayerDef): number => d.repeatY ?? d.repeat;
/** The only layers WP4 may use on tower shell geometry (edges and periodic solids). No trims inside towers. */
export const TOWER_LAYERS: readonly MatId[] = [Mat.CMU_PAINTED, Mat.CONCRETE_WALL, Mat.CONCRETE_FLOOR, Mat.CONCRETE_CEIL, Mat.METAL_PAINTED];
