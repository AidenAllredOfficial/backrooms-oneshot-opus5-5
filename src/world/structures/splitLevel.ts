// src/world/structures/splitLevel.ts — R2 vertical variety stamps, called from INSIDE zone generators (LOBBY, OFFICE,
// CONCRETE): the split-level hall (a sunken 5.7-7.2 m tall hall overlooked by a gallery), the light well (a railed
// shaft in the floor with a lit floor or still water 6 m down) and the lattice-pendant helper of tall rooms.
//
// Split-level hall (all in the 2.5D model, no new ids):
//   - hall cells: floor = base - depthCm (300 / 450), ceiling unchanged (the district ceiling, so 5.7-7.2 m of air);
//   - hall | gallery boundary: a HALF parapet (hA = base + 95) with a METAL_PAINTED pipe handrail on top, except
//     the stair head, which is OPEN;
//   - stair: a 2-3-cell-wide ramp solid (15 visual steps) hugging one long side, rising to the gallery at one short
//     end; its open side gets a stepped RAIL balustrade;
//   - optional SOLID columns (full height, WALL-wrapped like LOBBY thick blocks) standing on the hall floor;
//   - light from below: PENDANT_LINEAR fittings hung 3 m above the hall floor (cables up to the ceiling).
// The caller guarantees the preconditions (hall rect inside [1, 31), all hall + ring cells plain floor at one
// height, no stamps / ramps inside) and checks connectivity; buildSplitHall only writes.

import { CELL } from '../../core/constants.ts';
import { cellIdx } from '../../core/grid.ts';
import { CellFlag, EdgeKind, FixtureKind, Mat, type FixtureKindId, type MatId } from '../../core/ids.ts';
import { NO_WATER } from '../../core/layout.ts';
import type { ZoneGenContext } from '../../core/world.ts';
import { addCustomFixtureUnique } from '../zones/l0common.ts';
import { DECO_FLAGS, putEdge, WALK_SOLID } from './util.ts';

export const SPLIT_DEPTHS: readonly number[] = [300, 450];
export const PARAPET_CM = 95;
export const STAIR_STEPS = 15;
const HANDRAIL_R = 0.025;

export interface SplitHall {
  i0: number; j0: number; i1: number; j1: number; // sunken hall, local cells [i0,i1) x [j0,j1)
  depthCm: number;
  /** the stair runs along this axis, hugging the min (-1) or max (+1) side across it, with its head at the min (-1)
   * or max (+1) end along it */
  stairAxis: 'x' | 'z'; stairSide: -1 | 1; stairHead: -1 | 1;
  stairW: number; stairL: number;
  wallMat: MatId; stairMat: MatId; parapetMat: MatId;
  columns: boolean;
  /** pendant light over the hall floor (null: none) */
  pendant: { kind: FixtureKindId; luminance: number; cct: readonly [number, number]; w: number; h: number } | null;
}

export interface SplitInfo { stair: [number, number, number, number]; columns: number; pendants: number }

/** Stair cells [i0, j0, i1, j1) of a hall spec. */
export function stairRect(h: SplitHall): [number, number, number, number] {
  if (h.stairAxis === 'z') {
    const a0 = h.stairSide < 0 ? h.i0 : h.i1 - h.stairW;
    const b0 = h.stairHead < 0 ? h.j0 : h.j1 - h.stairL;
    return [a0, b0, a0 + h.stairW, b0 + h.stairL];
  }
  const b0 = h.stairSide < 0 ? h.j0 : h.j1 - h.stairW;
  const a0 = h.stairHead < 0 ? h.i0 : h.i1 - h.stairL;
  return [a0, b0, a0 + h.stairL, b0 + h.stairW];
}

export function buildSplitHall(ctx: ZoneGenContext, h: SplitHall): SplitInfo {
  const g = ctx.grid, l = g.layout;
  const base = l.floorCm[cellIdx(h.i0, h.j0)];
  const low = base - h.depthCm;
  const inHall = (li: number, lj: number): boolean => li >= h.i0 && li < h.i1 && lj >= h.j0 && lj < h.j1;
  const [si0, sj0, si1, sj1] = stairRect(h);
  const inStair = (li: number, lj: number): boolean => li >= si0 && li < si1 && lj >= sj0 && lj < sj1;
  // cells
  g.setCells(h.i0, h.j0, h.i1, h.j1, { floorCm: low, blockCm: 0, waterCm: NO_WATER, flagsClear: CellFlag.SOLID | CellFlag.WET | CellFlag.NO_CEIL | CellFlag.SPAWN_OK });
  for (let lj = h.j0; lj < h.j1; lj++) for (let li = h.i0; li < h.i1; li++) l.wallMat[cellIdx(li, lj)] = h.wallMat;
  // interior edges open
  for (let lj = h.j0; lj < h.j1; lj++) for (let li = h.i0 + 1; li < h.i1; li++) putEdge(g, 'x', li, lj, EdgeKind.OPEN, { trim: 0 });
  for (let lj = h.j0 + 1; lj < h.j1; lj++) for (let li = h.i0; li < h.i1; li++) putEdge(g, 'z', li, lj, EdgeKind.OPEN, { trim: 0 });
  // perimeter: parapet, stair head open
  const para = { hA: base + PARAPET_CM, matNeg: h.parapetMat, matPos: h.parapetMat, trim: 0 };
  const headLine = h.stairAxis === 'z' ? (h.stairHead < 0 ? h.j0 : h.j1) : (h.stairHead < 0 ? h.i0 : h.i1);
  const isHead = (axis: 'x' | 'z', i: number, j: number): boolean => h.stairAxis === 'z'
    ? axis === 'z' && j === headLine && i >= si0 && i < si1
    : axis === 'x' && i === headLine && j >= sj0 && j < sj1;
  const runs: [number, number, number, number][] = []; // handrail runs (x0, z0, x1, z1)
  const perim = (axis: 'x' | 'z', line: number, c0: number, c1: number): void => {
    let runStart = -1;
    for (let c = c0; c <= c1; c++) {
      const i = axis === 'x' ? line : c, j = axis === 'x' ? c : line;
      const head = c < c1 && isHead(axis, i, j);
      if (c < c1) putEdge(g, axis, i, j, head ? EdgeKind.OPEN : EdgeKind.HALF, head ? { trim: 0 } : para);
      const railed = c < c1 && !head;
      if (railed && runStart < 0) runStart = c;
      if (!railed && runStart >= 0) {
        if (axis === 'x') runs.push([line * CELL, runStart * CELL, line * CELL, c * CELL]);
        else runs.push([runStart * CELL, line * CELL, c * CELL, line * CELL]);
        runStart = -1;
      }
    }
  };
  perim('x', h.i0, h.j0, h.j1); perim('x', h.i1, h.j0, h.j1);
  perim('z', h.j0, h.i0, h.i1); perim('z', h.j1, h.i0, h.i1);
  const railY = (base + PARAPET_CM) / 100 + HANDRAIL_R + 0.005;
  for (const [x0, z0, x1, z1] of runs) {
    g.addSolid({ kind: 'pipe', a: [x0, railY, z0], b: [x1, railY, z1], r: HANDRAIL_R, mat: Mat.METAL_PAINTED, flags: DECO_FLAGS });
  }
  // stair: ramp + stepped balustrade on its open side
  const dir: 0 | 1 | 2 | 3 = h.stairAxis === 'x' ? (h.stairHead < 0 ? 1 : 0) : (h.stairHead < 0 ? 3 : 2);
  g.addSolid({
    kind: 'ramp', x0: si0 * CELL, z0: sj0 * CELL, x1: si1 * CELL, z1: sj1 * CELL, y0: low / 100, y1: base / 100, dir,
    steps: STAIR_STEPS, mat: h.stairMat, flags: WALK_SOLID, bakeGroup: 0,
  });
  // the open side: a stepped stringer curb (RAIL, 15 cm above the low end of each cell's run: non-walkable for the
  // graph, see-through for light) with a sloped pipe handrail on posts, 0.95 m above the nosings
  const openLine = h.stairAxis === 'z' ? (h.stairSide < 0 ? si1 : si0) : (h.stairSide < 0 ? sj1 : sj0);
  for (let k = 0; k < h.stairL; k++) {
    const lowEnd = Math.round(base - (h.depthCm * (k + 1)) / h.stairL);
    const along = h.stairHead < 0 ? (h.stairAxis === 'z' ? sj0 + k : si0 + k) : (h.stairAxis === 'z' ? sj1 - 1 - k : si1 - 1 - k);
    const o = { hA: lowEnd + 15, matNeg: h.parapetMat, matPos: h.parapetMat, trim: 0 };
    if (h.stairAxis === 'z') putEdge(g, 'x', openLine, along, EdgeKind.RAIL, o);
    else putEdge(g, 'z', along, openLine, EdgeKind.RAIL, o);
  }
  {
    const lineM = openLine * CELL;
    const a0 = (h.stairAxis === 'z' ? (h.stairHead < 0 ? sj0 : sj1) : (h.stairHead < 0 ? si0 : si1)) * CELL; // head
    const a1 = (h.stairAxis === 'z' ? (h.stairHead < 0 ? sj1 : sj0) : (h.stairHead < 0 ? si1 : si0)) * CELL; // foot
    const yHead = base / 100 + 0.95, yFoot = low / 100 + 0.95;
    const P = (a: number, y: number): [number, number, number] => (h.stairAxis === 'z' ? [lineM, y, a] : [a, y, lineM]);
    g.addSolid({ kind: 'pipe', a: P(a0, yHead), b: P(a1, yFoot), r: HANDRAIL_R, mat: Mat.METAL_PAINTED, flags: DECO_FLAGS });
    for (let k = 0; k <= h.stairL; k++) {
      const t = k / h.stairL, a = a0 + (a1 - a0) * t;
      const yTop = yHead + (yFoot - yHead) * t;
      const yCurb = (base - (h.depthCm * Math.min(h.stairL, k + 1)) / h.stairL + 15) / 100;
      if (yTop - yCurb > 0.05) g.addSolid({ kind: 'pipe', a: P(a, yCurb), b: P(a, yTop), r: 0.018, mat: Mat.METAL_PAINTED, flags: DECO_FLAGS });
    }
  }
  // columns: a row down the hall's middle band, every 4 cells, clear of the stair and its foot
  let columns = 0;
  const colAt: number[] = [];
  if (h.columns) {
    const alongZ = h.stairAxis === 'z';
    const len = alongZ ? h.j1 - h.j0 : h.i1 - h.i0, wid = alongZ ? h.i1 - h.i0 : h.j1 - h.j0;
    if (wid >= 8 && len >= 10) {
      const acrossList = [2, wid - 3];
      for (const ac of acrossList) {
        for (let a = 3; a <= len - 4; a += 4) {
          const li = alongZ ? h.i0 + ac : h.i0 + a, lj = alongZ ? h.j0 + a : h.j0 + ac;
          let clear = true;
          for (let dj = -2; dj <= 2 && clear; dj++) for (let di = -2; di <= 2 && clear; di++) if (inStair(li + di, lj + dj)) clear = false;
          if (!clear || !inHall(li, lj)) continue;
          g.setCells(li, lj, li + 1, lj + 1, { flagsSet: CellFlag.SOLID });
          const wo = { matNeg: Mat.CONCRETE_WALL, matPos: Mat.CONCRETE_WALL, trim: 0 };
          putEdge(g, 'x', li, lj, EdgeKind.WALL, wo); putEdge(g, 'x', li + 1, lj, EdgeKind.WALL, wo);
          putEdge(g, 'z', li, lj, EdgeKind.WALL, wo); putEdge(g, 'z', li, lj + 1, EdgeKind.WALL, wo);
          l.wallMat[cellIdx(li, lj)] = Mat.CONCRETE_WALL;
          colAt.push(cellIdx(li, lj));
          columns++;
        }
      }
    }
  }
  // pendants 3 m above the hall floor, on a 3 x 4 cell grid clear of the stair and the columns
  let pendants = 0;
  if (h.pendant) {
    const pd = h.pendant;
    const alongZ = h.stairAxis === 'z';
    const len = alongZ ? h.j1 - h.j0 : h.i1 - h.i0, wid = alongZ ? h.i1 - h.i0 : h.j1 - h.j0;
    const nA = Math.max(1, Math.round(len / 4)), nW = Math.max(1, Math.round(wid / 3.2));
    for (let b = 0; b < nW; b++) {
      for (let a = 0; a < nA; a++) {
        const fa = (a + 0.5) * len / nA, fw = (b + 0.5) * wid / nW;
        const x = alongZ ? (h.i0 + fw) * CELL : (h.i0 + fa) * CELL, z = alongZ ? (h.j0 + fa) * CELL : (h.j0 + fw) * CELL;
        const li = Math.floor(x / CELL), lj = Math.floor(z / CELL);
        if (inStair(li, lj) || colAt.includes(cellIdx(li, lj))) continue;
        const y = low / 100 + 3.0;
        if (y > l.ceilCm[cellIdx(li, lj)] / 100 - 0.3) continue;
        addCustomFixtureUnique(ctx, {
          kind: pd.kind, x, y, z, nx: 0, ny: -1, nz: 0, tx: alongZ ? 0 : 1, ty: 0, tz: alongZ ? 1 : 0,
          w: pd.w, h: pd.h, cct0: pd.cct[0], cct1: pd.cct[1], luminance: pd.luminance, hum: 0.35,
        });
        pendants++;
      }
    }
  }
  return { stair: [si0, sj0, si1, sj1], columns, pendants };
}

// ------------------------------------------------------------------------------------------------ light well

export interface LightWell { i0: number; j0: number; i1: number; j1: number; water: boolean }
export const WELL_DEPTH_CM = 600;

/** A railed shaft in the floor: cells NOWALK at base - 600, RAIL (100 cm) + pipe handrail around, concrete (or pool
 * tile) shaft walls; at the bottom either still water with an UNDERWATER lamp or a lit floor under a CAGE_BULB. */
export function buildLightWell(ctx: ZoneGenContext, w: LightWell, seq: number): void {
  const g = ctx.grid, l = g.layout;
  const base = l.floorCm[cellIdx(w.i0, w.j0)];
  const bottom = base - WELL_DEPTH_CM;
  g.setCells(w.i0, w.j0, w.i1, w.j1, {
    floorCm: bottom, floorMat: w.water ? Mat.POOL_TILE : Mat.CONCRETE_FLOOR, blockCm: 0,
    waterCm: w.water ? bottom + 45 : NO_WATER,
    flagsSet: CellFlag.NOWALK, flagsClear: CellFlag.SOLID | CellFlag.WET | CellFlag.SPAWN_OK,
  });
  for (let lj = w.j0; lj < w.j1; lj++) for (let li = w.i0; li < w.i1; li++) l.wallMat[cellIdx(li, lj)] = w.water ? Mat.POOL_TILE : Mat.CONCRETE_WALL;
  for (let lj = w.j0; lj < w.j1; lj++) for (let li = w.i0 + 1; li < w.i1; li++) putEdge(g, 'x', li, lj, EdgeKind.OPEN, { trim: 0 });
  for (let lj = w.j0 + 1; lj < w.j1; lj++) for (let li = w.i0; li < w.i1; li++) putEdge(g, 'z', li, lj, EdgeKind.OPEN, { trim: 0 });
  // a 90 cm concrete curb-parapet (the shaft walls continue it down) with a pipe handrail on top at 1.0 m
  const rail = { hA: base + 90, matNeg: Mat.CONCRETE_WALL, matPos: Mat.CONCRETE_WALL, trim: 0 };
  for (let lj = w.j0; lj < w.j1; lj++) { putEdge(g, 'x', w.i0, lj, EdgeKind.RAIL, rail); putEdge(g, 'x', w.i1, lj, EdgeKind.RAIL, rail); }
  for (let li = w.i0; li < w.i1; li++) { putEdge(g, 'z', li, w.j0, EdgeKind.RAIL, rail); putEdge(g, 'z', li, w.j1, EdgeKind.RAIL, rail); }
  const y = (base + 90) / 100 + HANDRAIL_R + 0.005;
  const x0 = w.i0 * CELL, x1 = w.i1 * CELL, z0 = w.j0 * CELL, z1 = w.j1 * CELL;
  for (const [ax, az, bx, bz] of [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]] as const) {
    g.addSolid({ kind: 'pipe', a: [ax, y, az], b: [bx, y, bz], r: HANDRAIL_R, mat: Mat.METAL_PAINTED, flags: DECO_FLAGS });
  }
  if (w.water) {
    g.addWater({ x0, z0, x1, z1, y: (bottom + 45) / 100, floorY: bottom / 100, kind: 1 });
    // an underwater lamp in the middle of one shaft wall, 25 cm below the surface: the shaft glows turquoise
    const along = seq & 1 ? 'x' : 'z';
    const px = along === 'x' ? (x0 + x1) / 2 : x0 + 0.08, pz = along === 'x' ? z0 + 0.08 : (z0 + z1) / 2;
    g.addFixture({
      kind: FixtureKind.UNDERWATER, state: 0, shape: 0, px, py: (bottom + 20) / 100, pz,
      nx: along === 'x' ? 0 : 1, ny: 0, nz: along === 'x' ? 1 : 0, tx: along === 'x' ? 1 : 0, ty: 0, tz: along === 'x' ? 0 : 1,
      w: 0.3, h: 0.3, color: [0.55, 0.95, 1], luminance: 5200, hum: 0.2, bakeGroup: 0,
    }, { latticeI: Math.floor((g.gi0 * CELL + px) / 0.6), latticeJ: Math.floor((g.gj0 * CELL + pz) / 0.6) });
  } else {
    // a caged bulb on the shaft wall 1.6 m above the bottom: a lit floor far below
    const px = x0 + 0.2, pz = (z0 + z1) / 2;
    addCustomFixtureUnique(ctx, {
      kind: FixtureKind.CAGE_BULB, x: px, y: bottom / 100 + 1.9, z: pz, nx: 1, ny: 0, nz: 0, tx: 0, ty: 0, tz: 1,
      w: 0.1, h: 0.1, cct0: 2800, cct1: 3200, luminance: 160, hum: 0.5,
    });
  }
}
