// src/bake/beam.ts — conservative "beam" visibility between a receiver box and a light's emitter (WP7 §Algorithms
// 5, a ray-free early-out of the (patch, light) classification). Pure module, allocation-free.
//
// Every visibility segment the direct pass may cast for a receiver region -- classification segments, shadow
// samples, centre rays -- runs from a point p of the receiver's sample box P to a point e of the emitter's box E.
// The union of all those segments is exactly the swept box H(t) = (1 - t) P + t E, t in [0, 1], whose bounds are
// linear in t on every axis. `beamClear` walks the halo cells, edge lines and corner posts that H touches and
// returns true only when NOTHING the DDA (dda.ts `occluded`) could stop a segment at is inside H:
//   - every cell H enters is of the ray's bake group and not SOLID (the owner cell included: the DDA exempts only
//     a segment's start cell, so an exempt owner cell gets no beam), and H's height range inside it stays within
//     [dLo, dCeil] (floor, blocker top, ceiling);
//   - no occluder box of the group bucketed in those cells intersects H (ramps are treated as their boxes);
//   - every edge line H crosses is open (mode 0) over H's height range at the crossing, and so is every corner
//     post within WALL_T/2 of it.
// All tests are conservative (touching counts as blocked; doorways, arches and windows fall back to rays), so a
// clear beam implies that every one of those segments is unoccluded: FULL without a single ray, and the bake
// output is byte-identical to the ray-classified result (checked in tests/bake/beam.test.ts).
//
// Speed: every cell has a "free" height interval (computed once per VisGrid): above its floor / blocker and every
// box bucketed there, below its ceiling, and inside the open intervals of its own east / south edges and its 4
// corner posts. A cell whose row height range lies inside it needs no further test; the others get the exact
// per-cell tests. The walk starts at the receiver's end, where most occluders are found.

import { CELL, WALL_T } from '../core/constants.ts';
import { CellFlag } from '../core/ids.ts';
import type { BakeJob } from './job.ts';
import { SHAPE_RECT, SHAPE_SPHERE } from './lights.ts';
import type { VisGrid } from './visgrid.ts';

const SOLID = CellFlag.SOLID;
/** Slack: x/z in cells (covers the 2^-20 quantization of sample points); y in metres: the DDA's floor / ceiling
 * tolerance (1e-3) and a margin for its rounding (every height test here is that much stricter than the DDA's). */
const EPS_XZ = 1e-5;
const EPS_Y = 1e-3;
const MARGIN_Y = 1e-5;
const POST = WALL_T / 2 / CELL;
/** Cell budget of one beam walk; wider beams (far diagonal lights) fall back to rays. */
const MAX_CELLS = 256;

/** Test switch: `enabled = false` makes the classification cast its segments everywhere (the output must not
 * change; tests/bake/beam.test.ts). */
export const beamOpts = { enabled: true };

/** Receiver box of the next `beamClear` call: x0 y0 z0 x1 y1 z1 (x/z halo cells, y metres). */
export const beamBox = new Float64Array(6);

/** Reset `beamBox` to empty (then grow it with `beamAdd`). */
export function beamReset(): void {
  beamBox[0] = Infinity; beamBox[1] = Infinity; beamBox[2] = Infinity;
  beamBox[3] = -Infinity; beamBox[4] = -Infinity; beamBox[5] = -Infinity;
}
export function beamAdd(x: number, y: number, z: number): void {
  if (x < beamBox[0]) beamBox[0] = x; if (x > beamBox[3]) beamBox[3] = x;
  if (y < beamBox[1]) beamBox[1] = y; if (y > beamBox[4]) beamBox[4] = y;
  if (z < beamBox[2]) beamBox[2] = z; if (z > beamBox[5]) beamBox[5] = z;
}

// ---- per-VisGrid free height intervals (lazy)
let freeG: VisGrid | null = null;
let freeLo = new Float64Array(0), freeHi = new Float64Array(0);
/** Tiny step below an exclusive upper bound (edges / posts block at y >= hi). */
const BELOW = 1e-9;
function freeIntervals(g: VisGrid): void {
  if (freeG === g) return;
  const n = g.n;
  if (freeLo.length < n * n) { freeLo = new Float64Array(n * n); freeHi = new Float64Array(n * n); }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = j * n + i;
      let lo = g.dLo[c] - EPS_Y, hi = g.dCeil[c] + EPS_Y;
      if (g.cBoxHi[c] > lo) lo = g.cBoxHi[c] + MARGIN_Y;
      const ex = j * (n + 1) + i + 1, ez = (j + 1) * n + i;
      if (g.exMode[ex] !== 0 || g.ezMode[ez] !== 0) lo = Infinity;
      if (g.exLo[ex] > lo) lo = g.exLo[ex];
      if (g.ezLo[ez] > lo) lo = g.ezLo[ez];
      if (g.exHi[ex] - BELOW < hi) hi = g.exHi[ex] - BELOW;
      if (g.ezHi[ez] - BELOW < hi) hi = g.ezHi[ez] - BELOW;
      for (let k = 0; k < 4; k++) {
        const v = (j + (k >> 1)) * (n + 1) + i + (k & 1);
        if (g.vLo[v] > lo) lo = g.vLo[v];
        if (g.vHi[v] - BELOW < hi) hi = g.vHi[v] - BELOW;
      }
      freeLo[c] = lo; freeHi[c] = hi;
    }
  }
  freeG = g;
}

// swept-box bounds: lo_a(t) = l0 + l1 t, hi_a(t) = h0 + h1 t per axis, with reciprocal slopes (0 slope: Infinity)
let xl0 = 0, xl1 = 0, xh0 = 0, xh1 = 0, xli = 0, xhi = 0;
let yl0 = 0, yl1 = 0, yh0 = 0, yh1 = 0, yli = 0, yhi = 0;
let zl0 = 0, zl1 = 0, zh0 = 0, zh1 = 0, zli = 0, zhi = 0;
// current t interval (narrowed by the cut* functions)
let ta = 0, tb = 1;

/** Narrow [ta, tb] to the t where lo(t) <= M and hi(t) >= m (overlap with [m, M], touching included). */
function cutX(m: number, M: number): boolean {
  if (xl1 > 0) { const t = (M - xl0) * xli; if (t < tb) tb = t; } else if (xl1 < 0) { const t = (M - xl0) * xli; if (t > ta) ta = t; } else if (xl0 > M) return false;
  if (xh1 > 0) { const t = (m - xh0) * xhi; if (t > ta) ta = t; } else if (xh1 < 0) { const t = (m - xh0) * xhi; if (t < tb) tb = t; } else if (xh0 < m) return false;
  return ta <= tb;
}
function cutZ(m: number, M: number): boolean {
  if (zl1 > 0) { const t = (M - zl0) * zli; if (t < tb) tb = t; } else if (zl1 < 0) { const t = (M - zl0) * zli; if (t > ta) ta = t; } else if (zl0 > M) return false;
  if (zh1 > 0) { const t = (m - zh0) * zhi; if (t > ta) ta = t; } else if (zh1 < 0) { const t = (m - zh0) * zhi; if (t < tb) tb = t; } else if (zh0 < m) return false;
  return ta <= tb;
}
function cutY(m: number, M: number): boolean {
  if (yl1 > 0) { const t = (M - yl0) * yli; if (t < tb) tb = t; } else if (yl1 < 0) { const t = (M - yl0) * yli; if (t > ta) ta = t; } else if (yl0 > M) return false;
  if (yh1 > 0) { const t = (m - yh0) * yhi; if (t > ta) ta = t; } else if (yh1 < 0) { const t = (m - yh0) * yhi; if (t < tb) tb = t; } else if (yh0 < m) return false;
  return ta <= tb;
}

/** Height range of H over [ta, tb] (the bounds are linear: extremes at the interval ends), widened by MARGIN_Y. */
let yMin = 0, yMax = 0;
function yRange(): void {
  const a = yl0 + yl1 * ta, b = yl0 + yl1 * tb;
  const c = yh0 + yh1 * ta, d = yh0 + yh1 * tb;
  yMin = (a < b ? a : b) - MARGIN_Y;
  yMax = (c > d ? c : d) + MARGIN_Y;
}

/** Corner post at vertex (X, Z) open over [yMin, yMax]? */
function postOpen(g: VisGrid, X: number, Z: number): boolean {
  const v = Z * (g.n + 1) + X;
  return yMin >= g.vLo[v] && yMax < g.vHi[v];
}

/** Detailed tests of cell (i, j) inside the row interval [ra, rb]: the cell itself, its boxes, and the crossings of
 * its east line (if H continues east in this row, `east`) and south line (if H continues south, `south`). */
function cellOk(g: VisGrid, i: number, j: number, ra: number, rb: number, group: number, east: boolean, south: boolean): boolean {
  const n = g.n, c = j * n + i;
  ta = ra; tb = rb;
  if (cutX(i, i + 1)) {
    yRange();
    if (yMin < g.dLo[c] - EPS_Y || yMax > g.dCeil[c] + EPS_Y) return false;
    const ca = ta, cb = tb;
    for (let k = g.boxStart[c], ke = g.boxStart[c + 1]; k < ke; k++) {
      const b = g.boxList[k];
      if (g.boxGroup[b] !== group) continue;
      const bo = b * 6;
      ta = ca; tb = cb;
      if (cutX(g.box[bo], g.box[bo + 3]) && cutZ(g.box[bo + 2], g.box[bo + 5]) &&
        cutY(g.box[bo + 1] - MARGIN_Y, g.box[bo + 4] + MARGIN_Y)) return false;
    }
  }
  if (east) {
    const X = i + 1;
    ta = ra; tb = rb;
    if (cutX(X, X)) {
      yRange();
      const e = j * (n + 1) + X;
      if (g.exMode[e] !== 0 || yMin < g.exLo[e] || yMax >= g.exHi[e]) return false;
      const za = zl0 + zl1 * ta, zb = zl0 + zl1 * tb, zc = zh0 + zh1 * ta, zd = zh0 + zh1 * tb;
      if ((za < zb ? za : zb) < j + POST && !postOpen(g, X, j)) return false;
      if ((zc > zd ? zc : zd) > j + 1 - POST && !postOpen(g, X, j + 1)) return false;
    }
  }
  if (south) {
    const Z = j + 1;
    ta = 0; tb = 1;
    if (cutZ(Z, Z) && cutX(i, i + 1)) {
      yRange();
      const e = Z * n + i;
      if (g.ezMode[e] !== 0 || yMin < g.ezLo[e] || yMax >= g.ezHi[e]) return false;
      const xa = xl0 + xl1 * ta, xb = xl0 + xl1 * tb, xc = xh0 + xh1 * ta, xd = xh0 + xh1 * tb;
      if ((xa < xb ? xa : xb) < i + POST && !postOpen(g, i, Z)) return false;
      if ((xc > xd ? xc : xd) > i + 1 - POST && !postOpen(g, i + 1, Z)) return false;
    }
  }
  return true;
}

/**
 * True if no segment from a point of `beamBox` to a point of light l's emitter can be occluded for bake group
 * `group` (see the header). False means "unknown": cast rays.
 */
export function beamClear(job: BakeJob, l: number, group: number): boolean {
  const g = job.g, L = job.L, n = g.n, o = l * 3;
  freeIntervals(g);
  const fLo = freeLo, fHi = freeHi;
  // emitter box: every classification corner, shadow sample and the visibility end point lie inside it
  // (points: centre + tangential offsets + 0.02 m along the emitting normal; sphere: a disc of radius w/2)
  const shape = L.shape[l];
  let ex: number, ey: number, ez: number, lx = L.pos[o], ly = L.pos[o + 1], lz = L.pos[o + 2];
  if (shape === SHAPE_SPHERE) { ex = L.w[l] * 0.5 / CELL; ey = L.w[l] * 0.5; ez = ex; } else {
    const hw = L.w[l] * 0.5, hh = (shape === SHAPE_RECT ? L.h[l] : L.w[l]) * 0.5, off = 0.01 + 1e-7;
    lx += L.nrm[o] * 0.01 / CELL; ly += L.nrm[o + 1] * 0.01; lz += L.nrm[o + 2] * 0.01 / CELL;
    ex = (Math.abs(L.tan[o]) * hw + Math.abs(L.bit[o]) * hh + Math.abs(L.nrm[o]) * off) / CELL;
    ey = Math.abs(L.tan[o + 1]) * hw + Math.abs(L.bit[o + 1]) * hh + Math.abs(L.nrm[o + 1]) * off;
    ez = (Math.abs(L.tan[o + 2]) * hw + Math.abs(L.bit[o + 2]) * hh + Math.abs(L.nrm[o + 2]) * off) / CELL;
  }
  const e0x = lx - ex - EPS_XZ, e1x = lx + ex + EPS_XZ, e0y = ly - ey, e1y = ly + ey, e0z = lz - ez - EPS_XZ, e1z = lz + ez + EPS_XZ;
  const p0x = beamBox[0] - EPS_XZ, p0y = beamBox[1], p0z = beamBox[2] - EPS_XZ;
  const p1x = beamBox[3] + EPS_XZ, p1y = beamBox[4], p1z = beamBox[5] + EPS_XZ;
  if (!(p0x <= p1x && p0y <= p1y && p0z <= p1z)) return false;
  const X0 = p0x < e0x ? p0x : e0x, X1 = p1x > e1x ? p1x : e1x;
  const Z0 = p0z < e0z ? p0z : e0z, Z1 = p1z > e1z ? p1z : e1z;
  // (the last halo row / column has no south / east edges in the grid arrays: stay one cell inside)
  if (X0 < 0 || Z0 < 0 || X1 >= n - 1 || Z1 >= n - 1) return false;
  xl0 = p0x; xl1 = e0x - p0x; xh0 = p1x; xh1 = e1x - p1x; xli = 1 / xl1; xhi = 1 / xh1;
  yl0 = p0y; yl1 = e0y - p0y; yh0 = p1y; yh1 = e1y - p1y; yli = 1 / yl1; yhi = 1 / yh1;
  zl0 = p0z; zl1 = e0z - p0z; zh0 = p1z; zh1 = e1z - p1z; zli = 1 / zl1; zhi = 1 / zh1;
  let budget = MAX_CELLS;
  const j0 = Math.floor(Z0), j1 = Math.floor(Z1);
  // walk rows (and cells within a row) from the receiver's side
  const jUp = e0z + e1z >= p0z + p1z, iUp = e0x + e1x >= p0x + p1x;
  for (let jj = 0, nj = j1 - j0 + 1; jj < nj; jj++) {
    const j = jUp ? j0 + jj : j1 - jj;
    ta = 0; tb = 1;
    if (!cutZ(j, j + 1)) continue;
    const ra = ta, rb = tb; // the row's t interval
    const xa = xl0 + xl1 * ra, xb = xl0 + xl1 * rb, xc = xh0 + xh1 * ra, xd = xh0 + xh1 * rb;
    const i0 = Math.floor(xa < xb ? xa : xb), i1 = Math.floor(xc > xd ? xc : xd);
    yRange();
    const rowLo = yMin, rowHi = yMax;
    const south = j < j1;
    for (let ii = 0, ni = i1 - i0 + 1; ii < ni; ii++) {
      const i = iUp ? i0 + ii : i1 - ii;
      if (--budget < 0) return false;
      const c = j * n + i;
      if (g.group[c] !== group || (g.flags[c] & SOLID) !== 0) return false;
      // the row's height range inside the cell's free interval settles it (cell, boxes, own edges and posts)
      if (rowLo >= fLo[c] && rowHi <= fHi[c]) continue;
      if (!cellOk(g, i, j, ra, rb, group, i < i1, south)) return false;
    }
  }
  return true;
}
