// src/core/mesh.ts — worker outputs crossing the worker boundary (all typed arrays are transferable).
// Producer map: surfaces/charts + shell/water meshes: WP5; prop meshes: WP6 via GeometryWriter;
// lightmaps/emission/light volume: WP7; collision: WP12 (pure builder run in the worker).

import type { LmTpc } from './constants.ts';
import type { Vec3 } from './grid.ts';
import type { LightStateId, ValueOf, ZoneId } from './ids.ts';

/** Vertex streams. Shader attribute names: position, normal, uv, brLmUv, brLayer, brFlags, brTint, brEmit, brAux.
 * NEVER name an attribute uv1/uv2 (three declares `attribute vec2 uv1` under USE_UV1). */
export interface MeshBuffers {
  position: Float32Array; // xyz, TILE-LOCAL metres
  normal: Int8Array; // xyzw normalized (w = 0), itemSize 4
  uv: Float32Array; // material uv = tile-local metres / repeat (vertical faces: v = y / layerRepeatY)
  lmUv: Float32Array; // lightmap atlas uv in [0,1] (props: 0,0)
  layer: Uint8Array; // MatId
  flags: Uint8Array; // VFlag bits
  tint: Uint8Array; // rgba8 normalized: rgb albedo tint (emissive colour for lenses), a = variation seed (fixture.seed & 255 on DYN_EMIT/SHIMMER)
  emit: Float32Array; // emissive luminance in nits (0 = none)
  aux: Uint8Array; // u8x4, meaning selected by VFlag.FLOOR_AUX / PROP_AUX
  index: Uint32Array;
  vertexCount: number;
  indexCount: number;
  bounds: [number, number, number, number, number, number]; // tile-local AABB
}

export const ChartKind = { FLOOR_GRID: 0, CEIL_GRID: 1, WALL: 2, STEP: 3, SOFFIT: 4, BOX: 5, PLENUM: 6, RAMP: 7, TRIM_BORROW: 8 } as const;
export type ChartKindId = ValueOf<typeof ChartKind>;

/** One lightmap chart. Texel (u,v) centre = origin + (u+0.5)*axisU + (v+0.5)*axisV (tile-local metres),
 * except FLOOR_GRID/CEIL_GRID where x,z come from that formula and y from the owner cell's floor/ceiling. */
export interface Chart {
  id: number;
  kind: ChartKindId;
  bakeGroup: number;
  x: number; y: number; w: number; h: number; // atlas texel rect INCLUDING the 1-texel apron; LM_PAD gutter lies outside
  origin: Vec3;
  axisU: Vec3; // metres per texel along u
  axisV: Vec3;
  normal: Vec3;
  layer: number; // MatId of the surface (bounce colour, mask profile)
  /** Apron rule: every chart has a 1-texel apron. Bit set => that end CONTINUES into a neighbouring tile's chart
   * (wall run split at a tile boundary, grid charts on all four sides): apron texels are baked at their true
   * positions (seamless bilinear across tiles). Bit clear => apron is filled by dilation.
   * 1: -u end, 2: +u end, 4: -v end, 8: +v end. */
  cont: number;
}

export interface SurfaceSet {
  tileKey: string;
  tpc: LmTpc;
  atlasW: number; // LM_ATLAS_W
  atlasH: number; // 256 | 512 | 768 | 1024
  charts: Chart[];
  hash: number; // FNV over chart rects/origins/axes; build and bake MUST agree (tested)
}

/** Dynamic (flicker-channel) light reference for runtime uniforms. Slot order: (dx,dz) in
 * [(0,0),(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(1,-1),(-1,1),(1,1)] relative to the tile. */
export interface DynLightRef { id: number; state: LightStateId; seed: number; color: Vec3; x: number; y: number; z: number } // world metres
export const DYN_SLOT_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1],
];

export interface TileMesh {
  tileKey: string;
  zone: ZoneId;
  shell: MeshBuffers;
  props: MeshBuffers | null;
  water: MeshBuffers | null;
  decals: MeshBuffers | null; // soft-alpha decals (decal material variant); hard-alpha SIGNAGE/CHALK stays alpha-tested here too
  atlas: { width: number; height: number; tpc: LmTpc; chartHash: number; chartCount: number };
  dynLights: (DynLightRef | null)[]; // length 9, DYN_SLOT_OFFSETS order
  tris: number;
}

/** Sample (i along x, k = LV.Y level, j along z) is at index ((j * LV.NY + k) * LV.NX + i) * 4 in a, b and c.
 * Uploaded as Data3DTexture(width = LV.NX, height = LV.NY, depth = LV.NZ): texture u = x, v = level, w = z. */
export interface LightVolumeData {
  a: Uint16Array; // RGBA16F, LV.NX*LV.NY*LV.NZ: rgb static irradiance (lux), a = AO
  b: Uint8Array; // RGBA8: dominant dir xyz*0.5+0.5, a = directionality
  c: Uint16Array | null; // RGBA16F: per-channel dynamic irradiance luminance (lux)
  /** RGBA8 18x18 (the tile's 16x16 cells + 1-cell ring, index (lj+1)*18 + (li+1)): r = bits N1 E2 S4 W8 of the
   * cell's edges that occlude at y = 1.2 m. The props shader clamps each fragment's LV lookup >= 0.3 m inside its
   * OWN cell on those sides, so trilinear filtering never crosses a wall (any prop size). */
  wallMask: Uint8Array;
}

export interface LightmapData {
  tileKey: string;
  variant: 'preview' | 'full';
  width: number;
  height: number;
  chartHash: number;
  irr: Uint16Array; // RGBA16F: rgb static irradiance (lux; indirect already x AO), a = baked AO
  dir: Uint8Array; // RGBA8: dominant direction xyz*0.5+0.5 (world), a = directionality w in [0,1]
  flick: Uint16Array | null; // RGBA16F: channel c = irradiance luminance (lux) of that channel's dynamic light
  mask: Uint8Array; // RGBA8: r stain, g grime, b wetness, a damage
  emission: Uint16Array; // RGBA16F EMISSION.RES^2: rgb emitter radiance (nits, dynamic lights at i = 1),
                          // a = regionKey(nb.region()), NEGATED where the radiance belongs to a dynamic light
  volume: LightVolumeData;
  stats: { ms: number; texels: number; rays: number; lights: number };
}

/** Per-chunk collision acceleration (built by WP12 buildChunkCollision in the worker). Chunk-local metres. */
export interface ChunkCollision {
  chunkKey: string;
  boxes: Float32Array; // n*6: x0,y0,z0,x1,y1,z1 (walls/jambs/posts/solids/props with collide)
  boxFlags: Uint8Array; // n: SolidFlag bits (COLLIDE, WALKABLE_TOP)
  cellStart: Uint32Array; // 1025 prefix offsets into cellBoxes
  cellBoxes: Uint32Array; // box indices whose footprint overlaps the cell (expanded by PLAYER.radius)
  ramps: Float32Array; // n*8: x0,z0,x1,z1,y0,y1,dir,unused
}

export function emptyMeshBuffers(): MeshBuffers {
  return {
    position: new Float32Array(0), normal: new Int8Array(0), uv: new Float32Array(0), lmUv: new Float32Array(0),
    layer: new Uint8Array(0), flags: new Uint8Array(0), tint: new Uint8Array(0), emit: new Float32Array(0),
    aux: new Uint8Array(0), index: new Uint32Array(0), vertexCount: 0, indexCount: 0, bounds: [0, 0, 0, 0, 0, 0],
  };
}

export function meshTransferables(m: MeshBuffers | null, out: ArrayBuffer[]): void {
  if (!m) return;
  for (const a of [m.position, m.normal, m.uv, m.lmUv, m.layer, m.flags, m.tint, m.emit, m.aux, m.index]) out.push(a.buffer as ArrayBuffer);
}
