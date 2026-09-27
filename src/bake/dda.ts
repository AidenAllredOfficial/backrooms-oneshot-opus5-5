// src/bake/dda.ts — 2.5D visibility: a 2D Amanatides–Woo walk over the VisGrid cells in xz with the height
// interpolated along the segment (WP7 §Algorithms 2). Pure module, allocation-free.
//
// Within each cell a segment is occluded if it leaves [floor, ceiling], dips under a blocker top, enters a SOLID
// cell or a cell of another bake group (group-0 rays treat TOWER/ELEVATOR cells as solid, tower rays everything
// outside their tower), or hits a bucketed occluder box / ramp slab of its own group. At every edge-line crossing
// `edgeOccludesAt` is evaluated at the crossing point; crossings within WALL_T/2 of a vertex also test every
// edge meeting at that vertex (the corner posts), so vertex crossings test both edges.
// x/z are halo cell units (exact dyadic), y metres; the segment parameter t runs over [0, 1].

import { CELL, DOOR_W, WALL_T } from '../core/constants.ts';
import { edgeOccludesAt } from '../core/edges.ts';
import { CellFlag } from '../core/ids.ts';
import { DDA_EPS_Y, MAT_PROP, type VisGrid } from './visgrid.ts';

const EPS_Y = DDA_EPS_Y;
const POST = WALL_T / 2 / CELL; // post half-width in cell units
const SOLID = CellFlag.SOLID;

/** Ray counters (stats): total and per kind (RAY_*: classification segments, shadow samples, bitset, probe). */
export const RAY_CLASSIFY = 0, RAY_SHADOW = 1, RAY_BITSET = 2, RAY_PROBE = 3;
export const rayStats = { rays: 0, kind: RAY_CLASSIFY, byKind: new Float64Array(4) };

function nextStamp(g: VisGrid): number {
  g.stamp++;
  if (g.stamp > 0x3fffffff) { g.stamp = 1; g.boxStamp.fill(0); }
  return g.stamp;
}

const HALF_HOLE = DOOR_W / 2;
/** edgeOccludesAt of an x-edge / z-edge from the precomputed occlusion intervals (VisGrid.exLo). */
const occEx = (g: VisGrid, e: number, t: number, y: number): boolean => {
  if (y < g.exLo[e] || y >= g.exHi[e]) return true;
  const m = g.exMode[e];
  if (m === 0) return false;
  if (m === 1) return Math.abs(t - CELL / 2) >= HALF_HOLE;
  return edgeOccludesAt(g.exKind[e], g.exA[e], g.exB[e], t, y, g.exSill[e]);
};
const occEz = (g: VisGrid, e: number, t: number, y: number): boolean => {
  if (y < g.ezLo[e] || y >= g.ezHi[e]) return true;
  const m = g.ezMode[e];
  if (m === 0) return false;
  if (m === 1) return Math.abs(t - CELL / 2) >= HALF_HOLE;
  return edgeOccludesAt(g.ezKind[e], g.ezA[e], g.ezB[e], t, y, g.ezSill[e]);
};

/** Any occluding edge (post) at vertex (X, Z) at height y. */
export function vertexBlocked(g: VisGrid, X: number, Z: number, y: number): boolean {
  if (X < 0 || Z < 0 || X > g.n || Z > g.n) return false;
  const v = Z * (g.n + 1) + X;
  return y < g.vLo[v] || y >= g.vHi[v];
}

/** Crossing the x-line X within row `row` at `along` (cell units from the row start), height y. */
export function crossX(g: VisGrid, X: number, row: number, along: number, y: number): boolean {
  if (X < 0 || X > g.n || row < 0 || row >= g.n) return true;
  if (occEx(g, row * (g.n + 1) + X, along * CELL, y)) return true;
  if (along < POST) return vertexBlocked(g, X, row, y);
  if (along > 1 - POST) return vertexBlocked(g, X, row + 1, y);
  return false;
}
/** Crossing the z-line Z within column `col`. */
export function crossZ(g: VisGrid, Z: number, col: number, along: number, y: number): boolean {
  if (Z < 0 || Z > g.n || col < 0 || col >= g.n) return true;
  if (occEz(g, Z * g.n + col, along * CELL, y)) return true;
  if (along < POST) return vertexBlocked(g, col, Z, y);
  if (along > 1 - POST) return vertexBlocked(g, col + 1, Z, y);
  return false;
}

/** Segment (t in [0,1]) against box b (slab test, strict). */
function segBox(g: VisGrid, b: number, ax: number, ay: number, az: number, dx: number, dy: number, dz: number): boolean {
  const o = b * 6;
  let t0 = 0, t1 = 1;
  if (dx !== 0) {
    let u = (g.box[o] - ax) / dx, v = (g.box[o + 3] - ax) / dx;
    if (u > v) { const w = u; u = v; v = w; }
    if (u > t0) t0 = u; if (v < t1) t1 = v;
    if (t0 >= t1) return false;
  } else if (ax <= g.box[o] || ax >= g.box[o + 3]) return false;
  if (dz !== 0) {
    let u = (g.box[o + 2] - az) / dz, v = (g.box[o + 5] - az) / dz;
    if (u > v) { const w = u; u = v; v = w; }
    if (u > t0) t0 = u; if (v < t1) t1 = v;
    if (t0 >= t1) return false;
  } else if (az <= g.box[o + 2] || az >= g.box[o + 5]) return false;
  const r = g.boxRamp[b];
  if (r < 0) {
    if (dy !== 0) {
      let u = (g.box[o + 1] - ay) / dy, v = (g.box[o + 4] - ay) / dy;
      if (u > v) { const w = u; u = v; v = w; }
      if (u > t0) t0 = u; if (v < t1) t1 = v;
      return t0 < t1;
    }
    return ay > g.box[o + 1] && ay < g.box[o + 4];
  }
  // ramp slab: f(t) = y(t) - h(t) must enter (-thick, 0) somewhere in [t0, t1] (f is linear there)
  const fa = ay + t0 * dy - rampH(g, b, ax + t0 * dx, az + t0 * dz);
  const fb = ay + t1 * dy - rampH(g, b, ax + t1 * dx, az + t1 * dz);
  const th = g.rampY[b * 3 + 2];
  return Math.max(fa, fb) > -th && Math.min(fa, fb) < 0;
}

function rampH(g: VisGrid, b: number, x: number, z: number): number {
  const o = b * 6, r = g.boxRamp[b];
  const y0 = g.rampY[b * 3], y1 = g.rampY[b * 3 + 1];
  let s = r === 0 ? (x - g.box[o]) / (g.box[o + 3] - g.box[o])
    : r === 1 ? (g.box[o + 3] - x) / (g.box[o + 3] - g.box[o])
      : r === 2 ? (z - g.box[o + 2]) / (g.box[o + 5] - g.box[o + 2])
        : (g.box[o + 5] - z) / (g.box[o + 5] - g.box[o + 2]);
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  return y0 + (y1 - y0) * s;
}

/**
 * True if the segment A->B is blocked for bake group `group`. `exemptStart`: skip the group/SOLID test in the
 * start cell (texel rays start in their owner cell, which may be an elevator lobby cell).
 */
export function occluded(g: VisGrid, ax: number, ay: number, az: number, bx: number, by: number, bz: number, group: number, exemptStart: boolean): boolean {
  rayStats.rays++;
  rayStats.byKind[rayStats.kind]++;
  const n = g.n;
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  let ci = Math.floor(ax), cj = Math.floor(az);
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0, sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const ix = dx !== 0 ? 1 / dx : 0, iz = dz !== 0 ? 1 / dz : 0;
  let tx = sx > 0 ? (ci + 1 - ax) * ix : sx < 0 ? (ci - ax) * ix : Infinity;
  let tz = sz > 0 ? (cj + 1 - az) * iz : sz < 0 ? (cj - az) * iz : Infinity;
  let t0 = 0;
  const stamp = nextStamp(g);
  let first = exemptStart;
  for (;;) {
    if (ci < 0 || cj < 0 || ci >= n || cj >= n) return true;
    const c = cj * n + ci;
    const t1 = tx < tz ? (tx < 1 ? tx : 1) : (tz < 1 ? tz : 1);
    if (!first && g.ddaGroup[c] !== group) return true;
    first = false;
    const ya = ay + t0 * dy, yb = ay + t1 * dy;
    const ylo = ya < yb ? ya : yb, yhi = ya < yb ? yb : ya;
    const rc = g.ddaCell, r = c * 4;
    if (ylo < rc[r] || yhi > rc[r + 1]) return true;
    // (a height range outside every box of the cell skips the list: each box would skip itself below)
    if (yhi > rc[r + 2] && ylo < rc[r + 3]) for (let k = g.boxStart[c], ke = g.boxStart[c + 1]; k < ke; k++) {
      const b = g.boxList[k];
      if (g.boxStamp[b] === stamp) continue;
      // the segment's height range inside this cell misses the box: it may still hit it in another cell of the
      // box's footprint, so it is not stamped as tested
      if (yhi <= g.box[b * 6 + 1] || ylo >= g.box[b * 6 + 4]) continue;
      g.boxStamp[b] = stamp;
      if (g.boxGroup[b] === group && segBox(g, b, ax, ay, az, dx, dy, dz)) return true;
    }
    if (t1 >= 1) return false;
    if (tx < tz) {
      const X = sx > 0 ? ci + 1 : ci;
      const along = (az - cj) + tx * dz, y = ay + tx * dy;
      const e = cj * (n + 1) + X;
      if (y < g.exLo[e] || y >= g.exHi[e]) return true;
      const md = g.exMode[e];
      if (md !== 0 && (md === 1 ? Math.abs(along * CELL - CELL / 2) >= HALF_HOLE : edgeOccludesAt(g.exKind[e], g.exA[e], g.exB[e], along * CELL, y, g.exSill[e]))) return true;
      if (along < POST) { const v = cj * (n + 1) + X; if (y < g.vLo[v] || y >= g.vHi[v]) return true; }
      else if (along > 1 - POST) { const v = (cj + 1) * (n + 1) + X; if (y < g.vLo[v] || y >= g.vHi[v]) return true; }
      ci += sx; t0 = tx;
      tx = (sx > 0 ? ci + 1 - ax : ci - ax) * ix;
    } else {
      const Z = sz > 0 ? cj + 1 : cj;
      const along = (ax - ci) + tz * dx, y = ay + tz * dy;
      const e = Z * n + ci;
      if (y < g.ezLo[e] || y >= g.ezHi[e]) return true;
      const md = g.ezMode[e];
      if (md !== 0 && (md === 1 ? Math.abs(along * CELL - CELL / 2) >= HALF_HOLE : edgeOccludesAt(g.ezKind[e], g.ezA[e], g.ezB[e], along * CELL, y, g.ezSill[e]))) return true;
      if (along < POST) { const v = Z * (n + 1) + ci; if (y < g.vLo[v] || y >= g.vHi[v]) return true; }
      else if (along > 1 - POST) { const v = Z * (n + 1) + ci + 1; if (y < g.vLo[v] || y >= g.vHi[v]) return true; }
      cj += sz; t0 = tz;
      tz = (sz > 0 ? cj + 1 - az : cj - az) * iz;
    }
  }
}

/**
 * Up to five rays sharing the xz path (cell centre at 5 heights -> one end point). Returns the bitmask of the
 * heights (bit k = start height ys[k]) whose segment is unoccluded. No start-cell exemption. Allocation-free.
 */
export function trace5(g: VisGrid, ax: number, az: number, ys: Float64Array, bx: number, by: number, bz: number, group: number): number {
  rayStats.rays += 5;
  rayStats.byKind[RAY_BITSET] += 5;
  const n = g.n;
  const dx = bx - ax, dz = bz - az;
  const y0 = ys[0], y1 = ys[1], y2 = ys[2], y3 = ys[3], y4 = ys[4];
  const d0 = by - y0, d1 = by - y1, d2 = by - y2, d3 = by - y3, d4 = by - y4;
  let alive = 31;
  let ci = Math.floor(ax), cj = Math.floor(az);
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0, sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const ix = dx !== 0 ? 1 / dx : 0, iz = dz !== 0 ? 1 / dz : 0;
  let tx = sx > 0 ? (ci + 1 - ax) * ix : sx < 0 ? (ci - ax) * ix : Infinity;
  let tz = sz > 0 ? (cj + 1 - az) * iz : sz < 0 ? (cj - az) * iz : Infinity;
  let t0 = 0;
  const stamp = nextStamp(g);
  for (;;) {
    if (ci < 0 || cj < 0 || ci >= n || cj >= n) return 0;
    const c = cj * n + ci;
    const t1 = tx < tz ? (tx < 1 ? tx : 1) : (tz < 1 ? tz : 1);
    if (g.group[c] !== group || (g.flags[c] & SOLID) !== 0) return 0;
    const fl = g.dFloor[c] - EPS_Y, ce = g.dCeil[c] + EPS_Y, bt = g.blockTop[c] - EPS_Y;
    for (let k = 0; k < 5; k++) {
      if ((alive & (1 << k)) === 0) continue;
      const yk = k === 0 ? y0 : k === 1 ? y1 : k === 2 ? y2 : k === 3 ? y3 : y4;
      const dk = k === 0 ? d0 : k === 1 ? d1 : k === 2 ? d2 : k === 3 ? d3 : d4;
      const ya = yk + t0 * dk, yb = yk + t1 * dk;
      const ylo = ya < yb ? ya : yb, yhi = ya < yb ? yb : ya;
      if (ylo < fl || yhi > ce || ylo < bt) alive &= ~(1 << k);
    }
    if (alive === 0) return 0;
    for (let k = g.boxStart[c], ke = g.boxStart[c + 1]; k < ke; k++) {
      const b = g.boxList[k];
      if (g.boxStamp[b] === stamp) continue;
      g.boxStamp[b] = stamp;
      if (g.boxGroup[b] !== group) continue;
      if ((alive & 1) !== 0 && segBox(g, b, ax, y0, az, dx, d0, dz)) alive &= ~1;
      if ((alive & 2) !== 0 && segBox(g, b, ax, y1, az, dx, d1, dz)) alive &= ~2;
      if ((alive & 4) !== 0 && segBox(g, b, ax, y2, az, dx, d2, dz)) alive &= ~4;
      if ((alive & 8) !== 0 && segBox(g, b, ax, y3, az, dx, d3, dz)) alive &= ~8;
      if ((alive & 16) !== 0 && segBox(g, b, ax, y4, az, dx, d4, dz)) alive &= ~16;
      if (alive === 0) return 0;
    }
    if (t1 >= 1) return alive;
    if (tx < tz) {
      const X = sx > 0 ? ci + 1 : ci;
      const along = (az - cj) + tx * dz;
      if ((alive & 1) !== 0 && crossX(g, X, cj, along, y0 + tx * d0)) alive &= ~1;
      if ((alive & 2) !== 0 && crossX(g, X, cj, along, y1 + tx * d1)) alive &= ~2;
      if ((alive & 4) !== 0 && crossX(g, X, cj, along, y2 + tx * d2)) alive &= ~4;
      if ((alive & 8) !== 0 && crossX(g, X, cj, along, y3 + tx * d3)) alive &= ~8;
      if ((alive & 16) !== 0 && crossX(g, X, cj, along, y4 + tx * d4)) alive &= ~16;
      ci += sx; t0 = tx;
      tx = (sx > 0 ? ci + 1 - ax : ci - ax) * ix;
    } else {
      const Z = sz > 0 ? cj + 1 : cj;
      const along = (ax - ci) + tz * dx;
      if ((alive & 1) !== 0 && crossZ(g, Z, ci, along, y0 + tz * d0)) alive &= ~1;
      if ((alive & 2) !== 0 && crossZ(g, Z, ci, along, y1 + tz * d1)) alive &= ~2;
      if ((alive & 4) !== 0 && crossZ(g, Z, ci, along, y2 + tz * d2)) alive &= ~4;
      if ((alive & 8) !== 0 && crossZ(g, Z, ci, along, y3 + tz * d3)) alive &= ~8;
      if ((alive & 16) !== 0 && crossZ(g, Z, ci, along, y4 + tz * d4)) alive &= ~16;
      cj += sz; t0 = tz;
      tz = (sz > 0 ? cj + 1 - az : cj - az) * iz;
    }
    if (alive === 0) return 0;
  }
}

// ---------------------------------------------------------------- first hit (probe rays)

export const HIT_NONE = 0, HIT_FLOOR = 1, HIT_CEIL = 2, HIT_WALL = 3, HIT_BOX_TOP = 4, HIT_BOX_SIDE = 5, HIT_BOX_BOTTOM = 6;
/** Wall / box-side normal direction codes: 0 = +x, 1 = -x, 2 = +z, 3 = -z. `box`: the hit occluder box (HIT_BOX_*),
 * else -1. */
export interface HitRecord { kind: number; t: number; x: number; y: number; z: number; cell: number; dir: number; mat: number; wet: boolean; box: number }
export const hit: HitRecord = { kind: 0, t: 0, x: 0, y: 0, z: 0, cell: 0, dir: 0, mat: 0, wet: false, box: -1 };

/** Plenum albedo layer for missing ceilings. */
const MAT_PLENUM = 21;

/** Box entry: returns entry t in [tlo, thi] or -1, sets boxFace (1 floor-like top, 2 bottom, 3 side) and boxDir. */
let boxFace = 0, boxDir = 0;
function boxEntry(g: VisGrid, b: number, ax: number, ay: number, az: number, dx: number, dy: number, dz: number, tlo: number, thi: number): number {
  const o = b * 6;
  let t0 = -1e30, t1 = 1e30, ax0 = -1;
  if (dx !== 0) {
    let u = (g.box[o] - ax) / dx, v = (g.box[o + 3] - ax) / dx;
    if (u > v) { const w = u; u = v; v = w; }
    if (u > t0) { t0 = u; ax0 = 0; } if (v < t1) t1 = v;
  } else if (ax <= g.box[o] || ax >= g.box[o + 3]) return -1;
  if (dz !== 0) {
    let u = (g.box[o + 2] - az) / dz, v = (g.box[o + 5] - az) / dz;
    if (u > v) { const w = u; u = v; v = w; }
    if (u > t0) { t0 = u; ax0 = 2; } if (v < t1) t1 = v;
  } else if (az <= g.box[o + 2] || az >= g.box[o + 5]) return -1;
  if (t0 >= t1) return -1;
  const r = g.boxRamp[b];
  if (r < 0) {
    if (dy !== 0) {
      let u = (g.box[o + 1] - ay) / dy, v = (g.box[o + 4] - ay) / dy;
      if (u > v) { const w = u; u = v; v = w; }
      if (u > t0) { t0 = u; ax0 = 1; } if (v < t1) t1 = v;
    } else if (ay <= g.box[o + 1] || ay >= g.box[o + 4]) return -1;
    if (t0 >= t1 || t0 < tlo || t0 > thi) return -1;
    if (ax0 === 1) { boxFace = dy < 0 ? 1 : 2; boxDir = 0; }
    else if (ax0 === 0) { boxFace = 3; boxDir = dx > 0 ? 1 : 0; }
    else { boxFace = 3; boxDir = dz > 0 ? 3 : 2; }
    return t0;
  }
  // ramp: xz range [t0, t1]; f(t) = y - h linear
  const ta = t0 > 0 ? t0 : 0, tb = t1 < 1 ? t1 : 1;
  if (ta >= tb) return -1;
  const th = g.rampY[b * 3 + 2];
  const fa = ay + ta * dy - rampH(g, b, ax + ta * dx, az + ta * dz);
  const fb = ay + tb * dy - rampH(g, b, ax + tb * dx, az + tb * dz);
  let te = -1;
  if (fa > -th && fa < 0) { te = ta; boxFace = 3; boxDir = ax0 === 2 ? (dz > 0 ? 3 : 2) : (dx > 0 ? 1 : 0); }
  else if (fa >= 0 && fb < 0) { te = ta + (tb - ta) * (fa / (fa - fb)); boxFace = 1; boxDir = 0; }
  else if (fa <= -th && fb > -th) { te = ta + (tb - ta) * ((-th - fa) / (fb - fa)); boxFace = 2; boxDir = 0; }
  if (te < tlo || te > thi) return -1;
  return te;
}

/**
 * First surface hit along A + t*(dx,dy,dz), t in [0,1] (x/z halo units, y m). Result in `hit`
 * (kind HIT_NONE on a miss). `hit.cell` is the cell the hit surface faces.
 */
export function traceHit(g: VisGrid, ax: number, ay: number, az: number, dx: number, dy: number, dz: number, group: number): void {
  rayStats.rays++;
  rayStats.byKind[RAY_PROBE]++;
  const n = g.n;
  let ci = Math.floor(ax), cj = Math.floor(az);
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0, sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const ix = dx !== 0 ? 1 / dx : 0, iz = dz !== 0 ? 1 / dz : 0;
  let tx = sx > 0 ? (ci + 1 - ax) * ix : sx < 0 ? (ci - ax) * ix : Infinity;
  let tz = sz > 0 ? (cj + 1 - az) * iz : sz < 0 ? (cj - az) * iz : Infinity;
  let t0 = 0;
  hit.kind = HIT_NONE; hit.wet = false; hit.box = -1;
  for (;;) {
    if (ci < 0 || cj < 0 || ci >= n || cj >= n) return;
    const c = cj * n + ci;
    const t1 = tx < tz ? (tx < 1 ? tx : 1) : (tz < 1 ? tz : 1);
    let best = 2, kind = HIT_NONE, dir = 0, mat = 0, hb = -1;
    if (dy < 0) {
      const top = g.blockTop[c] > g.dFloor[c] ? g.blockTop[c] : g.dFloor[c];
      const tf = (top - ay) / dy;
      if (tf >= t0 && tf <= t1) { best = tf; kind = HIT_FLOOR; mat = g.floorMat[c]; }
    } else if (dy > 0) {
      const tc = (g.dCeil[c] - ay) / dy;
      if (tc >= t0 && tc <= t1) {
        best = tc; kind = HIT_CEIL;
        mat = (g.flags[c] & CellFlag.NO_CEIL) !== 0 || g.ceilKind[c] === 3 /* OPEN_DARK */ ? MAT_PLENUM : g.ceilMat[c];
      }
    }
    const ya = ay + t0 * dy, yb = ay + t1 * dy;
    // (skip the list when the segment's height range in the cell misses every box of it; slack keeps touching
    // entries, so the result is unchanged)
    if ((ya > yb ? ya : yb) >= g.cBoxLo[c] - 1e-9 && (ya < yb ? ya : yb) <= g.cBoxHi[c] + 1e-9) for (let k = g.boxStart[c], ke = g.boxStart[c + 1]; k < ke; k++) {
      const b = g.boxList[k];
      if (g.boxGroup[b] !== group) continue;
      const te = boxEntry(g, b, ax, ay, az, dx, dy, dz, t0 - 1e-12, t1);
      if (te >= 0 && te < best) {
        best = te; mat = g.boxMat[b]; hb = b;
        kind = boxFace === 1 ? HIT_BOX_TOP : boxFace === 2 ? HIT_BOX_BOTTOM : HIT_BOX_SIDE;
        dir = boxDir;
      }
    }
    if (kind !== HIT_NONE) {
      hit.kind = kind; hit.t = best; hit.dir = dir; hit.mat = mat; hit.cell = c; hit.box = kind >= HIT_BOX_TOP ? hb : -1;
      hit.x = ax + best * dx; hit.y = ay + best * dy; hit.z = az + best * dz;
      hit.wet = kind === HIT_FLOOR && (g.flags[c] & CellFlag.WET) !== 0;
      return;
    }
    if (t1 >= 1) return;
    if (tx < tz) {
      const X = sx > 0 ? ci + 1 : ci;
      const along = (az - cj) + tx * dz, y = ay + tx * dy;
      const e = cj * (n + 1) + X;
      const nci = ci + sx;
      let blocked = crossX(g, X, cj, along, y);
      let m = sx > 0 ? g.exMatN[e] : g.exMatP[e];
      if (!blocked && nci >= 0 && nci < n) {
        const nc = cj * n + nci;
        if (g.group[nc] !== group || (g.flags[nc] & SOLID) !== 0 || y < g.dFloor[nc] || y > g.dCeil[nc]) blocked = true;
        else if (y < g.blockTop[nc]) { blocked = true; m = g.floorMat[nc]; }
      }
      if (blocked) {
        hit.kind = HIT_WALL; hit.t = tx; hit.dir = sx > 0 ? 1 : 0; hit.mat = m; hit.cell = c;
        hit.x = X; hit.y = y; hit.z = cj + along;
        return;
      }
      ci = nci; t0 = tx;
      tx = (sx > 0 ? ci + 1 - ax : ci - ax) * ix;
    } else {
      const Z = sz > 0 ? cj + 1 : cj;
      const along = (ax - ci) + tz * dx, y = ay + tz * dy;
      const e = Z * n + ci;
      const ncj = cj + sz;
      let blocked = crossZ(g, Z, ci, along, y);
      let m = sz > 0 ? g.ezMatN[e] : g.ezMatP[e];
      if (!blocked && ncj >= 0 && ncj < n) {
        const nc = ncj * n + ci;
        if (g.group[nc] !== group || (g.flags[nc] & SOLID) !== 0 || y < g.dFloor[nc] || y > g.dCeil[nc]) blocked = true;
        else if (y < g.blockTop[nc]) { blocked = true; m = g.floorMat[nc]; }
      }
      if (blocked) {
        hit.kind = HIT_WALL; hit.t = tz; hit.dir = sz > 0 ? 3 : 2; hit.mat = m; hit.cell = c;
        hit.x = ci + along; hit.y = y; hit.z = Z;
        return;
      }
      cj = ncj; t0 = tz;
      tz = (sz > 0 ? cj + 1 - az : cj - az) * iz;
    }
  }
}

/** The far hit of `traceHit2`. */
export const hitFar: HitRecord = { kind: 0, t: 0, x: 0, y: 0, z: 0, cell: 0, dir: 0, mat: 0, wet: false, box: -1 };

/**
 * `traceHit` into `hit`, plus the first hit with the prop boxes (MAT_PROP) entered before `skipT` transparent into
 * `hitFar` (the probes' far field without the props next to them, probes.ts), in one walk: past a near prop the
 * walk goes on for the far hit only. Both records equal what separate traceHit walks (the second one ignoring those
 * prop entries) would return; when the first hit is not such a prop, hitFar = hit. Counts as one ray.
 */
export function traceHit2(g: VisGrid, ax: number, ay: number, az: number, dx: number, dy: number, dz: number, group: number, skipT: number): void {
  rayStats.rays++;
  rayStats.byKind[RAY_PROBE]++;
  const n = g.n;
  let ci = Math.floor(ax), cj = Math.floor(az);
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0, sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const ix = dx !== 0 ? 1 / dx : 0, iz = dz !== 0 ? 1 / dz : 0;
  let tx = sx > 0 ? (ci + 1 - ax) * ix : sx < 0 ? (ci - ax) * ix : Infinity;
  let tz = sz > 0 ? (cj + 1 - az) * iz : sz < 0 ? (cj - az) * iz : Infinity;
  let t0 = 0;
  hit.kind = HIT_NONE; hit.wet = false; hit.box = -1;
  hitFar.kind = HIT_NONE; hitFar.wet = false; hitFar.box = -1;
  let nearDone = false; // `hit` is final (a near prop box); only the far hit is still searched
  for (;;) {
    if (ci < 0 || cj < 0 || ci >= n || cj >= n) return;
    const c = cj * n + ci;
    const t1 = tx < tz ? (tx < 1 ? tx : 1) : (tz < 1 ? tz : 1);
    let best = 2, kind = HIT_NONE, dir = 0, mat = 0, hb = -1; // (props included)
    let bestF = 2, kindF = HIT_NONE, dirF = 0, matF = 0, hbF = -1; // (near props transparent)
    if (dy < 0) {
      const top = g.blockTop[c] > g.dFloor[c] ? g.blockTop[c] : g.dFloor[c];
      const tf = (top - ay) / dy;
      if (tf >= t0 && tf <= t1) { best = bestF = tf; kind = kindF = HIT_FLOOR; mat = matF = g.floorMat[c]; }
    } else if (dy > 0) {
      const tc = (g.dCeil[c] - ay) / dy;
      if (tc >= t0 && tc <= t1) {
        best = bestF = tc; kind = kindF = HIT_CEIL;
        mat = matF = (g.flags[c] & CellFlag.NO_CEIL) !== 0 || g.ceilKind[c] === 3 /* OPEN_DARK */ ? MAT_PLENUM : g.ceilMat[c];
      }
    }
    const ya = ay + t0 * dy, yb = ay + t1 * dy;
    if ((ya > yb ? ya : yb) >= g.cBoxLo[c] - 1e-9 && (ya < yb ? ya : yb) <= g.cBoxHi[c] + 1e-9) for (let k = g.boxStart[c], ke = g.boxStart[c + 1]; k < ke; k++) {
      const b = g.boxList[k];
      if (g.boxGroup[b] !== group) continue;
      const te = boxEntry(g, b, ax, ay, az, dx, dy, dz, t0 - 1e-12, t1);
      if (te < 0) continue;
      const bk = boxFace === 1 ? HIT_BOX_TOP : boxFace === 2 ? HIT_BOX_BOTTOM : HIT_BOX_SIDE;
      if (te < best) { best = te; mat = g.boxMat[b]; hb = b; kind = bk; dir = boxDir; }
      if (te < bestF && (te >= skipT || g.boxMat[b] !== MAT_PROP)) { bestF = te; matF = g.boxMat[b]; hbF = b; kindF = bk; dirF = boxDir; }
    }
    if (!nearDone && kind !== HIT_NONE) {
      hit.kind = kind; hit.t = best; hit.dir = dir; hit.mat = mat; hit.cell = c; hit.box = kind >= HIT_BOX_TOP ? hb : -1;
      hit.x = ax + best * dx; hit.y = ay + best * dy; hit.z = az + best * dz;
      hit.wet = kind === HIT_FLOOR && (g.flags[c] & CellFlag.WET) !== 0;
      nearDone = true;
    }
    if (kindF !== HIT_NONE) {
      hitFar.kind = kindF; hitFar.t = bestF; hitFar.dir = dirF; hitFar.mat = matF; hitFar.cell = c; hitFar.box = kindF >= HIT_BOX_TOP ? hbF : -1;
      hitFar.x = ax + bestF * dx; hitFar.y = ay + bestF * dy; hitFar.z = az + bestF * dz;
      hitFar.wet = kindF === HIT_FLOOR && (g.flags[c] & CellFlag.WET) !== 0;
      return;
    }
    if (t1 >= 1) return;
    let wk = HIT_NONE, wt = 0, wdir = 0, wm = 0, wx = 0, wy = 0, wz = 0;
    if (tx < tz) {
      const X = sx > 0 ? ci + 1 : ci;
      const along = (az - cj) + tx * dz, y = ay + tx * dy;
      const e = cj * (n + 1) + X;
      const nci = ci + sx;
      let blocked = crossX(g, X, cj, along, y);
      let m = sx > 0 ? g.exMatN[e] : g.exMatP[e];
      if (!blocked && nci >= 0 && nci < n) {
        const nc = cj * n + nci;
        if (g.group[nc] !== group || (g.flags[nc] & SOLID) !== 0 || y < g.dFloor[nc] || y > g.dCeil[nc]) blocked = true;
        else if (y < g.blockTop[nc]) { blocked = true; m = g.floorMat[nc]; }
      }
      if (blocked) { wk = HIT_WALL; wt = tx; wdir = sx > 0 ? 1 : 0; wm = m; wx = X; wy = y; wz = cj + along; }
      else { ci = nci; t0 = tx; tx = (sx > 0 ? ci + 1 - ax : ci - ax) * ix; }
    } else {
      const Z = sz > 0 ? cj + 1 : cj;
      const along = (ax - ci) + tz * dx, y = ay + tz * dy;
      const e = Z * n + ci;
      const ncj = cj + sz;
      let blocked = crossZ(g, Z, ci, along, y);
      let m = sz > 0 ? g.ezMatN[e] : g.ezMatP[e];
      if (!blocked && ncj >= 0 && ncj < n) {
        const nc = ncj * n + ci;
        if (g.group[nc] !== group || (g.flags[nc] & SOLID) !== 0 || y < g.dFloor[nc] || y > g.dCeil[nc]) blocked = true;
        else if (y < g.blockTop[nc]) { blocked = true; m = g.floorMat[nc]; }
      }
      if (blocked) { wk = HIT_WALL; wt = tz; wdir = sz > 0 ? 3 : 2; wm = m; wx = ci + along; wy = y; wz = Z; }
      else { cj = ncj; t0 = tz; tz = (sz > 0 ? cj + 1 - az : cj - az) * iz; }
    }
    if (wk !== HIT_NONE) {
      if (!nearDone) { hit.kind = wk; hit.t = wt; hit.dir = wdir; hit.mat = wm; hit.cell = c; hit.x = wx; hit.y = wy; hit.z = wz; }
      hitFar.kind = wk; hitFar.t = wt; hitFar.dir = wdir; hitFar.mat = wm; hitFar.cell = c; hitFar.x = wx; hitFar.y = wy; hitFar.z = wz;
      return;
    }
  }
}
