// src/bake/index.ts — light baker entry point (WP7). Pure module; performance.now() is used for stats only.
//
// bakeTile(nb, tile, surfaces, variant, q, term, cache?) -> LightmapData
//   1. job: VisGrid halo, light set, per-chunk visibility / patch tables (from the BakeCache when given);
//   2. texel setup from the given SurfaceSet (its chart hash is verified: a mismatch throws);
//   3. direct: full (classified FULL / NONE / PARTIAL, exact polygon form factors, shadow samples, 2x2 refinement)
//      or preview (bitset classes on 2x2 blocks);
//   4. indirect: full (SH-L1 probes gathered from the world-anchored patch cache, multi-bounce) or preview
//      (2D edge-aware diffusion), times the analytic AO;
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
import { TX_VALID, isLattice, latNbr, latticeNeighbours, latticeOff, setupTexels } from './context.ts';
import { rayStats } from './dda.ts';
import { dilate } from './dilate.ts';
import { directFull, directPreview, hasDynamic, type DirectResult } from './direct.ts';
import { bakeEmission } from './emission.ts';
import { encodeLightmap } from './encode.ts';
import { dynIndirect, indirectAt } from './indirect.ts';
import { createJob, type BakeDiag } from './job.ts';
import { createMaskCache, maskAt, maskOut } from './mask.ts';
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
  rays: number;
  rayKinds: [number, number, number, number]; // classification segments, shadow samples, bitset, probe rays
  nonDynamicFlicker: number; // FLICKER/ANOMALY lights that were not dynamic (must be 0 after WP4)
  ms: { setup: number; direct: number; indirect: number; finish: number; total: number; encode: number; emission: number; volume: number };
}
export const lastBake: BakeReport = {
  variant: 'full', lights: 0, staticLights: 0, dynamicLights: 0, texels: 0, rays: 0, rayKinds: [0, 0, 0, 0], nonDynamicFlicker: 0,
  receivers: 0, dropped: 0, dropMax: 0, dropSum: 0, patches: 0, visBits: 0, pairs: [0, 0, 0], shadowTexels: 0,
  ms: { setup: 0, direct: 0, indirect: 0, finish: 0, total: 0, encode: 0, emission: 0, volume: 0 },
};

const ind3 = new Float64Array(3);
const bounce4 = new Float64Array(4);

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
  let valid = 0;
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
    aoAt(job, x, y, z, nx, ny, nz, c, group, false);
    const ao = aoOut.ao;
    AO[t] = ao; AOW[t] = aoOut.wall; WD[t] = aoOut.wallDist;
    if (doIndirect) {
      if (P) indirectAt(job, P, x, y, z, nx, ny, nz, c, ind3);
      else if (D) {
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
  const volume = bakeVolume(job, P, D, dyn, term);
  const t4 = performance.now();

  const L = job.L;
  let nStatic = 0, nDyn = 0;
  for (let l = 0; l < L.n; l++) { if (L.dynamic[l] !== 0) nDyn++; else nStatic++; }
  const rays = rayStats.rays - rays0;
  for (let k = 0; k < 4; k++) lastBake.rayKinds[k] = rayStats.byKind[k] - kinds0[k];
  const d = job.diag;
  lastBake.variant = variant;
  lastBake.lights = L.n; lastBake.staticLights = nStatic; lastBake.dynamicLights = nDyn;
  lastBake.texels = valid; lastBake.rays = rays; lastBake.nonDynamicFlicker = L.nonDynamicFlicker;
  lastBake.receivers = d.receivers; lastBake.dropped = d.dropped; lastBake.dropMax = d.dropMax; lastBake.dropSum = d.dropSum;
  lastBake.patches = d.patches; lastBake.visBits = d.visBits;
  lastBake.pairs = [d.pairs[0], d.pairs[1], d.pairs[2]]; lastBake.shadowTexels = d.shadowTexels;
  lastBake.ms.setup = t1 - t0; lastBake.ms.direct = t2 - t1; lastBake.ms.indirect = t3 - t2; lastBake.ms.finish = t4 - t3; lastBake.ms.total = t4 - t0;
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
