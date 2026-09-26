// src/bake/channels.ts — flicker channels (WP7 §Algorithms 8). Pure module.
//
// Every dynamic light owns channel tileChannel(tile containing it) (resolved in lights.ts from its own chunk).
// flick[c] = direct irradiance luminance of that light (visibility as in the full / preview direct pass, see
// direct.ts) + a bounce term 0.3 * rho_L * Y_L, where Y_L and rho_L are per-light pure functions: the mean direct
// Y at the floor centres (bitset visibility) and the mean floor albedo over the cells within R_DYN of the light
// that a flood fill restricted to that disc reaches from the light's cell (through edges that do not occlude at
// 1.2 m). The bounce is added on receivers whose owner cell the flood reached, faded by the light's window.
// That constant is only the PREVIEW bounce now: the full bake bounces the dynamic lights through the probes like
// the static ones (probes.ts ProbeSet.dyn, indirect.ts dynIndirect; ~1 lux from the constant vs 20-40 lux of real
// bounce on the ceiling around a flickering troffer, which rendered as a black hole). `addDynIndirect` attributes a
// channel's probe bounce to the one dynamic light of that channel whose window covers the receiver (faded by that
// window), so every channel value is still modulated by the light the shader picks for it (R_DYN < TILE_SIZE / 2).

import { CELL } from '../core/constants.ts';
import { CellFlag } from '../core/ids.ts';
import { formFactor } from './areaLight.ts';
import { selectDynamic } from './classify.ts';
import { VIS_FLOOR, type BakeJob } from './job.ts';
import { albedoOf } from './probes.ts';
import { openLink } from './preview.ts';
import { luma, windowDist2, windowW } from './util.ts';
import { visBits } from './visbits.ts';

export interface DynInfo {
  lights: number[]; // dynamic light indices
  bounce: Float64Array; // per entry: 0.3 * rho_L * Y_L (lux)
  reach: Uint8Array[]; // per entry: halo cells reached by the flood
}

const rho = new Float64Array(3);

export function computeDynamic(job: BakeJob): DynInfo {
  const L = job.L, g = job.g, n = g.n;
  const lights: number[] = [];
  for (let l = 0; l < L.n; l++) if (L.dynamic[l] !== 0 && L.reachTile[l] !== 0) lights.push(l);
  const bounce = new Float64Array(lights.length);
  const reach: Uint8Array[] = [];
  const stack = new Int32Array(n * n);
  for (let k = 0; k < lights.length; k++) {
    const l = lights[k], o = l * 3;
    const lx = L.pos[o], lz = L.pos[o + 2];
    const R = L.R[l];
    const r2 = (R / CELL) * (R / CELL);
    const seen = new Uint8Array(n * n);
    reach.push(seen);
    const c0 = Math.floor(lz) * n + Math.floor(lx);
    if (c0 < 0 || c0 >= n * n || (g.flags[c0] & CellFlag.SOLID) !== 0) continue;
    let sp = 0, cnt = 0, ySum = 0, rSum = 0;
    seen[c0] = 1; stack[sp++] = c0;
    while (sp > 0) {
      const c = stack[--sp];
      const hi = c % n, hj = (c - hi) / n;
      // direct Y at the floor centre (normal up), bitset visibility at the floor receiver height
      const fy = (g.blockTop[c] > g.floor[c] ? g.blockTop[c] : g.floor[c]) + 0.02;
      let Y = 0;
      if ((visBits(job, l, c) & VIS_FLOOR) !== 0) {
        const f = formFactor(L, l, hi + 0.5, fy, hj + 0.5, 0, 1, 0, 0);
        const w = windowW(windowDist2((lx - hi - 0.5) * CELL, L.pos[o + 1] - fy, (lz - hj - 0.5) * CELL, L.hAllow[l]), L.invR2[l]);
        Y = f * w * L.radLum[l];
      }
      ySum += Y;
      albedoOf(g.floorMat[c], (g.flags[c] & CellFlag.WET) !== 0, rho);
      rSum += luma(rho[0], rho[1], rho[2]);
      cnt++;
      for (let s = 0; s < 4; s++) {
        const i = hi + (s === 0 ? -1 : s === 1 ? 1 : 0), j = hj + (s === 2 ? -1 : s === 3 ? 1 : 0);
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const nc = j * n + i;
        if (seen[nc] !== 0) continue;
        const dx = i + 0.5 - lx, dz = j + 0.5 - lz;
        if (dx * dx + dz * dz >= r2) continue;
        if (!openLink(g, c, nc)) continue;
        seen[nc] = 1; stack[sp++] = nc;
      }
    }
    if (cnt > 0) bounce[k] = 0.3 * (rSum / cnt) * (ySum / cnt);
  }
  return { lights, bounce, reach };
}

/** Add the bounce terms of the dynamic lights reaching a receiver in cell c at (x, y, z) into f[0..3] (x ao). */
export function addBounce(job: BakeJob, D: DynInfo, x: number, y: number, z: number, c: number, ao: number, f: Float64Array): void {
  const L = job.L;
  for (let k = 0; k < D.lights.length; k++) {
    if (D.reach[k][c] === 0 || D.bounce[k] <= 0) continue;
    const l = D.lights[k], o = l * 3;
    const w = windowW(windowDist2((L.pos[o] - x) * CELL, L.pos[o + 1] - y, (L.pos[o + 2] - z) * CELL, L.hAllow[l]), L.invR2[l]);
    if (w <= 0) continue;
    f[L.channel[l]] += D.bounce[k] * w * ao;
  }
}

const dsel = new Int32Array(16);

/** Add the probe-bounced dynamic luminance `ind` (4 channels, lux) of a receiver at (x, y, z) into f[0..3], x ao and
 * x the window of the channel's dynamic light at the receiver (0 where no light of that channel reaches it). */
export function addDynIndirect(job: BakeJob, x: number, y: number, z: number, group: number, ind: Float64Array, ao: number, f: Float64Array): void {
  const L = job.L;
  const md = selectDynamic(job, x, y, z, group, dsel);
  for (let i = 0; i < md; i++) {
    const l = dsel[i], o = l * 3;
    const ch = L.channel[l];
    if (ch < 0 || ind[ch] <= 0) continue;
    const w = windowW(windowDist2((L.pos[o] - x) * CELL, L.pos[o + 1] - y, (L.pos[o + 2] - z) * CELL, L.hAllow[l]), L.invR2[l]);
    if (w <= 0) continue;
    f[ch] += ind[ch] * w * ao;
  }
}
