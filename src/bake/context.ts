// src/bake/context.ts — bake context + direct-light test helpers (WP7; stable API used by tests), and texel setup
// (WP7 §Algorithms 4). Pure module.
//
// Texel setup:
//   - grid charts (FLOOR_GRID / CEIL_GRID): x,z from the chart formula (texel centre (u - 0.5) * t, never on a
//     cell line); owner = the cell containing it; y = owner floor + 0.02 / owner ceiling - 0.02;
//   - other charts: p = origin + (u + 0.5) axisU + (v + 0.5) axisV + 0.02 normal; owner = cell containing
//     p + 0.01 normal;
//   - every sample is clamped LM_SAMPLE_WALL_CLEAR inside its owner cell on each side whose edge occludes at the
//     sample height (or whose neighbour is solid / out of group / above or below it there), and away from corner
//     posts;
//   - invalid texels (filled by dilation): owner SOLID (floor grid: also VOID, blocker), TOWER cell of another
//     group, sample inside an occluder box, outside the owner's vertical span, NO_CEIL / OPEN_DARK ceilings,
//     apron texels without a `cont` bit. Apron texels with `cont` bits are baked at their true positions.
//   - receiver patches: the valid texels of one chart inside one owner cell (non-grid charts: and one 1.5 m
//     height band).

import { CELL, LM_PAD, LM_SAMPLE_WALL_CLEAR } from '../core/constants.ts';
import type { TileKey, Vec3 } from '../core/grid.ts';
import { CeilKind, CellFlag } from '../core/ids.ts';
import type { Fixture } from '../core/layout.ts';
import { ChartKind, type Chart, type SurfaceSet } from '../core/mesh.ts';
import type { BakeQuality } from '../core/quality.ts';
import type { LayoutNeighborhood } from '../core/world.ts';
import { EXACT_FULL, emitterSample, formFactor, ff, rot, sampleRotation, sp } from './areaLight.ts';
import { crossX, crossZ, occluded, vertexBlocked } from './dda.ts';
import { createJob, type BakeJob } from './job.ts';
import { HALO_OFF, INV_CELL, SURF_OFF, quant, windowDist2, windowW } from './util.ts';
import { insideBox } from './visgrid.ts';

export type { BakeCache } from './cache.ts';
export { createBakeCache } from './cache.ts';

export interface BakeContext { readonly tile: TileKey; readonly lights: readonly Fixture[]; readonly originX: number; readonly originZ: number }

interface ContextImpl extends BakeContext { readonly job: BakeJob }

export function createBakeContext(nb: LayoutNeighborhood, tile: TileKey, q: BakeQuality): BakeContext {
  const job = createJob(nb, tile, q, null);
  const L = job.L;
  const lights: Fixture[] = [];
  for (let l = 0; l < L.n; l++) {
    const f = L.fixtures[l];
    lights.push({ ...f, px: (L.pos[l * 3] - HALO_OFF) * CELL, pz: (L.pos[l * 3 + 2] - HALO_OFF) * CELL });
  }
  const ctx: ContextImpl = { tile, lights, originX: job.originX, originZ: job.originZ, job };
  return ctx;
}

const jobOf = (ctx: BakeContext): BakeJob => (ctx as ContextImpl).job;
const hx = (m: number): number => HALO_OFF + quant(m * INV_CELL);

/** tile-local metres */
export function traceVisible(ctx: BakeContext, ax: number, ay: number, az: number, bx: number, by: number, bz: number, group: number): boolean {
  return !occluded(jobOf(ctx).g, hx(ax), ay, hx(az), hx(bx), by, hx(bz), group, false);
}

/** direct only, lux: every static light of the group, window, exact form factor and shadow-sampled visibility. */
export function irradianceAt(ctx: BakeContext, p: Vec3, n: Vec3, group: number, out: Vec3): void {
  const job = jobOf(ctx);
  const L = job.L, g = job.g;
  const x = hx(p[0]), z = hx(p[2]), y = p[1];
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  const nx = n[0] / nl, ny = n[1] / nl, nz = n[2] / nl;
  out[0] = 0; out[1] = 0; out[2] = 0;
  const S = job.q.shadowSamples;
  for (let l = 0; l < L.n; l++) {
    if (L.dynamic[l] !== 0 || L.group[l] !== group) continue;
    const o = l * 3;
    const w = windowW(windowDist2((L.pos[o] - x) * CELL, L.pos[o + 1] - y, (L.pos[o + 2] - z) * CELL, L.hAllow[l]), L.invR2[l]);
    if (w <= 0) continue;
    const f = formFactor(L, l, x, y, z, nx, ny, nz, EXACT_FULL);
    if (f <= 0) continue;
    sampleRotation(Math.round((g.gi0 + x) * 1200), Math.round(y * 1000), Math.round((g.gj0 + z) * 1200), L.uid[l]);
    let vis = 0;
    for (let i = 0; i < S; i++) {
      emitterSample(L, l, i, x, y, z);
      if (!occluded(g, x, y, z, sp.x, sp.y, sp.z, group, false)) vis++;
    }
    const k = f * w * vis / S;
    out[0] += k * L.rad[o]; out[1] += k * L.rad[o + 1]; out[2] += k * L.rad[o + 2];
  }
  void ff; void rot;
}

// ---------------------------------------------------------------- texel setup

export const TX_UNUSED = 0, TX_VALID = 1, TX_INVALID = 2, TX_GUTTER = 3;

export interface TexelSet {
  n: number;
  atlasW: number; atlasH: number; tpc: number;
  map: Int32Array; // atlas texel -> compact index, -1 if none
  atlas: Int32Array; // compact -> atlas texel
  chart: Int32Array; u: Int32Array; v: Int32Array;
  state: Uint8Array;
  x: Float64Array; y: Float64Array; z: Float64Array; // halo cells / m
  nx: Float32Array; ny: Float32Array; nz: Float32Array;
  cell: Int32Array; // owner halo cell (-1 if none)
  group: Int32Array;
  patch: Int32Array; // receiver patch of valid texels, -1 otherwise
  // patches
  nPatch: number;
  pStart: Int32Array; pList: Int32Array; // CSR texel lists
  pChart: Int32Array; pCell: Int32Array; pGroup: Int32Array;
  pc: Float64Array; // 3/patch: selection point (grid charts: owner cell centre at the surface height; else centroid)
  pExt: Float64Array; // half extent (m)
  pYmin: Float64Array; pYmax: Float64Array; // sample height range of the patch (m)
  pCorner: Int32Array; // 4/patch: extreme texels (compact indices)
  grid: Uint8Array; // per chart: 1 floor grid, 2 ceil grid, 0 other
  chartW: Int32Array; chartH: Int32Array; // per chart: texel size (incl. apron)
  /** 1 = texel within 2 of a chart end that continues into a neighbouring tile (grid charts: every side): it is
   * shared with that tile, so it is evaluated without patch-dependent shortcuts (seam-exact). */
  seam: Uint8Array;
}

const CLEAR = quant(LM_SAMPLE_WALL_CLEAR / CELL);

/** Is the neighbour cell nc a barrier at height y for group `group`? */
function nbBlocks(job: BakeJob, nc: number, y: number, group: number): boolean {
  const g = job.g;
  if ((g.flags[nc] & CellFlag.SOLID) !== 0) return true;
  if (g.group[nc] !== group && ((g.flags[nc] & CellFlag.TOWER) !== 0 || group !== 0)) return true;
  return y < g.dFloor[nc] || y > g.dCeil[nc] || y < g.blockTop[nc];
}

/** Clamp (x, z) (halo cells) inside owner cell c at height y. Writes cx/cz of `clampOut`. */
export const clampOut = { x: 0, z: 0 };
export function clampSample(job: BakeJob, c: number, x: number, y: number, z: number, group: number): void {
  const g = job.g, n = g.n;
  const hi = c % n, hj = (c - hi) / n;
  let fx = x - hi, fz = z - hj;
  const nearW = fx < CLEAR, nearE = fx > 1 - CLEAR, nearN = fz < CLEAR, nearS = fz > 1 - CLEAR;
  if (!nearW && !nearE && !nearN && !nearS) { clampOut.x = x; clampOut.z = z; return; } // interior: nothing to clamp
  const wB = nearW && (crossX(g, hi, hj, fz, y) || (hi > 0 && nbBlocks(job, c - 1, y, group)));
  const eB = nearE && (crossX(g, hi + 1, hj, fz, y) || (hi + 1 < n && nbBlocks(job, c + 1, y, group)));
  const nB = nearN && (crossZ(g, hj, hi, fx, y) || (hj > 0 && nbBlocks(job, c - n, y, group)));
  const sB = nearS && (crossZ(g, hj + 1, hi, fx, y) || (hj + 1 < n && nbBlocks(job, c + n, y, group)));
  if (wB) fx = CLEAR;
  if (eB) fx = 1 - CLEAR;
  if (nB) fz = CLEAR;
  if (sB) fz = 1 - CLEAR;
  // corner posts
  for (let a = 0; a <= 1; a++) {
    for (let b = 0; b <= 1; b++) {
      const nearX = a === 0 ? fx < CLEAR : fx > 1 - CLEAR;
      const nearZ = b === 0 ? fz < CLEAR : fz > 1 - CLEAR;
      if (nearX && nearZ && vertexBlocked(g, hi + a, hj + b, y)) {
        fx = a === 0 ? CLEAR : 1 - CLEAR;
        fz = b === 0 ? CLEAR : 1 - CLEAR;
      }
    }
  }
  clampOut.x = hi + fx; clampOut.z = hj + fz;
}

/** Receiver patches of non-grid charts are further split into world-aligned height bands of PATCH_BAND metres
 * (boundaries at -1.5 + 1.5 k: they divide the 3 m tower period), so tall walls (12 m atrium walls, the 12 m
 * periodic tower shaft) select and classify their lights per band instead of from one far-away centre. */
export const PATCH_BAND = 1.5;
export const PATCH_BANDS = 32;
const patchBand = (y: number): number => {
  const b = Math.floor((y + 1.5) / PATCH_BAND) + 8; // y in [-13.5, 34.5) -> 0..31
  return b < 0 ? 0 : b >= PATCH_BANDS ? PATCH_BANDS - 1 : b;
};

export function setupTexels(job: BakeJob, surfaces: SurfaceSet): TexelSet {
  const g = job.g, n = g.n;
  const W = surfaces.atlasW, H = surfaces.atlasH;
  const charts = surfaces.charts;
  // capacity: chart rects + gutters
  let cap = 0;
  for (const ch of charts) cap += (ch.w + 2 * LM_PAD) * (ch.h + 2 * LM_PAD);
  const map = new Int32Array(W * H).fill(-1);
  const atlas = new Int32Array(cap), chart = new Int32Array(cap), uA = new Int32Array(cap), vA = new Int32Array(cap);
  const state = new Uint8Array(cap);
  const X = new Float64Array(cap), Y = new Float64Array(cap), Z = new Float64Array(cap);
  const NX = new Float32Array(cap), NY = new Float32Array(cap), NZ = new Float32Array(cap);
  const cell = new Int32Array(cap).fill(-1), group = new Int32Array(cap), patch = new Int32Array(cap).fill(-1);
  const gridK = new Uint8Array(charts.length);
  let cnt = 0;
  // patches (built per chart)
  // patch of a halo cell for the current chart (stamped with the chart index + 1)
  const pOf = new Int32Array(n * n * PATCH_BANDS), pStamp = new Int32Array(n * n * PATCH_BANDS);
  const pChart: number[] = [], pCell: number[] = [], pGroup: number[] = [];

  for (let ci = 0; ci < charts.length; ci++) {
    const ch = charts[ci];
    const grid = ch.kind === ChartKind.FLOOR_GRID ? 1 : ch.kind === ChartKind.CEIL_GRID ? 2 : 0;
    gridK[ci] = grid;
    let nx = ch.normal[0], ny = ch.normal[1], nz = ch.normal[2];
    const nl = Math.hypot(nx, ny, nz);
    if (nl > 1e-9) { nx /= nl; ny /= nl; nz /= nl; } else { nx = 0; ny = grid === 2 ? -1 : 1; nz = 0; }
    if (grid === 1) { nx = 0; ny = 1; nz = 0; } else if (grid === 2) { nx = 0; ny = -1; nz = 0; }
    const cgroup = ch.bakeGroup;
    for (let v = 0; v < ch.h; v++) {
      for (let u = 0; u < ch.w; u++) {
        const ax = ch.x + u, ay = ch.y + v;
        if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
        const ai = ay * W + ax;
        if (map[ai] >= 0) continue; // overlapping charts: first wins (WP5 guarantees none)
        const t = cnt++;
        map[ai] = t; atlas[t] = ai; chart[t] = ci; uA[t] = u; vA[t] = v;
        NX[t] = nx; NY[t] = ny; NZ[t] = nz;
        group[t] = cgroup;
        const lx = ch.origin[0] + (u + 0.5) * ch.axisU[0] + (v + 0.5) * ch.axisV[0];
        const ly = ch.origin[1] + (u + 0.5) * ch.axisU[1] + (v + 0.5) * ch.axisV[1];
        const lz = ch.origin[2] + (u + 0.5) * ch.axisU[2] + (v + 0.5) * ch.axisV[2];
        let x: number, z: number, y: number, c: number;
        if (grid !== 0) {
          x = HALO_OFF + quant(lx * INV_CELL); z = HALO_OFF + quant(lz * INV_CELL);
          const hi = Math.floor(x), hj = Math.floor(z);
          c = hi >= 0 && hj >= 0 && hi < n && hj < n ? hj * n + hi : -1;
          y = c < 0 ? 0 : grid === 1 ? g.floor[c] + SURF_OFF : g.ceil[c] - SURF_OFF;
        } else {
          x = HALO_OFF + quant((lx + SURF_OFF * nx) * INV_CELL); z = HALO_OFF + quant((lz + SURF_OFF * nz) * INV_CELL);
          y = ly + SURF_OFF * ny;
          const hi = Math.floor(x + 0.01 * nx * INV_CELL), hj = Math.floor(z + 0.01 * nz * INV_CELL);
          c = hi >= 0 && hj >= 0 && hi < n && hj < n ? hj * n + hi : -1;
        }
        let ok = c >= 0;
        if (ok) {
          const f = g.flags[c];
          if ((f & CellFlag.SOLID) !== 0) ok = false;
          else if (g.group[c] !== cgroup && ((f & CellFlag.TOWER) !== 0 || cgroup !== 0)) ok = false;
          else if (grid === 1 && ((f & CellFlag.VOID) !== 0 || g.blockTop[c] > g.floor[c])) ok = false;
          else if (grid === 2 && ((f & CellFlag.NO_CEIL) !== 0 || g.ceilKind[c] === CeilKind.OPEN_DARK)) ok = false;
          else if (grid === 0 && (y < g.dFloor[c] - 0.03 || y > g.dCeil[c] + 0.03)) ok = false;
          else if (grid === 0 && (
            (u === 0 && (ch.cont & 1) === 0) || (u === ch.w - 1 && (ch.cont & 2) === 0) ||
            (v === 0 && (ch.cont & 4) === 0) || (v === ch.h - 1 && (ch.cont & 8) === 0))) ok = false;
        }
        if (ok) {
          // the owner may differ from the cell containing x,z for non-grid charts: keep the sample inside it
          const hi = c % n, hj = (c - hi) / n;
          if (x < hi) x = hi; else if (x >= hi + 1) x = hi + 1 - 1 / 1048576;
          if (z < hj) z = hj; else if (z >= hj + 1) z = hj + 1 - 1 / 1048576;
          clampSample(job, c, x, y, z, cgroup);
          x = clampOut.x; z = clampOut.z;
          if (insideBox(g, c, x, y, z, cgroup)) ok = false;
        }
        X[t] = x; Y[t] = y; Z[t] = z;
        cell[t] = c;
        state[t] = ok ? TX_VALID : TX_INVALID;
        if (ok) {
          const pk = c * PATCH_BANDS + (grid !== 0 ? 0 : patchBand(y));
          let p = pStamp[pk] === ci + 1 ? pOf[pk] : -1;
          if (p < 0) {
            p = pChart.length;
            pStamp[pk] = ci + 1; pOf[pk] = p;
            pChart.push(ci); pCell.push(c); pGroup.push(cgroup);
          }
          patch[t] = p;
        }
      }
    }
  }
  // gutters (filled by dilation; first chart claims a texel)
  for (let ci = 0; ci < charts.length; ci++) {
    const ch = charts[ci];
    for (let v = -LM_PAD; v < ch.h + LM_PAD; v++) {
      for (let u = -LM_PAD; u < ch.w + LM_PAD; u++) {
        if (u >= 0 && v >= 0 && u < ch.w && v < ch.h) continue;
        const ax = ch.x + u, ay = ch.y + v;
        if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
        const ai = ay * W + ax;
        if (map[ai] >= 0) continue;
        const t = cnt++;
        map[ai] = t; atlas[t] = ai; chart[t] = ci; uA[t] = u; vA[t] = v;
        state[t] = TX_GUTTER;
        NX[t] = 0; NY[t] = 1; NZ[t] = 0;
      }
    }
  }
  // patch CSR + selection points + extremes
  const nP = pChart.length;
  const pStart = new Int32Array(nP + 1);
  for (let t = 0; t < cnt; t++) if (patch[t] >= 0) pStart[patch[t] + 1]++;
  for (let p = 0; p < nP; p++) pStart[p + 1] += pStart[p];
  const pList = new Int32Array(pStart[nP]);
  const fill = pStart.slice(0, nP);
  for (let t = 0; t < cnt; t++) if (patch[t] >= 0) pList[fill[patch[t]]++] = t;
  const pc = new Float64Array(nP * 3), pExt = new Float64Array(nP), pCorner = new Int32Array(nP * 4);
  const pYmin = new Float64Array(nP), pYmax = new Float64Array(nP);
  for (let p = 0; p < nP; p++) {
    let sx = 0, sy = 0, sz = 0;
    let bMin = 1e30, bMax = -1e30, dMin = 1e30, dMax = -1e30;
    let iMin = -1, iMax = -1, jMin = -1, jMax = -1;
    const a = pStart[p], b = pStart[p + 1];
    for (let k = a; k < b; k++) {
      const t = pList[k];
      sx += X[t]; sy += Y[t]; sz += Z[t];
      const s1 = uA[t] + vA[t], s2 = uA[t] - vA[t];
      if (s1 < bMin) { bMin = s1; iMin = t; }
      if (s1 > bMax) { bMax = s1; iMax = t; }
      if (s2 < dMin) { dMin = s2; jMin = t; }
      if (s2 > dMax) { dMax = s2; jMax = t; }
    }
    const inv = 1 / (b - a);
    let cx = sx * inv, cy = sy * inv, cz = sz * inv;
    const c = pCell[p];
    let ylo = Infinity, yhi = -Infinity;
    for (let k = a; k < b; k++) { const yy = Y[pList[k]]; if (yy < ylo) ylo = yy; if (yy > yhi) yhi = yy; }
    pYmin[p] = ylo; pYmax[p] = yhi;
    // Selection point and extent must not depend on which of the cell's texels this tile owns (a tile's apron
    // patch and the neighbour tile's full patch of the same cell must select the same lights): in-plane
    // horizontal coordinates snap to the owner cell centre, the extent is the cell's.
    const t0 = pList[a];
    const hc = (c % n) + 0.5, vc = (c - (c % n)) / n + 0.5;
    let ext: number;
    if (gridK[pChart[p]] !== 0 || Math.abs(NY[t0]) > 0.9) { cx = hc; cz = vc; ext = 0.5 * CELL * Math.SQRT2; }
    else if (Math.abs(NX[t0]) > 0.9) { cz = vc; ext = Math.sqrt(0.36 + 0.25 * (yhi - ylo) * (yhi - ylo)); }
    else if (Math.abs(NZ[t0]) > 0.9) { cx = hc; ext = Math.sqrt(0.36 + 0.25 * (yhi - ylo) * (yhi - ylo)); }
    else {
      ext = 0;
      for (let k = a; k < b; k++) {
        const t = pList[k];
        const ex = (X[t] - cx) * CELL, ey = Y[t] - cy, ez = (Z[t] - cz) * CELL;
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (d > ext) ext = d;
      }
    }
    pc[p * 3] = cx; pc[p * 3 + 1] = cy; pc[p * 3 + 2] = cz;
    pExt[p] = ext;
    pCorner[p * 4] = iMin; pCorner[p * 4 + 1] = iMax; pCorner[p * 4 + 2] = jMin; pCorner[p * 4 + 3] = jMax;
  }
  return {
    n: cnt, atlasW: W, atlasH: H, tpc: surfaces.tpc,
    map, atlas: atlas.subarray(0, cnt), chart: chart.subarray(0, cnt), u: uA.subarray(0, cnt), v: vA.subarray(0, cnt),
    state: state.subarray(0, cnt), x: X.subarray(0, cnt), y: Y.subarray(0, cnt), z: Z.subarray(0, cnt),
    nx: NX.subarray(0, cnt), ny: NY.subarray(0, cnt), nz: NZ.subarray(0, cnt),
    cell: cell.subarray(0, cnt), group: group.subarray(0, cnt), patch: patch.subarray(0, cnt),
    nPatch: nP, pStart, pList, pChart: Int32Array.from(pChart), pCell: Int32Array.from(pCell), pGroup: Int32Array.from(pGroup),
    pc, pExt, pYmin, pYmax, pCorner, grid: gridK,
    chartW: Int32Array.from(charts, (c) => c.w), chartH: Int32Array.from(charts, (c) => c.h),
    seam: seamFlags(charts, gridK, chart.subarray(0, cnt), uA.subarray(0, cnt), vA.subarray(0, cnt)),
  };
}

function seamFlags(charts: readonly Chart[], grid: Uint8Array, chart: Int32Array, u: Int32Array, v: Int32Array): Uint8Array {
  const n = chart.length;
  const out = new Uint8Array(n);
  for (let t = 0; t < n; t++) {
    const ci = chart[t], ch = charts[ci];
    const cont = grid[ci] !== 0 ? 15 : ch.cont;
    if (cont === 0) continue;
    const uu = u[t], vv = v[t];
    if (((cont & 1) !== 0 && uu <= 1) || ((cont & 2) !== 0 && uu >= ch.w - 2) ||
      ((cont & 4) !== 0 && vv <= 1) || ((cont & 8) !== 0 && vv >= ch.h - 2)) out[t] = 1;
  }
  return out;
}

/** Lattice parity offset of a chart: grid charts use (u - 1) so the lattice is world-aligned across tiles. */
export const latticeOff = (T: TexelSet, chart: number): number => (T.grid[chart] !== 0 ? 1 : 0);
/** Is texel t on the 2x2 evaluation lattice? */
export const isLattice = (T: TexelSet, t: number, gridOff: number): boolean =>
  ((T.u[t] - gridOff) & 1) === 0 && ((T.v[t] - gridOff) & 1) === 0;

/** Lattice neighbours of the last `latticeNeighbours` call. */
export const latNbr = new Int32Array(4);
/**
 * The lattice texels an off-lattice texel t (of patch p) interpolates from: its two horizontal, two vertical or
 * four diagonal lattice neighbours, all VALID texels of the same patch. Returns their count in latNbr, or 0 when the
 * texel must be evaluated exactly: missing neighbours, or one of the two texel rows / columns next to each chart
 * end (apron + first interior), so texels shared by two tiles are computed the same way on both sides of a seam.
 */
export function latticeNeighbours(T: TexelSet, t: number, p: number, gridOff: number): number {
  const u = T.u[t], v = T.v[t];
  const ch = T.chart[t];
  const w = T.chartW[ch], h = T.chartH[ch];
  if (u <= 1 || v <= 1 || u >= w - 2 || v >= h - 2) return 0;
  const ou = (u - gridOff) & 1, ov = (v - gridOff) & 1;
  const W = T.atlasW, base = T.atlas[t];
  let cnt = 0;
  for (let k = 0; k < 4; k++) {
    let du: number, dv: number;
    if (ou === 1 && ov === 0) { if (k >= 2) break; du = k === 0 ? -1 : 1; dv = 0; }
    else if (ou === 0 && ov === 1) { if (k >= 2) break; du = 0; dv = k === 0 ? -1 : 1; }
    else { du = (k & 1) === 0 ? -1 : 1; dv = k < 2 ? -1 : 1; }
    const s = T.map[base + dv * W + du];
    if (s < 0 || T.chart[s] !== ch || T.u[s] !== u + du || T.v[s] !== v + dv || T.state[s] !== TX_VALID || T.patch[s] !== p) return 0;
    latNbr[cnt++] = s;
  }
  return cnt;
}

/** Quantized world position of a texel for hashing (mm); tower groups wrap y into one period. */
export const wq = { x: 0, y: 0, z: 0 };
export function worldQ(job: BakeJob, x: number, y: number, z: number, tower: boolean): void {
  wq.x = Math.round((job.g.gi0 + x) * 1200);
  wq.z = Math.round((job.g.gj0 + z) * 1200);
  const yy = tower ? y - 3 * Math.floor((y + 1.5) / 3) : y;
  wq.y = Math.round(yy * 1000);
}
