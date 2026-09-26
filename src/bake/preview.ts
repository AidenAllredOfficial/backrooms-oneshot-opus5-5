// src/bake/preview.ts — preview variant indirect: 2D edge-aware diffusion (WP7 §Algorithms 7). Pure module.
// (The preview direct term lives in direct.ts: directPreview.)
//
//   1. Per-cell radiosity B0 = mean over the cell's floor and wall faces of rho * E_direct / pi (coarse patches,
//      bitset visibility), over the tile +- DOMAIN cells.
//   2. 8 Jacobi iterations of B = (B0 + 0.85 * sum_open B_nb) / (1 + 0.85 * n_open) over the 4 neighbours reachable
//      through edges that do not occlude at 1.2 m (energy factor 0.85): light spreads into unlit neighbours with
//      attenuation, uniform areas keep their level, walls stop it (leak-free).
//   3. Per texel: bilinear over the cell centres with weight 0 across edges occluding at 1.2 m, x surface factor
//      (ceiling 1.0, wall 0.8, floor 0.6) x AO; E = pi * B.

import { CELL } from '../core/constants.ts';
import { EDGE_OCCLUDES, edgeOccludesAt } from '../core/edges.ts';
import { CellFlag } from '../core/ids.ts';
import { albedoOf } from './probes.ts';
import type { BakeJob } from './job.ts';
import { PK_FLOOR, PK_WALL, patchE, pref } from './patches.ts';
import { HALO_OFF } from './util.ts';
import type { VisGrid } from './visgrid.ts';

export const DOMAIN = 8; // cells around the tile
export const DN = 16 + 2 * DOMAIN;
const D0 = HALO_OFF - DOMAIN; // halo index of the first domain cell
const ITER = 8;
const ENERGY = 0.85;
const Y_OPEN = 1.2;

export interface Diffusion { b: Float32Array } // 3 per domain cell

const rho = new Float64Array(3);

const edgeX = (g: VisGrid, X: number, row: number, y: number): boolean => {
  const e = row * (g.n + 1) + X, k = g.exKind[e];
  return k !== 0 && EDGE_OCCLUDES[k] && edgeOccludesAt(k, g.exA[e], g.exB[e], CELL / 2, y, g.exSill[e]);
};
const edgeZ = (g: VisGrid, Z: number, col: number, y: number): boolean => {
  const e = Z * g.n + col, k = g.ezKind[e];
  return k !== 0 && EDGE_OCCLUDES[k] && edgeOccludesAt(k, g.ezA[e], g.ezB[e], CELL / 2, y, g.ezSill[e]);
};
const solid = (g: VisGrid, c: number): boolean => (g.flags[c] & CellFlag.SOLID) !== 0;

/** Open link between 4-neighbour halo cells a and b (b = a + 1 or a + n) at 1.2 m above the higher floor. */
export function openLink(g: VisGrid, a: number, b: number): boolean {
  if (solid(g, a) || solid(g, b) || g.group[a] !== g.group[b]) return false;
  const n = g.n;
  const y = Math.max(g.floor[a], g.floor[b]) + Y_OPEN;
  if (b === a + 1) return !edgeX(g, (a % n) + 1, (a - (a % n)) / n, y);
  if (b === a - 1) return !edgeX(g, a % n, (a - (a % n)) / n, y);
  if (b === a + n) return !edgeZ(g, (a - (a % n)) / n + 1, a % n, y);
  return !edgeZ(g, (a - (a % n)) / n, a % n, y);
}

export function computeDiffusion(job: BakeJob): Diffusion {
  const g = job.g, n = g.n;
  const N = DN * DN;
  const b0 = new Float64Array(N * 3);
  const open = new Uint8Array(N); // bits: 1 W, 2 E, 4 N, 8 S
  for (let dj = 0; dj < DN; dj++) {
    for (let di = 0; di < DN; di++) {
      const hi = D0 + di, hj = D0 + dj, c = hj * n + hi, d = dj * DN + di;
      if (solid(g, c)) continue;
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      const fy = g.blockTop[c] > g.floor[c] ? g.blockTop[c] : g.floor[c];
      patchE(job, PK_FLOOR, c, hi + 0.5, fy, hj + 0.5, 0, false);
      albedoOf(g.floorMat[c], (g.flags[c] & CellFlag.WET) !== 0, rho);
      sr += rho[0] * pref.e[pref.o]; sg += rho[1] * pref.e[pref.o + 1]; sb += rho[2] * pref.e[pref.o + 2]; cnt++;
      const ym = job.cellH[c * 3 + 1];
      for (let s = 0; s < 4; s++) {
        const nb = s === 0 ? c - 1 : s === 1 ? c + 1 : s === 2 ? c - n : c + n;
        const inDom = s === 0 ? di > 0 : s === 1 ? di < DN - 1 : s === 2 ? dj > 0 : dj < DN - 1;
        const link = openLink(g, c, nb);
        if (link && inDom) open[d] |= 1 << s;
        if (link) continue;
        // a wall face on this side: its irradiance at mid height
        const dir = s === 0 ? 0 : s === 1 ? 1 : s === 2 ? 2 : 3;
        const x = s === 0 ? hi + 0.078125 : s === 1 ? hi + 0.921875 : hi + 0.5;
        const z = s === 2 ? hj + 0.078125 : s === 3 ? hj + 0.921875 : hj + 0.5;
        patchE(job, PK_WALL, c, x, ym, z, dir, false);
        let mat: number;
        if (s <= 1) { const e = hj * (n + 1) + hi + (s === 1 ? 1 : 0); mat = s === 1 ? g.exMatN[e] : g.exMatP[e]; }
        else { const e = (hj + (s === 3 ? 1 : 0)) * n + hi; mat = s === 3 ? g.ezMatN[e] : g.ezMatP[e]; }
        albedoOf(mat, false, rho);
        sr += rho[0] * pref.e[pref.o]; sg += rho[1] * pref.e[pref.o + 1]; sb += rho[2] * pref.e[pref.o + 2]; cnt++;
      }
      const k = 1 / (Math.PI * cnt);
      b0[d * 3] = sr * k; b0[d * 3 + 1] = sg * k; b0[d * 3 + 2] = sb * k;
    }
  }
  let cur = Float64Array.from(b0);
  let nxt = new Float64Array(N * 3);
  for (let it = 0; it < ITER; it++) {
    for (let d = 0; d < N; d++) {
      const o = open[d];
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      if (o !== 0) {
        for (let s = 0; s < 4; s++) {
          if ((o & (1 << s)) === 0) continue;
          const e = s === 0 ? d - 1 : s === 1 ? d + 1 : s === 2 ? d - DN : d + DN;
          sr += cur[e * 3]; sg += cur[e * 3 + 1]; sb += cur[e * 3 + 2]; cnt++;
        }
      }
      const inv = 1 / (1 + ENERGY * cnt);
      nxt[d * 3] = (b0[d * 3] + ENERGY * sr) * inv;
      nxt[d * 3 + 1] = (b0[d * 3 + 1] + ENERGY * sg) * inv;
      nxt[d * 3 + 2] = (b0[d * 3 + 2] + ENERGY * sb) * inv;
    }
    const t = cur; cur = nxt; nxt = t;
  }
  return { b: Float32Array.from(cur) };
}

/** Diffused radiosity (RGB) at (x, z) for owner cell c: bilinear over cell centres, zero weight across walls. */
export function diffusedAt(job: BakeJob, D: Diffusion, x: number, z: number, c: number, out: Float64Array): void {
  const g = job.g, n = g.n;
  const fx = x - 0.5, fz = z - 0.5;
  const i0 = Math.floor(fx), j0 = Math.floor(fz);
  const tx = fx - i0, tz = fz - j0;
  let ws = 0, r = 0, gg = 0, b = 0;
  const hi = c % n, hj = (c - hi) / n;
  for (let bj = 0; bj < 2; bj++) {
    for (let bi = 0; bi < 2; bi++) {
      const w = (bi ? tx : 1 - tx) * (bj ? tz : 1 - tz);
      if (w <= 0) continue;
      const ci = i0 + bi, cj = j0 + bj;
      const di = ci - D0, dj = cj - D0;
      if (di < 0 || dj < 0 || di >= DN || dj >= DN) continue;
      const pc = cj * n + ci;
      if (pc !== c) {
        const dxc = ci - hi, dzc = cj - hj;
        let ok: boolean;
        if (dxc === 0 || dzc === 0) ok = openLink(g, c, pc);
        else {
          const m1 = hj * n + ci, m2 = cj * n + hi;
          ok = (openLink(g, c, m1) && openLink(g, m1, pc)) || (openLink(g, c, m2) && openLink(g, m2, pc));
        }
        if (!ok) continue;
      }
      const d = dj * DN + di;
      r += w * D.b[d * 3]; gg += w * D.b[d * 3 + 1]; b += w * D.b[d * 3 + 2]; ws += w;
    }
  }
  if (ws <= 0) {
    const di = hi - D0, dj = hj - D0;
    if (di >= 0 && dj >= 0 && di < DN && dj < DN) { const d = dj * DN + di; r = D.b[d * 3]; gg = D.b[d * 3 + 1]; b = D.b[d * 3 + 2]; ws = 1; }
    else { out[0] = 0; out[1] = 0; out[2] = 0; return; }
  }
  out[0] = r / ws; out[1] = gg / ws; out[2] = b / ws;
}

/** Surface factor of the preview indirect term from the receiver normal's y. */
export const surfaceFactor = (ny: number): number => (ny < -0.5 ? 1.0 : ny > 0.5 ? 0.6 : 0.8);
