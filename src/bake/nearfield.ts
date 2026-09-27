// src/bake/nearfield.ts — near-field final gather around prop occluder boxes (furniture, cars, racks, boxes). Pure
// module (scratch and the per-bake face cache are module state).
//
// The texel indirect is a per-cell probe (1.2 m spacing) interpolated to the texel, which cannot see a desk top
// 0.7 m above the floor or a car body 0.2 m above it. Receivers with a prop box (visgrid MAT_PROP: PROP_OCCLUDERS
// parts and whole-footprint props) within NEAR.R (the region, `nearWeight` > 0) trace short rays instead:
//   lightmap texels (`nearFieldAt`): N cosine-distributed rays of NEAR.R over the texel's hemisphere, from a
//     (0,2)-sequence (Sobol dimensions 1-2; every power-of-two prefix is stratified) Cranley-Patterson rotated by
//     the texel's quantized world position. Rays that leave the region or hit a wall / floor / ceiling keep the
//     probe's far field; rays that hit a prop box return that face's first-bounce radiance.
//     Solid boxes (pillars, slabs, trusses, stairs) stay far field: they keep the analytic box AO everywhere.
//     A prop face's radiance is rho * E / pi of its own world-anchored 0.3 m sub-patch (`propFaceRadiance`: K lights,
//     form factor and one visibility ray each, cached per bake), not the shell patch of the cell it stands in (a desk
//     side panel under the desk top is not lit like the partition wall behind it).
//     V  = sum over far-field rays of w_i / sum of w_i, w_i = the probe SH radiance (luma) along the ray (blocking
//          the bright ceiling costs more than blocking a dark wall), floored at W_MIN of the mean;
//     Vg = 1 - boxHits / N (geometric, for the specular occlusion in irr.a);
//     E  = pi / N * sum of the box radiances (RGB).
//   The estimator is E_ind = (E_cube(n) * V + E) * mb with the unchanged ambient cube and per-channel multi-bounce;
//   the whole full bake leaves out the analytic AO of prop boxes and the contact AO of footprints with boxes (ao.ts
//   skipProps). The correction is scaled by `nearWeight`, which fades it to 0 (V = 1, E = 0: the value outside the
//   region) over the region's outer NEAR.TAPER, so the region's edge is seamless.
//   light-volume samples (`nearSphereCorrect`): M sphere directions (Fibonacci, hash-rotated per sample), and a
//     delta-form SH correction D_c = (L_box,c - max(0, L_sh,c(w))) * 4 pi / M for every box hit.
// Every ray is exact halo arithmetic (translation invariant) and every pattern is seeded by world positions, so
// seam texels agree between tiles and the result does not depend on the BakeCache.

import { CELL, LIGHT } from '../core/constants.ts';
import { formFactor, rot, sampleRotation } from './areaLight.ts';
import { boxesAround, boxesAroundList } from './ao.ts';
import { FILTER_CELL, isTowerCell, selectLights } from './classify.ts';
import { worldQ, wq } from './context.ts';
import { HIT_BOX_BOTTOM, HIT_BOX_SIDE, HIT_BOX_TOP, hit, occluded, traceHit } from './dda.ts';
import type { BakeJob } from './job.ts';
import { albedoOf } from './probes.ts';
import { Y00, Y1, fibonacciDirs, hashRotation } from './sh.ts';
import { LB, LG, LR, quant, windowDist2, windowW } from './util.ts';
import { MAT_PROP } from './visgrid.ts';

export const NEAR = {
  /** ray length and region radius (m) */
  R: 1.2,
  /** radiance weight floor (fraction of the mean radiance) */
  W_MIN: 0.1,
  /** a box must rise this far in front of a lightmap receiver's plane to put it in the region (m) */
  FRONT: 0.05,
  /** outer band of the region (m) over which the traced correction fades out (`nearWeight`) */
  TAPER: 0.6,
  /** Cranley-Patterson rotation salt of the hemisphere pattern */
  SALT: 0x6e4f,
  /** hashRotation layer offset of the light-volume sphere pattern */
  LV_LAYER: 40,
} as const;

/** 32-point (0,2)-sequence: u = van der Corput over 5 bits, v = Sobol dimension 2 (direction numbers
 * 16, 24, 20, 30, 17 / 32). The first 16 points equal areaLight.ts SAMPLE_U / SAMPLE_V. */
export const NEAR_MAX = 32;
export const NU = new Float64Array(NEAR_MAX), NV = new Float64Array(NEAR_MAX);
{
  const m = [16, 24, 20, 30, 17];
  for (let i = 0; i < NEAR_MAX; i++) {
    let u = 0, v = 0;
    for (let b = 0; b < 5; b++) {
      if (((i >> b) & 1) === 0) continue;
      u += 16 >> b;
      v ^= m[b];
    }
    NU[i] = u / 32; NV[i] = v / 32;
  }
}

const R2 = NEAR.R * NEAR.R;
/** Receivers within this distance of a prop box may interpolate a traced 4x4-lattice corner (<= 3 texels away). */
export const NEAR_REACH = NEAR.R + 0.45;
const REACH2 = NEAR_REACH * NEAR_REACH;
/** Distance (m) to the nearest qualifying prop box of the last `nearWeight` call (Infinity beyond NEAR_REACH). */
export const nearDist = { d: Infinity };
const RC = NEAR.R / CELL; // ray length in halo cells (x/z)

/**
 * Near-field weight of (x, y, z) (halo cells / m) of owner cell c: 0 outside the region, else a smoothstep from 0
 * at NEAR.R to 1 at NEAR.R - NEAR.TAPER of the distance to the nearest prop box of `group` (for hemisphere
 * receivers, `hemi`, only boxes rising at least NEAR.FRONT in front of the plane of normal n). The traced correction
 * is scaled by it, so it fades out smoothly where the finite rays start to miss the box. Tower cells are never in
 * the region. Exact halo arithmetic on world boxes: seam texels decide identically in both tiles.
 */
export function nearWeight(job: BakeJob, c: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, group: number, hemi: boolean): number {
  const g = job.g;
  nearDist.d = Infinity;
  if (!(job.boxTop9[c] > -Infinity) || isTowerCell(job, c)) return 0; // (no box in the 3x3 cells)
  const at = boxesAround(job, c), bl = boxesAroundList();
  let d2min = REACH2;
  for (let k = at + 1, ke = at + 1 + bl[at]; k < ke; k++) {
    const b = bl[k];
    if (g.boxGroup[b] !== group || g.boxMat[b] !== MAT_PROP) continue;
    const o = b * 6;
    const x0 = g.box[o], y0 = g.box[o + 1], z0 = g.box[o + 2], x1 = g.box[o + 3], y1 = g.box[o + 4], z1 = g.box[o + 5];
    const dx = (x < x0 ? x0 - x : x > x1 ? x - x1 : 0) * CELL;
    const dz = (z < z0 ? z0 - z : z > z1 ? z - z1 : 0) * CELL;
    const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= d2min) continue;
    if (hemi) { // farthest box corner along n, relative to the receiver
      const fx = (nx > 0 ? x1 - x : x0 - x) * CELL, fy = ny > 0 ? y1 - y : y0 - y, fz = (nz > 0 ? z1 - z : z0 - z) * CELL;
      if (nx * fx + ny * fy + nz * fz <= NEAR.FRONT) continue;
    }
    d2min = d2;
  }
  if (d2min >= REACH2) return 0;
  const d = Math.sqrt(d2min);
  nearDist.d = d;
  if (d2min >= R2) return 0;
  const t = (NEAR.R - d) / NEAR.TAPER;
  return t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/** Is a receiver in the near-field region (`nearWeight` > 0)? */
export const nearRegion = (job: BakeJob, c: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, group: number, hemi: boolean): boolean =>
  nearWeight(job, c, x, y, z, nx, ny, nz, group, hemi) > 0;

/** Result of `nearFieldAt`: radiance-weighted far-field visibility, geometric visibility, box bounce (RGB lux). */
export const nearOut = { v: 1, vg: 1, e: new Float64Array(3), hits: 0 };

const rad = new Float64Array(3);

// ---------------------------------------------------------------- prop face radiance

/** Prop face sub-patch size (m) and the offset of its evaluation point off the face (m). */
const FACE_SUB = 0.3, FACE_OFF = 0.02;
/** Exact-polygon factor of the face sub-patches (as the shell patches). */
const FACE_EXACT = 1.5;
let faceJob: BakeJob | null = null;
const faceMap = new Map<number, number>();
let faceE = new Float32Array(3 * 256);
let faceN = 0;
const fsel = new Int32Array(LIGHT.K_MAX);
const rho3 = new Float64Array(3);

/**
 * Radiance (RGB, nits) of the prop face at the current `hit` (a HIT_BOX_* hit on a MAT_PROP box), written to out:
 * rho * E / pi with E the direct irradiance of the face's 0.3 m sub-patch (anchored at the box's min corner, so a pure
 * function of world geometry): the K_MAX strongest lights, each with its form factor, window and one DDA ray from
 * the sub-patch centre to the emitter centre. Cached per bake job.
 */
export function propFaceRadiance(job: BakeJob, out: Float64Array): void {
  if (faceJob !== job) { faceJob = job; faceMap.clear(); faceN = 0; }
  const g = job.g, b = hit.box, o = b * 6;
  const x0 = g.box[o], y0 = g.box[o + 1], z0 = g.box[o + 2], x1 = g.box[o + 3], y1 = g.box[o + 4], z1 = g.box[o + 5];
  // face: 0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z; (u, v) in metres from the face's min corner
  let face: number, u: number, v: number, lu: number, lv: number;
  if (hit.kind === HIT_BOX_TOP || hit.kind === HIT_BOX_BOTTOM) {
    face = hit.kind === HIT_BOX_TOP ? 2 : 3;
    u = (hit.x - x0) * CELL; v = (hit.z - z0) * CELL; lu = (x1 - x0) * CELL; lv = (z1 - z0) * CELL;
  } else if (hit.dir <= 1) {
    face = hit.dir;
    u = (hit.z - z0) * CELL; v = hit.y - y0; lu = (z1 - z0) * CELL; lv = y1 - y0;
  } else {
    face = hit.dir + 2;
    u = (hit.x - x0) * CELL; v = hit.y - y0; lu = (x1 - x0) * CELL; lv = y1 - y0;
  }
  const nu = Math.min(64, Math.max(1, Math.round(lu / FACE_SUB))), nv = Math.min(64, Math.max(1, Math.round(lv / FACE_SUB)));
  let iu = Math.floor((u / lu) * nu), iv = Math.floor((v / lv) * nv);
  iu = iu < 0 ? 0 : iu >= nu ? nu - 1 : iu; iv = iv < 0 ? 0 : iv >= nv ? nv - 1 : iv;
  const key = ((b * 6 + face) * 64 + iu) * 64 + iv;
  let at = faceMap.get(key);
  if (at === undefined) {
    at = faceN * 3;
    if (faceE.length < at + 3) { const e = new Float32Array(faceE.length * 2); e.set(faceE); faceE = e; }
    faceIrradiance(job, b, face, (iu + 0.5) * lu / nu, (iv + 0.5) * lv / nv, at);
    faceMap.set(key, at);
    faceN++;
  }
  albedoOf(MAT_PROP, false, rho3);
  out[0] = rho3[0] * faceE[at] / Math.PI; out[1] = rho3[1] * faceE[at + 1] / Math.PI; out[2] = rho3[2] * faceE[at + 2] / Math.PI;
}

/** Direct static irradiance of face `face` of box b at face coordinates (u, v) (m) into faceE[at..at + 2]. */
function faceIrradiance(job: BakeJob, b: number, face: number, u: number, v: number, at: number): void {
  const g = job.g, L = job.L, o = b * 6;
  const ax = face <= 1 ? 0 : face <= 3 ? 1 : 2; // normal axis
  const sgn = (face & 1) === 0 ? 1 : -1;
  let px: number, py: number, pz: number;
  const off = FACE_OFF * sgn;
  if (ax === 1) { px = g.box[o] + quant(u / CELL); pz = g.box[o + 2] + quant(v / CELL); py = (sgn > 0 ? g.box[o + 4] : g.box[o + 1]) + off; }
  else if (ax === 0) { px = (sgn > 0 ? g.box[o + 3] : g.box[o]) + quant(off / CELL); pz = g.box[o + 2] + quant(u / CELL); py = g.box[o + 1] + v; }
  else { px = g.box[o] + quant(u / CELL); pz = (sgn > 0 ? g.box[o + 5] : g.box[o + 2]) + quant(off / CELL); py = g.box[o + 1] + v; }
  const nx = ax === 0 ? sgn : 0, ny = ax === 1 ? sgn : 0, nz = ax === 2 ? sgn : 0;
  let er = 0, eg = 0, eb = 0;
  const n = g.n, ci = Math.floor(px), cj = Math.floor(pz);
  if (ci >= 0 && cj >= 0 && ci < n && cj < n) {
    const c = cj * n + ci, group = g.boxGroup[b];
    if (g.ddaGroup[c] === group) {
      const m = selectLights(job, px, py, pz, nx, ny, nz, c, group, FACE_SUB * 0.5, FILTER_CELL, fsel);
      for (let q = 0; q < m; q++) {
        const l = fsel[q], lo = l * 3;
        const w = windowW(windowDist2((L.pos[lo] - px) * CELL, L.pos[lo + 1] - py, (L.pos[lo + 2] - pz) * CELL, L.hAllow[l]), L.invR2[l]);
        if (w <= 0) continue;
        const f = formFactor(L, l, px, py, pz, nx, ny, nz, FACE_EXACT);
        if (f <= 0) continue;
        if (occluded(g, px, py, pz, L.vis[lo], L.vis[lo + 1], L.vis[lo + 2], group, false)) continue;
        const k = f * w;
        er += k * L.rad[lo]; eg += k * L.rad[lo + 1]; eb += k * L.rad[lo + 2];
      }
    }
  }
  faceE[at] = er; faceE[at + 1] = eg; faceE[at + 2] = eb;
}

/**
 * Near-field gather of a lightmap texel at (x, y, z) (halo cells / m), unit normal n: `rays` (<= 32) cosine rays
 * of NEAR.R weighted by the interpolated probe SH-L1 `sh` (12 floats, sh.ts order), the correction scaled by the
 * texel's `nearWeight` w. Result in `nearOut`.
 */
export function nearFieldAt(job: BakeJob, x: number, y: number, z: number, nx: number, ny: number, nz: number, group: number, rays: number, sh: Float64Array, w: number): void {
  const N = rays < NEAR_MAX ? rays : NEAR_MAX;
  const g = job.g;
  worldQ(job, x, y, z, false);
  sampleRotation(wq.x, wq.y, wq.z, NEAR.SALT);
  const ru = rot.u, rv = rot.v;
  // tangent frame: t = normalize(up x n) (x axis x n for near-vertical normals), b = n x t
  let tx: number, ty: number, tz: number;
  if (ny < 0.9 && ny > -0.9) { tx = nz; ty = 0; tz = -nx; } else { tx = 0; ty = -nz; tz = ny; }
  const tl = 1 / Math.sqrt(tx * tx + ty * ty + tz * tz);
  tx *= tl; ty *= tl; tz *= tl;
  const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
  // luminance SH
  const l0 = LR * sh[0] + LG * sh[4] + LB * sh[8];
  const l1 = LR * sh[1] + LG * sh[5] + LB * sh[9];
  const l2 = LR * sh[2] + LG * sh[6] + LB * sh[10];
  const l3 = LR * sh[3] + LG * sh[7] + LB * sh[11];
  const wMin = NEAR.W_MIN * Y00 * (l0 > 0 ? l0 : 0);
  let wv = 0, wa = 0, er = 0, eg = 0, eb = 0, nb = 0;
  for (let i = 0; i < N; i++) {
    let u = NU[i] + ru; if (u >= 1) u -= 1;
    let v = NV[i] + rv; if (v >= 1) v -= 1;
    const st = Math.sqrt(u), ct = Math.sqrt(1 - u), ph = 2 * Math.PI * v;
    const lx = st * Math.cos(ph), ly = st * Math.sin(ph);
    const wx = tx * lx + bx * ly + nx * ct, wy = ty * lx + by * ly + ny * ct, wz = tz * lx + bz * ly + nz * ct;
    let lw = Y00 * l0 + Y1 * (l1 * wy + l2 * wz + l3 * wx);
    if (lw < wMin) lw = wMin;
    wa += lw;
    traceHit(g, x, y, z, wx * RC, wy * NEAR.R, wz * RC, group);
    const k = hit.kind;
    if ((k === HIT_BOX_TOP || k === HIT_BOX_SIDE || k === HIT_BOX_BOTTOM) && hit.mat === MAT_PROP) {
      propFaceRadiance(job, rad);
      er += rad[0]; eg += rad[1]; eb += rad[2];
      nb++;
    } else wv += lw;
  }
  const s = (Math.PI / N) * w;
  nearOut.e[0] = er * s; nearOut.e[1] = eg * s; nearOut.e[2] = eb * s;
  const vg = 1 - nb / N;
  nearOut.vg = 1 + w * (vg - 1);
  nearOut.v = 1 + w * ((wa > 0 ? wv / wa : vg) - 1);
  nearOut.hits = nb;
}

const rotM = new Float64Array(9);
const sh0 = new Float64Array(12);

/**
 * Near-field correction of a light-volume sample's SH-L1 (12 floats, radiance, modified in place): M (<= 512)
 * Fibonacci directions rotated per sample (quantized world sample position, `layer` = LV y index), traced over
 * NEAR.R; every prop box hit replaces the SH radiance of its direction by the box face's radiance (delta form, so
 * with no hit the SH is untouched), scaled by the sample's `nearWeight` w. Returns the box-hit fraction x w.
 */
export function nearSphereCorrect(job: BakeJob, x: number, y: number, z: number, group: number, M: number, layer: number, sh: Float64Array, w: number): number {
  const g = job.g;
  const dirs = fibonacciDirs(M);
  // world sample indices (LV.STEP = CELL / 2: two per cell); the hash keeps the pattern tile-independent
  hashRotation(Math.round((g.gi0 + x) * 2 - 0.5), Math.round((g.gj0 + z) * 2 - 0.5), NEAR.LV_LAYER + layer, rotM);
  const k4 = ((4 * Math.PI) / M) * w;
  for (let j = 0; j < 12; j++) sh0[j] = sh[j]; // (the far field each hit replaces: the uncorrected SH)
  let hits = 0;
  for (let r = 0; r < M; r++) {
    const ax = dirs[r * 3], ay = dirs[r * 3 + 1], az = dirs[r * 3 + 2];
    const wx = rotM[0] * ax + rotM[1] * ay + rotM[2] * az;
    const wy = rotM[3] * ax + rotM[4] * ay + rotM[5] * az;
    const wz = rotM[6] * ax + rotM[7] * ay + rotM[8] * az;
    traceHit(g, x, y, z, wx * RC, wy * NEAR.R, wz * RC, group);
    const k = hit.kind;
    if ((k !== HIT_BOX_TOP && k !== HIT_BOX_SIDE && k !== HIT_BOX_BOTTOM) || hit.mat !== MAT_PROP) continue;
    propFaceRadiance(job, rad);
    hits++;
    const s1 = Y1 * wy, s2 = Y1 * wz, s3 = Y1 * wx;
    for (let ch = 0; ch < 3; ch++) {
      const o = ch * 4;
      let ls = sh0[o] * Y00 + sh0[o + 1] * s1 + sh0[o + 2] * s2 + sh0[o + 3] * s3;
      if (ls < 0) ls = 0;
      const d = (rad[ch] - ls) * k4;
      sh[o] += d * Y00; sh[o + 1] += d * s1; sh[o + 2] += d * s2; sh[o + 3] += d * s3;
    }
  }
  return (hits / M) * w;
}
