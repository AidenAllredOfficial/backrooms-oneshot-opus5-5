// src/bake/probes.ts — irradiance probes (WP7 §Algorithms 6). Pure module.
//
// One probe per cell of the tile plus a 1-cell ring, at the cell's 3 layer heights (effective floor + 0.4, mid,
// ceiling - 0.35; tower cells at the heights of the fundamental period, then reused for every storey copy).
// q.probeRays Fibonacci directions, rotated by a hash of the probe's world cell and layer, are traced with the
// DDA to the first hit (capped at LIGHT.PROBE_RAY_MAX). A hit returns the hit patch's radiance rho * E / pi
// (emitter surfaces contribute only their reflected light: their emission is already in the direct term).
// Misses use the tile-independent ambient rho_probe * E_cell / pi, with E_cell the coarse floor-patch irradiance
// of the probe's own cell and rho_probe the probe's hit-weighted albedo. The result is projected to SH-L1 RGB
// (light volume) and to an ambient cube of 6 cosine-weighted axis irradiances (lightmap texels, see ProbeSet.cube).
// Every probe is a pure function of world geometry and lights, so ring probes agree between neighbouring tiles.
// With `withDyn` (the tile has dynamic lights) the same rays also gather the dynamic lights' bounced LUMINANCE
// per flicker channel (hit patch rho_luma * E_dyn / pi, misses: the own cell's floor patch) into a second ambient
// cube per channel (ProbeSet.dyn), so flickering panels light the ceiling and walls around them indirectly like
// the static lights do (the old per-light constant 0.3 * rho * Y_mean left a black ceiling around them).

import { CELL, LIGHT } from '../core/constants.ts';
import { CellFlag } from '../core/ids.ts';
import { LAYER_DEFS } from '../core/materials.ts';
import { HIT_BOX_BOTTOM, HIT_BOX_SIDE, HIT_BOX_TOP, HIT_CEIL, HIT_FLOOR, HIT_NONE, HIT_WALL, hit, traceHit } from './dda.ts';
import type { BakeJob } from './job.ts';
import { FINE_DIST, PATCH_DYN, PK_CEIL, PK_FLOOR, PK_WALL, patchE, pref } from './patches.ts';
import { Y00, Y1, fibonacciDirs, hashRotation } from './sh.ts';
import { PROBE_N, PROBE_OFF, luma } from './util.ts';
import { insideBox, MAT_PROP } from './visgrid.ts';

export interface ProbeSet {
  /** probes per axis (18) and halo index of the first probe cell */
  n: number; off: number;
  /** 12 floats per probe (RGB SH-L1), index ((pj * n + pi) * 3 + layer) */
  sh: Float32Array;
  /** 18 floats per probe: the cosine-weighted irradiance of the 6 axis directions (+x -x +y -y +z -z), RGB each
   * (an "ambient cube"): exact hemispherical integrals of the probe's ray samples for axis-aligned receivers,
   * where the SH-L1 projection rings (a floor under a bright spot would get negative upward irradiance). */
  cube: Float32Array;
  rho: Float32Array; // hit-weighted albedo (luma)
  valid: Uint8Array;
  /** Dynamic lights (null when the tile has none): 24 floats per probe, channel ch at ch * 6 + the ambient-cube
   * axis (+x -x +y -y +z -z): cosine-weighted bounced luminance irradiance of that flicker channel. */
  dyn: Float32Array | null;
}

const PROP_RHO = 0.3;
const INV_PI = 1 / Math.PI;

/** Albedo (linear RGB) of a hit material layer id into out[0..2]. */
export function albedoOf(mat: number, wet: boolean, out: Float64Array): void {
  if (mat === MAT_PROP || !LAYER_DEFS[mat]) { out[0] = PROP_RHO; out[1] = PROP_RHO; out[2] = PROP_RHO; }
  else { const a = LAYER_DEFS[mat].albedoMean; out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; }
  if (wet) { out[0] *= 0.7; out[1] *= 0.7; out[2] *= 0.7; }
}

const rho3 = new Float64Array(3);
const rotM = new Float64Array(9);

/** Radiance (RGB, nits) of the current `hit`, written to out. */
function hitRadiance(job: BakeJob, dist: number, out: Float64Array): void {
  const fine = dist < FINE_DIST;
  const k = hit.kind;
  if (k === HIT_FLOOR || k === HIT_BOX_TOP) patchE(job, PK_FLOOR, hit.cell, hit.x, hit.y, hit.z, 0, fine);
  else if (k === HIT_CEIL || k === HIT_BOX_BOTTOM) patchE(job, PK_CEIL, hit.cell, hit.x, hit.y, hit.z, 0, fine);
  else patchE(job, PK_WALL, hit.cell, hit.x, hit.y, hit.z, hit.dir, fine);
  albedoOf(hit.mat, hit.wet, rho3);
  const e = pref.e, o = pref.o;
  out[0] = rho3[0] * e[o] * INV_PI; out[1] = rho3[1] * e[o + 1] * INV_PI; out[2] = rho3[2] * e[o + 2] * INV_PI;
}

const rad = new Float64Array(3);
const acc = new Float64Array(12);
const cub = new Float64Array(18);
const dcub = new Float64Array(24);

/** Accumulate a ray's dynamic luminance (4 channels at e[o + PATCH_DYN ..], x k) into the per-channel cubes. */
function addDynCube(dx: number, dy: number, dz: number, e: Float32Array, o: number, k: number): void {
  const a0 = dx > 0 ? 0 : 1, c0 = dx > 0 ? dx : -dx;
  const a1 = dy > 0 ? 2 : 3, c1 = dy > 0 ? dy : -dy;
  const a2 = dz > 0 ? 4 : 5, c2 = dz > 0 ? dz : -dz;
  for (let ch = 0; ch < 4; ch++) {
    const v = e[o + PATCH_DYN + ch] * k;
    if (v === 0) continue;
    const b = ch * 6;
    dcub[b + a0] += v * c0; dcub[b + a1] += v * c1; dcub[b + a2] += v * c2;
  }
}
const dirX = new Float64Array(512), dirY = new Float64Array(512), dirZ = new Float64Array(512), missR = new Uint8Array(512);

/** Accumulate a ray's radiance into the 6 cosine lobes of the ambient cube (sum; scaled by 4 pi / N later). */
function addCube(dx: number, dy: number, dz: number, r: number, g: number, b: number): void {
  const o0 = dx > 0 ? 0 : 3, c0 = dx > 0 ? dx : -dx;
  const o1 = dy > 0 ? 6 : 9, c1 = dy > 0 ? dy : -dy;
  const o2 = dz > 0 ? 12 : 15, c2 = dz > 0 ? dz : -dz;
  cub[o0] += r * c0; cub[o0 + 1] += g * c0; cub[o0 + 2] += b * c0;
  cub[o1] += r * c1; cub[o1 + 1] += g * c1; cub[o1 + 2] += b * c1;
  cub[o2] += r * c2; cub[o2 + 1] += g * c2; cub[o2 + 2] += b * c2;
}

export function computeProbes(job: BakeJob, withDyn = false): ProbeSet {
  const g = job.g, n = g.n;
  const N = PROBE_N, off = PROBE_OFF;
  const count = N * N * 3;
  const P: ProbeSet = {
    n: N, off, sh: new Float32Array(count * 12), cube: new Float32Array(count * 18), rho: new Float32Array(count), valid: new Uint8Array(count),
    dyn: withDyn ? new Float32Array(count * 24) : null,
  };
  const nRays = job.q.probeRays;
  const dirs = fibonacciDirs(nRays);
  const len = LIGHT.PROBE_RAY_MAX;
  const norm = (4 * Math.PI) / nRays;
  for (let pj = 0; pj < N; pj++) {
    for (let pi = 0; pi < N; pi++) {
      const hi = off + pi, hj = off + pj;
      const c = hj * n + hi;
      if ((g.flags[c] & CellFlag.SOLID) !== 0) continue;
      const group = g.group[c];
      const tower = (g.flags[c] & CellFlag.TOWER) !== 0 && group !== 0;
      for (let layer = 0; layer < 3; layer++) {
        const pIdx = (pj * N + pi) * 3 + layer;
        const px = hi + 0.5, pz = hj + 0.5, py = job.cellH[c * 3 + layer];
        if (insideBox(g, c, px, py, pz, group)) continue;
        if (!tower && (py <= g.floor[c] || py >= g.ceil[c] || py <= g.blockTop[c])) continue;
        hashRotation(g.gi0 + hi, g.gj0 + hj, layer + (tower ? 16 : 0), rotM);
        acc.fill(0); cub.fill(0);
        if (withDyn) dcub.fill(0);
        let miss0 = 0, miss1 = 0, miss2 = 0, miss3 = 0, rhoSum = 0, hits = 0;
        for (let r = 0; r < nRays; r++) {
          const bx = dirs[r * 3], by = dirs[r * 3 + 1], bz = dirs[r * 3 + 2];
          const dx = rotM[0] * bx + rotM[1] * by + rotM[2] * bz;
          const dy = rotM[3] * bx + rotM[4] * by + rotM[5] * bz;
          const dz = rotM[6] * bx + rotM[7] * by + rotM[8] * bz;
          traceHit(g, px, py, pz, dx * len / CELL, dy * len, dz * len / CELL, group);
          const s1 = Y1 * dy, s2 = Y1 * dz, s3 = Y1 * dx;
          dirX[r] = dx; dirY[r] = dy; dirZ[r] = dz; missR[r] = 0;
          if (hit.kind === HIT_NONE) { miss0 += Y00; miss1 += s1; miss2 += s2; miss3 += s3; missR[r] = 1; continue; }
          if (hit.kind !== HIT_WALL && hit.kind !== HIT_BOX_SIDE && hit.kind !== HIT_FLOOR && hit.kind !== HIT_CEIL &&
            hit.kind !== HIT_BOX_TOP && hit.kind !== HIT_BOX_BOTTOM) continue;
          hitRadiance(job, hit.t * len, rad);
          const rhoL = luma(rho3[0], rho3[1], rho3[2]);
          rhoSum += rhoL;
          hits++;
          if (withDyn) addDynCube(dx, dy, dz, pref.e, pref.o, rhoL * INV_PI);
          for (let ch = 0; ch < 3; ch++) {
            const v = rad[ch];
            acc[ch * 4] += v * Y00; acc[ch * 4 + 1] += v * s1; acc[ch * 4 + 2] += v * s2; acc[ch * 4 + 3] += v * s3;
          }
          addCube(dx, dy, dz, rad[0], rad[1], rad[2]);
        }
        let rhoP: number;
        if (hits > 0) rhoP = rhoSum / hits;
        else { albedoOf(g.floorMat[c], false, rho3); rhoP = luma(rho3[0], rho3[1], rho3[2]); }
        if (!tower && miss0 !== 0) {
          // tile-independent ambient for misses: rho_probe * E_cell / pi (coarse floor patch of the own cell)
          const fy = g.blockTop[c] > g.floor[c] ? g.blockTop[c] : g.floor[c];
          patchE(job, PK_FLOOR, c, hi + 0.5, fy, hj + 0.5, 0, false);
          const e = pref.e, o = pref.o;
          for (let ch = 0; ch < 3; ch++) {
            const a = rhoP * e[o + ch] * INV_PI;
            acc[ch * 4] += a * miss0; acc[ch * 4 + 1] += a * miss1; acc[ch * 4 + 2] += a * miss2; acc[ch * 4 + 3] += a * miss3;
          }
          const ar = rhoP * e[o] * INV_PI, ag = rhoP * e[o + 1] * INV_PI, ab = rhoP * e[o + 2] * INV_PI;
          for (let r = 0; r < nRays; r++) if (missR[r] !== 0) addCube(dirX[r], dirY[r], dirZ[r], ar, ag, ab);
          if (withDyn) for (let r = 0; r < nRays; r++) if (missR[r] !== 0) addDynCube(dirX[r], dirY[r], dirZ[r], e, o, rhoP * INV_PI);
        }
        const so = pIdx * 12;
        for (let k = 0; k < 12; k++) P.sh[so + k] = acc[k] * norm;
        for (let k = 0; k < 18; k++) P.cube[pIdx * 18 + k] = cub[k] * norm;
        if (P.dyn) for (let k = 0; k < 24; k++) P.dyn[pIdx * 24 + k] = dcub[k] * norm;
        P.rho[pIdx] = rhoP;
        P.valid[pIdx] = 1;
      }
    }
  }
  return P;
}
