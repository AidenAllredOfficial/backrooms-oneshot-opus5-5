// src/core/grid.ts — coordinate conventions, keys and index helpers. Pure, no allocation in hot helpers.
//
// Axes: right-handed, +Y up, +X east, -Z north. Camera Euler order 'YXZ'; yaw 0 looks along -Z;
// positive yaw turns LEFT (counter-clockwise seen from above); positive pitch looks up. Radians everywhere.
// Global cell (gi, gj) covers x in [gi*CELL, (gi+1)*CELL), z in [gj*CELL, (gj+1)*CELL).
// Chunk cx = floorDiv(gi, 32); local li = gi - 32*cx. Tile (quadrant) q = qx + 2*qz with qx = li >> 4.
// Cell arrays: index lj*32 + li.
// x-edges ("ex", on lines x = i*CELL, separating cells (i-1, lj) | (i, lj)): index lj*33 + i, i in 0..32.
// z-edges ("ez", on lines z = j*CELL, separating cells (li, j-1) | (li, j)): index j*32 + li, j in 0..32.
// A chunk stores BOTH border lines; border values come from the shared pure seam function so neighbours agree.
// Layout positions (fixtures, solids, props, ...) are CHUNK-LOCAL metres (x,z in [0,38.4)), y storey-relative.
// Mesh vertex positions are TILE-LOCAL metres; mesh.position = tile origin (float64 on CPU => precise).

import { CELL, CHUNK_CELLS, CHUNK_SIZE, TILE_CELLS, TILE_SIZE } from './constants.ts';
import type { StoreyId } from './ids.ts';

export type Vec3 = [number, number, number];

export interface ChunkKey { readonly s: StoreyId; readonly cx: number; readonly cz: number }
export interface TileKey { readonly s: StoreyId; readonly cx: number; readonly cz: number; readonly q: 0 | 1 | 2 | 3 }

export const chunkKeyStr = (k: ChunkKey): string => `${k.s}:${k.cx}:${k.cz}`;
export const tileKeyStr = (k: TileKey): string => `${k.s}:${k.cx}:${k.cz}:${k.q}`;
export function parseChunkKey(str: string): ChunkKey {
  const [s, cx, cz] = str.split(':').map(Number);
  return { s: s as StoreyId, cx, cz };
}
export function parseTileKey(str: string): TileKey {
  const [s, cx, cz, q] = str.split(':').map(Number);
  return { s: s as StoreyId, cx, cz, q: q as 0 | 1 | 2 | 3 };
}
export const tileChunk = (t: TileKey): ChunkKey => ({ s: t.s, cx: t.cx, cz: t.cz });
export const tileQx = (q: number): number => q & 1;
export const tileQz = (q: number): number => q >> 1;
/** Global tile coordinates (used for flicker channel parity). */
export const globalTileX = (t: TileKey): number => t.cx * 2 + (t.q & 1);
export const globalTileZ = (t: TileKey): number => t.cz * 2 + (t.q >> 1);
/** Flicker channel owned by the dynamic light of a tile: (gtx & 1) + 2 * (gtz & 1). */
export const tileChannel = (t: TileKey): number => (globalTileX(t) & 1) + 2 * (globalTileZ(t) & 1);

export const floorDiv = (a: number, b: number): number => Math.floor(a / b);
export const mod = (a: number, b: number): number => ((a % b) + b) % b;
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Polynomial smoothstep (allowed in layout decisions: no transcendental functions). */
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** World metres -> global cell. The 1e-7 guards 1.2 not being exactly representable. THE ONLY rounding of
 * metres to the grid: chunk, local cell and tile are all derived from it (never from metres directly). */
export const worldToCell = (m: number): number => Math.floor(m / CELL + 1e-7);
export const cellToChunk = (g: number): number => Math.floor(g / CHUNK_CELLS);
export const worldToChunk = (m: number): number => cellToChunk(worldToCell(m));
export const chunkOriginX = (cx: number): number => cx * CHUNK_SIZE;
export const chunkOriginZ = (cz: number): number => cz * CHUNK_SIZE;
export const tileOriginX = (t: TileKey): number => t.cx * CHUNK_SIZE + (t.q & 1) * TILE_SIZE;
export const tileOriginZ = (t: TileKey): number => t.cz * CHUNK_SIZE + (t.q >> 1) * TILE_SIZE;
/** First local cell (li0, lj0) of tile q inside its chunk. */
export const tileCell0 = (q: number): [number, number] => [(q & 1) * TILE_CELLS, (q >> 1) * TILE_CELLS];
export const tileOfLocalCell = (li: number, lj: number): 0 | 1 | 2 | 3 =>
  (((li >> 4) & 1) | (((lj >> 4) & 1) << 1)) as 0 | 1 | 2 | 3;

export const cellIdx = (li: number, lj: number): number => lj * 32 + li;
export const exIdx = (i: number, lj: number): number => lj * 33 + i;
export const ezIdx = (li: number, j: number): number => j * 32 + li;

export function chunkKeyAt(s: StoreyId, x: number, z: number): ChunkKey {
  return { s, cx: worldToChunk(x), cz: worldToChunk(z) };
}
export function tileKeyAt(s: StoreyId, x: number, z: number): TileKey {
  const gi = worldToCell(x), gj = worldToCell(z);
  const cx = cellToChunk(gi), cz = cellToChunk(gj);
  return { s, cx, cz, q: tileOfLocalCell(gi - cx * CHUNK_CELLS, gj - cz * CHUNK_CELLS) };
}
/** Tile containing a CHUNK-LOCAL point (metres). WP4 (dynamic pick), WP5 (dynLights slots, fixture geometry
 * owner) and WP7 (flicker channel) all use this for "the tile containing the light" (fixture centre). */
export const tileOfPoint = (x: number, z: number): 0 | 1 | 2 | 3 =>
  tileOfLocalCell(clamp(worldToCell(x), 0, CHUNK_CELLS - 1), clamp(worldToCell(z), 0, CHUNK_CELLS - 1));

/** Rotated rectangular footprints (towers, elevators). Local frame: u across (0..W-1), v along (0..L-1).
 * rot 0: u->+x, v->+z   rot 1: u->+z, v->-x   rot 2: u->-x, v->-z   rot 3: u->-z, v->+x  (all proper rotations).
 * (i0, j0) is the MIN corner of the axis-aligned rotated footprint: W x L cells for rot 0/2, L x W for rot 1/3. */
export function footprintRect(i0: number, j0: number, W: number, L: number, rot: 0 | 1 | 2 | 3): [number, number, number, number] {
  return (rot & 1) === 0 ? [i0, j0, i0 + W, j0 + L] : [i0, j0, i0 + L, j0 + W]; // half-open [i0,i1) x [j0,j1)
}
/** Footprint cell (u, v) -> local cell (li, lj). */
export function footprintCell(i0: number, j0: number, W: number, L: number, rot: 0 | 1 | 2 | 3, u: number, v: number): [number, number] {
  switch (rot) {
    case 0: return [i0 + u, j0 + v];
    case 1: return [i0 + (L - 1 - v), j0 + u];
    case 2: return [i0 + (W - 1 - u), j0 + (L - 1 - v)];
    default: return [i0 + v, j0 + (W - 1 - u)];
  }
}
/** Footprint-local metres (um in [0, W*CELL], vm in [0, L*CELL]) -> chunk-local metres [x, z]. Consistent with footprintCell. */
export function footprintPoint(i0: number, j0: number, W: number, L: number, rot: 0 | 1 | 2 | 3, um: number, vm: number): [number, number] {
  const x0 = i0 * CELL, z0 = j0 * CELL;
  switch (rot) {
    case 0: return [x0 + um, z0 + vm];
    case 1: return [x0 + L * CELL - vm, z0 + um];
    case 2: return [x0 + W * CELL - um, z0 + L * CELL - vm];
    default: return [x0 + vm, z0 + W * CELL - um];
  }
}
/** Unit forward vector for yaw (pitch ignored): yaw 0 -> (0,0,-1); yaw +PI/2 -> (-1,0,0). */
export function forwardXZ(yaw: number, out: { x: number; z: number }): void {
  out.x = -Math.sin(yaw);
  out.z = -Math.cos(yaw);
}
export const chebyshev = (ax: number, az: number, bx: number, bz: number): number =>
  Math.max(Math.abs(ax - bx), Math.abs(az - bz));
