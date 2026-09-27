// src/bake/probes.ts — irradiance probes (WP7 §Algorithms 6). Pure module.
//
// One probe per cell of the tile plus a 1-cell ring, at the cell's 3 layer heights (effective floor + 0.4, mid,
// ceiling - 0.35; tower cells at the heights of the fundamental period, then reused for every storey copy).
// q.probeRays Fibonacci directions, rotated by a hash of the probe's world cell and layer, are traced with the
// DDA to the first hit (capped at LIGHT.PROBE_RAY_MAX). A hit returns the hit patch's radiance rho * E / pi
// (emitter surfaces contribute only their reflected light: their emission is already in the direct term).
// Misses use the tile-independent ambient rho_probe * E_cell / pi, with E_cell the coarse floor-patch irradiance
// of the probe's own cell and rho_probe the probe's hit-weighted albedo (RGB: the multi-bounce gain is applied
// per channel, so a yellow room's higher bounces get more saturated). The result is projected to SH-L1 RGB
// (light volume) and to an ambient cube of 6 cosine-weighted axis irradiances (lightmap texels, see ProbeSet.cube).
// Every probe is a pure function of world geometry and lights, so ring probes agree between neighbouring tiles.
// With `withDyn` (the tile has dynamic lights) the same rays also gather the dynamic lights' bounced LUMINANCE
// per flicker channel (hit patch rho_luma * E_dyn / pi, misses: the own cell's floor patch) into a second ambient
// cube per channel (ProbeSet.dyn), so flickering panels light the ceiling and walls around them indirectly like
// the static lights do (the old per-light constant 0.3 * rho * Y_mean left a black ceiling around them).
// With `farR` > 0 (full bakes with the near-field gather) every probe also stores its FAR field (ProbeSet.far*):
// the same rays with the prop boxes entered within farR m transparent (a ray hitting a desk top 0.3 m above a low
// probe is traced on past it). Receivers in the near-field region blend towards it by their nearWeight, and the
// gather then puts the props within its own NEAR.R back (visibility + box bounce): a probe under a desk top or a
// chair seat no longer darkens the under-desk floor a second time (the traced V multiplied the probe's own view of
// the same desk), while probes away from the region keep the props (tall racks still shade the aisles).

import { CELL, LIGHT } from '../core/constants.ts';
import { CellFlag } from '../core/ids.ts';
import { LAYER_DEFS } from '../core/materials.ts';
import { HIT_BOX_BOTTOM, HIT_BOX_SIDE, HIT_BOX_TOP, HIT_CEIL, HIT_FLOOR, HIT_NONE, HIT_WALL, hit, hitFar, traceHit, traceHit2, type HitRecord } from './dda.ts';
import { boxesAround, boxesAroundList } from './ao.ts';
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
  rho: Float32Array; // 3 floats per probe: hit-weighted albedo (linear RGB)
  valid: Uint8Array;
  /** Dynamic lights (null when the tile has none): 24 floats per probe, channel ch at ch * 6 + the ambient-cube
   * axis (+x -x +y -y +z -z): cosine-weighted bounced luminance irradiance of that flicker channel. */
  dyn: Float32Array | null;
  /** Far field (null without `farR`): sh / cube of the same rays with the prop boxes near the probe transparent. */
  farSh: Float32Array | null;
  farCube: Float32Array | null;
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
const amb3 = new Float64Array(3);
const rotM = new Float64Array(9);

/** Radiance (RGB, nits) of hit record h (`hit` or `hitFar`), written to out. */
function hitRadiance(job: BakeJob, h: HitRecord, dist: number, out: Float64Array): void {
  const fine = dist < FINE_DIST;
  const k = h.kind;
  if (k === HIT_FLOOR || k === HIT_BOX_TOP) patchE(job, PK_FLOOR, h.cell, h.x, h.y, h.z, 0, fine);
  else if (k === HIT_CEIL || k === HIT_BOX_BOTTOM) patchE(job, PK_CEIL, h.cell, h.x, h.y, h.z, 0, fine);
  else patchE(job, PK_WALL, h.cell, h.x, h.y, h.z, h.dir, fine);
  albedoOf(h.mat, h.wet, rho3);
  const e = pref.e, o = pref.o;
  out[0] = rho3[0] * e[o] * INV_PI; out[1] = rho3[1] * e[o + 1] * INV_PI; out[2] = rho3[2] * e[o + 2] * INV_PI;
}

const rad = new Float64Array(3);
const acc = new Float64Array(12);
const cub = new Float64Array(18);
const dcub = new Float64Array(24);
const facc = new Float64Array(12);
const fcub = new Float64Array(18);

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
const farMiss = new Uint8Array(512);

/** Accumulate a ray's radiance into the 6 cosine lobes of an ambient cube (sum; scaled by 4 pi / N later). */
function addCube(dx: number, dy: number, dz: number, r: number, g: number, b: number, cube = cub): void {
  const o0 = dx > 0 ? 0 : 3, c0 = dx > 0 ? dx : -dx;
  const o1 = dy > 0 ? 6 : 9, c1 = dy > 0 ? dy : -dy;
  const o2 = dz > 0 ? 12 : 15, c2 = dz > 0 ? dz : -dz;
  cube[o0] += r * c0; cube[o0 + 1] += g * c0; cube[o0 + 2] += b * c0;
  cube[o1] += r * c1; cube[o1 + 1] += g * c1; cube[o1 + 2] += b * c1;
  cube[o2] += r * c2; cube[o2 + 1] += g * c2; cube[o2 + 2] += b * c2;
}
/** Accumulate a ray's RGB radiance r into an SH-L1 accumulator a (12 floats; s1..s3 = Y1 * (dy, dz, dx)). */
function addSh(a: Float64Array, r: Float64Array, s1: number, s2: number, s3: number): void {
  for (let ch = 0; ch < 3; ch++) {
    const v = r[ch];
    a[ch * 4] += v * Y00; a[ch * 4 + 1] += v * s1; a[ch * 4 + 2] += v * s2; a[ch * 4 + 3] += v * s3;
  }
}
/** Is a prop box of `group` within r m of (x, y, z) (halo cells / m) of cell c (r <= 1 cell)? Probes without one
 * have far field = full field exactly, and skip the far walk. */
function propWithin(job: BakeJob, c: number, x: number, y: number, z: number, group: number, r: number): boolean {
  const g = job.g, at = boxesAround(job, c), bl = boxesAroundList();
  for (let k = at + 1, ke = at + 1 + bl[at]; k < ke; k++) {
    const b = bl[k];
    if (g.boxGroup[b] !== group || g.boxMat[b] !== MAT_PROP) continue;
    const o = b * 6;
    const dx = (x < g.box[o] ? g.box[o] - x : x > g.box[o + 3] ? x - g.box[o + 3] : 0) * CELL;
    const dz = (z < g.box[o + 2] ? g.box[o + 2] - z : z > g.box[o + 5] ? z - g.box[o + 5] : 0) * CELL;
    const dy = y < g.box[o + 1] ? g.box[o + 1] - y : y > g.box[o + 4] ? y - g.box[o + 4] : 0;
    if (dx * dx + dy * dy + dz * dz < r * r) return true;
  }
  return false;
}
const isHit = (k: number): boolean =>
  k === HIT_WALL || k === HIT_BOX_SIDE || k === HIT_FLOOR || k === HIT_CEIL || k === HIT_BOX_TOP || k === HIT_BOX_BOTTOM;

export function computeProbes(job: BakeJob, withDyn = false, farR = 0): ProbeSet {
  const g = job.g, n = g.n;
  const N = PROBE_N, off = PROBE_OFF;
  const count = N * N * 3;
  const far = farR > 0;
  const P: ProbeSet = {
    n: N, off, sh: new Float32Array(count * 12), cube: new Float32Array(count * 18), rho: new Float32Array(count * 3), valid: new Uint8Array(count),
    dyn: withDyn ? new Float32Array(count * 24) : null,
    farSh: far ? new Float32Array(count * 12) : null, farCube: far ? new Float32Array(count * 18) : null,
  };
  const nRays = job.q.probeRays;
  const dirs = fibonacciDirs(nRays);
  const len = LIGHT.PROBE_RAY_MAX;
  const norm = (4 * Math.PI) / nRays;
  const skipT = farR / len;
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
        const farP = far && propWithin(job, c, px, py, pz, group, farR); // (else far = full)
        if (farP) { facc.fill(0); fcub.fill(0); }
        if (withDyn) dcub.fill(0);
        let miss0 = 0, miss1 = 0, miss2 = 0, miss3 = 0, rhoR = 0, rhoG = 0, rhoB = 0, hits = 0;
        for (let r = 0; r < nRays; r++) {
          const bx = dirs[r * 3], by = dirs[r * 3 + 1], bz = dirs[r * 3 + 2];
          const dx = rotM[0] * bx + rotM[1] * by + rotM[2] * bz;
          const dy = rotM[3] * bx + rotM[4] * by + rotM[5] * bz;
          const dz = rotM[6] * bx + rotM[7] * by + rotM[8] * bz;
          // (far field: the same walk goes on past a prop box entered within farR, dda.ts traceHit2)
          if (farP) traceHit2(g, px, py, pz, dx * len / CELL, dy * len, dz * len / CELL, group, skipT);
          else traceHit(g, px, py, pz, dx * len / CELL, dy * len, dz * len / CELL, group);
          const s1 = Y1 * dy, s2 = Y1 * dz, s3 = Y1 * dx;
          dirX[r] = dx; dirY[r] = dy; dirZ[r] = dz; missR[r] = 0; farMiss[r] = 0;
          if (hit.kind === HIT_NONE) { miss0 += Y00; miss1 += s1; miss2 += s2; miss3 += s3; missR[r] = 1; farMiss[r] = 1; continue; }
          if (!isHit(hit.kind)) continue;
          const refar = farP && hit.kind >= HIT_BOX_TOP && hit.mat === MAT_PROP && hit.t < skipT;
          hitRadiance(job, hit, hit.t * len, rad);
          const rhoL = luma(rho3[0], rho3[1], rho3[2]);
          rhoR += rho3[0]; rhoG += rho3[1]; rhoB += rho3[2];
          hits++;
          if (withDyn) addDynCube(dx, dy, dz, pref.e, pref.o, rhoL * INV_PI);
          addSh(acc, rad, s1, s2, s3);
          addCube(dx, dy, dz, rad[0], rad[1], rad[2]);
          if (!farP) continue;
          if (refar) {
            if (hitFar.kind === HIT_NONE) { farMiss[r] = 1; continue; }
            if (!isHit(hitFar.kind)) continue;
            hitRadiance(job, hitFar, hitFar.t * len, rad);
          }
          addSh(facc, rad, s1, s2, s3);
          addCube(dx, dy, dz, rad[0], rad[1], rad[2], fcub);
        }
        if (hits > 0) { rhoR /= hits; rhoG /= hits; rhoB /= hits; }
        else { albedoOf(g.floorMat[c], false, rho3); rhoR = rho3[0]; rhoG = rho3[1]; rhoB = rho3[2]; }
        let anyMiss = miss0 !== 0;
        if (farP && !anyMiss) for (let r = 0; r < nRays && !anyMiss; r++) anyMiss = farMiss[r] !== 0;
        if (!tower && anyMiss) {
          // tile-independent ambient for misses: rho_probe * E_cell / pi (coarse floor patch of the own cell)
          const fy = g.blockTop[c] > g.floor[c] ? g.blockTop[c] : g.floor[c];
          patchE(job, PK_FLOOR, c, hi + 0.5, fy, hj + 0.5, 0, false);
          const e = pref.e, o = pref.o;
          const ar = rhoR * e[o] * INV_PI, ag = rhoG * e[o + 1] * INV_PI, ab = rhoB * e[o + 2] * INV_PI;
          acc[0] += ar * miss0; acc[1] += ar * miss1; acc[2] += ar * miss2; acc[3] += ar * miss3;
          acc[4] += ag * miss0; acc[5] += ag * miss1; acc[6] += ag * miss2; acc[7] += ag * miss3;
          acc[8] += ab * miss0; acc[9] += ab * miss1; acc[10] += ab * miss2; acc[11] += ab * miss3;
          for (let r = 0; r < nRays; r++) if (missR[r] !== 0) addCube(dirX[r], dirY[r], dirZ[r], ar, ag, ab);
          if (withDyn) {
            const rhoP = luma(rhoR, rhoG, rhoB);
            for (let r = 0; r < nRays; r++) if (missR[r] !== 0) addDynCube(dirX[r], dirY[r], dirZ[r], e, o, rhoP * INV_PI);
          }
          if (farP) { // (the far field's misses: the same ambient)
            amb3[0] = ar; amb3[1] = ag; amb3[2] = ab;
            for (let r = 0; r < nRays; r++) {
              if (farMiss[r] === 0) continue;
              addSh(facc, amb3, Y1 * dirY[r], Y1 * dirZ[r], Y1 * dirX[r]);
              addCube(dirX[r], dirY[r], dirZ[r], ar, ag, ab, fcub);
            }
          }
        }
        const so = pIdx * 12;
        for (let k = 0; k < 12; k++) P.sh[so + k] = acc[k] * norm;
        for (let k = 0; k < 18; k++) P.cube[pIdx * 18 + k] = cub[k] * norm;
        if (P.farSh && P.farCube) {
          const fa = farP ? facc : acc, fc = farP ? fcub : cub;
          for (let k = 0; k < 12; k++) P.farSh[so + k] = fa[k] * norm;
          for (let k = 0; k < 18; k++) P.farCube[pIdx * 18 + k] = fc[k] * norm;
        }
        if (P.dyn) for (let k = 0; k < 24; k++) P.dyn[pIdx * 24 + k] = dcub[k] * norm;
        P.rho[pIdx * 3] = rhoR; P.rho[pIdx * 3 + 1] = rhoG; P.rho[pIdx * 3 + 2] = rhoB;
        P.valid[pIdx] = 1;
      }
    }
  }
  return P;
}
