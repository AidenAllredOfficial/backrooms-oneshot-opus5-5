// src/world/structures/util.ts — shared helpers for the R2 architecture stamps that zone generators call from inside
// generate() (split levels, light wells, open plenums, doors, windows, zone-transition connectors):
// connectivity measurement from the seam ports, edge / cell snapshots for try-and-revert, side-of-cell edge access.
// Pure module: no three / DOM / Math.random.

import { CELL, CHUNK_CELLS, CHUNK_CELL_COUNT } from '../../core/constants.ts';
import { cellIdx, exIdx, ezIdx } from '../../core/grid.ts';
import { CellFlag, EdgeKind, SolidFlag } from '../../core/ids.ts';
import type { ChunkLayout } from '../../core/layout.ts';
import type { ChunkGrid, EdgeOpts } from '../../core/world.ts';
import { cellWalkable, edgeKindWalkable, edgePassable, portCells } from '../connectivity.ts';

export const N = CHUNK_CELLS;
export const inChunk = (li: number, lj: number): boolean => li >= 0 && lj >= 0 && li < N && lj < N;

/** Direction tables: 0 = +x, 1 = -x, 2 = +z, 3 = -z (Solid ramp `dir` encoding). */
export const DX: readonly number[] = [1, -1, 0, 0];
export const DZ: readonly number[] = [0, 0, 1, -1];

/** The edge on side d of cell (li, lj): axis, line index i / j (edge coordinates as in ChunkGrid.setEdge). */
export function sideEdge(li: number, lj: number, d: number): { axis: 'x' | 'z'; i: number; j: number } {
  switch (d) {
    case 0: return { axis: 'x', i: li + 1, j: lj };
    case 1: return { axis: 'x', i: li, j: lj };
    case 2: return { axis: 'z', i: li, j: lj + 1 };
    default: return { axis: 'z', i: li, j: lj };
  }
}
export function edgeKindAt(l: ChunkLayout, axis: 'x' | 'z', i: number, j: number): number {
  return axis === 'x' ? l.ex.kind[exIdx(i, j)] : l.ez.kind[ezIdx(i, j)];
}
export function edgeHAAt(l: ChunkLayout, axis: 'x' | 'z', i: number, j: number): number {
  return axis === 'x' ? l.ex.hA[exIdx(i, j)] : l.ez.hA[ezIdx(i, j)];
}
/** Interior edge (both cells inside the chunk): lines 1..31. */
export const interiorEdge = (axis: 'x' | 'z', i: number, j: number): boolean =>
  axis === 'x' ? i > 0 && i < N && j >= 0 && j < N : j > 0 && j < N && i >= 0 && i < N;

/** Number of walkable cells reached from the seam ports over passable interior edges (WP1 rule, ramps included). */
export function reachFromPorts(l: ChunkLayout, seen: Uint8Array = new Uint8Array(CHUNK_CELL_COUNT), queue: Int32Array = new Int32Array(CHUNK_CELL_COUNT)): number {
  seen.fill(0);
  let head = 0, tail = 0;
  for (const c of portCells(l)) {
    if (seen[c] || !cellWalkable(l, c)) continue;
    seen[c] = 1; queue[tail++] = c;
  }
  while (head < tail) {
    const c = queue[head++];
    const li = c & 31, lj = c >> 5;
    if (li > 0 && !seen[c - 1] && cellWalkable(l, c - 1) && edgePassable(l, 'x', li, lj)) { seen[c - 1] = 1; queue[tail++] = c - 1; }
    if (li < N - 1 && !seen[c + 1] && cellWalkable(l, c + 1) && edgePassable(l, 'x', li + 1, lj)) { seen[c + 1] = 1; queue[tail++] = c + 1; }
    if (lj > 0 && !seen[c - N] && cellWalkable(l, c - N) && edgePassable(l, 'z', li, lj)) { seen[c - N] = 1; queue[tail++] = c - N; }
    if (lj < N - 1 && !seen[c + N] && cellWalkable(l, c + N) && edgePassable(l, 'z', li, lj + 1)) { seen[c + N] = 1; queue[tail++] = c + N; }
  }
  return tail;
}

/** Walkable cells that are NOT reached from the ports (0 = the chunk is one piece as seen from its seams). */
export function unreachedWalkable(l: ChunkLayout, seen?: Uint8Array): number {
  const s = seen ?? new Uint8Array(CHUNK_CELL_COUNT);
  reachFromPorts(l, s);
  let n = 0;
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) if (!s[c] && cellWalkable(l, c)) n++;
  return n;
}

/** Snapshot of everything the R2 stamps may write (edges, per-cell arrays, content array lengths), for
 * try-then-revert placement. Cheap: typed-array copies of ~20 KB. */
export interface Snapshot {
  ex: Uint8Array[]; exH: Int16Array[]; ez: Uint8Array[]; ezH: Int16Array[];
  flags: Uint16Array; floorCm: Int16Array; ceilCm: Int16Array; waterCm: Int16Array; blockCm: Int16Array;
  floorMat: Uint8Array; ceilMat: Uint8Array; ceilKind: Uint8Array; tiles: Uint16Array; wallMat: Uint8Array;
  n: { fixtures: number; solids: number; props: number; decals: number; water: number; emitters: number };
}
export function snapshot(l: ChunkLayout): Snapshot {
  return {
    ex: [l.ex.kind.slice(), l.ex.matNeg.slice(), l.ex.matPos.slice(), l.ex.trim.slice()], exH: [l.ex.hA.slice(), l.ex.hB.slice()],
    ez: [l.ez.kind.slice(), l.ez.matNeg.slice(), l.ez.matPos.slice(), l.ez.trim.slice()], ezH: [l.ez.hA.slice(), l.ez.hB.slice()],
    flags: l.flags.slice(), floorCm: l.floorCm.slice(), ceilCm: l.ceilCm.slice(), waterCm: l.waterCm.slice(), blockCm: l.blockCm.slice(),
    floorMat: l.floorMat.slice(), ceilMat: l.ceilMat.slice(), ceilKind: l.ceilKind.slice(), tiles: l.tiles.slice(), wallMat: l.wallMat.slice(),
    n: { fixtures: l.fixtures.length, solids: l.solids.length, props: l.props.length, decals: l.decals.length, water: l.water.length, emitters: l.emitters.length },
  };
}
export function restore(l: ChunkLayout, s: Snapshot): void {
  l.ex.kind.set(s.ex[0]); l.ex.matNeg.set(s.ex[1]); l.ex.matPos.set(s.ex[2]); l.ex.trim.set(s.ex[3]); l.ex.hA.set(s.exH[0]); l.ex.hB.set(s.exH[1]);
  l.ez.kind.set(s.ez[0]); l.ez.matNeg.set(s.ez[1]); l.ez.matPos.set(s.ez[2]); l.ez.trim.set(s.ez[3]); l.ez.hA.set(s.ezH[0]); l.ez.hB.set(s.ezH[1]);
  l.flags.set(s.flags); l.floorCm.set(s.floorCm); l.ceilCm.set(s.ceilCm); l.waterCm.set(s.waterCm); l.blockCm.set(s.blockCm);
  l.floorMat.set(s.floorMat); l.ceilMat.set(s.ceilMat); l.ceilKind.set(s.ceilKind); l.tiles.set(s.tiles); l.wallMat.set(s.wallMat);
  l.fixtures.length = s.n.fixtures; l.solids.length = s.n.solids; l.props.length = s.n.props; l.decals.length = s.n.decals;
  l.water.length = s.n.water; l.emitters.length = s.n.emitters;
}

/** A cell that is plain walkable floor a stamp may take over: inside, not reserved / SOLID / VOID / NOWALK / blocked. */
export function plainCell(g: ChunkGrid, li: number, lj: number): boolean {
  if (!inChunk(li, lj) || g.isReserved(li, lj)) return false;
  const l = g.layout, c = cellIdx(li, lj);
  return (l.flags[c] & (CellFlag.SOLID | CellFlag.VOID | CellFlag.NOWALK | CellFlag.TOWER | CellFlag.ELEVATOR)) === 0 && l.blockCm[c] === 0;
}

/** Does any ramp / box solid footprint overlap the cell rect [i0,i1) x [j0,j1)? */
export function solidsInRect(l: ChunkLayout, i0: number, j0: number, i1: number, j1: number): boolean {
  const x0 = i0 * CELL, z0 = j0 * CELL, x1 = i1 * CELL, z1 = j1 * CELL;
  for (const s of l.solids) {
    let a0: number, a1: number, b0: number, b1: number;
    if (s.kind === 'box') { a0 = s.min[0]; a1 = s.max[0]; b0 = s.min[2]; b1 = s.max[2]; }
    else if (s.kind === 'ramp') { a0 = s.x0; a1 = s.x1; b0 = s.z0; b1 = s.z1; }
    else { a0 = Math.min(s.a[0], s.b[0]) - s.r; a1 = Math.max(s.a[0], s.b[0]) + s.r; b0 = Math.min(s.a[2], s.b[2]) - s.r; b1 = Math.max(s.a[2], s.b[2]) + s.r; }
    if (a0 < x1 - 1e-6 && a1 > x0 + 1e-6 && b0 < z1 - 1e-6 && b1 > z0 + 1e-6) return true;
  }
  return false;
}

/** Any prop whose base point lies inside the cell rect? */
export function propsInRect(l: ChunkLayout, i0: number, j0: number, i1: number, j1: number): boolean {
  for (const p of l.props) {
    const li = Math.floor(p.x / CELL), lj = Math.floor(p.z / CELL);
    if (li >= i0 && li < i1 && lj >= j0 && lj < j1) return true;
  }
  return false;
}

/** Writes an edge unless frozen; keeps the existing materials / trim unless given. */
export function putEdge(g: ChunkGrid, axis: 'x' | 'z', i: number, j: number, kind: number, o?: EdgeOpts): boolean {
  if (!interiorEdge(axis, i, j) || g.isFrozenEdge(axis, i, j)) return false;
  return g.setEdge(axis, i, j, kind, o);
}

/** Edge kind is walkable (HEADER only when >= 190 cm). */
export const walkKind = edgeKindWalkable;

/** Rendered-only solid flag sets. */
export const DECO_FLAGS = SolidFlag.RENDER;
export const OCC_FLAGS = SolidFlag.RENDER | SolidFlag.OCCLUDE;
export const WALK_SOLID = SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.WALKABLE_TOP | SolidFlag.RENDER;
export const BOX_SOLID = SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.RENDER;

/** Is edge (axis, i, j) a plain OPEN edge (both cells inside)? */
export const isOpenEdge = (l: ChunkLayout, axis: 'x' | 'z', i: number, j: number): boolean => edgeKindAt(l, axis, i, j) === EdgeKind.OPEN;
