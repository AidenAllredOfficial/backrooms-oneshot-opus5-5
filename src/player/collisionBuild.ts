// src/player/collisionBuild.ts (WP12, PURE) — per-chunk collision acceleration, built in the worker via handleRequest.
//
// Output (chunk-local metres, see core/mesh.ts ChunkCollision):
//   boxes     n*6  x0,y0,z0,x1,y1,z1
//   boxFlags  n    SolidFlag bits (COLLIDE always; WALKABLE_TOP where the top is a floor the player may stand on)
//   cellStart 1025 CSR prefix offsets into cellBoxes
//   cellBoxes      indices of boxes whose XZ footprint, expanded by PLAYER.radius, overlaps the cell
//   ramps     n*8  x0,z0,x1,z1,y0,y1,dir,filled (walkable inclined planes: stair flights; filled = 1 for a
//                  SolidFlag.FILLED body, solid down to the floor, else 0: an open flight with a soffit)
//
// Sources (§5 WP12 "Collision build"):
//   * edges: core/edges edgePieces() of every EDGE_COLLIDES kind (GLITCH included), thickness edgeThickness(kind).
//     Pieces touching a grid vertex are extended by WALL_T/2 along the edge, which closes the corner square
//     where two perpendicular runs meet (the "posts") and caps free wall ends.
//   * SOLID cells (merged into greedy rectangles, full height), blockCm boxes (WALKABLE_TOP), NOWALK cells
//     (deep-water edges: virtual boxes), VOID cells (a pit floor at -TOWER_SPAN as a last-resort catch).
//   * expandPeriodicSolids (tower replicas): COLLIDE boxes, ramps, COLLIDE pipes (as AABBs).
//   * props (expandPeriodicProps): PROP_DEFS footprints with `collide` (or a COLLIDE override bit), yaw snapped
//     to 90 degrees, never CEILING-mounted props. DOOR_FRAME is emitted as two jambs + a head so lone door
//     frames can be walked through.
//   * cell-height steps: a cell whose floor is above a neighbour's gets a "riser" box [lowest neighbour floor,
//     floor] (WALKABLE_TOP) so floor steps block exactly like boxes (> stepMax blocks, <= stepMax is climbed); a
//     cell whose ceiling is below a neighbour's gets a "soffit" box [ceil, highest neighbour ceil] when the
//     ceiling is low enough to matter. Cells on the chunk border cannot see their out-of-chunk neighbour, so
//     they assume the worst case across any edge that is not a full wall (the boxes are harmless otherwise).
//
// Duplicate boxes from neighbouring chunks (core addSolid rule) are harmless: each chunk is queried on its own.

import { CELL, CHUNK_CELLS, CHUNK_CELL_COUNT, PLAYER, TOWER_SPAN, WALL_T } from '../core/constants.ts';
import { EDGE_COLLIDES, edgePieces, edgeThickness } from '../core/edges.ts';
import { cellIdx, chunkKeyStr, exIdx, ezIdx } from '../core/grid.ts';
import { CellFlag, EdgeKind, PropFlag, PropKind, SolidFlag } from '../core/ids.ts';
import type { ChunkLayout } from '../core/layout.ts';
import type { ChunkCollision } from '../core/mesh.ts';
import { PROP_DEFS } from '../core/props.ts';
import { expandPeriodicProps, expandPeriodicSolids } from '../mesh/periodic.ts';

/** Bottom / top of full-height masses (SOLID cells, border risers). Below every tower replica, above every ceiling. */
export const SOLID_Y0 = -TOWER_SPAN - 1;
export const SOLID_Y1_MIN = 12;
/** A ceiling lower than this above the lowest neighbouring floor can stop a standing player: emit a soffit box. */
export const SOFFIT_MATTERS = PLAYER.height + PLAYER.stepMax + 0.2;

const F_COLLIDE = SolidFlag.COLLIDE;
const F_WALK = SolidFlag.COLLIDE | SolidFlag.WALKABLE_TOP;
const EPS = 1e-6;
const HALF_POST = WALL_T / 2;

class BoxList {
  v: number[] = [];
  f: number[] = [];
  add(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, flags: number): void {
    if (!(x1 > x0 && y1 > y0 && z1 > z0)) return;
    if (!Number.isFinite(x0 + y0 + z0 + x1 + y1 + z1)) return;
    this.v.push(x0, y0, z0, x1, y1, z1);
    this.f.push(flags);
  }
  get count(): number { return this.f.length; }
}

const isSolid = (l: ChunkLayout, c: number): boolean => (l.flags[c] & CellFlag.SOLID) !== 0;
const isVoid = (l: ChunkLayout, c: number): boolean => (l.flags[c] & CellFlag.VOID) !== 0;
/** Floor height (m) used for neighbour comparisons; VOID cells have no floor (pit bottom at -TOWER_SPAN). */
const floorM = (l: ChunkLayout, c: number): number => (isVoid(l, c) ? -TOWER_SPAN : l.floorCm[c] / 100);
const ceilM = (l: ChunkLayout, c: number): number => l.ceilCm[c] / 100;

/** Edge kind between cell (li,lj) and its neighbour in direction d (0 W, 1 E, 2 N, 3 S). */
function sideEdgeKind(l: ChunkLayout, li: number, lj: number, d: number): number {
  switch (d) {
    case 0: return l.ex.kind[exIdx(li, lj)];
    case 1: return l.ex.kind[exIdx(li + 1, lj)];
    case 2: return l.ez.kind[ezIdx(li, lj)];
    default: return l.ez.kind[ezIdx(li, lj + 1)];
  }
}
const DI = [-1, 1, 0, 0];
const DJ = [0, 0, -1, 1];
const fullWall = (k: number): boolean => k === EdgeKind.WALL || k === EdgeKind.GLITCH;

export function buildChunkCollision(l: ChunkLayout): ChunkCollision {
  const B = new BoxList();
  const ramps: number[] = [];
  const N = CHUNK_CELLS;

  let maxCeil = 0;
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) if (!isSolid(l, c)) maxCeil = Math.max(maxCeil, ceilM(l, c));
  const solidY1 = Math.max(SOLID_Y1_MIN, maxCeil + 1);

  // ------------------------------------------------------------ edges
  const pieces = new Float32Array(32);
  const edge = (axis: 'x' | 'z', i: number, j: number): void => {
    const e = axis === 'x' ? l.ex : l.ez;
    const idx = axis === 'x' ? exIdx(i, j) : ezIdx(i, j);
    const kind = e.kind[idx];
    if (!EDGE_COLLIDES[kind]) return;
    // adjacent cells: 'x' => (i-1, j) | (i, j); 'z' => (i, j-1) | (i, j)
    let yLo = Infinity, ySill = -Infinity, yHi = -Infinity, known = 0;
    for (let s = 0; s < 2; s++) {
      const ci = axis === 'x' ? i - 1 + s : i;
      const cj = axis === 'x' ? j : j - 1 + s;
      if (ci < 0 || cj < 0 || ci >= N || cj >= N) continue;
      const c = cellIdx(ci, cj);
      if (isSolid(l, c)) continue;
      const f = floorM(l, c);
      yLo = Math.min(yLo, f); ySill = Math.max(ySill, f); yHi = Math.max(yHi, ceilM(l, c));
      known++;
    }
    if (known === 0) return; // buried in solid mass (the SOLID box covers it) or both sides unknown
    const n = edgePieces(kind, e.hA[idx], e.hB[idx], yLo, ySill, yHi, pieces);
    const th = edgeThickness(kind) / 2;
    const line = (axis === 'x' ? i : j) * CELL;
    const base = (axis === 'x' ? j : i) * CELL;
    for (let p = 0; p < n; p++) {
      let t0 = pieces[p * 4], t1 = pieces[p * 4 + 1];
      const y0 = pieces[p * 4 + 2], y1 = pieces[p * 4 + 3];
      if (t0 <= EPS) t0 -= HALF_POST;
      if (t1 >= CELL - 1e-4) t1 += HALF_POST;
      if (axis === 'x') B.add(line - th, y0, base + t0, line + th, y1, base + t1, F_COLLIDE);
      else B.add(base + t0, y0, line - th, base + t1, y1, line + th, F_COLLIDE);
    }
  };
  for (let lj = 0; lj < N; lj++) for (let i = 0; i <= N; i++) edge('x', i, lj);
  for (let j = 0; j <= N; j++) for (let li = 0; li < N; li++) edge('z', li, j);

  // ------------------------------------------------------------ SOLID cells: greedy rectangles
  const used = new Uint8Array(CHUNK_CELL_COUNT);
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      const c0 = cellIdx(li, lj);
      if (used[c0] || !isSolid(l, c0)) continue;
      let w = 1;
      while (li + w < N && !used[cellIdx(li + w, lj)] && isSolid(l, cellIdx(li + w, lj))) w++;
      let h = 1;
      for (;;) {
        if (lj + h >= N) break;
        let ok = true;
        for (let k = 0; k < w; k++) {
          const c = cellIdx(li + k, lj + h);
          if (used[c] || !isSolid(l, c)) { ok = false; break; }
        }
        if (!ok) break;
        h++;
      }
      for (let b = 0; b < h; b++) for (let a = 0; a < w; a++) used[cellIdx(li + a, lj + b)] = 1;
      B.add(li * CELL, SOLID_Y0, lj * CELL, (li + w) * CELL, solidY1, (lj + h) * CELL, F_COLLIDE);
    }
  }

  // ------------------------------------------------------------ per-cell boxes: blockers, NOWALK, VOID, risers, soffits
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      const c = cellIdx(li, lj);
      if (isSolid(l, c)) continue;
      const x0 = li * CELL, z0 = lj * CELL, x1 = x0 + CELL, z1 = z0 + CELL;
      const flags = l.flags[c];
      const f = floorM(l, c), ce = ceilM(l, c);
      if (flags & CellFlag.VOID) {
        // pits: there is no floor; a catch floor at the pit bottom keeps a player that is not warped away bounded
        B.add(x0, -TOWER_SPAN - 0.2, z0, x1, -TOWER_SPAN, z1, F_WALK);
        continue;
      }
      if (flags & CellFlag.NOWALK) {
        // deep-water edge: a virtual box over the whole cell (never enter)
        B.add(x0, Math.min(f, SOLID_Y0), z0, x1, Math.max(ce, f + PLAYER.height + 1), z1, F_COLLIDE);
        continue;
      }
      if (l.blockCm[c] > 0) B.add(x0, f, z0, x1, f + l.blockCm[c] / 100, z1, F_WALK);

      // neighbour heights
      let lower = f, upper = ce, lowestFloor = f;
      for (let d = 0; d < 4; d++) {
        const ni = li + DI[d], nj = lj + DJ[d];
        const k = sideEdgeKind(l, li, lj, d);
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) {
          if (fullWall(k)) continue;
          lower = Math.min(lower, SOLID_Y0); // unknown out-of-chunk neighbour: worst case
          upper = Math.max(upper, ce + 1);
          continue;
        }
        const nc = cellIdx(ni, nj);
        if (isSolid(l, nc)) continue;
        const nf = floorM(l, nc);
        lower = Math.min(lower, nf);
        lowestFloor = Math.min(lowestFloor, nf);
        upper = Math.max(upper, ceilM(l, nc));
      }
      if (lower < f - 1e-3) B.add(x0, lower, z0, x1, f, z1, F_WALK);
      if (upper > ce + 1e-3 && ce - lowestFloor < SOFFIT_MATTERS) B.add(x0, ce, z0, x1, upper, z1, F_COLLIDE);
    }
  }

  // ------------------------------------------------------------ solids (tower replicas included)
  for (const s of expandPeriodicSolids(l)) {
    if (s.kind === 'box') {
      if (!(s.flags & SolidFlag.COLLIDE)) continue;
      B.add(s.min[0], s.min[1], s.min[2], s.max[0], s.max[1], s.max[2], (s.flags & SolidFlag.WALKABLE_TOP) ? F_WALK : F_COLLIDE);
    } else if (s.kind === 'ramp') {
      if (!(s.flags & (SolidFlag.COLLIDE | SolidFlag.WALKABLE_TOP))) continue;
      ramps.push(Math.min(s.x0, s.x1), Math.min(s.z0, s.z1), Math.max(s.x0, s.x1), Math.max(s.z0, s.z1), s.y0, s.y1, s.dir, (s.flags & SolidFlag.FILLED) !== 0 ? 1 : 0);
    } else if (s.kind === 'pipe') {
      if (!(s.flags & SolidFlag.COLLIDE)) continue;
      const r = s.r;
      B.add(Math.min(s.a[0], s.b[0]) - r, Math.min(s.a[1], s.b[1]) - r, Math.min(s.a[2], s.b[2]) - r,
        Math.max(s.a[0], s.b[0]) + r, Math.max(s.a[1], s.b[1]) + r, Math.max(s.a[2], s.b[2]) + r, F_COLLIDE);
    }
  }

  // ------------------------------------------------------------ props
  for (const p of expandPeriodicProps(l)) {
    const def = PROP_DEFS[p.kind];
    if (!def) continue;
    if (p.flags & PropFlag.CEILING) continue; // CEILING_FURNITURE: no collision
    if (!def.collide && !(p.flags & SolidFlag.COLLIDE)) continue;
    const q = (((Math.round(p.yaw / (Math.PI / 2)) % 4) + 4) % 4) & 1;
    const k = p.scale > 0 ? p.scale : 1;
    const sx = def.size[0] * k, sy = def.size[1] * k, sz = def.size[2] * k;
    const hx = (q ? sz : sx) / 2, hz = (q ? sx : sz) / 2;
    if (p.kind === PropKind.DOOR_FRAME) {
      // two jambs + head (opening 0.9 m x 2.08 m scaled), so a lone door frame is passable
      const along = q ? hz : hx; // half-width along the frame
      const jamb = Math.max(0.05, along - 0.45 * k);
      const head = 2.08 * k;
      if (q === 0) {
        B.add(p.x - hx, p.y, p.z - hz, p.x - hx + jamb, p.y + sy, p.z + hz, F_COLLIDE);
        B.add(p.x + hx - jamb, p.y, p.z - hz, p.x + hx, p.y + sy, p.z + hz, F_COLLIDE);
        B.add(p.x - hx, p.y + head, p.z - hz, p.x + hx, p.y + sy, p.z + hz, F_COLLIDE);
      } else {
        B.add(p.x - hx, p.y, p.z - hz, p.x + hx, p.y + sy, p.z - hz + jamb, F_COLLIDE);
        B.add(p.x - hx, p.y, p.z + hz - jamb, p.x + hx, p.y + sy, p.z + hz, F_COLLIDE);
        B.add(p.x - hx, p.y + head, p.z - hz, p.x + hx, p.y + sy, p.z + hz, F_COLLIDE);
      }
      continue;
    }
    B.add(p.x - hx, p.y, p.z - hz, p.x + hx, p.y + sy, p.z + hz, F_WALK);
  }

  // ------------------------------------------------------------ cell buckets (CSR)
  const nb = B.count;
  const boxes = new Float32Array(B.v);
  const boxFlags = new Uint8Array(B.f);
  const r = PLAYER.radius;
  const range = (a0: number, a1: number, out: Int32Array): boolean => {
    const i0 = Math.max(0, Math.floor((a0 - r) / CELL));
    const i1 = Math.min(N - 1, Math.floor((a1 + r) / CELL - 1e-9));
    out[0] = i0; out[1] = i1;
    return i1 >= i0;
  };
  const rx = new Int32Array(2), rz = new Int32Array(2);
  const counts = new Uint32Array(CHUNK_CELL_COUNT + 1);
  for (let b = 0; b < nb; b++) {
    if (!range(boxes[b * 6], boxes[b * 6 + 3], rx) || !range(boxes[b * 6 + 2], boxes[b * 6 + 5], rz)) continue;
    for (let lj = rz[0]; lj <= rz[1]; lj++) for (let li = rx[0]; li <= rx[1]; li++) counts[cellIdx(li, lj) + 1]++;
  }
  const cellStart = new Uint32Array(CHUNK_CELL_COUNT + 1);
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) cellStart[c + 1] = cellStart[c] + counts[c + 1];
  const cellBoxes = new Uint32Array(cellStart[CHUNK_CELL_COUNT]);
  const fill = cellStart.slice(0, CHUNK_CELL_COUNT);
  for (let b = 0; b < nb; b++) {
    if (!range(boxes[b * 6], boxes[b * 6 + 3], rx) || !range(boxes[b * 6 + 2], boxes[b * 6 + 5], rz)) continue;
    for (let lj = rz[0]; lj <= rz[1]; lj++) for (let li = rx[0]; li <= rx[1]; li++) cellBoxes[fill[cellIdx(li, lj)]++] = b;
  }

  return { chunkKey: chunkKeyStr(l.key), boxes, boxFlags, cellStart, cellBoxes, ramps: new Float32Array(ramps) };
}

/** Height of a ramp record (8 floats at `o` in `ramps`) at chunk-local (x, z); NaN outside its footprint. */
export function rampHeightAt(ramps: Float32Array, o: number, x: number, z: number): number {
  const x0 = ramps[o], z0 = ramps[o + 1], x1 = ramps[o + 2], z1 = ramps[o + 3];
  const e = 1e-3; // Float32 storage: accept the exact edges of the footprint
  if (x < x0 - e || x > x1 + e || z < z0 - e || z > z1 + e) return NaN;
  const y0 = ramps[o + 4], y1 = ramps[o + 5], dir = ramps[o + 6];
  let t: number;
  switch (dir) {
    case 0: t = (x - x0) / (x1 - x0); break; // ascends toward +x
    case 1: t = (x1 - x) / (x1 - x0); break; // ascends toward -x
    case 2: t = (z - z0) / (z1 - z0); break; // ascends toward +z
    default: t = (z1 - z) / (z1 - z0); break; // ascends toward -z
  }
  return y0 + (y1 - y0) * (t < 0 ? 0 : t > 1 ? 1 : t);
}
