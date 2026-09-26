// src/bake/visbits.ts — the shared visibility bitset (WP7 §Algorithms 1): for every (halo cell, light in range)
// the visibility of the light's centre from the cell centre at the cell's 3 layer heights (effective floor + 0.4,
// mid, ceiling - 0.35), extended with the floor and ceiling RECEIVER heights (floor + 0.02, ceiling - 0.02): a
// floor texel below a HALF wall's top can be shadowed although the 0.4 m layer sees the light, so the FULL
// early-out of floor / ceiling receivers must look at their own height. Computed lazily, one 5-height DDA walk
// per pair (the heights share the xz path), stored in per-(light, chunk) tables that
// live in the BakeCache when one is given (world-anchored, so neighbouring tiles on the same worker reuse them).
// Used by the patch cache, the light volume, preview classification and the full-bake early-outs. Pure module.

import { CellFlag } from '../core/ids.ts';
import { trace5 } from './dda.ts';
import { VIS_ALL, visTable, type BakeJob } from './job.ts';
import { CELL } from '../core/constants.ts';

const ys = new Float64Array(5);

/** Visibility bits (VIS_* in job.ts: bit k = height k of the cell sees the light centre) of light l from halo cell c. */
export function visBits(job: BakeJob, l: number, c: number): number {
  const g = job.g;
  const tab = visTable(job, l, g.slot[c]);
  const loc = g.local[c];
  const v = tab[loc];
  if ((v & 128) !== 0) return v & VIS_ALL;
  const L = job.L;
  let bits = 0;
  const n = g.n;
  const hi = c % n, hj = (c - hi) / n;
  if ((g.flags[c] & CellFlag.SOLID) === 0 && g.group[c] === L.group[l]) {
    const o = l * 3;
    const dx = (L.pos[o] - (hi + 0.5)) * CELL, dz = (L.pos[o + 2] - (hj + 0.5)) * CELL;
    if (dx * dx + dz * dz < L.R[l] * L.R[l]) {
      ys[0] = job.cellY[c * 5]; ys[1] = job.cellY[c * 5 + 1]; ys[2] = job.cellY[c * 5 + 2];
      ys[3] = job.cellY[c * 5 + 3]; ys[4] = job.cellY[c * 5 + 4];
      bits = trace5(g, hi + 0.5, hj + 0.5, ys, L.vis[o], L.vis[o + 1], L.vis[o + 2], L.group[l]);
    }
  }
  tab[loc] = 128 | bits;
  job.diag.visBits++;
  return bits;
}

/** OR of the visibility bits over the 3x3 cells around c (any of the 5 heights). */
export function visUnion9(job: BakeJob, l: number, c: number): number {
  const n = job.g.n;
  const hi = c % n, hj = (c - hi) / n;
  let u = 0;
  for (let dj = -1; dj <= 1; dj++) {
    const j = hj + dj;
    if (j < 0 || j >= n) continue;
    for (let di = -1; di <= 1; di++) {
      const i = hi + di;
      if (i < 0 || i >= n) continue;
      u |= visBits(job, l, j * n + i);
      if (u === VIS_ALL) return VIS_ALL;
    }
  }
  return u;
}

/** AND of the visibility bits over the 3x3 cells around c (VIS_ALL = all 9 cells see the light at all 5 heights). */
export function visAll9(job: BakeJob, l: number, c: number): number {
  const n = job.g.n;
  const hi = c % n, hj = (c - hi) / n;
  let a = VIS_ALL;
  for (let dj = -1; dj <= 1; dj++) {
    const j = hj + dj;
    for (let di = -1; di <= 1; di++) {
      const i = hi + di;
      if (i < 0 || j < 0 || i >= n || j >= n) return 0;
      a &= visBits(job, l, j * n + i);
      if (a === 0) return 0;
    }
  }
  return a;
}
