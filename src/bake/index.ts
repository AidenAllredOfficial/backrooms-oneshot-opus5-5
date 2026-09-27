// src/bake/index.ts — light baker entry point (WP7). Pure module; performance.now() is used for stats only.
//
// bakeTile(nb, tile, surfaces, variant, q, term, cache?) -> LightmapData
//   1. job: VisGrid halo, light set, per-chunk visibility / patch tables (from the BakeCache when given);
//   2. texel setup from the given SurfaceSet (its chart hash is verified: a mismatch throws);
//   3. direct: full (classified FULL / NONE / PARTIAL, exact polygon form factors, shadow samples, 2x2 refinement)
//      or preview (bitset classes on 2x2 blocks);
//   4. indirect: full (SH-L1 probes gathered from the world-anchored patch cache, per-channel multi-bounce) or
//      preview (2D edge-aware diffusion), times the analytic AO; full bakes with q.nearRays > 0 trace a near-field
//      gather at texels with an occluder box within 1.2 m (nearfield.ts: radiance-weighted visibility of the far
//      field plus the boxes' bounce, replacing the analytic box and contact AO there);
//   5. flicker channels (dynamic lights only; direct luminance + per-light bounce), surface mask, emission map,
//      light volume + wall mask;
//   6. chart-local dilation and encoding. `term !== 'all'` zeroes the other term (debug bakes).
// Every stochastic pattern is seeded by quantized WORLD positions; all ray arithmetic is exact in halo units, so
// the output is byte-identical with or without a cache and seam texels agree between tiles.

import { tileKeyStr, type TileKey } from '../core/grid.ts';
import type { LightmapData, SurfaceSet } from '../core/mesh.ts';
import type { BakeQuality } from '../core/quality.ts';
import type { BakeTerm } from '../core/worker.ts';
import type { LayoutNeighborhood } from '../core/world.ts';
import { chartHash } from '../mesh/chartHash.ts';
import { aoAt, aoOut } from './ao.ts';
import { cacheImpl, type BakeCache } from './cache.ts';
import { addBounce, addDynIndirect, computeDynamic, type DynInfo } from './channels.ts';
import { TX_VALID, isLattice, latNbr, latticeNeighbours, latticeOff, setupTexels, type TexelSet } from './context.ts';
import { rayStats } from './dda.ts';
import { dilate } from './dilate.ts';
import { directFull, directPreview, hasDynamic, type DirectResult } from './direct.ts';
import { bakeEmission } from './emission.ts';
import { encodeLightmap } from './encode.ts';
import { growF32 } from './util.ts';
import { cellsLinked, dynIndirect, indirectAt, indirectOut, interp, interpolateProbes } from './indirect.ts';
import { createJob, type BakeDiag, type BakeJob } from './job.ts';
import { createMaskCache, maskAt, maskOut } from './mask.ts';
import { NEAR_REACH, nearDist, nearFieldAt, nearOut, nearWeight } from './nearfield.ts';
import { computeDiffusion, diffusedAt, surfaceFactor, type Diffusion } from './preview.ts';
import { computeProbes, type ProbeSet } from './probes.ts';
import { bakeVolume } from './volume.ts';

export type { BakeCache } from './cache.ts';
export { createBakeCache } from './cache.ts';

/** Diagnostics of the most recent bakeTile call (bench / tests; not part of LightmapData). */
export interface BakeReport extends BakeDiag {
  variant: 'preview' | 'full';
  lights: number; // lights in the job (all groups, static + dynamic)
  staticLights: number;
  dynamicLights: number;
  texels: number; // valid texels baked
  nearTexels: number; // texels evaluated with the near-field gather
  rays: number;
  rayKinds: [number, number, number, number]; // classification segments, shadow samples, bitset, probe rays
  nonDynamicFlicker: number; // FLICKER/ANOMALY lights that were not dynamic (must be 0 after WP4)
  /** near: the lightmap near-field gathers (part of indirect) */
  ms: { setup: number; direct: number; indirect: number; near: number; finish: number; total: number; encode: number; emission: number; volume: number };
}
export const lastBake: BakeReport = {
  variant: 'full', lights: 0, staticLights: 0, dynamicLights: 0, texels: 0, nearTexels: 0, rays: 0, rayKinds: [0, 0, 0, 0], nonDynamicFlicker: 0,
  receivers: 0, dropped: 0, dropMax: 0, dropSum: 0, patches: 0, visBits: 0, pairs: [0, 0, 0], shadowTexels: 0,
  ms: { setup: 0, direct: 0, indirect: 0, near: 0, finish: 0, total: 0, encode: 0, emission: 0, volume: 0 },
};

const ind3 = new Float64Array(3);
const bounce4 = new Float64Array(4);

/** Near-field factors of the lattice texels in and around the region, 8 floats per slot: V, Vg, E (RGB lux),
 * mb * ao (RGB). */
const NEAR_STRIDE = 8;
let nearData = new Float32Array(NEAR_STRIDE * 4096);
function storeNear(slot: number): void {
  const o = slot * NEAR_STRIDE;
  nearData[o] = nearOut.v; nearData[o + 1] = nearOut.vg;
  nearData[o + 2] = nearOut.e[0]; nearData[o + 3] = nearOut.e[1]; nearData[o + 4] = nearOut.e[2];
}

/** Parity offset of the near-field 4x4 lattice: a sub-lattice of the 2x2 evaluation lattice (grid charts: (u - 1),
 * world-aligned; others: u - 2, the first even interior texel). */
const nearOff = (T: TexelSet, chart: number): number => (T.grid[chart] !== 0 ? 1 : 2);

const nearW = new Float64Array(4);
/**
 * The 4x4-lattice corners a pending near texel t bilinearly interpolates its near-field factors from (latNbr, weights
 * in nearW): computed (how 1) VALID texels of the same chart whose factors are known (outside the region, or traced),
 * in the same patch or in a linked cell at the same height (grid charts). Corners beyond the chart's interior (and
 * valid apron) are left out (constant extrapolation over the last texels). Returns 0 when one is missing (the texel
 * is traced).
 */
function nearCorners(job: BakeJob, T: TexelSet, t: number, how: Uint8Array, NF: Uint8Array): number {
  const ch = T.chart[t], no = nearOff(T, ch), cw = T.chartW[ch], chh = T.chartH[ch];
  const u = T.u[t], v = T.v[t], p = T.patch[t], c = T.cell[t], grid = T.grid[ch] !== 0;
  const ru = (u - no) & 3, rv = (v - no) & 3;
  const W = T.atlasW, base = T.atlas[t];
  let cnt = 0, wsum = 0;
  for (let k = 0; k < 4; k++) {
    const bu = k & 1, bv = k >> 1;
    if ((bu !== 0 && ru === 0) || (bv !== 0 && rv === 0)) continue;
    const du = bu !== 0 ? 4 - ru : -ru, dv = bv !== 0 ? 4 - rv : -rv;
    const uu = u + du, vv = v + dv;
    if (uu < 0 || vv < 0 || uu >= cw || vv >= chh) continue;
    const s = T.map[base + dv * W + du];
    if ((uu === 0 || vv === 0 || uu === cw - 1 || vv === chh - 1) && !(s >= 0 && T.state[s] === TX_VALID)) continue; // apron
    if (s < 0 || T.chart[s] !== ch || T.u[s] !== u + du || T.v[s] !== v + dv || T.state[s] !== TX_VALID || how[s] !== 1 || NF[s] === 2) return 0;
    if (T.patch[s] !== p) {
      const cs = T.cell[s];
      if (cs !== c && (T.group[s] !== T.group[t] || (grid && T.y[s] !== T.y[t]) || !cellsLinked(job.g, c, cs, T.x[t], T.y[t], T.z[t]))) return 0;
    }
    latNbr[cnt] = s;
    const w = (bu !== 0 ? ru : 4 - ru) * (bv !== 0 ? rv : 4 - rv) * (1 / 16);
    nearW[cnt++] = w;
    wsum += w;
  }
  if (cnt > 0 && wsum < 1) for (let k = 0; k < cnt; k++) nearW[k] /= wsum;
  return cnt;
}

function emptyDirect(n: number, withFlick: boolean): DirectResult {
  return { e: new Float32Array(n * 3), v: new Float32Array(n * 3), flick: withFlick ? new Float32Array(n * 4) : null, anyDynamic: withFlick };
}

export function bakeTile(
  nb: LayoutNeighborhood, tile: TileKey, surfaces: SurfaceSet, variant: 'preview' | 'full', q: BakeQuality, term: BakeTerm,
  cache?: BakeCache,
): LightmapData {
  const t0 = performance.now();
  const key = tileKeyStr(tile);
  if (surfaces.tileKey !== key) throw new Error(`bakeTile: SurfaceSet is for tile ${surfaces.tileKey}, not ${key}`);
  if (surfaces.tpc !== q.tpc) throw new Error(`bakeTile: SurfaceSet tpc ${surfaces.tpc} != bake tpc ${q.tpc}`);
  const hash = chartHash(surfaces.charts);
  if (hash !== surfaces.hash) throw new Error(`bakeTile: chartHash mismatch for ${key} (charts ${hash}, surfaces.hash ${surfaces.hash})`);
  const rays0 = rayStats.rays;
  const kinds0 = Array.from(rayStats.byKind);

  const job = createJob(nb, tile, q, cacheImpl(cache));
  const T = setupTexels(job, surfaces);
  const doDirect = term !== 'indirect', doIndirect = term !== 'direct';
  const t1 = performance.now();

  // ---- direct (static E, direction accumulator, dynamic channel luminance)
  const anyDyn = hasDynamic(job);
  const R: DirectResult = doDirect
    ? (variant === 'full' ? directFull(job, T) : directPreview(job, T, surfaces))
    : emptyDirect(T.n, anyDyn);
  const dyn: DynInfo | null = anyDyn ? computeDynamic(job) : null;
  const t2 = performance.now();

  // ---- indirect + AO + mask per texel
  const P: ProbeSet | null = variant === 'full' && doIndirect ? computeProbes(job, anyDyn) : null;
  const D: Diffusion | null = variant === 'preview' && doIndirect ? computeDiffusion(job) : null;
  const n = T.n;
  const E = R.e, V = R.v, F = R.flick;
  const AO = new Float32Array(n).fill(1);
  const M = new Float32Array(n * 4);
  const cw = createMaskCache(job);
  // Per-texel AO (+ wall-only AO and wall distance for the mask), indirect x AO and dynamic bounce.
  //   full:    evaluated on the 2x2 lattice (world-aligned on grid charts) and at chart ends; the other texels
  //            interpolate their lattice neighbours of the same patch (AO and probe irradiance are smooth);
  //   preview: evaluated once per 2x2 texel block and replicated (mask included), like the preview direct term.
  const preview = variant === 'preview';
  const W = surfaces.atlasW, H = surfaces.atlasH;
  const AOW = new Float32Array(n), WD = new Float32Array(n), IND = new Float32Array(n * 3);
  const BF = F ? new Float32Array(n * 4) : null;
  const how = new Uint8Array(n); // 1 computed, 2 interpolate (full), 3 copied from blockRep (preview)
  const rep = new Int32Array(n); // preview: block representative; full: lattice-neighbour count (how 2)
  const nbr = preview ? null : new Int32Array(n * 4); // full: the lattice neighbours of `how 2` texels
  const blockRep = preview ? new Int32Array(W * H).fill(-1) : null;
  const charts = surfaces.charts;
  // near-field gather (full bakes with q.nearRays > 0): the prop boxes' analytic AO is replaced everywhere; texels
  // in the region get their factors (V, Vg, E) traced on a 4x4 sub-lattice of the 2x2 lattice (world-aligned on
  // grid charts) and at seams, the other lattice texels interpolate those lattice corners (NF 1 traced, 2 pending
  // in the region, 4 pending outside it, 3 done, 0 none)
  const nearRays = P !== null ? (q.nearRays ?? 0) : 0;
  const NF = nearRays > 0 ? new Uint8Array(n) : null;
  const NS = nearRays > 0 ? new Int32Array(n) : null; // slot in nearData
  let nSlots = 0;
  let valid = 0, nearTexels = 0, nearMs = 0;
  for (let t = 0; t < n; t++) {
    if (T.state[t] !== TX_VALID) continue;
    valid++;
    const c = T.cell[t];
    if (blockRep) {
      const ci = T.chart[t], ch = charts[ci];
      const u = T.u[t], v = T.v[t];
      const bu = T.grid[ci] !== 0 ? (((u - 1) >> 1) << 1) + 1 : (u >> 1) << 1;
      const bv = T.grid[ci] !== 0 ? (((v - 1) >> 1) << 1) + 1 : (v >> 1) << 1;
      const ax = ch.x + bu, ay = ch.y + bv;
      if (ax >= 0 && ay >= 0 && ax < W && ay < H) {
        const key = ay * W + ax;
        const r = blockRep[key];
        if (r >= 0 && T.cell[r] === c && T.chart[r] === ci) { how[t] = 3; rep[t] = r; continue; }
        if (r < 0) blockRep[key] = t;
      }
    } else {
      const off = latticeOff(T, T.chart[t]);
      if (!isLattice(T, t, off)) {
        const cnt = latticeNeighbours(T, t, T.patch[t], off);
        if (cnt > 0 && nbr) {
          how[t] = 2; rep[t] = cnt;
          for (let k = 0; k < cnt; k++) nbr[t * 4 + k] = latNbr[k];
          continue;
        }
      }
    }
    how[t] = 1;
    const x = T.x[t], y = T.y[t], z = T.z[t], nx = T.nx[t], ny = T.ny[t], nz = T.nz[t];
    const group = T.group[t];
    aoAt(job, x, y, z, nx, ny, nz, c, group, false, nearRays > 0);
    const ao = aoOut.ao;
    AO[t] = ao; AOW[t] = aoOut.wall; WD[t] = aoOut.wallDist;
    if (doIndirect) {
      if (P) {
        const nw = NF !== null ? nearWeight(job, c, x, y, z, nx, ny, nz, group, true) : 0;
        const near = nw > 0;
        indirectAt(job, P, x, y, z, nx, ny, nz, c, ind3, near);
        if (NF && NS && interp.w > 0) {
          const no = nearOff(T, T.chart[t]);
          const exact = (((T.u[t] - no) | (T.v[t] - no)) & 3) === 0 || T.seam[t] !== 0;
          // (an exact texel outside the region, or one out of reach of a traced corner, keeps V = 1)
          if (near || (!exact && nearDist.d < NEAR_REACH)) {
            const slot = nSlots++;
            if (nearData.length < nSlots * NEAR_STRIDE) nearData = growF32(nearData, nSlots * NEAR_STRIDE);
            NS[t] = slot;
            const mb = indirectOut.mb, o = slot * NEAR_STRIDE;
            nearData[o + 5] = mb[0] * ao; nearData[o + 6] = mb[1] * ao; nearData[o + 7] = mb[2] * ao;
            if (!near) NF[t] = 4;
            else if (exact) {
              const tn = performance.now();
              nearFieldAt(job, x, y, z, nx, ny, nz, group, nearRays, interp.sh, nw);
              nearMs += performance.now() - tn;
              nearTexels++;
              storeNear(slot);
              NF[t] = 1;
            } else NF[t] = 2;
          }
        }
      } else if (D) {
        diffusedAt(job, D, x, z, c, ind3);
        const k = Math.PI * surfaceFactor(ny);
        ind3[0] *= k; ind3[1] *= k; ind3[2] *= k;
      }
      IND[t * 3] = ind3[0] * ao; IND[t * 3 + 1] = ind3[1] * ao; IND[t * 3 + 2] = ind3[2] * ao;
      if (BF && dyn) {
        bounce4.fill(0);
        // full: the probes' bounced dynamic luminance (set by indirectAt); preview: the per-light constant
        if (P) addDynIndirect(job, x, y, z, group, dynIndirect, ao, bounce4);
        else addBounce(job, dyn, x, y, z, c, ao, bounce4);
        for (let k = 0; k < 4; k++) BF[t * 4 + k] = bounce4[k];
      }
    }
  }
  if (NF && NS && P) {
    const ND = nearData;
    // the other lattice texels: bilinear interpolation of the factors of their 4x4-lattice corners (a corner outside
    // the region has V = Vg = 1, E = 0), so the factors fade out continuously across the region's edge; region
    // texels whose corners are missing or all outside the region are traced, others outside keep V = 1
    for (let t = 0; t < n; t++) {
      const f = NF[t];
      if (f !== 2 && f !== 4) continue;
      const cnt = nearCorners(job, T, t, how, NF);
      let traced = 0;
      for (let k = 0; k < cnt; k++) if (NF[latNbr[k]] === 1) traced++;
      if (f === 4 && traced === 0) { NF[t] = 0; continue; }
      if (traced > 0) {
        let v = 0, vg = 0, e0 = 0, e1 = 0, e2 = 0;
        for (let k = 0; k < cnt; k++) {
          const s = latNbr[k], w = nearW[k];
          if (NF[s] === 0) { v += w; vg += w; continue; }
          const o = NS[s] * NEAR_STRIDE;
          v += w * ND[o]; vg += w * ND[o + 1]; e0 += w * ND[o + 2]; e1 += w * ND[o + 3]; e2 += w * ND[o + 4];
        }
        const o = NS[t] * NEAR_STRIDE;
        ND[o] = v; ND[o + 1] = vg; ND[o + 2] = e0; ND[o + 3] = e1; ND[o + 4] = e2;
      } else {
        const x = T.x[t], y = T.y[t], z = T.z[t], c = T.cell[t], nx = T.nx[t], ny = T.ny[t], nz = T.nz[t], group = T.group[t];
        interpolateProbes(job, P, x, y, z, c, true, false);
        const tn = performance.now();
        nearFieldAt(job, x, y, z, nx, ny, nz, group, nearRays, interp.sh, nearWeight(job, c, x, y, z, nx, ny, nz, group, true));
        nearMs += performance.now() - tn;
        nearTexels++;
        storeNear(NS[t]);
      }
      NF[t] = 3;
    }
    // E_ind = (E_cube * V + E_box) * mb: the far field seen past the boxes plus the boxes' own bounce
    for (let t = 0; t < n; t++) {
      if (NF[t] === 0) continue;
      const o = NS[t] * NEAR_STRIDE, v = ND[o];
      IND[t * 3] = IND[t * 3] * v + ND[o + 2] * ND[o + 5];
      IND[t * 3 + 1] = IND[t * 3 + 1] * v + ND[o + 3] * ND[o + 6];
      IND[t * 3 + 2] = IND[t * 3 + 2] * v + ND[o + 4] * ND[o + 7];
      AO[t] *= ND[o + 1];
      if (BF) for (let k = 0; k < 4; k++) BF[t * 4 + k] *= v; // (the flicker channels' probe bounce, same visibility)
    }
  }
  for (let t = 0; t < n; t++) {
    const h = how[t];
    if (h === 2 && nbr) {
      const cnt = rep[t];
      const inv = 1 / cnt;
      let a0 = 0, a1 = 0, a2 = 0, i0 = 0, i1 = 0, i2 = 0;
      for (let k = 0; k < cnt; k++) {
        const s = nbr[t * 4 + k];
        a0 += AO[s]; a1 += AOW[s]; a2 += WD[s];
        i0 += IND[s * 3]; i1 += IND[s * 3 + 1]; i2 += IND[s * 3 + 2];
      }
      AO[t] = a0 * inv; AOW[t] = a1 * inv; WD[t] = a2 * inv;
      IND[t * 3] = i0 * inv; IND[t * 3 + 1] = i1 * inv; IND[t * 3 + 2] = i2 * inv;
      if (BF) for (let j = 0; j < 4; j++) {
        let b = 0;
        for (let k = 0; k < cnt; k++) b += BF[nbr[t * 4 + k] * 4 + j];
        BF[t * 4 + j] = b * inv;
      }
    } else if (h === 3) {
      const r = rep[t];
      AO[t] = AO[r]; AOW[t] = AOW[r]; WD[t] = WD[r];
      IND[t * 3] = IND[r * 3]; IND[t * 3 + 1] = IND[r * 3 + 1]; IND[t * 3 + 2] = IND[r * 3 + 2];
      if (BF) for (let j = 0; j < 4; j++) BF[t * 4 + j] = BF[r * 4 + j];
    }
  }
  for (let t = 0; t < n; t++) {
    const h = how[t];
    if (h === 0) continue;
    E[t * 3] += IND[t * 3]; E[t * 3 + 1] += IND[t * 3 + 1]; E[t * 3 + 2] += IND[t * 3 + 2];
    if (F && BF) for (let k = 0; k < 4; k++) F[t * 4 + k] += BF[t * 4 + k];
    if (h === 3) {
      const r = rep[t];
      M[t * 4] = M[r * 4]; M[t * 4 + 1] = M[r * 4 + 1]; M[t * 4 + 2] = M[r * 4 + 2]; M[t * 4 + 3] = M[r * 4 + 3];
      continue;
    }
    maskAt(job, cw, T.x[t], T.y[t], T.z[t], T.nx[t], T.ny[t], T.nz[t], T.cell[t], AOW[t], WD[t]);
    M[t * 4] = maskOut.r; M[t * 4 + 1] = maskOut.g; M[t * 4 + 2] = maskOut.b; M[t * 4 + 3] = maskOut.a;
  }
  const t3 = performance.now();

  // ---- dilation, encoding, emission map, light volume
  const arrs: Float32Array[] = [E, V, AO, M];
  const comps = [3, 3, 1, 4];
  if (F) { arrs.push(F); comps.push(4); }
  dilate(T, { arrs, comps }, surfaces.charts.length, job.g);
  const enc = encodeLightmap(T, E, V, AO, F, M);
  const tEnc = performance.now();
  const emission = bakeEmission(job);
  const tEm = performance.now();
  const volume = bakeVolume(job, P, D, dyn, term, variant === 'full' ? (q.nearRays ?? 0) : 0);
  const t4 = performance.now();

  const L = job.L;
  let nStatic = 0, nDyn = 0;
  for (let l = 0; l < L.n; l++) { if (L.dynamic[l] !== 0) nDyn++; else nStatic++; }
  const rays = rayStats.rays - rays0;
  for (let k = 0; k < 4; k++) lastBake.rayKinds[k] = rayStats.byKind[k] - kinds0[k];
  const d = job.diag;
  lastBake.variant = variant;
  lastBake.lights = L.n; lastBake.staticLights = nStatic; lastBake.dynamicLights = nDyn;
  lastBake.texels = valid; lastBake.nearTexels = nearTexels; lastBake.rays = rays; lastBake.nonDynamicFlicker = L.nonDynamicFlicker;
  lastBake.receivers = d.receivers; lastBake.dropped = d.dropped; lastBake.dropMax = d.dropMax; lastBake.dropSum = d.dropSum;
  lastBake.patches = d.patches; lastBake.visBits = d.visBits;
  lastBake.pairs = [d.pairs[0], d.pairs[1], d.pairs[2]]; lastBake.shadowTexels = d.shadowTexels;
  lastBake.ms.setup = t1 - t0; lastBake.ms.direct = t2 - t1; lastBake.ms.indirect = t3 - t2; lastBake.ms.near = nearMs; lastBake.ms.finish = t4 - t3; lastBake.ms.total = t4 - t0;
  lastBake.ms.encode = tEnc - t3; lastBake.ms.emission = tEm - tEnc; lastBake.ms.volume = t4 - tEm;

  return {
    tileKey: key,
    variant,
    width: surfaces.atlasW,
    height: surfaces.atlasH,
    chartHash: surfaces.hash,
    irr: enc.irr,
    dir: enc.dir,
    flick: enc.flick,
    mask: enc.mask,
    emission,
    volume: { a: volume.a, b: volume.b, c: volume.c, wallMask: volume.wallMask },
    stats: { ms: t4 - t0, texels: valid, rays, lights: L.n },
  };
}
