// src/world/connectivity.ts — connectivity repair (union-find + 0-1-3 BFS carving) and the shared walkability
// predicates used by rooms, validation and spawn search (WP1).
//
// Walkable cell: not SOLID|VOID|NOWALK|TOWER|ELEVATOR, water depth <= 1.1 m, blockCm === 0.
// Passable edge: EDGE_WALKABLE[kind] (HEADER only if hA >= 190) and (|Δfloor| <= 36 cm or a ramp solid links
// the two cells).
// Repair: port cells (inner cells of walkable seam edges) and targets are forced walkable; every component that
// holds a port or target, or has >= 3 cells, is joined to the main component (the one of the first port in N, E,
// S, W order) along the cheapest path: passable edge 0, interior non-frozen wall 1 (becomes `door`), SOLID cell
// 3 (cleared), frozen / reserved infinite. Components that stay unreachable: < 3 cells -> SOLID, else SEALED
// (except components holding a port cell, which are reached through the seam and left untouched).

import { CELL, CHUNK_CELLS, CHUNK_CELL_COUNT, PLAYER } from '../core/constants.ts';
import { EDGE_WALKABLE } from '../core/edges.ts';
import { cellIdx, exIdx, ezIdx } from '../core/grid.ts';
import { CellFlag, EdgeKind, EdgeTrim } from '../core/ids.ts';
import { NO_WATER, type ChunkLayout, type Port } from '../core/layout.ts';
import type { ChunkGrid } from '../core/world.ts';

const N = CHUNK_CELLS;
const STEP_CM = 36;
const HEADER_WALKABLE_CM = 190;
const WADE_CM = Math.round(PLAYER.wadeMaxDepth * 100); // 110
const NOT_WALKABLE = CellFlag.SOLID | CellFlag.VOID | CellFlag.NOWALK | CellFlag.TOWER | CellFlag.ELEVATOR;
const INF = 0x3fffffff;

/** Walkable cell (index lj*32+li). */
export function cellWalkable(l: ChunkLayout, c: number): boolean {
  if ((l.flags[c] & NOT_WALKABLE) !== 0 || l.blockCm[c] !== 0) return false;
  const w = l.waterCm[c];
  return w === NO_WATER || w - l.floorCm[c] <= WADE_CM;
}

/** Walkable edge kind (HEADER only when its underside is >= 190 cm). */
export const edgeKindWalkable = (kind: number, hA: number): boolean =>
  EDGE_WALKABLE[kind] && (kind !== EdgeKind.HEADER || hA >= HEADER_WALKABLE_CM);

/** A ramp solid of `l` links the two cells across interior edge (axis, i, j): the edge crosses the ramp along its
 * ascent axis, overlaps its width, and each side is either on the ramp or within a step of the ramp height there. */
export function rampLinks(l: ChunkLayout, axis: 'x' | 'z', i: number, j: number): boolean {
  if (l.solids.length === 0) return false;
  const along = axis === 'x' ? i * CELL : j * CELL; // edge line coordinate along the crossing axis
  const w0 = (axis === 'x' ? j : i) * CELL, w1 = w0 + CELL; // edge extent across
  const ca = axis === 'x' ? cellIdx(i - 1, j) : cellIdx(i, j - 1);
  const cb = cellIdx(i, j);
  for (const s of l.solids) {
    if (s.kind !== 'ramp') continue;
    const xAxis = s.dir === 0 || s.dir === 1;
    if (xAxis !== (axis === 'x')) continue;
    const a0 = Math.min(xAxis ? s.x0 : s.z0, xAxis ? s.x1 : s.z1), a1 = Math.max(xAxis ? s.x0 : s.z0, xAxis ? s.x1 : s.z1);
    const b0 = Math.min(xAxis ? s.z0 : s.x0, xAxis ? s.z1 : s.x1), b1 = Math.max(xAxis ? s.z0 : s.x0, xAxis ? s.z1 : s.x1);
    if (along < a0 - 0.01 || along > a1 + 0.01) continue;
    if (Math.min(w1, b1) - Math.max(w0, b0) < 0.3) continue;
    const lowAtMin = s.dir === 0 || s.dir === 2; // ascent toward +axis: low end at the min coordinate
    const len = a1 - a0;
    const t = len > 1e-6 ? (along - a0) / len : 0;
    const f = lowAtMin ? t : 1 - t;
    const hCm = (s.y0 + (s.y1 - s.y0) * f) * 100;
    const onRamp = (c: number): boolean => {
      const cx = ((c & 31) + 0.5) * CELL, cz = ((c >> 5) + 0.5) * CELL;
      const px = xAxis ? cx : cz, pw = xAxis ? cz : cx;
      return px > a0 && px < a1 && pw > b0 && pw < b1;
    };
    const okA = onRamp(ca) || Math.abs(l.floorCm[ca] - hCm) <= STEP_CM;
    const okB = onRamp(cb) || Math.abs(l.floorCm[cb] - hCm) <= STEP_CM;
    if (okA && okB) return true;
  }
  return false;
}

/** Passable INTERIOR edge (both cells inside the chunk): axis 'x' line i in 1..31, 'z' line j in 1..31. */
export function edgePassable(l: ChunkLayout, axis: 'x' | 'z', i: number, j: number): boolean {
  const e = axis === 'x' ? l.ex : l.ez;
  const k = axis === 'x' ? exIdx(i, j) : ezIdx(i, j);
  if (!edgeKindWalkable(e.kind[k], e.hA[k])) return false;
  const ca = axis === 'x' ? cellIdx(i - 1, j) : cellIdx(i, j - 1);
  const cb = cellIdx(i, j);
  if (Math.abs(l.floorCm[ca] - l.floorCm[cb]) <= STEP_CM) return true;
  return rampLinks(l, axis, i, j);
}

/** Inner cells of walkable seam edges, in N, E, S, W order (each side in increasing cell order). */
export function portCells(l: ChunkLayout): number[] {
  const out: number[] = [];
  for (let li = 0; li < N; li++) { const k = ezIdx(li, 0); if (edgeKindWalkable(l.ez.kind[k], l.ez.hA[k])) out.push(cellIdx(li, 0)); }
  for (let lj = 0; lj < N; lj++) { const k = exIdx(N, lj); if (edgeKindWalkable(l.ex.kind[k], l.ex.hA[k])) out.push(cellIdx(N - 1, lj)); }
  for (let li = 0; li < N; li++) { const k = ezIdx(li, N); if (edgeKindWalkable(l.ez.kind[k], l.ez.hA[k])) out.push(cellIdx(li, N - 1)); }
  for (let lj = 0; lj < N; lj++) { const k = exIdx(0, lj); if (edgeKindWalkable(l.ex.kind[k], l.ex.hA[k])) out.push(cellIdx(0, lj)); }
  return out;
}

/** Ports (maximal runs of walkable seam edges) of a layout's border lines. */
export function computePorts(l: ChunkLayout): Port[] {
  const out: Port[] = [];
  const side = (name: Port['side'], walk: (c: number) => boolean): void => {
    let from = -1;
    for (let c = 0; c <= N; c++) {
      const w = c < N && walk(c);
      if (w && from < 0) from = c;
      else if (!w && from >= 0) { out.push({ side: name, from, to: c }); from = -1; }
    }
  };
  side('W', (c) => edgeKindWalkable(l.ex.kind[exIdx(0, c)], l.ex.hA[exIdx(0, c)]));
  side('N', (c) => edgeKindWalkable(l.ez.kind[ezIdx(c, 0)], l.ez.hA[ezIdx(c, 0)]));
  side('E', (c) => edgeKindWalkable(l.ex.kind[exIdx(N, c)], l.ex.hA[exIdx(N, c)]));
  side('S', (c) => edgeKindWalkable(l.ez.kind[ezIdx(c, N)], l.ez.hA[ezIdx(c, N)]));
  return out;
}

/** Union-find over walkable cells joined by passable interior edges. Returns the parent array (-1 = not walkable). */
export function walkComponents(l: ChunkLayout, parent: Int32Array = new Int32Array(CHUNK_CELL_COUNT)): Int32Array {
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) parent[c] = cellWalkable(l, c) ? c : -1;
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      const c = cellIdx(li, lj);
      if (parent[c] < 0) continue;
      if (li > 0 && parent[c - 1] >= 0 && edgePassable(l, 'x', li, lj)) union(parent, c - 1, c);
      if (lj > 0 && parent[c - N] >= 0 && edgePassable(l, 'z', li, lj)) union(parent, c - N, c);
    }
  }
  return parent;
}

export function find(parent: Int32Array, c: number): number {
  let r = c;
  while (parent[r] !== r) r = parent[r];
  while (parent[c] !== r) { const n = parent[c]; parent[c] = r; c = n; }
  return r;
}
function union(parent: Int32Array, a: number, b: number): void {
  const ra = find(parent, a), rb = find(parent, b);
  if (ra === rb) return;
  if (ra < rb) parent[rb] = ra; else parent[ra] = rb; // root = lowest cell index
}

export function repairConnectivity(g: ChunkGrid, targets: readonly [number, number][], door: 'open' | 'doorway'): { carved: number; sealed: number } {
  const l = g.layout;
  const reservedCell = (c: number): boolean => (l.flags[c] & CellFlag.RESERVED) !== 0;
  const forceWalkable = (c: number): void => {
    if (reservedCell(c)) return;
    l.flags[c] &= ~CellFlag.SOLID;
    l.blockCm[c] = 0;
  };

  // ---- ports and targets are forced walkable first
  const ports = portCells(l);
  const special = new Uint8Array(CHUNK_CELL_COUNT);
  for (const c of ports) { forceWalkable(c); special[c] = 1; }
  for (const [li, lj] of targets) {
    if (li < 0 || lj < 0 || li >= N || lj >= N) continue;
    const c = cellIdx(li, lj);
    forceWalkable(c);
    special[c] = 1;
  }

  // ---- 1. components
  const parent = walkComponents(l);
  // ---- 2. main = component of the first (walkable) port in N, E, S, W order
  let mainCell = -1;
  for (const c of ports) if (parent[c] >= 0) { mainCell = c; break; }
  if (mainCell < 0) {
    for (let c = 0; c < CHUNK_CELL_COUNT; c++) if (parent[c] >= 0) { mainCell = c; break; }
  }
  if (mainCell < 0) return { carved: 0, sealed: 0 };

  // component summary, ascending lowest-cell-index order (roots ARE the lowest cell of their component)
  const size = new Int32Array(CHUNK_CELL_COUNT);
  const hasSpecial = new Uint8Array(CHUNK_CELL_COUNT);
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
    if (parent[c] < 0) continue;
    const r = find(parent, c);
    size[r]++;
    if (special[c]) hasSpecial[r] = 1;
  }
  const roots: number[] = [];
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) if (parent[c] === c) roots.push(c);

  let carved = 0;
  const dist = new Int32Array(CHUNK_CELL_COUNT);
  const prev = new Int32Array(CHUNK_CELL_COUNT);
  const edgeCost = (a: number, b: number): number => {
    // interior edge between adjacent cells a and b
    const ai = a & 31, aj = a >> 5, bi = b & 31, bj = b >> 5;
    const axis: 'x' | 'z' = aj === bj ? 'x' : 'z';
    const i = axis === 'x' ? Math.max(ai, bi) : ai, j = axis === 'z' ? Math.max(aj, bj) : aj;
    if (edgePassable(l, axis, i, j)) return 0;
    if (g.isFrozenEdge(axis, i, j) || reservedCell(a) || reservedCell(b)) return INF;
    if (Math.abs(l.floorCm[a] - l.floorCm[b]) > STEP_CM) return INF; // opening a wall does not remove a step
    return 1;
  };
  const cellCost = (c: number): number => {
    if (parent[c] >= 0) return 0;
    const f = l.flags[c];
    if ((f & CellFlag.RESERVED) !== 0) return INF;
    if ((f & (CellFlag.VOID | CellFlag.NOWALK | CellFlag.TOWER | CellFlag.ELEVATOR)) !== 0) return INF;
    const w = l.waterCm[c];
    if (w !== NO_WATER && w - l.floorCm[c] > WADE_CM) return INF;
    return 3; // SOLID and/or blocker: cleared
  };

  for (const root of roots) {
    const mainRoot = find(parent, mainCell);
    if (find(parent, root) === mainRoot) continue;
    if (!hasSpecial[root] && size[root] < 3) continue;
    // ---- 3. Dial's algorithm (costs 0, 1, 3, 4) from the component to main
    dist.fill(INF);
    prev.fill(-1);
    const buckets: number[][] = [[]];
    for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
      if (parent[c] >= 0 && find(parent, c) === root) { dist[c] = 0; buckets[0].push(c); }
    }
    let hit = -1;
    for (let d = 0; d < buckets.length && hit < 0; d++) {
      const bucket = buckets[d];
      for (let q = 0; q < bucket.length && hit < 0; q++) {
        const a = bucket[q];
        if (dist[a] !== d) continue;
        if (parent[a] >= 0 && find(parent, a) === mainRoot) { hit = a; break; }
        const ai = a & 31, aj = a >> 5;
        for (let dir = 0; dir < 4; dir++) {
          let b: number;
          if (dir === 0) { if (ai === 0) continue; b = a - 1; }
          else if (dir === 1) { if (ai === N - 1) continue; b = a + 1; }
          else if (dir === 2) { if (aj === 0) continue; b = a - N; }
          else { if (aj === N - 1) continue; b = a + N; }
          const cc = cellCost(b);
          if (cc >= INF) continue;
          const ec = edgeCost(a, b);
          if (ec >= INF) continue;
          const nd = d + ec + cc;
          if (nd < dist[b]) {
            dist[b] = nd;
            prev[b] = a;
            while (buckets.length <= nd) buckets.push([]);
            buckets[nd].push(b);
          }
        }
      }
    }
    if (hit < 0) continue;
    // ---- carve the path (walls -> door, SOLID -> clear) and merge everything on it into main
    for (let c = hit; prev[c] >= 0; c = prev[c]) {
      const p = prev[c];
      for (const x of [p, c]) {
        if (parent[x] < 0) {
          l.flags[x] &= ~CellFlag.SOLID;
          l.blockCm[x] = 0;
          parent[x] = x;
          carved++;
        }
      }
      const pi = p & 31, pj = p >> 5, ci = c & 31, cj = c >> 5;
      const axis: 'x' | 'z' = pj === cj ? 'x' : 'z';
      const i = axis === 'x' ? Math.max(pi, ci) : pi, j = axis === 'z' ? Math.max(pj, cj) : pj;
      if (!edgePassable(l, axis, i, j)) {
        const e = axis === 'x' ? l.ex : l.ez;
        const k = axis === 'x' ? exIdx(i, j) : ezIdx(i, j);
        const lowCeil = Math.min(l.ceilCm[p], l.ceilCm[c]) - Math.max(l.floorCm[p], l.floorCm[c]);
        const useDoor = door === 'doorway' && lowCeil >= 215;
        if (g.setEdge(axis, i, j, useDoor ? EdgeKind.DOORWAY : EdgeKind.OPEN, { trim: useDoor ? e.trim[k] | EdgeTrim.CASING : e.trim[k] })) carved++;
      }
      union(parent, p, c);
    }
    union(parent, root, hit);
  }

  // ---- 4. unreachable components: < 3 cells -> SOLID, otherwise SEALED.
  // Exception (logged in docs/contract-changes/WP1.md): a component that holds a PORT cell is entered from the
  // neighbour chunk across the seam, so it is neither SOLID (the port cell must stay walkable; the seam edge is
  // frozen and shared with the neighbour) nor SEALED (it is not a pocket "heard, not entered").
  let sealed = 0;
  const mainRoot = find(parent, mainCell);
  size.fill(0);
  hasSpecial.fill(0);
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) if (parent[c] >= 0) size[find(parent, c)]++;
  for (const c of ports) if (parent[c] >= 0) hasSpecial[find(parent, c)] = 1;
  const done = new Uint8Array(CHUNK_CELL_COUNT);
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
    if (parent[c] < 0) continue;
    const r = find(parent, c);
    if (r === mainRoot || hasSpecial[r]) continue;
    if (!done[r]) { done[r] = 1; sealed++; }
    if (size[r] < 3 && !reservedCell(c)) { l.flags[c] |= CellFlag.SOLID; l.blockCm[c] = 0; }
    else l.flags[c] |= CellFlag.SEALED;
  }
  return { carved, sealed };
}
