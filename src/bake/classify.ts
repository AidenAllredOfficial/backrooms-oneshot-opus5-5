// src/bake/classify.ts — per-receiver light selection (LIGHT.K_MAX), the K_MAX tail, and per-(receiver patch,
// light) visibility classification FULL / NONE / PARTIAL (WP7 §Algorithms 3, 5). Pure module.
//
// Selection: candidates are the static lights of the receiver's bake group whose window reaches it and that are
// not entirely behind the receiver plane or in front-culled by the emitter plane. They are visited in order of
// the unshadowed estimate I_max * w(d) / d^2 (ties: world-stable uid) and accepted while their bitset
// visibility is not zero (texels: any of the 3x3 cells at any height; patches: the owner cell at any height)
// until K_MAX are accepted. The candidates left over form the K_MAX tail: not dropped, but approximated without
// rays (tailSum); its estimate share is the bench's "K_MAX tail" diagnostic.
//
// Classification of a (patch, light) pair: early-out from the bitset -- all 9 cells see the light at the heights
// the patch spans (layers + floor / ceiling receiver height) and no occluder box above min(patch, light) height
// bucketed in the 3x3 cells lies between the owner cell and the emitter (boxesBetween) -> FULL; none of them sees it at any height -> NONE -- then (full bake) the beam proof of
// beam.ts (nothing inside the swept box between the patch's texel box and the emitter -> FULL, no rays) -- otherwise
// segment tests from the 4 extreme patch texels + the patch centroid to 4 emitter points (all visible -> FULL, none
// -> NONE, else PARTIAL).
// Tower (group != 0) receivers never use the bitset (their cells span the whole periodic stack).

import { CELL, LIGHT } from '../core/constants.ts';
import { CellFlag } from '../core/ids.ts';
import { emitterCorner, lensW, sp } from './areaLight.ts';
import { beamClear, beamOpts } from './beam.ts';
import { occluded } from './dda.ts';
import { VIS_ALL, VIS_CEIL, VIS_FLOOR, VIS_LOW, VIS_MID, VIS_TOP, type BakeJob } from './job.ts';
import { SHAPE_RECT, SHAPE_SPHERE, blockOf } from './lights.ts';
import { better, windowDist2, windowW } from './util.ts';
import { visAll9, visBits, visUnion9 } from './visbits.ts';

export const FILTER_NONE = 0, FILTER_CELL = 1, FILTER_UNION9 = 2;
/** CLS_FRAC: a PARTIAL light whose visibility is given per texel without rays (weak lights: the sub-block's
 * visible segment fraction). CLS_INTERP: visibility interpolated from the sub-block's 4 shadow-sampled corners. */
export const CLS_NONE = 0, CLS_FULL = 1, CLS_PARTIAL = 2, CLS_FRAC = 3, CLS_INTERP = 4;

const MAXC = 1024;
const candL = new Int32Array(MAXC);
const candE = new Float64Array(MAXC);
const candU = new Uint32Array(MAXC);
/** Unshadowed estimate of each light chosen by the last selectLights call (same order as its output). */
export const selEst = new Float64Array(LIGHT.K_MAX);

/** Is cell c a periodic tower cell (its receivers bypass the bitset)? */
export const isTowerCell = (job: BakeJob, c: number): boolean => (job.g.flags[c] & CellFlag.TOWER) !== 0 && job.g.group[c] !== 0;

/**
 * Select up to K_MAX static lights for a receiver at (x, y, z) (halo cells / m) with unit normal n, owner cell c,
 * bake group `group`. `ext`: receiver half-extent (m) used for conservative plane culling. Writes light indices
 * (best first) to `out`; returns the count.
 */
export function selectLights(job: BakeJob, x: number, y: number, z: number, nx: number, ny: number, nz: number, c: number, group: number, ext: number, filter: number, out: Int32Array): number {
  const L = job.L;
  const b = blockOf(x, z);
  let nc = 0, total = 0;
  for (let k = L.blockStart[b], ke = L.blockStart[b + 1]; k < ke; k++) {
    const l = L.blockList[k];
    if (L.dynamic[l] !== 0 || L.group[l] !== group) continue;
    const o = l * 3;
    const dx = (L.pos[o] - x) * CELL, dy = L.pos[o + 1] - y, dz = (L.pos[o + 2] - z) * CELL;
    const w = windowW(windowDist2(dx, dy, dz, L.hAllow[l]), L.invR2[l]);
    if (w <= 0) continue;
    // light entirely behind (or coplanar with) the receiver plane?
    const shape = L.shape[l];
    const lext = shape === SHAPE_RECT
      ? Math.abs(nx * L.tan[o] + ny * L.tan[o + 1] + nz * L.tan[o + 2]) * L.w[l] * 0.5 + Math.abs(nx * L.bit[o] + ny * L.bit[o + 1] + nz * L.bit[o + 2]) * L.h[l] * 0.5
      : L.w[l] * 0.5;
    if ((nx !== 0 || ny !== 0 || nz !== 0) && nx * dx + ny * dy + nz * dz + lext <= 1e-4) continue; // n = 0: omni receiver
    // receiver entirely behind a one-sided emitter?
    if (shape !== SHAPE_SPHERE && -(L.nrm[o] * dx + L.nrm[o + 1] * dy + L.nrm[o + 2] * dz) + ext <= 0) continue;
    const d2 = dx * dx + dy * dy + dz * dz;
    const e = L.imax[l] * w / (d2 > 0.01 ? d2 : 0.01);
    if (!(e > 0) || nc >= MAXC) continue;
    candL[nc] = l; candE[nc] = e; candU[nc] = L.uid[l]; nc++;
    total += e;
  }
  lastNc = nc;
  const K = LIGHT.K_MAX;
  let m = 0, rejected = 0;
  // Visit candidates best first ((estimate desc, uid asc)); only the top K + PREFIX_EXTRA are ordered up front
  // (quickselect threshold + insertion sort); when bitset rejections exhaust them, fall back to plain scanning.
  let np = 0;
  if (nc > 0) {
    const kth = Math.min(nc, K + PREFIX_EXTRA);
    let thr = -Infinity;
    if (kth < nc) {
      for (let i = 0; i < nc; i++) qs[i] = candE[i];
      thr = quickselectDesc(qs, nc, kth - 1);
    }
    for (let i = 0; i < nc; i++) {
      if (candE[i] < thr) continue;
      // insertion into the ordered prefix
      let j = np++;
      while (j > 0) {
        const p = prefix[j - 1];
        if (!better(candE[i], candU[i], candE[p], candU[p])) break;
        prefix[j] = p; j--;
      }
      prefix[j] = i;
    }
  }
  const take = (bi: number): void => {
    const l = candL[bi];
    candL[bi] = -1;
    let ok = true;
    if (filter === FILTER_UNION9) ok = visUnion9(job, l, c) !== 0;
    else if (filter === FILTER_CELL) ok = visBits(job, l, c) !== 0;
    if (ok) { selEst[m] = candE[bi]; out[m++] = l; } else rejected += candE[bi];
  };
  for (let k = 0; k < np && m < K; k++) take(prefix[k]);
  while (m < K) {
    let bi = -1;
    for (let i = 0; i < nc; i++) {
      if (candL[i] < 0) continue;
      if (bi < 0 || better(candE[i], candU[i], candE[bi], candU[bi])) bi = i;
    }
    if (bi < 0) break;
    take(bi);
  }
  // diagnostics: estimate sum of the remaining (never evaluated) candidates
  const d = job.diag;
  d.receivers++;
  let left = 0;
  for (let i = 0; i < nc; i++) if (candL[i] >= 0) left += candE[i];
  if (left > 0 && total > 0) {
    const r = left / (total - rejected > 0 ? total - rejected : total);
    d.dropped++;
    d.dropSum += r;
    if (r > d.dropMax) d.dropMax = r;
  }
  return m;
}

let lastNc = 0;
const PREFIX_EXTRA = 8;
const qs = new Float64Array(MAXC);
const prefix = new Int32Array(MAXC);
/** k-th largest (0-based) of a[0..n) by in-place quickselect (Hoare partition). */
function quickselectDesc(a: Float64Array, n: number, k: number): number {
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] > pivot) i++;
      while (a[j] < pivot) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
  }
  return a[k];
}
/** Result of `tailSum`: RGB irradiance (lux) and the luminance-weighted direction sum. */
export const tail = { r: 0, g: 0, b: 0, vx: 0, vy: 0, vz: 0 };

/**
 * The K_MAX tail: the candidates of the LAST selectLights call that were never evaluated (weaker than the K_MAX
 * selected lights). Instead of dropping them, their irradiance is approximated from the selection estimate with
 * point-light cosines, E = I_max w / d^2 * max(0, n.w) * max(0, -nL.w), and the owner cell's bitset visibility at
 * `bit` (a VIS_* mask) -- never a ray, and never through a wall the bitset sees as closed. Cheap (no sqrt beyond
 * one per light) and a pure function of the receiver point, like the selection. `byRegion` (preview): same light
 * region instead of the bitset. Result in `tail`.
 */
export function tailSum(job: BakeJob, x: number, y: number, z: number, nx: number, ny: number, nz: number, c: number, bit: number, byRegion = false): void {
  tail.r = 0; tail.g = 0; tail.b = 0; tail.vx = 0; tail.vy = 0; tail.vz = 0;
  const L = job.L, g = job.g;
  const omni = nx === 0 && ny === 0 && nz === 0;
  const reg = g.region[c];
  for (let i = 0; i < lastNc; i++) {
    const l = candL[i];
    if (l < 0) continue;
    if (byRegion) {
      // preview: light region (flood fill across edges open at 1.2 m) instead of the bitset (no rays at all)
      const lc = Math.floor(L.pos[l * 3 + 2]) * g.n + Math.floor(L.pos[l * 3]);
      if (reg === 0 || g.region[lc] !== reg) continue;
    } else if ((visBits(job, l, c) & bit) === 0) continue;
    const o = l * 3;
    const dx = (L.pos[o] - x) * CELL, dy = L.pos[o + 1] - y, dz = (L.pos[o + 2] - z) * CELL;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(d > 1e-6)) continue;
    const wx = dx / d, wy = dy / d, wz = dz / d;
    const cr = omni ? 1 : nx * wx + ny * wy + nz * wz;
    if (cr <= 0) continue;
    let ce = L.shape[l] === SHAPE_SPHERE ? 1 : -(L.nrm[o] * wx + L.nrm[o + 1] * wy + L.nrm[o + 2] * wz);
    if (ce <= 0) continue;
    if (L.lens[l] !== 0) ce *= lensW(ce);
    const k = candE[i] * cr * ce / L.radLum[l]; // candE is luminance: back to the RGB radiance scale
    tail.r += k * L.rad[o]; tail.g += k * L.rad[o + 1]; tail.b += k * L.rad[o + 2];
    const kl = candE[i] * cr * ce;
    tail.vx += kl * wx; tail.vy += kl * wy; tail.vz += kl * wz;
  }
}

/** Dynamic lights (any count, same group) whose window reaches the receiver; writes indices to out. */
export function selectDynamic(job: BakeJob, x: number, y: number, z: number, group: number, out: Int32Array): number {
  const L = job.L;
  const b = blockOf(x, z);
  let m = 0;
  for (let k = L.blockStart[b], ke = L.blockStart[b + 1]; k < ke; k++) {
    const l = L.blockList[k];
    if (L.dynamic[l] === 0 || L.group[l] !== group) continue;
    const o = l * 3;
    const dx = (L.pos[o] - x) * CELL, dy = L.pos[o + 1] - y, dz = (L.pos[o + 2] - z) * CELL;
    if (windowW(windowDist2(dx, dy, dz, L.hAllow[l]), L.invR2[l]) <= 0) continue;
    if (m < out.length) out[m++] = l;
  }
  return m;
}

/** Patch sample points (5 x 3: 4 inset corners + the centre; x z halo, y m) used by `classifyPatch`. The centre
 * point (beyond the spec's 16 segments) catches light through a narrow opening that all 4 corners miss. */
export const PATCH_PTS = 5;
export const patchCorners = new Float64Array(3 * PATCH_PTS);

/**
 * Classify light l for a texel patch with owner cell c. Corner sample points must be in `patchCorners`.
 * `bitsEarlyOut`: use the bitset early-outs (group-0 receivers). `need`: the visibility bits that must be set in
 * all 9 cells for the FULL early-out (the heights the patch spans, see `patchNeed`). `beam`: `beamBox` holds the
 * bounding box of every receiver point the class will stand for; a clear beam (beam.ts) is FULL without rays (the
 * segment tests would all pass: the result is the same).
 */
export function classifyPatch(job: BakeJob, l: number, c: number, group: number, bitsEarlyOut: boolean, need: number, yMin = -Infinity, beam = false, yMax = Infinity): number {
  const g = job.g;
  if (bitsEarlyOut) {
    if (visUnion9(job, l, c) === 0) return CLS_NONE;
    if ((visAll9(job, l, c) & need) === need && !boxesBetween(job, c, l, Math.min(yMin, lightLowY(job, l)), Math.max(yMax, lightHighY(job, l)))) return CLS_FULL;
  }
  // ray-free proof that every segment is unoccluded (beam.ts; the receiver box is in `beamBox`)
  if (beam && beamOpts.enabled && beamClear(job, l, group)) return CLS_FULL;
  let vis = 0, blk = 0;
  for (let k = 0; k < PATCH_PTS; k++) {
    const px = patchCorners[k * 3], py = patchCorners[k * 3 + 1], pz = patchCorners[k * 3 + 2];
    for (let e = 0; e < 4; e++) {
      emitterCorner(job.L, l, e);
      if (occluded(g, px, py, pz, sp.x, sp.y, sp.z, group, true)) blk++; else vis++;
      if (vis > 0 && blk > 0) return CLS_PARTIAL;
    }
  }
  return vis === 0 ? CLS_NONE : CLS_FULL;
}

/** Any occluder box bucketed in the 3x3 cells around c whose top is above yCut? (A box entirely below both the
 * receiver and the light cannot cut a segment between them.) */
export function boxesNear(job: BakeJob, c: number, yCut = -Infinity): boolean {
  return job.boxTop9[c] > yCut;
}

/**
 * Any occluder box bucketed in the 3x3 cells around c that could cut a segment between (any point of) cell c and
 * (any point of) light l's emitter: its top is above yCut, its bottom below yTop AND its xz extent overlaps the xz
 * bounding box of the cell and the emitter footprint (every such segment lies inside that box). Exact refinement of
 * `boxesNear` (a desk in the next cell, on the far side from the light, no longer blocks the FULL early-out; nor
 * does the WAREHOUSE roof truss above the high-bays and every receiver); tile-independent (cell extent, not the
 * patch's) when yCut / yTop are.
 */
export function boxesBetween(job: BakeJob, c: number, l: number, yCut: number, yTop = Infinity): boolean {
  if (!(job.boxTop9[c] > yCut)) return false;
  const g = job.g, n = g.n, L = job.L, o = l * 3;
  const hi = c % n, hj = (c - hi) / n;
  const m = 0.05; // emitter offsets (EMIT_OFF, sample insets) + slack, metres
  let ex: number, ez: number;
  if (L.shape[l] === SHAPE_RECT) {
    ex = Math.abs(L.tan[o]) * L.w[l] * 0.5 + Math.abs(L.bit[o]) * L.h[l] * 0.5 + Math.abs(L.nrm[o]) * 0.02;
    ez = Math.abs(L.tan[o + 2]) * L.w[l] * 0.5 + Math.abs(L.bit[o + 2]) * L.h[l] * 0.5 + Math.abs(L.nrm[o + 2]) * 0.02;
  } else { ex = L.w[l] * 0.5; ez = ex; }
  const lx = L.pos[o], lz = L.pos[o + 2];
  const x0 = Math.min(hi, lx - (ex + m) / CELL), x1 = Math.max(hi + 1, lx + (ex + m) / CELL);
  const z0 = Math.min(hj, lz - (ez + m) / CELL), z1 = Math.max(hj + 1, lz + (ez + m) / CELL);
  for (let dj = -1; dj <= 1; dj++) {
    const j = hj + dj;
    if (j < 0 || j >= n || j + 1 <= z0 || j >= z1) continue;
    for (let di = -1; di <= 1; di++) {
      const i = hi + di;
      if (i < 0 || i >= n || i + 1 <= x0 || i >= x1) continue;
      const cc = j * n + i;
      if (!(job.boxTop[cc] > yCut)) continue;
      for (let k = g.boxStart[cc], ke = g.boxStart[cc + 1]; k < ke; k++) {
        const b = g.boxList[k], bo = b * 6;
        if (g.box[bo + 4] <= yCut || g.box[bo + 1] >= yTop) continue;
        if (g.box[bo + 3] <= x0 || g.box[bo] >= x1 || g.box[bo + 5] <= z0 || g.box[bo + 2] >= z1) continue;
        return true;
      }
    }
  }
  return false;
}

/** Lowest point of light l's emitter (m). */
export function lightLowY(job: BakeJob, l: number): number {
  return job.L.pos[l * 3 + 1] - lightExtY(job, l);
}
/** Highest point of light l's emitter, with its sample offset along the emitting normal (m). */
export function lightHighY(job: BakeJob, l: number): number {
  return job.L.pos[l * 3 + 1] + lightExtY(job, l) + 0.05;
}
function lightExtY(job: BakeJob, l: number): number {
  const L = job.L, o = l * 3;
  return L.shape[l] === SHAPE_RECT
    ? Math.abs(L.tan[o + 1]) * L.w[l] * 0.5 + Math.abs(L.bit[o + 1]) * L.h[l] * 0.5 + Math.abs(L.nrm[o + 1]) * 0.02
    : L.w[l] * 0.5;
}

/** Visibility bits a patch spanning heights [y0, y1] in cell c needs for the FULL early-out. */
export function patchNeed(job: BakeJob, c: number, y0: number, y1: number): number {
  const h = job.cellY, o = c * 5;
  let need = VIS_LOW | VIS_MID | VIS_TOP;
  if (y0 < h[o]) need |= VIS_FLOOR;
  if (y1 > h[o + 2]) need |= VIS_CEIL;
  return need & VIS_ALL;
}

/** Visible fraction of the PATCH_PTS x 4 classification segments of light l (points in `patchCorners`). */
export function visibleFraction(job: BakeJob, l: number, group: number): number {
  const g = job.g;
  let vis = 0;
  for (let k = 0; k < PATCH_PTS; k++) {
    const px = patchCorners[k * 3], py = patchCorners[k * 3 + 1], pz = patchCorners[k * 3 + 2];
    for (let e = 0; e < 4; e++) {
      emitterCorner(job.L, l, e);
      if (!occluded(g, px, py, pz, sp.x, sp.y, sp.z, group, true)) vis++;
    }
  }
  return vis / (PATCH_PTS * 4);
}

/** Tile-independent class of light l for receivers of cell c from the bitset alone: NONE / FULL when the
 * early-outs decide, PARTIAL otherwise (seam texels use this instead of patch-dependent segment tests). `yMin` must
 * then be tile-independent too (the patch's lowest sample height: all texels of a band / grid cell share it). */
export function bitsetClass(job: BakeJob, l: number, c: number, need: number, tower: boolean, yMin = -Infinity): number {
  if (tower) return CLS_PARTIAL;
  if (visUnion9(job, l, c) === 0) return CLS_NONE;
  // (yTop: the owner cell's ceiling bounds every receiver of the cell, tile-independently)
  if ((visAll9(job, l, c) & need) === need && !boxesBetween(job, c, l, Math.min(yMin, lightLowY(job, l)), Math.max(job.g.ceil[c], lightHighY(job, l)))) return CLS_FULL;
  return CLS_PARTIAL;
}
