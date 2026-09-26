// src/mesh/tileGrid.ts — WP5 private: flat per-tile window over a LayoutNeighborhood (cells and edges of the tile
// plus an M-cell margin), in tile-relative indices. Pure module (no three/DOM).
//
// Tile-relative cell (ci, cj): chunk-relative cell (li0 + ci, lj0 + cj), tile-local metres [ci*CELL, (ci+1)*CELL).
// Edges use one uniform address: axis a = 0 for x-lines (plane x = L*CELL, running along z), a = 1 for z-lines
// (plane z = L*CELL, running along x); L = tile-relative line, c = tile-relative cell along the line.
//   a = 0: cells A = (L-1, c) (the -x side), B = (L, c);   a = 1: A = (c, L-1) (the -z side), B = (c, L).

import { CELL, CHUNK_CELLS, TILE_CELLS } from '../core/constants.ts';
import { floorDiv, tileCell0, type TileKey } from '../core/grid.ts';
import { CellFlag, StructureKind } from '../core/ids.ts';
import { NO_WATER, type ChunkLayout, type EdgeGrid } from '../core/layout.ts';
import type { LayoutNeighborhood } from '../core/world.ts';

export const M = 3; // margin cells around the tile
export const GW = TILE_CELLS + 2 * M; // window width in cells
export const NE = GW * (GW + 1); // edges per axis in the window
export const PIT_BOTTOM = -6; // m, bottom of VOID pits and of tower shafts
export const TOWER_Y = 6; // m, tower cells span [-6, 6]

const N = CHUNK_CELLS;

export class TileGrid {
  readonly nb: LayoutNeighborhood;
  readonly tile: TileKey;
  readonly li0: number;
  readonly lj0: number;
  /** chunk-local metres of the tile origin */
  readonly ox: number;
  readonly oz: number;
  // ---- cells (index cix(ci, cj))
  readonly flags = new Uint16Array(GW * GW);
  readonly floorCm = new Int16Array(GW * GW);
  readonly ceilCm = new Int16Array(GW * GW);
  readonly waterCm = new Int16Array(GW * GW);
  readonly blockCm = new Int16Array(GW * GW);
  readonly floorMat = new Uint8Array(GW * GW);
  readonly ceilMat = new Uint8Array(GW * GW);
  readonly ceilKind = new Uint8Array(GW * GW);
  readonly tiles = new Uint16Array(GW * GW);
  readonly wallMat = new Uint8Array(GW * GW);
  readonly trimMat = new Uint8Array(GW * GW);
  readonly warmth = new Uint8Array(GW * GW);
  readonly group = new Float64Array(GW * GW); // bake group of the cell (tower / elevator structure), 0 = storey
  // ---- edges (index eix(a, L, c))
  readonly eKind = new Uint8Array(2 * NE);
  readonly eHA = new Int16Array(2 * NE);
  readonly eHB = new Int16Array(2 * NE);
  readonly eMatNeg = new Uint8Array(2 * NE);
  readonly eMatPos = new Uint8Array(2 * NE);
  readonly eTrim = new Uint8Array(2 * NE);
  private regionCache = new Int32Array(GW * GW).fill(-1);

  constructor(nb: LayoutNeighborhood, tile: TileKey) {
    this.nb = nb;
    this.tile = tile;
    const [li0, lj0] = tileCell0(tile.q);
    this.li0 = li0;
    this.lj0 = lj0;
    this.ox = li0 * CELL;
    this.oz = lj0 * CELL;
    for (let cj = -M; cj < TILE_CELLS + M; cj++) {
      for (let ci = -M; ci < TILE_CELLS + M; ci++) {
        const k = cix(ci, cj);
        const li = li0 + ci, lj = lj0 + cj;
        const dcx = floorDiv(li, N), dcz = floorDiv(lj, N);
        if (dcx < -1 || dcx > 1 || dcz < -1 || dcz > 1) { this.flags[k] = CellFlag.SOLID; continue; }
        const l = nb.get(dcx as -1 | 0 | 1, dcz as -1 | 0 | 1);
        const idx = (lj - dcz * N) * N + (li - dcx * N);
        this.flags[k] = l.flags[idx];
        this.floorCm[k] = l.floorCm[idx];
        this.ceilCm[k] = l.ceilCm[idx];
        this.waterCm[k] = l.waterCm[idx];
        this.blockCm[k] = l.blockCm[idx];
        this.floorMat[k] = l.floorMat[idx];
        this.ceilMat[k] = l.ceilMat[idx];
        this.ceilKind[k] = l.ceilKind[idx];
        this.tiles[k] = l.tiles[idx];
        this.wallMat[k] = l.wallMat ? l.wallMat[idx] : 0;
        this.trimMat[k] = l.trimMat ? l.trimMat[idx] : 4;
        this.warmth[k] = l.warmth[idx];
      }
    }
    // structure bake groups (towers / elevators), from all 9 layouts
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const l = nb.get(dx as -1 | 0 | 1, dz as -1 | 0 | 1);
        for (const s of l.structures) {
          if ((s.kind !== StructureKind.TOWER && s.kind !== StructureKind.ELEVATOR) || s.bakeGroup === 0) continue;
          for (let lj = s.j0; lj < s.j1; lj++) {
            for (let li = s.i0; li < s.i1; li++) {
              const ci = li + dx * N - li0, cj = lj + dz * N - lj0;
              if (ci < -M || cj < -M || ci >= TILE_CELLS + M || cj >= TILE_CELLS + M) continue;
              const k = cix(ci, cj);
              if (this.flags[k] & (CellFlag.TOWER | CellFlag.ELEVATOR)) this.group[k] = s.bakeGroup;
            }
          }
        }
      }
    }
    // edges
    for (let a = 0; a < 2; a++) {
      for (let c = -M; c < TILE_CELLS + M; c++) {
        for (let L = -M; L <= TILE_CELLS + M; L++) {
          const k = eix(a, L, c);
          const loc = this.edgeLoc(a, L, c);
          if (!loc) continue;
          const [eg, idx] = loc;
          this.eKind[k] = eg.kind[idx];
          this.eHA[k] = eg.hA[idx];
          this.eHB[k] = eg.hB[idx];
          this.eMatNeg[k] = eg.matNeg[idx];
          this.eMatPos[k] = eg.matPos[idx];
          this.eTrim[k] = eg.trim[idx];
        }
      }
    }
  }

  /** Edge grid + index of a tile-relative edge (any position inside the 3x3 neighbourhood). */
  edgeLoc(a: number, L: number, c: number): [EdgeGrid, number] | null {
    const lineC = (a === 0 ? this.li0 : this.lj0) + L; // chunk-relative line
    const alongC = (a === 0 ? this.lj0 : this.li0) + c; // chunk-relative cell along the line
    if (lineC < -N || lineC > 2 * N || alongC < -N || alongC >= 2 * N) return null;
    const dl = lineC < 0 ? -1 : lineC > N ? 1 : 0;
    const dc = floorDiv(alongC, N);
    const lay: ChunkLayout = a === 0 ? this.nb.get(dl as -1 | 0 | 1, dc as -1 | 0 | 1) : this.nb.get(dc as -1 | 0 | 1, dl as -1 | 0 | 1);
    const ln = lineC - dl * N, al = alongC - dc * N;
    return a === 0 ? [lay.ex, al * 33 + ln] : [lay.ez, ln * 32 + al];
  }

  /** Cell layout + local index for any tile-relative cell inside the neighbourhood. */
  cellLoc(ci: number, cj: number): [ChunkLayout, number] | null {
    const li = this.li0 + ci, lj = this.lj0 + cj;
    const dcx = floorDiv(li, N), dcz = floorDiv(lj, N);
    if (dcx < -1 || dcx > 1 || dcz < -1 || dcz > 1) return null;
    return [this.nb.get(dcx as -1 | 0 | 1, dcz as -1 | 0 | 1), (lj - dcz * N) * N + (li - dcx * N)];
  }

  inTile(ci: number, cj: number): boolean { return ci >= 0 && cj >= 0 && ci < TILE_CELLS && cj < TILE_CELLS; }
  inWin(ci: number, cj: number): boolean { return ci >= -M && cj >= -M && ci < TILE_CELLS + M && cj < TILE_CELLS + M; }
  isSolid(k: number): boolean { return (this.flags[k] & CellFlag.SOLID) !== 0; }
  isVoid(k: number): boolean { return (this.flags[k] & CellFlag.VOID) !== 0; }
  isTower(k: number): boolean { return (this.flags[k] & CellFlag.TOWER) !== 0; }
  /** metres */
  floor(k: number): number { return this.isTower(k) ? -TOWER_Y : this.floorCm[k] / 100; }
  ceil(k: number): number { return this.isTower(k) ? TOWER_Y : this.ceilCm[k] / 100; }
  /** Lowest visible y of faces owned by the cell (blocker tops hide what is below them). */
  bottom(k: number): number {
    if (this.isVoid(k) || this.isTower(k)) return PIT_BOTTOM;
    return (this.floorCm[k] + Math.max(0, this.blockCm[k])) / 100;
  }
  top(k: number): number { return this.ceil(k); }
  /** Water surface (m) above the cell floor, or NaN. */
  waterY(k: number): number {
    const w = this.waterCm[k];
    if (w === NO_WATER || this.isSolid(k)) return NaN;
    return w > this.floorCm[k] ? w / 100 : NaN;
  }
  /** Cell has a walkable-style floor surface (not SOLID / VOID / TOWER). */
  hasFloor(k: number): boolean { return (this.flags[k] & (CellFlag.SOLID | CellFlag.VOID | CellFlag.TOWER)) === 0; }
  /** Light-region label (nb.region) of a tile-relative cell. */
  region(ci: number, cj: number): number {
    const k = cix(ci, cj);
    let r = this.regionCache[k];
    if (r < 0) { r = this.nb.region(this.li0 + ci, this.lj0 + cj); this.regionCache[k] = r; }
    return r;
  }
  /** Cell containing a tile-local point (may be outside the tile). */
  cellAt(x: number, z: number): [number, number] {
    return [Math.floor(x / CELL + 1e-7), Math.floor(z / CELL + 1e-7)];
  }
}

export const cix = (ci: number, cj: number): number => (cj + M) * GW + (ci + M);
/** Inverse of cix. */
export const cixInv = (k: number): [number, number] => [(k % GW) - M, Math.floor(k / GW) - M];
export const eix = (a: number, L: number, c: number): number => a * NE + (c + M) * (GW + 1) + (L + M);
/** Tile-relative cells on the -/+ side of an edge. */
export function edgeCells(a: number, L: number, c: number): [number, number, number, number] {
  return a === 0 ? [L - 1, c, L, c] : [c, L - 1, c, L];
}
