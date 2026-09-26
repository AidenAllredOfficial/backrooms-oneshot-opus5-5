// src/mesh/floors.ts — WP5 floors (§5 WP5 rule 4): greedy floor rectangles on the FLOOR_GRID chart with FLOOR_AUX
// (reflection plane, region key, water byte), REFLECTIVE/UNDERWATER flags, METAL_GRATE plenum pits.
// Floors of structure cells (tower/elevator bake groups) get their own BOX charts. Pure module.

import { CELL, TILE_CELLS, WALL_T, regionKey } from '../core/constants.ts';
import { EDGE_RENDERS, edgeBaseThickness, edgePieces } from '../core/edges.ts';
import { CellFlag, LightState, Mat, VFlag } from '../core/ids.ts';
import { fixtureRadiance, type Fixture } from '../core/layout.ts';
import { LAYER_DEFS } from '../core/materials.ts';
import type { ChartKindId } from '../core/mesh.ts';
import { greedyRects } from './geom.ts';
import { hQuad, state, vQuad, type Face, type Plan } from './plan.ts';
import { PIT_BOTTOM, cix, eix, type TileGrid } from './tileGrid.ts';
import { hSpec, waterByte } from './walls.ts';
import { kf, q4, tintRGB } from './uv.ts';

const K_BOX = 5 as ChartKindId;
const GRATE_PIT = 0.4;
const EPS = 1e-5;

/** Floor aux bytes of every tile cell (FLOOR_AUX layout): x = refl plane / 5 cm, y,z = region key, w = water byte. */
export function floorAux(g: TileGrid): Uint32Array {
  const out = new Uint32Array(TILE_CELLS * TILE_CELLS);
  const tmp: Fixture[] = [];
  for (let cj = 0; cj < TILE_CELLS; cj++) {
    for (let ci = 0; ci < TILE_CELLS; ci++) {
      const k = cix(ci, cj);
      if (g.isSolid(k)) continue;
      const floor = g.floor(k), ceil = g.ceil(k);
      const xc = g.ox + (ci + 0.5) * CELL, zc = g.oz + (cj + 0.5) * CELL;
      g.nb.fixturesNear(xc, zc, 3 * CELL, tmp);
      let sumW = 0, sumH = 0, sumHY = 0;
      for (const f of tmp) {
        if (f.state === LightState.OFF || f.bakeGroup !== g.group[k]) continue;
        const flux = f.shape === 0 ? Math.PI * fixtureRadiance(f) * f.w * f.h : 4 * Math.PI * f.luminance;
        if (!(flux > 0)) continue;
        sumW += flux;
        if (f.py < ceil - 0.05) { sumH += flux; sumHY += flux * (f.py - floor); }
      }
      const refl = sumH > 0.5 * sumW && sumH > 0 ? sumHY / sumH : ceil - floor;
      const rb = Math.max(0, Math.min(255, Math.round((refl * 100) / 5)));
      const key = regionKey(g.region(ci, cj));
      const wy = g.waterY(k);
      const wb = wy === wy ? waterByte(g.waterCm[k]) : 0;
      out[cj * TILE_CELLS + ci] = (rb | ((key & 255) << 8) | ((key >> 8) << 16) | (wb << 24)) >>> 0;
    }
  }
  return out;
}

/** WaterRect kind (0 pool, 1 flooded, 2 film) of the water body over tile cell (ci, cj); 0 when none. Submerged
 * floors carry it in tint.a so the caustics can scale by the body kind (materials/chunks/lighting.ts). */
function waterKindAt(g: TileGrid, ci: number, cj: number): number {
  const xc = g.ox + (ci + 0.5) * CELL, zc = g.oz + (cj + 0.5) * CELL;
  for (const w of g.nb.center.water) {
    if (xc >= Math.min(w.x0, w.x1) && xc < Math.max(w.x0, w.x1) && zc >= Math.min(w.z0, w.z1) && zc < Math.max(w.z0, w.z1)) return w.kind;
  }
  return 0;
}

export function emitFloors(plan: Plan, g: TileGrid, aux: Uint32Array): void {
  const keys = new Int32Array(TILE_CELLS * TILE_CELLS).fill(-1);
  const ids = new Map<string, number>();
  const rep: number[] = []; // representative cell per key id
  for (let cj = 0; cj < TILE_CELLS; cj++) {
    for (let ci = 0; ci < TILE_CELLS; ci++) {
      const k = cix(ci, cj);
      if (!g.hasFloor(k) || g.blockCm[k] > 0) continue;
      const wet = g.flags[k] & CellFlag.WET ? 1 : 0;
      const wk = aux[cj * TILE_CELLS + ci] >>> 24 ? waterKindAt(g, ci, cj) : 0;
      const s = `${g.floorCm[k]}|${g.floorMat[k]}|${wet}|${aux[cj * TILE_CELLS + ci]}|${g.ceilCm[k]}|${g.group[k]}|${wk}`;
      let id = ids.get(s);
      if (id === undefined) { id = rep.length; ids.set(s, id); rep.push(cj * TILE_CELLS + ci); }
      keys[cj * TILE_CELLS + ci] = id;
    }
  }
  const rects = greedyRects(keys, TILE_CELLS, TILE_CELLS);
  for (let r = 0; r < rects.length; r += 5) {
    const i0 = rects[r], j0 = rects[r + 1], i1 = rects[r + 2], j1 = rects[r + 3], id = rects[r + 4];
    const cell = rep[id], ci = cell % TILE_CELLS, cj = (cell / TILE_CELLS) | 0;
    const k = cix(ci, cj);
    const mat = g.floorMat[k];
    const y = g.floor(k);
    const a = aux[cell];
    let flags = VFlag.FLOOR_AUX;
    if ((LAYER_DEFS[mat]?.reflective ?? false) || g.flags[k] & CellFlag.WET) flags |= VFlag.REFLECTIVE;
    let tint = 0xffffff;
    if (a >>> 24 && g.waterY(k) === g.waterY(k)) { flags |= VFlag.UNDERWATER; tint = tintRGB(1, 1, 1, waterKindAt(g, ci, cj)); }
    const grate = mat === Mat.METAL_GRATE;
    if (grate) flags |= VFlag.DECAL;
    const x0 = i0 * CELL, x1 = i1 * CELL, z0 = j0 * CELL, z1 = j1 * CELL;
    const f = hQuad(y, 1, x0, x1, z0, z1, state(mat, flags, tint, 0, a));
    const group = g.group[k];
    if (group === 0) plan.own(f, plan.floorGrid);
    else plan.own(f, plan.addSpec(hSpec(K_BOX, group, mat, `4f${kf(i0, 3)}${kf(j0, 3)}|${q4(y)}`, y, 1)));
    if (grate) emitGratePit(plan, g, i0, j0, i1, j1, y, f);
  }
}

/** 0.4 m PLENUM pit under a METAL_GRATE floor rect: bottom + sides where the neighbour is not the same grate. */
function emitGratePit(plan: Plan, g: TileGrid, i0: number, j0: number, i1: number, j1: number, y: number, floorFace: Face): void {
  const st = state(Mat.PLENUM, VFlag.NO_GRIME, tintRGB(0.3, 0.3, 0.3));
  const yb = y - GRATE_PIT;
  const src = floorFace.spec!;
  const bottom = hQuad(yb, 1, i0 * CELL, i1 * CELL, j0 * CELL, j1 * CELL, st);
  plan.borrow(bottom, src);
  const isGrate = (ci: number, cj: number, fcm: number): boolean => {
    const k = cix(ci, cj);
    return g.hasFloor(k) && g.floorMat[k] === Mat.METAL_GRATE && g.floorCm[k] === fcm && g.blockCm[k] <= 0;
  };
  const fcm = Math.round(y * 100);
  const pcs = new Float32Array(16);
  /** Half thickness (at floor level) of a rendered edge piece spanning the whole edge from the grate floor up, or -1.
   * Two grate cells separated by such a wall get pit sides under the wall faces (the greedy rect runs under it). */
  const wallHalf = (a: number, L: number, c: number, kn: number): number => {
    const e = eix(a, L, c);
    const kind = g.eKind[e];
    if (!EDGE_RENDERS[kind]) return -1;
    const n = edgePieces(kind, g.eHA[e], g.eHB[e], y, y, Math.max(y + 0.5, g.ceil(kn)), pcs);
    for (let i = 0; i < n; i++) {
      if (pcs[i * 4] <= EPS && pcs[i * 4 + 1] >= CELL - EPS && pcs[i * 4 + 2] <= y + EPS && pcs[i * 4 + 3] > y + EPS) {
        return edgeBaseThickness(kind) / 2;
      }
    }
    return -1;
  };
  // sample the grid >= WALL_T/2 inside the grate cell: a side on a wall line (under the wall) must never take the
  // bilinear weight of a texel across that wall (no-leak rule, §2.3: texel centres sit t/2 <= WALL_T/2 off the line)
  const ins = WALL_T / 2 + 0.005;
  for (let cj = j0; cj < j1; cj++) {
    for (let ci = i0; ci < i1; ci++) {
      // -x, +x, -z, +z sides of this cell facing into the pit: [neighbour, plane axis, line, sign, edge a, L, c]
      const sides: [number, number, 0 | 2, number, number, number, number, number][] = [
        [ci - 1, cj, 0, ci * CELL, 1, 0, ci, cj], [ci + 1, cj, 0, (ci + 1) * CELL, -1, 0, ci + 1, cj],
        [ci, cj - 1, 2, cj * CELL, 1, 1, cj, ci], [ci, cj + 1, 2, (cj + 1) * CELL, -1, 1, cj + 1, ci],
      ];
      for (const [ni, nj, ax, line, sign, ea, eL, ec] of sides) {
        let plane = line;
        if (isGrate(ni, nj, fcm)) {
          const h = wallHalf(ea, eL, ec, cix(ni, nj));
          if (h < 0) continue; // the pit continues into the neighbour's
          plane = line + sign * h; // under the wall face on this side
        }
        const t0 = ax === 0 ? cj * CELL : ci * CELL;
        const f = vQuad(ax, plane, sign, t0, t0 + CELL, yb, y - EPS, st);
        // sample the grid inside this cell (not on the line)
        const lm = f.p.slice();
        const ta = ax === 0 ? 2 : 0; // along-face axis: keep the ends off the perpendicular cell lines too
        for (let v = 0; v < lm.length; v += 3) {
          lm[v + ax] = line + sign * ins;
          lm[v + ta] = Math.min(t0 + CELL - ins, Math.max(t0 + ins, lm[v + ta]));
        }
        f.lm = lm;
        plan.borrow(f, src);
      }
    }
  }
}

/** VOID cells (pits): a PLENUM-dark bottom quad at PIT_BOTTOM (-6 m), greedy-merged, with a borrowed lightmap uv
 * (the floor grid at the same xz, whose VOID texels are dilated) darkened by the tint; edge fog / haze make it read
 * as depth. Tower cells are VOID-free (their shafts are solids). */
export function emitPitBottoms(plan: Plan, g: TileGrid): void {
  const keys = new Int32Array(TILE_CELLS * TILE_CELLS).fill(-1);
  let any = false;
  for (let cj = 0; cj < TILE_CELLS; cj++) {
    for (let ci = 0; ci < TILE_CELLS; ci++) {
      const k = cix(ci, cj);
      if (!g.isVoid(k) || g.isSolid(k) || g.isTower(k)) continue;
      keys[cj * TILE_CELLS + ci] = 0;
      any = true;
    }
  }
  if (!any) return;
  const st = state(Mat.PLENUM, VFlag.NO_GRIME, tintRGB(0.12, 0.12, 0.12));
  const rects = greedyRects(keys, TILE_CELLS, TILE_CELLS);
  for (let r = 0; r < rects.length; r += 5) {
    const x0 = rects[r] * CELL, z0 = rects[r + 1] * CELL, x1 = rects[r + 2] * CELL, z1 = rects[r + 3] * CELL;
    plan.borrow(hQuad(PIT_BOTTOM, 1, x0, x1, z0, z1, st), plan.floorGrid);
  }
}
