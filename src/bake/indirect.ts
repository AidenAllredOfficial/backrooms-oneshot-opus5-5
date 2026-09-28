// src/bake/indirect.ts — texel / light-volume indirect irradiance from the probe grid (WP7 §Algorithms 6).
// Pure module.
//
// Bilinear interpolation of the 4 neighbouring cells' probes (probe = cell centre), weight 0 across an edge that
// occludes at the probe height, across different rooms (room ids are chunk-local, so across a chunk line the edge
// test decides alone), across floor steps > 0.5 m unless both probes (the owner's layer and the neighbour's, each at
// its own cell's height) lie STEP_CLEAR m above the higher floor (there the air over both cells is one: the ceiling
// over a pool took the pool's probes alone and drew its outline as a hard-edged rectangle; a deck's mid layer must not
// take a pit's, which lies at the pit's own mid height), and for invalid probes; renormalised. Diagonal neighbours need
// one open L-shaped path. Linear interpolation between the height layers (tower cells: periodic in y with the
// fundamental-period layers). Irradiance from the probes' ambient cube at the texel normal (SH-L1 rings for
// strongly directional fields; the light volume keeps SH-L1 for its direction), then multi-bounce per colour
// channel, E_c /= (1 - min(0.6, 0.55 * rho_c)) with rho the probe-weighted RGB albedo of the probes' own hits: each
// extra bounce is tinted by the surroundings again, so enclosed coloured rooms keep (and deepen) their colour in
// the shadows. The dynamic (luminance) channels use the luma of rho.
// The first-order normal response (TL2): the probes' hemisphere tangential moments (probes.ts ProbeSet.mom) are
// interpolated like the cube, and indirectAt turns them into the texel's indirect gradient `indirectOut.g` (world,
// luma, with the luma multi-bounce): d E_ind / d theta for the normal tilted toward each tangent. bake/index.ts stores
// it per texel so the shader's normal maps shade the indirect light (ceilings, whose w is 0, had no relief at all).

import { CELL } from '../core/constants.ts';
import { EDGE_OCCLUDES, edgeOccludesAt } from '../core/edges.ts';
import { CellFlag } from '../core/ids.ts';
import type { BakeJob } from './job.ts';
import type { ProbeSet } from './probes.ts';
import { luma } from './util.ts';
import type { VisGrid } from './visgrid.ts';

/** Interpolated SH (12), ambient cube (18), dynamic channel cubes (24, when the ProbeSet has them) and RGB rho of
 * the last `interpolateProbes` call (farSh / farCube / farDcube: scratch of the probes' far field, see `farW`). */
export const interp = {
  sh: new Float64Array(12), cube: new Float64Array(18), dcube: new Float64Array(24), rho3: new Float64Array(3), w: 0,
  farSh: new Float64Array(12), farCube: new Float64Array(18), farDcube: new Float64Array(24),
  /** hemisphere tangential moments (ProbeSet.mom layout; with the cube, when the ProbeSet has them) */
  mom: new Float64Array(12), farMom: new Float64Array(12),
};

/** Multi-bounce gain of one channel's (or the luma) probe albedo. */
export const multiBounce = (rho: number): number => 1 / (1 - Math.min(0.6, 0.55 * rho));

const exOcc = (g: VisGrid, X: number, row: number, t: number, y: number): boolean => {
  const e = row * (g.n + 1) + X;
  const k = g.exKind[e];
  return k !== 0 && EDGE_OCCLUDES[k] && edgeOccludesAt(k, g.exA[e], g.exB[e], t, y, g.exSill[e]);
};
const ezOcc = (g: VisGrid, Z: number, col: number, t: number, y: number): boolean => {
  const e = Z * g.n + col;
  const k = g.ezKind[e];
  return k !== 0 && EDGE_OCCLUDES[k] && edgeOccludesAt(k, g.ezA[e], g.ezB[e], t, y, g.ezSill[e]);
};

/** A floor step > 0.5 m separates the probes of its two cells only below this height (m) over the higher floor. */
export const STEP_CLEAR = 1;

/** Can probe interpolation connect cell a to its 4-neighbour b at height y (t = metres along the edge)? ys: the height
 * for the floor-step test (default y; probe links pass the lower of the two probes' heights). */
function link4(g: VisGrid, a: number, b: number, y: number, t: number, ys = y): boolean {
  const n = g.n;
  if ((g.flags[b] & CellFlag.SOLID) !== 0) return false;
  const fa = g.floor[a], fb = g.floor[b];
  if (Math.abs(fa - fb) > 0.5 && ys < (fa > fb ? fa : fb) + STEP_CLEAR) return false;
  if (g.room[a] !== g.room[b] && g.slot[a] === g.slot[b]) return false;
  if (g.group[a] !== g.group[b]) return false;
  const ai = a % n, aj = (a - ai) / n, bi = b % n, bj = (b - bi) / n;
  if (aj === bj) return !exOcc(g, ai > bi ? ai : bi, aj, t, y);
  return !ezOcc(g, aj > bj ? aj : bj, ai, t, y);
}

/** tEx / tEz: metres along the owner's ex (x-line) / ez (z-line) edges at the sample position; ys: see link4. */
function linked(g: VisGrid, a: number, b: number, y: number, tEx: number, tEz: number, ys = y): boolean {
  if (a === b) return true;
  const n = g.n;
  const ai = a % n, aj = (a - ai) / n, bi = b % n, bj = (b - bi) / n;
  if (aj === bj) return link4(g, a, b, y, tEx, ys); // same row: crossing an x-line
  if (ai === bi) return link4(g, a, b, y, tEz, ys); // same column: crossing a z-line
  const m1 = aj * n + bi, m2 = bj * n + ai; // L-paths via (bi, aj) and (ai, bj)
  const half = CELL / 2;
  return (link4(g, a, m1, y, half, ys) && link4(g, m1, b, y, half, ys)) || (link4(g, a, m2, y, half, ys) && link4(g, m2, b, y, half, ys));
}

/** Can a smooth field at (x, y, z) (halo cells / m) of owner cell a be interpolated with cell b's (probe links:
 * same room / group, no occluding edge between at y, floor steps <= 0.5 m or y STEP_CLEAR above the higher floor,
 * diagonals through an open L-path)? */
export function cellsLinked(g: VisGrid, a: number, b: number, x: number, y: number, z: number): boolean {
  const hi = a % g.n, hj = (a - hi) / g.n;
  return linked(g, a, b, y, clampT((z - hj) * CELL), clampT((x - hi) * CELL));
}

const cw = new Float64Array(4);
const cp = new Int32Array(4);

/** What `interpolateProbes` accumulates: the SH (light volume) and / or the ambient cube (texels), and the far
 * field of both (near-field receivers). */
let wantSh = true, wantCube = true, wantFar = false;

/** Horizontal interpolation at one layer; adds weight * SH into interp (scaled by `lw`). Returns false if empty. */
function horizontal(job: BakeJob, P: ProbeSet, x: number, z: number, c: number, layer: number, lw: number): boolean {
  const g = job.g, n = g.n;
  const fx = x - 0.5, fz = z - 0.5;
  const i0 = Math.floor(fx), j0 = Math.floor(fz);
  const tx = fx - i0, tz = fz - j0;
  const y = job.cellH[c * 3 + layer];
  const hi = c % n, hj = (c - hi) / n;
  const alongX = (z - hj) * CELL, alongZ = (x - hi) * CELL; // metres along ex / ez edges of the owner cell
  let wsum = 0, cnt = 0;
  for (let b = 0; b < 2; b++) {
    for (let a = 0; a < 2; a++) {
      const w = (a ? tx : 1 - tx) * (b ? tz : 1 - tz);
      if (w <= 0) continue;
      const pi = i0 + a - P.off, pj = j0 + b - P.off;
      if (pi < 0 || pj < 0 || pi >= P.n || pj >= P.n) continue;
      const pc = (j0 + b) * n + (i0 + a);
      const pIdx = (pj * P.n + pi) * 3 + layer;
      if (P.valid[pIdx] === 0) continue;
      // across a floor step both probes must lie in the shared air: the neighbour's layer sits at its own cell's height
      const yb = job.cellH[pc * 3 + layer];
      if (!linked(g, c, pc, y, clampT(alongX), clampT(alongZ), yb < y ? yb : y)) continue;
      cw[cnt] = w; cp[cnt] = pIdx; cnt++;
      wsum += w;
    }
  }
  if (wsum <= 0) {
    // fall back to the owner cell's own probe
    const pi = hi - P.off, pj = hj - P.off;
    if (pi < 0 || pj < 0 || pi >= P.n || pj >= P.n) return false;
    const pIdx = (pj * P.n + pi) * 3 + layer;
    if (P.valid[pIdx] === 0) return false;
    cw[0] = 1; cp[0] = pIdx; cnt = 1; wsum = 1;
  }
  const s = lw / wsum;
  for (let k = 0; k < cnt; k++) {
    const f = cw[k] * s;
    if (wantSh) { const o = cp[k] * 12; for (let j = 0; j < 12; j++) interp.sh[j] += f * P.sh[o + j]; }
    if (wantCube) { const oc = cp[k] * 18; for (let j = 0; j < 18; j++) interp.cube[j] += f * P.cube[oc + j]; }
    if (wantCube && P.mom) { const om = cp[k] * 12, m = P.mom; for (let j = 0; j < 12; j++) interp.mom[j] += f * m[om + j]; }
    if (wantFar && wantCube && P.farMom) { const om = cp[k] * 12, m = P.farMom; for (let j = 0; j < 12; j++) interp.farMom[j] += f * m[om + j]; }
    if (wantFar && P.farSh && P.farCube) {
      const o = cp[k] * 12, oc = cp[k] * 18, fs = P.farSh, fc = P.farCube;
      if (wantSh) for (let j = 0; j < 12; j++) interp.farSh[j] += f * fs[o + j];
      if (wantCube) for (let j = 0; j < 18; j++) interp.farCube[j] += f * fc[oc + j];
    }
    if (P.dyn) { const od = cp[k] * 24, d = P.dyn; for (let j = 0; j < 24; j++) interp.dcube[j] += f * d[od + j]; }
    if (wantFar && P.farDyn) { const od = cp[k] * 24, d = P.farDyn; for (let j = 0; j < 24; j++) interp.farDcube[j] += f * d[od + j]; }
    const r = interp.rho3, o3 = cp[k] * 3;
    r[0] += f * P.rho[o3]; r[1] += f * P.rho[o3 + 1]; r[2] += f * P.rho[o3 + 2];
  }
  interp.w += lw;
  return true;
}

const clampT = (t: number): number => (t < 0.02 ? 0.02 : t > CELL - 0.02 ? CELL - 0.02 : t);

/** Interpolate the probe SH (`sh`) and / or ambient cube (`cube`) at (x, y, z) (halo cells / m) owned by cell c
 * into `interp` (the other one is left zero). `farW` > 0 (a near-field receiver's nearWeight, when the ProbeSet has
 * the far field): the result (dynamic cubes included) blends towards the probes' far field (prop boxes next to the
 * probe transparent) by farW. Returns false if none. */
export function interpolateProbes(job: BakeJob, P: ProbeSet, x: number, y: number, z: number, c: number, sh = true, cube = true, farW = 0): boolean {
  interp.sh.fill(0); interp.cube.fill(0); interp.dcube.fill(0); interp.rho3.fill(0); interp.mom.fill(0); interp.w = 0;
  wantSh = sh; wantCube = cube; wantFar = farW > 0 && P.farSh !== null;
  if (wantFar) { interp.farSh.fill(0); interp.farCube.fill(0); interp.farDcube.fill(0); interp.farMom.fill(0); }
  const g = job.g;
  const h = job.cellH;
  const h0 = h[c * 3], h1 = h[c * 3 + 1], h2 = h[c * 3 + 2];
  let la: number, lb: number, t: number;
  if ((g.flags[c] & CellFlag.TOWER) !== 0 && g.group[c] !== 0) {
    const yw = y - 3 * Math.floor((y + 1.5) / 3); // [-1.5, 1.5)
    if (yw < h0) { la = 2; lb = 0; t = (yw - (h2 - 3)) / (h0 - (h2 - 3)); }
    else if (yw < h1) { la = 0; lb = 1; t = (yw - h0) / (h1 - h0); }
    else if (yw < h2) { la = 1; lb = 2; t = (yw - h1) / (h2 - h1); }
    else { la = 2; lb = 0; t = (yw - h2) / (h0 + 3 - h2); }
  } else if (y <= h0) { la = 0; lb = 0; t = 0; }
  else if (y >= h2) { la = 2; lb = 2; t = 0; }
  else if (y < h1) { la = 0; lb = 1; t = (y - h0) / (h1 - h0 || 1); }
  else { la = 1; lb = 2; t = (y - h1) / (h2 - h1 || 1); }
  let ok = false;
  if (la === lb || t <= 0) ok = horizontal(job, P, x, z, c, la, 1);
  else if (t >= 1) ok = horizontal(job, P, x, z, c, lb, 1);
  else {
    const a = horizontal(job, P, x, z, c, la, 1 - t);
    const b = horizontal(job, P, x, z, c, lb, t);
    ok = a || b;
  }
  if (!ok) {
    for (let k = 0; k < 3 && !ok; k++) ok = horizontal(job, P, x, z, c, k, 1);
  }
  if (!ok || interp.w <= 0) return false;
  if (interp.w !== 1) {
    const s = 1 / interp.w;
    for (let j = 0; j < 12; j++) interp.sh[j] *= s;
    for (let j = 0; j < 18; j++) interp.cube[j] *= s;
    for (let j = 0; j < 24; j++) interp.dcube[j] *= s;
    for (let j = 0; j < 12; j++) interp.mom[j] *= s;
    interp.rho3[0] *= s; interp.rho3[1] *= s; interp.rho3[2] *= s;
    if (wantFar) {
      for (let j = 0; j < 12; j++) interp.farSh[j] *= s;
      for (let j = 0; j < 18; j++) interp.farCube[j] *= s;
      for (let j = 0; j < 24; j++) interp.farDcube[j] *= s;
      for (let j = 0; j < 12; j++) interp.farMom[j] *= s;
    }
    interp.w = 1;
  }
  if (wantFar) {
    const fw = farW > 1 ? 1 : farW;
    for (let j = 0; j < 12; j++) interp.sh[j] += fw * (interp.farSh[j] - interp.sh[j]);
    for (let j = 0; j < 18; j++) interp.cube[j] += fw * (interp.farCube[j] - interp.cube[j]);
    if (P.farDyn) for (let j = 0; j < 24; j++) interp.dcube[j] += fw * (interp.farDcube[j] - interp.dcube[j]);
    if (P.farMom) for (let j = 0; j < 12; j++) interp.mom[j] += fw * (interp.farMom[j] - interp.mom[j]);
  }
  return true;
}

/** Bounced dynamic luminance (lux, per flicker channel, with multi-bounce) of the last `indirectAt` call; all zero
 * when the ProbeSet has no dynamic cubes. The caller applies AO and the channel light's window. */
export const dynIndirect = new Float64Array(4);

/** Per-channel multi-bounce gains (RGB, then the luma gain of the dynamic channels) of the last `indirectAt` call
 * (0 when no probe was found), and its indirect gradient g (world, luma lux per radian, with the luma gain; the caller
 * applies AO): see indirectGradient. */
export const indirectOut = { mb: new Float64Array(3), mbL: 0, g: new Float64Array(3) };

const lumaAt = (cb: Float64Array, o: number): number => luma(cb[o], cb[o + 1], cb[o + 2]);

/**
 * First-order normal response of the indirect irradiance at a receiver with unit normal n, from interpolated hemisphere
 * moments `mom` (ProbeSet.mom layout) and ambient cube `cube`; writes out[0..2] (world, same units as the cube's luma).
 * The receiver's hemisphere first moment m(n) = integral over omega . n > 0 of Y(omega) omega is blended from the axis
 * hemispheres like the cube (weights n_a^2): each one's normal component is its cube lobe (the cosine-weighted
 * irradiance), its tangential components the stored moments. g = m - (m . n) n: for a normal tilted by a small angle
 * theta toward a unit tangent t, E(n') = E(n) + theta (g . t), exact for the axis-aligned shell.
 */
export function indirectGradient(mom: Float64Array, cube: Float64Array, nx: number, ny: number, nz: number, out: Float64Array): void {
  const wx = nx * nx, wy = ny * ny, wz = nz * nz;
  const hx = nx > 0 ? 0 : 1, hy = ny > 0 ? 2 : 3, hz = nz > 0 ? 4 : 5; // hemisphere of each axis (cube lobe index)
  const sx = nx > 0 ? 1 : -1, sy = ny > 0 ? 1 : -1, sz = nz > 0 ? 1 : -1;
  // hemisphere h: normal component s * C(h); tangents (x, y, z order skipping its axis) at mom[h * 2], mom[h * 2 + 1]
  const mx = wx * sx * lumaAt(cube, hx * 3) + wy * mom[hy * 2] + wz * mom[hz * 2];
  const my = wx * mom[hx * 2] + wy * sy * lumaAt(cube, hy * 3) + wz * mom[hz * 2 + 1];
  const mz = wx * mom[hx * 2 + 1] + wy * mom[hy * 2 + 1] + wz * sz * lumaAt(cube, hz * 3);
  const d = mx * nx + my * ny + mz * nz;
  out[0] = mx - d * nx; out[1] = my - d * ny; out[2] = mz - d * nz;
}

/** Indirect irradiance (RGB, lux, with multi-bounce) at a texel; writes out[0..2] (and `dynIndirect`,
 * `indirectOut`). `keepSh`: also interpolate the probe SH (left in `interp.sh`, for the near-field gather); `farW`:
 * the texel's nearWeight (blend towards the probes' far field, see interpolateProbes). */
export function indirectAt(job: BakeJob, P: ProbeSet, x: number, y: number, z: number, nx: number, ny: number, nz: number, c: number, out: Float64Array, keepSh = false, farW = 0): void {
  dynIndirect.fill(0);
  const mbo = indirectOut.mb, go = indirectOut.g;
  go.fill(0);
  if (!interpolateProbes(job, P, x, y, z, c, keepSh, true, farW)) { out[0] = 0; out[1] = 0; out[2] = 0; mbo.fill(0); indirectOut.mbL = 0; return; }
  const rho = interp.rho3;
  const m0 = multiBounce(rho[0]), m1 = multiBounce(rho[1]), m2 = multiBounce(rho[2]);
  mbo[0] = m0; mbo[1] = m1; mbo[2] = m2;
  const mb = multiBounce(luma(rho[0], rho[1], rho[2]));
  indirectOut.mbL = mb;
  // ambient cube: E(n) = sum over axes of n_a^2 * E(sign of n_a); exact for the axis-aligned shell surfaces
  const cb = interp.cube;
  const wx = nx * nx, wy = ny * ny, wz = nz * nz;
  const ox = nx > 0 ? 0 : 3, oy = ny > 0 ? 6 : 9, oz = nz > 0 ? 12 : 15;
  out[0] = (wx * cb[ox] + wy * cb[oy] + wz * cb[oz]) * m0;
  out[1] = (wx * cb[ox + 1] + wy * cb[oy + 1] + wz * cb[oz + 1]) * m1;
  out[2] = (wx * cb[ox + 2] + wy * cb[oy + 2] + wz * cb[oz + 2]) * m2;
  if (P.mom) {
    indirectGradient(interp.mom, cb, nx, ny, nz, go);
    go[0] *= mb; go[1] *= mb; go[2] *= mb;
  }
  if (P.dyn) {
    const d = interp.dcube;
    const ax = nx > 0 ? 0 : 1, ay = ny > 0 ? 2 : 3, az = nz > 0 ? 4 : 5;
    for (let ch = 0; ch < 4; ch++) {
      const b = ch * 6;
      dynIndirect[ch] = (wx * d[b + ax] + wy * d[b + ay] + wz * d[b + az]) * mb;
    }
  }
}

/** Direction-averaged (L0) bounced dynamic luminance per channel of the last `interpolateProbes` call (light
 * volume samples), with multi-bounce; writes out[0..3]. */
export function dynIndirectL0(out: Float64Array): void {
  const d = interp.dcube;
  const mb = multiBounce(luma(interp.rho3[0], interp.rho3[1], interp.rho3[2]));
  for (let ch = 0; ch < 4; ch++) {
    const b = ch * 6;
    out[ch] = ((d[b] + d[b + 1] + d[b + 2] + d[b + 3] + d[b + 4] + d[b + 5]) / 6) * mb;
  }
}
