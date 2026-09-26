// src/mesh/solids.ts — WP5 solids (§5 WP5 rules 1b and 7): box solids of nb.center (after expandPeriodicSolids),
// faces split at cell lines and filtered by ownership, flush/covered faces culled, overlapping coplanar faces of
// two boxes emitted once, one BOX chart per box face;
// blocker cells (blockCm > 0): greedy tops (their sides are edge-line faces, see walls.ts). Pure module.

import { CELL, TILE_CELLS, TILE_SIZE } from '../core/constants.ts';
import { SolidFlag, VFlag } from '../core/ids.ts';
import type { Solid } from '../core/layout.ts';
import type { ChartKindId } from '../core/mesh.ts';
import { greedyRects, subtractRects } from './geom.ts';
import { hQuad, state, type ChartSpec, type Face, type Plan } from './plan.ts';
import { cix, type TileGrid } from './tileGrid.ts';
import { kf, q4 } from './uv.ts';
import { addVSplit, hSpec, underwater, vSpec } from './walls.ts';

const K_BOX = 5 as ChartKindId;
const EPS = 1e-5;
export type Box = Extract<Solid, { kind: 'box' }>;

/** Tile-local AABB of a box: [x0, y0, z0, x1, y1, z1]. */
const local = (g: TileGrid, b: Box): number[] => [b.min[0] - g.ox, b.min[1], b.min[2] - g.oz, b.max[0] - g.ox, b.max[1], b.max[2] - g.oz];

/** Is the rect on face (axis, plane, sign) covered by another render box on its outside? */
function covered(boxes: number[][], self: number, axis: number, plane: number, sign: number, lo: number[], hi: number[]): boolean {
  const o1 = axis === 0 ? 1 : 0, o2 = axis === 2 ? 1 : 2;
  for (let i = 0; i < boxes.length; i++) {
    if (i === self) continue;
    const b = boxes[i];
    const out = sign > 0 ? b[axis] <= plane + 1e-4 && b[axis + 3] >= plane + 1e-3 : b[axis + 3] >= plane - 1e-4 && b[axis] <= plane - 1e-3;
    if (!out) continue;
    if (b[o1] <= lo[0] + 1e-4 && b[o1 + 3] >= hi[0] - 1e-4 && b[o2] <= lo[1] + 1e-4 && b[o2 + 3] >= hi[1] - 1e-4) return true;
  }
  return false;
}

/** Split [a, b] at multiples of CELL, clipped to the tile. */
function cellSplits(a: number, b: number): number[] {
  const out: number[] = [];
  let x = Math.max(a, 0);
  const end = Math.min(b, TILE_SIZE);
  while (x < end - EPS) {
    const nx = Math.min(end, (Math.floor(x / CELL + 1e-7) + 1) * CELL);
    out.push(x, nx);
    x = nx;
  }
  return out;
}

export function emitBoxes(plan: Plan, g: TileGrid, solids: readonly Solid[]): void {
  const list: Box[] = [];
  const order: number[] = [];
  solids.forEach((s) => { if (s.kind === 'box' && s.flags & SolidFlag.RENDER) list.push(s); });
  const loc = list.map((b) => local(g, b));
  // "boxes by id": stable order by id, then replica order
  for (let i = 0; i < list.length; i++) order.push(i);
  order.sort((a, b) => list[a].id - list[b].id || a - b);
  let rank = 0;
  /** Rects (face coordinates: axis 1 (x, z), axis 0 (z, y), axis 2 (x, y)) of box faces already emitted, per
   * (axis, sign, plane): overlapping coplanar faces of two boxes are emitted once (first box in order wins). */
  const emitted = new Map<string, number[]>();
  const planeKey = (axis: number, sign: number, plane: number): string => `${axis}${sign}|${q4(plane)}`;
  for (const bi of order) {
    const b = list[bi], L = loc[bi];
    rank++;
    if (L[3] <= -EPS || L[0] >= TILE_SIZE + EPS || L[5] <= -EPS || L[2] >= TILE_SIZE + EPS) continue;
    const noLm = (b.flags & SolidFlag.NO_LM) !== 0;
    for (let axis = 0; axis < 3; axis++) {
      for (const sign of [-1, 1]) {
        const plane = sign > 0 ? L[axis + 3] : L[axis];
        const pk = planeKey(axis, sign, plane);
        const cop = emitted.get(pk) ?? [];
        const mine: number[] = [];
        let spec: ChartSpec | null = null;
        const key = `4s${kf(b.id, 10)}${kf(rank, 5)}${axis}${sign > 0 ? 1 : 0}`;
        const reg = (f: Face): void => {
          if (noLm) { plan.borrow(f, plan.floorGrid); return; }
          if (!spec) {
            spec = plan.addSpec(axis === 1 ? hSpec(K_BOX, b.bakeGroup, b.mat, key, plane, sign) : vSpec(K_BOX, b.bakeGroup, b.mat, key, axis === 0 ? 0 : 2, plane, sign));
            if (axis === 1) spec.cont = (L[0] < -EPS ? 1 : 0) | (L[3] > TILE_SIZE + EPS ? 2 : 0) | (L[2] < -EPS ? 4 : 0) | (L[5] > TILE_SIZE + EPS ? 8 : 0);
            else {
              const u0 = axis === 0 ? L[2] : L[0], u1 = axis === 0 ? L[5] : L[3];
              spec.cont = (u0 < -EPS ? 1 : 0) | (u1 > TILE_SIZE + EPS ? 2 : 0);
            }
          }
          plan.own(f, spec);
        };
        if (axis === 1) {
          const xs = cellSplits(L[0], L[3]), zs = cellSplits(L[2], L[5]);
          for (let zi = 0; zi < zs.length; zi += 2) {
            for (let xi = 0; xi < xs.length; xi += 2) {
              const x0 = xs[xi], x1 = xs[xi + 1], z0 = zs[zi], z1 = zs[zi + 1];
              const [ci, cj] = g.cellAt((x0 + x1) / 2, (z0 + z1) / 2);
              if (!g.inTile(ci, cj)) continue;
              const k = cix(ci, cj);
              if (g.isSolid(k) || g.group[k] !== b.bakeGroup) continue;
              if (plane <= g.bottom(k) + 0.005 || plane >= g.top(k) - 0.005) continue;
              if (covered(loc, bi, 1, plane, sign, [x0, z0], [x1, z1])) continue;
              let st = state(b.mat);
              const wy = g.waterY(k);
              if (wy > plane + EPS) st = underwater(st, Math.round(wy * 100));
              const r = cop.length ? subtractRects(x0, x1, z0, z1, cop, cop.length / 4) : [x0, x1, z0, z1];
              for (let i = 0; i < r.length; i += 4) {
                reg(hQuad(plane, sign, r[i], r[i + 1], r[i + 2], r[i + 3], st));
                mine.push(r[i], r[i + 1], r[i + 2], r[i + 3]);
              }
            }
          }
        } else {
          const ax: 0 | 2 = axis === 0 ? 0 : 2;
          const ts = axis === 0 ? cellSplits(L[2], L[5]) : cellSplits(L[0], L[3]);
          for (let ti = 0; ti < ts.length; ti += 2) {
            const t0 = ts[ti], t1 = ts[ti + 1];
            const px = axis === 0 ? plane + sign * 0.01 : (t0 + t1) / 2, pz = axis === 0 ? (t0 + t1) / 2 : plane + sign * 0.01;
            const [ci, cj] = g.cellAt(px, pz);
            if (!g.inTile(ci, cj)) continue;
            const k = cix(ci, cj);
            if (g.isSolid(k) || g.group[k] !== b.bakeGroup) continue;
            const y0 = Math.max(L[1], g.bottom(k)), y1 = Math.min(L[4], g.top(k));
            if (y1 - y0 <= EPS) continue;
            const lo = axis === 0 ? [y0, t0] : [t0, y0], hi = axis === 0 ? [y1, t1] : [t1, y1];
            if (covered(loc, bi, axis, plane, sign, lo, hi)) continue;
            const r = cop.length ? subtractRects(t0, t1, y0, y1, cop, cop.length / 4) : [t0, t1, y0, y1];
            for (let i = 0; i < r.length; i += 4) {
              addVSplit(ax, plane, sign, r[i], r[i + 1], r[i + 2], r[i + 3], state(b.mat), g.waterY(k), reg);
              mine.push(r[i], r[i + 1], r[i + 2], r[i + 3]);
            }
          }
        }
        if (mine.length) emitted.set(pk, cop.concat(mine));
      }
    }
  }
}

/** Blocker tops (cells with blockCm > 0): greedy BOX-chart rects at floor + blockCm, material = floorMat. */
export function emitBlockers(plan: Plan, g: TileGrid): void {
  const keys = new Int32Array(TILE_CELLS * TILE_CELLS).fill(-1);
  const ids = new Map<string, number>();
  const rep: number[] = [];
  for (let cj = 0; cj < TILE_CELLS; cj++) {
    for (let ci = 0; ci < TILE_CELLS; ci++) {
      const k = cix(ci, cj);
      if (!g.hasFloor(k) || g.blockCm[k] <= 0) continue;
      const s = `${g.floorCm[k] + g.blockCm[k]}|${g.floorMat[k]}|${g.group[k]}|${g.waterCm[k]}`;
      let id = ids.get(s);
      if (id === undefined) { id = rep.length; ids.set(s, id); rep.push(k); }
      keys[cj * TILE_CELLS + ci] = id;
    }
  }
  const r = greedyRects(keys, TILE_CELLS, TILE_CELLS);
  for (let i = 0; i < r.length; i += 5) {
    const k = rep[r[i + 4]];
    const y = (g.floorCm[k] + g.blockCm[k]) / 100;
    if (y >= g.top(k) - 0.005) continue;
    const spec = plan.addSpec(hSpec(K_BOX, g.group[k], g.floorMat[k], `4k${kf(r[i], 3)}${kf(r[i + 1], 3)}|${q4(y)}`, y, 1));
    let st = state(g.floorMat[k], VFlag.NO_GRIME);
    const wy = g.waterY(k);
    if (wy > y + EPS) st = underwater(st, g.waterCm[k]);
    plan.own(hQuad(y, 1, r[i] * CELL, r[i + 2] * CELL, r[i + 1] * CELL, r[i + 3] * CELL, st), spec);
  }
}
