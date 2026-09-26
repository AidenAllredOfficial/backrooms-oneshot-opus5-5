// src/bake/emission.ts — floor-reflection emission map (WP7 §Algorithms 10). Pure module.
//
// EMISSION.RES^2 texels of EMISSION.TEXEL m covering the tile +- EMISSION.MARGIN (texel (i, j) centre at tile-local
// (-MARGIN + (i + 0.5) * TEXEL, -MARGIN + (j + 0.5) * TEXEL), row-major in j (z)).
//   rgb = sum over emissive fixtures of fixtureRadiance(f) * color * stateMean whose emitting surface's xz footprint
//         covers the texel (anti-aliased: exact coverage of the 0.3 m texel box by the footprint rectangle; round
//         SPHERE/DISK footprints by their equal-area square, flux-exact); dynamic lights at intensity 1;
//   a   = regionKey(nb.region(cell of the texel centre)), NEGATED where the radiance comes from a dynamic light
//         (dynamic radiance >= static radiance there).
// Only downward-facing RECT emitters and bulbs are in the map: vertical emitters (exit signs, vending fronts) have
// no xz footprint, and upward ones (pool-floor lights) are never seen overhead by a reflecting floor.
// Periodic tower lights are in the light set once per storey replica (y + 3k); the 2D map takes exactly one of them
// (the replica in the fundamental period y in [-1.5, 1.5)), so a tower lamp is not summed several times.

import { CELL, EMISSION, regionKey } from '../core/constants.ts';
import { HALF_MAX, toHalf } from '../core/half.ts';
import type { BakeJob } from './job.ts';
import { SHAPE_RECT } from './lights.ts';
import { HALO_OFF } from './util.ts';

const clampH = (v: number): number => toHalf(v > HALF_MAX ? HALF_MAX : v < 0 ? 0 : v);

export function bakeEmission(job: BakeJob): Uint16Array {
  const RES = EMISSION.RES, T = EMISSION.TEXEL, M = EMISSION.MARGIN;
  const out = new Uint16Array(RES * RES * 4);
  const stat = new Float32Array(RES * RES * 3);
  const dyn = new Float32Array(RES * RES * 3);
  const L = job.L, g = job.g;
  // map extent in tile-local metres
  const e0 = -M, e1 = 19.2 + M;
  for (let l = 0; l < L.n; l++) {
    const o = l * 3;
    const cx = (L.pos[o] - HALO_OFF) * CELL, cz = (L.pos[o + 2] - HALO_OFF) * CELL; // tile-local
    if (L.tower[l] !== 0) {
      const y = L.pos[o + 1];
      if (y < -1.5 || y >= 1.5) continue; // another replica of the same lamp
    }
    const acc = L.dynamic[l] !== 0 ? dyn : stat;
    if (L.shape[l] === SHAPE_RECT) {
      if (L.nrm[o + 1] > -0.5) continue; // vertical (exit signs, vending fronts) or upward (underwater) emitter: nothing seen overhead
      const hw = L.w[l] * 0.5, hh = L.h[l] * 0.5;
      const ex = Math.abs(L.tan[o]) * hw + Math.abs(L.bit[o]) * hh;
      const ez = Math.abs(L.tan[o + 2]) * hw + Math.abs(L.bit[o + 2]) * hh;
      const x0 = cx - ex, x1 = cx + ex, z0 = cz - ez, z1 = cz + ez;
      if (x1 <= e0 || x0 >= e1 || z1 <= e0 || z0 >= e1) continue;
      const i0 = Math.max(0, Math.floor((x0 + M) / T)), i1 = Math.min(RES - 1, Math.floor((x1 + M) / T));
      const j0 = Math.max(0, Math.floor((z0 + M) / T)), j1 = Math.min(RES - 1, Math.floor((z1 + M) / T));
      const rr = L.rad[o], rg = L.rad[o + 1], rb = L.rad[o + 2];
      for (let j = j0; j <= j1; j++) {
        const tz0 = -M + j * T, tz1 = tz0 + T;
        const oz = Math.min(z1, tz1) - Math.max(z0, tz0);
        if (oz <= 0) continue;
        for (let i = i0; i <= i1; i++) {
          const tx0 = -M + i * T, tx1 = tx0 + T;
          const ox = Math.min(x1, tx1) - Math.max(x0, tx0);
          if (ox <= 0) continue;
          const cov = (ox * oz) / (T * T);
          const k = (j * RES + i) * 3;
          acc[k] += rr * cov; acc[k + 1] += rg * cov; acc[k + 2] += rb * cov;
        }
      }
    } else {
      // round bulb / disk: its equal-area square (side r * sqrt(pi)) with exact box coverage. Flux-exact at any
      // size (a 10 cm bulb lies between the samples of a supersampled 0.3 m texel and would vanish) and
      // anti-aliased like the rectangles.
      const r = L.w[l] * 0.5;
      const hs = 0.5 * r * Math.sqrt(Math.PI);
      const x0 = cx - hs, x1 = cx + hs, z0 = cz - hs, z1 = cz + hs;
      if (x1 <= e0 || x0 >= e1 || z1 <= e0 || z0 >= e1) continue;
      const k0 = 1 / (Math.PI * r * r); // intensity -> surface radiance of the disk / sphere
      const rr = L.rad[o] * k0, rg = L.rad[o + 1] * k0, rb = L.rad[o + 2] * k0;
      const i0 = Math.max(0, Math.floor((x0 + M) / T)), i1 = Math.min(RES - 1, Math.floor((x1 + M) / T));
      const j0 = Math.max(0, Math.floor((z0 + M) / T)), j1 = Math.min(RES - 1, Math.floor((z1 + M) / T));
      for (let j = j0; j <= j1; j++) {
        const tz0 = -M + j * T, tz1 = tz0 + T;
        const oz = Math.min(z1, tz1) - Math.max(z0, tz0);
        if (oz <= 0) continue;
        for (let i = i0; i <= i1; i++) {
          const tx0 = -M + i * T, tx1 = tx0 + T;
          const ox = Math.min(x1, tx1) - Math.max(x0, tx0);
          if (ox <= 0) continue;
          const cov = (ox * oz) / (T * T);
          const k = (j * RES + i) * 3;
          acc[k] += rr * cov; acc[k + 1] += rg * cov; acc[k + 2] += rb * cov;
        }
      }
    }
  }
  const n = g.n;
  for (let j = 0; j < RES; j++) {
    const hj = HALO_OFF + Math.floor((-M + (j + 0.5) * T) / CELL);
    for (let i = 0; i < RES; i++) {
      const hi = HALO_OFF + Math.floor((-M + (i + 0.5) * T) / CELL);
      const k = (j * RES + i) * 3, o = (j * RES + i) * 4;
      const sr = stat[k] + dyn[k], sg = stat[k + 1] + dyn[k + 1], sb = stat[k + 2] + dyn[k + 2];
      out[o] = clampH(sr); out[o + 1] = clampH(sg); out[o + 2] = clampH(sb);
      const key = hi >= 0 && hj >= 0 && hi < n && hj < n ? regionKey(g.region[hj * n + hi]) : 0;
      const dl = dyn[k] + dyn[k + 1] + dyn[k + 2], sl = stat[k] + stat[k + 1] + stat[k + 2];
      out[o + 3] = toHalf(dl > 0 && dl >= sl ? -key : key);
    }
  }
  return out;
}
