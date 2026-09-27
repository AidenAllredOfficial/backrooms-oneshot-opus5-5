// src/bake/direct.ts — direct lighting of lightmap texels, full variant (WP7 §Algorithms 5) and the preview
// variant's direct term (§Algorithms 7). Pure module.
//
// Full: per receiver patch (texels of one chart in one owner cell / height band), the K_MAX static lights (+ every
// dynamic light of the group in range) are classified FULL / NONE / PARTIAL (classify.ts: bitset early-outs, then the
// ray-free beam proof of beam.ts over the patch's texel box, then segment tests). FULL -> form factor per
// texel, no rays; NONE -> skipped; PARTIAL -> the patch is split into 4x4-texel sub-blocks whose 4 corner texels
// are shadow-sampled (q.shadowSamples stratified emitter points, (0,2)-sequence, Cranley–Patterson rotated per texel by a
// hash of its quantized world position): all lit -> FULL, all dark -> NONE, a smooth penumbra (corner spread <= 0.5)
// -> bilinear visibility, otherwise per-texel shadow samples. Weak lights (< 5% of the receiver's estimate) classify
// their sub-blocks with ONE ray per corner texel to the emitter centre (5 per incomplete sub-block) and use the
// sub-block's mean visibility where the corners disagree (60% of the sub-block work in OFFICE tiles went to such
// lights at 16-20 rays each; the error against per-texel shadow rays is unchanged). Shadow fractions of the
// current patch are memoized per (texel, light), so sub-block corners evaluated again per texel cost no rays. Texels shared with a neighbouring tile (chart ends with `cont`) skip these patch-
// dependent shortcuts and use the tile-independent bitset classes + per-texel shadow samples (seam-exact).
// Adaptive 2x2 refinement: lattice texels (world-aligned on grid charts) are evaluated, the others are interpolated
// from their lattice neighbours when those agree within 2% (static and dynamic parts decided separately).
// Window (1 - (d/R)^4)^2 on every light; the K_MAX tail (classify.ts tailSum) is added per patch.
// Outputs per texel: static E (RGB lux), the direction accumulator V = sum E_l * w_l (luminance weighted) and
// the dynamic channel luminance flick[c] (Rec.709 luma of the RGB irradiance). Two dynamic lights of one channel
// reaching the same receiver throw (generation guarantees it never happens).
//
// Preview: the same selection, visibility classes from the bitset only: the owner cell does not see the light at
// the nearest bit height -> 0; all 9 cells see it there -> 1; otherwise 0.5 + 0.5 * (seeing cells / 9) (cached per
// patch and bit). Evaluated on 2x2 texel blocks (world-aligned on grid charts) and replicated. Tower receivers and
// cells next to occluder boxes (sub-cell furniture shadows the cell-centre bitset cannot see) use one DDA ray per
// block instead.

import { CELL, LIGHT } from '../core/constants.ts';
import { EXACT_FULL, emitterSample, formFactor, ff, rot, SAMPLE_U, SAMPLE_V, sampleRotation, sp } from './areaLight.ts';
import { beamAdd, beamReset } from './beam.ts';
import {
  CLS_FRAC, CLS_FULL, CLS_INTERP, CLS_NONE, CLS_PARTIAL, FILTER_NONE, FILTER_UNION9, classifyPatch, isTowerCell, patchCorners, PATCH_PTS, patchNeed, bitsetClass, boxesBetween, lightHighY, lightLowY, selEst, selectDynamic, selectLights, tail, tailSum,
} from './classify.ts';
import type { SurfaceSet } from '../core/mesh.ts';
import { clampOut, clampSample, latNbr, latticeNeighbours, TX_VALID, type TexelSet, worldQ, wq } from './context.ts';
import { occluded, RAY_CLASSIFY, RAY_SHADOW, rayStats } from './dda.ts';
import { nearestBit, type BakeJob } from './job.ts';
import { SUN, SUN_RES } from './lights.ts';
import { HALO_OFF, INV_CELL, quant, windowDist2, windowW } from './util.ts';
import { visBits } from './visbits.ts';

export interface DirectResult {
  e: Float32Array; // 3 per texel: static direct irradiance (lux)
  v: Float32Array; // 3 per texel: sum of luminance-weighted light directions
  flick: Float32Array | null; // 4 per texel: dynamic channel luminance (lux)
  anyDynamic: boolean;
}

const sel = new Int32Array(LIGHT.K_MAX);
const cls = new Uint8Array(LIGHT.K_MAX);
const dsel = new Int32Array(16);
const dcls = new Uint8Array(16);
const pvis = new Float64Array(LIGHT.K_MAX);
const selEstP = new Float64Array(LIGHT.K_MAX);
const patchCls = new Uint8Array(LIGHT.K_MAX + 16);
const seamCls = new Uint8Array(LIGHT.K_MAX + 16);
const dvis = new Float64Array(16);
const val = new Float64Array(10);

/**
 * Per-patch memo of texel shadow fractions (full bake): memo[slot * memoStride + i] = shadowFraction of static light
 * sel[i] (i < m; dynamic light dsel[i - m] after them, DYN_SHADOW_SAMPLES) at the patch texel with list position
 * `slot`, -1 = not computed; wmemo[slot * m + i] = the weak-light centre visibility. Sub-block corners are evaluated
 * again per texel; both are pure functions of (texel, light) within the patch (the adaptive flag of a static light
 * is fixed per patch, `adaptL`), so the memo never changes a value (determinism, cache transparency and seam
 * exactness are unaffected).
 */
let memo = new Float32Array(1024);
let wmemo = new Float32Array(1024);
/** A static light whose unshadowed estimate is below this share of the patch's lights gets adaptive shadow samples
 * (shadowFraction `adapt`): the strong lights that draw the visible shadows keep every sample. */
export const ADAPT_SHARE = 0.15;
/** Per selected static light of the current patch: 1 = adaptive shadow samples (never at seam texels). */
const adaptL = new Uint8Array(LIGHT.K_MAX);
/** The texel evaluated by evalPoint is a seam texel (no adaptive samples: the neighbouring tile's patch differs). */
let curSeam = false;
let memoStride = 0;
/** List position (in the current patch) of the texel being evaluated by evalPoint, -1 = no memo. */
let memoSlot = -1;
function memoReset(np: number, m: number, md: number): void {
  memoStride = m + md;
  const need = np * memoStride;
  if (memo.length < need) memo = new Float32Array(2 * need);
  memo.fill(-1, 0, need);
  if (wmemo.length < np * m) wmemo = new Float32Array(2 * np * m);
  wmemo.fill(-1, 0, np * m);
}
/** Memoized shadow fraction of static light sel[i] (i < m) or dynamic light dsel[i - m] at patch texel t (list
 * position `slot`). */
function shadowMemo(job: BakeJob, T: TexelSet, i: number, m: number, t: number, slot: number, group: number): number {
  const k = slot * memoStride + i;
  let f = memo[k];
  if (f < 0) {
    f = i < m ? shadowFraction(job, sel[i], T.x[t], T.y[t], T.z[t], group, false, 0, adaptL[i] !== 0 && T.seam[t] === 0)
      : shadowFraction(job, dsel[i - m], T.x[t], T.y[t], T.z[t], group, false, DYN_SHADOW_SAMPLES);
    memo[k] = f;
  }
  return f;
}
/** Memoized weak-light centre visibility (centreVisible) of static light sel[i] at patch texel t. */
function centreMemo(job: BakeJob, T: TexelSet, i: number, m: number, t: number, slot: number, group: number): number {
  const k = slot * m + i;
  let f = wmemo[k];
  if (f < 0) { f = centreVisible(job, sel[i], t, T, group); wmemo[k] = f; }
  return f;
}

/** Weak lights (sub-block classification): binary visibility of the emitter centre from texel t (one ray). */
function centreVisible(job: BakeJob, l: number, t: number, T: TexelSet, group: number): number {
  const L = job.L, o = l * 3;
  rayStats.kind = RAY_SHADOW;
  const v = occluded(job.g, T.x[t], T.y[t], T.z[t], L.vis[o], L.vis[o + 1], L.vis[o + 2], group, true) ? 0 : 1;
  rayStats.kind = RAY_CLASSIFY;
  return v;
}
/** Weak lights on incomplete sub-blocks: visible fraction of the segments from the PATCH_PTS classification points
 * (in `patchCorners`) to the emitter centre. */
function centreFraction(job: BakeJob, l: number, group: number): number {
  const L = job.L, o = l * 3;
  let vis = 0;
  for (let k = 0; k < PATCH_PTS; k++) {
    if (!occluded(job.g, patchCorners[k * 3], patchCorners[k * 3 + 1], patchCorners[k * 3 + 2], L.vis[o], L.vis[o + 1], L.vis[o + 2], group, true)) vis++;
  }
  return vis / PATCH_PTS;
}

/** Shadow samples of a dynamic (flicker-channel) light (sub-block corners and PARTIAL texels). With q.shadowSamples
 * (4 at high) and no sub-block interpolation its penumbrae were white noise in 1/4 steps (blotchy walls next to
 * every flickering panel). At most one dynamic light reaches a receiver per channel, so the whole sample table
 * costs little. A pure function of the texel's world position (seam-exact). */
export const DYN_SHADOW_SAMPLES = 16;

/**
 * Shadow-sampled visibility fraction of light l from a texel (`samples` stratified emitter points, default
 * q.shadowSamples). `adapt`: when the first stratified quarter of them (the first 2 of 4 or 6, the first 4 of the
 * dynamic lights' 16: opposite quadrants of the emitter) agree, the texel is taken as fully lit / fully shadowed and
 * the rest are not cast. 83% of the WAREHOUSE shadow fractions were exactly 0 or 1 (rack decks and uprights cast
 * hard shadows through most sub-blocks); the misses are thin penumbra fringes, softened by the 3x3 shadow denoise.
 * Used for the dynamic lights and the static lights below ADAPT_SHARE of their patch (the error against a 16-sample
 * bake: mean 0.60% -> 0.65% OFFICE, 0.38% -> 0.42% WAREHOUSE; adaptive for every light: 0.81% / 0.53%). A pure
 * function of (texel, light, adapt).
 */
function shadowFraction(job: BakeJob, l: number, x: number, y: number, z: number, group: number, tower: boolean, samples = 0, adapt = true): number {
  const S = samples > 0 ? samples : job.q.shadowSamples;
  rayStats.kind = RAY_SHADOW;
  worldQ(job, x, y, z, tower);
  sampleRotation(wq.x, wq.y, wq.z, job.L.uid[l]);
  let vis = 0;
  const first = !adapt ? S : S >= 16 ? 4 : S >= 4 ? 2 : S;
  for (let i = 0; i < S; i++) {
    if (i === first && (vis === 0 || vis === first)) { rayStats.kind = RAY_CLASSIFY; return vis === 0 ? 0 : 1; }
    emitterSample(job.L, l, i, x, y, z);
    if (!occluded(job.g, x, y, z, sp.x, sp.y, sp.z, group, true)) vis++;
  }
  rayStats.kind = RAY_CLASSIFY;
  return vis / S;
}

// ---------------------------------------------------------------- the sun (lights.ts SunSet)

/** Sun direction samples per texel (full bake); the preview and patches use fewer. */
export const SUN_SAMPLES = 8;
/** Result of sunAt: RGB irradiance (lux), luminance and the visible fraction (0..1). */
export const sunOut = { r: 0, g: 0, b: 0, lum: 0, frac: 0 };
const sunHit = new Int32Array(SUN_SAMPLES);
const sunHx = new Float64Array(SUN_SAMPLES), sunHy = new Float64Array(SUN_SAMPLES), sunHz = new Float64Array(SUN_SAMPLES);

/** Aperture test of one direction from (x, y, z): writes the aperture point of sample slot k, true if glazed. */
function sunAperture(job: BakeJob, x: number, y: number, z: number, dx: number, dy: number, dz: number, k: number): boolean {
  const S = job.sun!;
  for (const p of S.planes) {
    if (p.y <= y + 0.05) continue;
    const t = (p.y - y) / dy;
    const hx = x + dx * t * INV_CELL, hz = z + dz * t * INV_CELL;
    const a = Math.floor(hx * 2), b = Math.floor(hz * 2);
    if (a < 0 || b < 0 || a >= SUN_RES || b >= SUN_RES) continue;
    if (p.bits[b * SUN_RES + a] === 0) continue;
    sunHx[k] = hx; sunHy[k] = p.y - 0.03; sunHz[k] = hz;
    return true;
  }
  return false;
}

/**
 * Direct sunlight at a receiver (x, y, z halo cells / m) with unit normal n (n = 0: omni), `samples` jittered
 * directions (1 = the centre direction). Pure function of the world position (seam-exact). Result in sunOut.
 * Occlusion: the first and last glazed samples are traced; the others only when those two disagree or some
 * samples miss the glazing (occluders near the receiver cast the same shadow for every sample: they diverge by
 * ~1 cm per metre).
 */
export function sunAt(job: BakeJob, x: number, y: number, z: number, nx: number, ny: number, nz: number, group: number, samples: number): void {
  sunOut.r = 0; sunOut.g = 0; sunOut.b = 0; sunOut.lum = 0; sunOut.frac = 0;
  const S = job.sun;
  if (!S || group !== 0) return;
  const omni = nx === 0 && ny === 0 && nz === 0;
  const cr = omni ? 1 : nx * S.dx + ny * S.dy + nz * S.dz;
  if (cr <= 0) return;
  let h = 0;
  if (samples <= 1) {
    if (sunAperture(job, x, y, z, S.dx, S.dy, S.dz, 0)) sunHit[h++] = 0;
  } else {
    worldQ(job, x, y, z, false);
    sampleRotation(wq.x, wq.y, wq.z, 0x5a11);
    for (let k = 0; k < samples; k++) {
      let u = SAMPLE_U[k] + rot.u; if (u >= 1) u -= 1;
      let v = SAMPLE_V[k] + rot.v; if (v >= 1) v -= 1;
      const a = (2 * u - 1) * SUN_CONE, b = (2 * v - 1) * SUN_CONE;
      const dx = S.dx + S.e1x * a + S.e2x * b, dy = S.dy + S.e2y * b, dz = S.dz + S.e1z * a + S.e2z * b;
      if (sunAperture(job, x, y, z, dx, dy, dz, k)) sunHit[h++] = k;
    }
  }
  if (h === 0) return;
  const kind = rayStats.kind;
  rayStats.kind = RAY_SHADOW;
  const ray = (k: number): boolean => !occluded(job.g, x, y, z, sunHx[k], sunHy[k], sunHz[k], group, true);
  const n = samples <= 1 ? 1 : samples;
  let vis: number;
  const first = ray(sunHit[0]);
  if (h === 1) vis = first ? 1 : 0;
  else {
    const last = ray(sunHit[h - 1]);
    if (first === last && h === n) vis = first ? h : 0;
    else {
      vis = (first ? 1 : 0) + (last ? 1 : 0);
      for (let i = 1; i < h - 1; i++) if (ray(sunHit[i])) vis++;
    }
  }
  rayStats.kind = kind;
  if (vis === 0) return;
  const f = (vis / n) * cr;
  sunOut.r = S.er * f; sunOut.g = S.eg * f; sunOut.b = S.eb * f;
  sunOut.lum = 0.2126 * sunOut.r + 0.7152 * sunOut.g + 0.0722 * sunOut.b;
  sunOut.frac = vis / n;
}
const SUN_CONE = SUN.cone;
/** Set by evalPoint: the texel is in a sun penumbra (denoised like shadow-sampled texels). */
let sunPartial = false;

/**
 * Per-light visibility reuse of the adaptive 2x2 refinement (full bake). Every lattice texel records the visibility
 * factor it used per light (`latVis[slot * latStride + i]`: static lights i < m, then the dynamic ones; -1 = not
 * evaluated: zero window or form factor). An off-lattice texel that has to be evaluated (its lattice neighbours
 * disagree in total irradiance: some light's shadow edge passes) takes a PARTIAL light's visibility from its
 * lattice neighbours when their values for THAT light agree within REUSE_SPREAD (their mean), and casts shadow rays
 * only for the lights whose visibility changes around it (a value already cast for the texel itself, as a sub-block
 * corner, is used first). Rack uprights and decks put a shadow edge of one of up to 16 lights through
 * most warehouse floor sub-blocks, and every off-lattice texel there re-sampled all 16 (73% of the per-texel shadow
 * rays). The same trade as the existing interpolation (features narrower than the lattice step between agreeing
 * lattice texels are not resolved), applied per light; texels next to chart ends (seams) never reuse.
 */
let latVis = new Float32Array(1024);
/** Max spread of the lattice neighbours' visibilities of one light for which an off-lattice texel reuses their
 * mean (the sub-block interpolation criterion INTERP_SPREAD). */
const REUSE_SPREAD = 0.5;
let latStride = 0;
/** Slot (patch list position) evalPoint records into, -1 = none (off-lattice texels). */
let latSlot = -1;
/** Lattice-neighbour slots an off-lattice texel may reuse from (count reuseN, 0 = none). */
const reuseSlot = new Int32Array(4);
let reuseN = 0;
function latReset(np: number, m: number): void {
  latStride = m;
  const need = np * m;
  if (latVis.length < need) latVis = new Float32Array(2 * need);
  latVis.fill(-1, 0, need);
}
/** The mean visibility the reuse neighbours recorded for light column j when they agree within REUSE_SPREAD, else
 * -1 (or when one has none). */
function agreedVis(j: number): number {
  let lo = 2, hi = -1, sum = 0;
  for (let k = 0; k < reuseN; k++) {
    const v = latVis[reuseSlot[k] * latStride + j];
    if (v < 0) return -1;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    sum += v;
  }
  return hi - lo <= REUSE_SPREAD ? sum / reuseN : -1;
}

/**
 * Evaluate one texel position into `val`. Static lights sel[0..m) with classes cls (visibility pvis for the
 * preview), dynamic lights dsel[0..md). `mode`: 0 full (PARTIAL -> shadow rays), 1 preview (pvis/dvis given).
 * `parts` (full): bit 1 evaluates the static lights, bit 2 the dynamic ones (`store` keeps only those).
 */
function evalPoint(job: BakeJob, x: number, y: number, z: number, nx: number, ny: number, nz: number, group: number, tower: boolean,
  m: number, md: number, mode: number, exact: number, parts = 3): void {
  const L = job.L;
  let er = 0, eg = 0, eb = 0, vx = 0, vy = 0, vz = 0, f0 = 0, f1 = 0, f2 = 0, f3 = 0;
  const rec = latSlot >= 0 ? latSlot * latStride : -1;
  for (let i = 0; i < m && (parts & 1) !== 0; i++) {
    const c = cls[i];
    if (c === CLS_NONE && mode === 0) { if (rec >= 0) latVis[rec + i] = 0; continue; }
    const l = sel[i];
    const o = l * 3;
    const w = windowW(windowDist2((L.pos[o] - x) * CELL, L.pos[o + 1] - y, (L.pos[o + 2] - z) * CELL, L.hAllow[l]), L.invR2[l]);
    if (w <= 0) continue;
    let vis = mode === 0 ? (c === CLS_FRAC ? pvis[i] : 1) : pvis[i];
    if (vis <= 0) { if (rec >= 0) latVis[rec + i] = 0; continue; }
    const f = formFactor(L, l, x, y, z, nx, ny, nz, exact);
    if (f <= 0) continue;
    if (mode === 0 && c === CLS_PARTIAL) {
      const wx = ff.wx, wy = ff.wy, wz = ff.wz;
      // (a value already cast for this texel -- a sub-block corner -- before the lattice neighbours' mean)
      const k = memoSlot >= 0 ? memoSlot * memoStride + i : -1;
      vis = k >= 0 ? memo[k] : -1;
      if (vis < 0 && reuseN > 0) vis = agreedVis(i);
      if (vis < 0) {
        vis = shadowFraction(job, l, x, y, z, group, tower, 0, k >= 0 && adaptL[i] !== 0 && !curSeam);
        if (k >= 0) memo[k] = vis;
      }
      if (rec >= 0) latVis[rec + i] = vis;
      if (vis <= 0) continue;
      ff.wx = wx; ff.wy = wy; ff.wz = wz;
    } else if (rec >= 0) latVis[rec + i] = vis;
    const k = f * w * vis;
    er += k * L.rad[o]; eg += k * L.rad[o + 1]; eb += k * L.rad[o + 2];
    const kl = k * L.radLum[l];
    vx += kl * ff.wx; vy += kl * ff.wy; vz += kl * ff.wz;
  }
  for (let i = 0; i < md && (parts & 2) !== 0; i++) {
    const c = dcls[i];
    if (c === CLS_NONE && mode === 0) { if (rec >= 0) latVis[rec + m + i] = 0; continue; }
    const l = dsel[i];
    const o = l * 3;
    const w = windowW(windowDist2((L.pos[o] - x) * CELL, L.pos[o + 1] - y, (L.pos[o + 2] - z) * CELL, L.hAllow[l]), L.invR2[l]);
    if (w <= 0) continue;
    let vis = mode === 0 ? (c === CLS_FRAC ? dvis[i] : 1) : dvis[i];
    if (vis <= 0) { if (rec >= 0) latVis[rec + m + i] = 0; continue; }
    const f = formFactor(L, l, x, y, z, nx, ny, nz, exact);
    if (f <= 0) continue;
    if (mode === 0 && c === CLS_PARTIAL) {
      const k = memoSlot >= 0 ? memoSlot * memoStride + m + i : -1;
      vis = k >= 0 ? memo[k] : -1;
      if (vis < 0 && reuseN > 0) vis = agreedVis(m + i);
      if (vis < 0) {
        vis = shadowFraction(job, l, x, y, z, group, tower, DYN_SHADOW_SAMPLES);
        if (k >= 0) memo[k] = vis;
      }
    }
    if (rec >= 0) latVis[rec + m + i] = vis;
    const Y = f * w * vis * L.radLum[l];
    const ch = L.channel[l];
    if (ch === 0) f0 += Y; else if (ch === 1) f1 += Y; else if (ch === 2) f2 += Y; else f3 += Y;
  }
  sunPartial = false;
  if (job.sun !== null && group === 0) {
    sunAt(job, x, y, z, nx, ny, nz, group, mode === 0 ? SUN_SAMPLES : 1);
    if (sunOut.lum > 0) {
      er += sunOut.r; eg += sunOut.g; eb += sunOut.b;
      const S = job.sun;
      vx += sunOut.lum * S.dx; vy += sunOut.lum * S.dy; vz += sunOut.lum * S.dz;
      if (sunOut.frac < 1) sunPartial = true;
    }
  }
  val[0] = er; val[1] = eg; val[2] = eb; val[3] = vx; val[4] = vy; val[5] = vz;
  val[6] = f0; val[7] = f1; val[8] = f2; val[9] = f3;
}

function store(R: DirectResult, t: number, parts = 3): void {
  if ((parts & 1) !== 0) {
    R.e[t * 3] = val[0] + tailE[0]; R.e[t * 3 + 1] = val[1] + tailE[1]; R.e[t * 3 + 2] = val[2] + tailE[2];
    R.v[t * 3] = val[3] + tailE[3]; R.v[t * 3 + 1] = val[4] + tailE[4]; R.v[t * 3 + 2] = val[5] + tailE[5];
  }
  if (R.flick && (parts & 2) !== 0) { R.flick[t * 4] = val[6]; R.flick[t * 4 + 1] = val[7]; R.flick[t * 4 + 2] = val[8]; R.flick[t * 4 + 3] = val[9]; }
}

/** K_MAX tail of the current patch (E rgb, V xyz), added by `store` and to texels that are never evaluated. */
const tailE = new Float64Array(6);
/** Compute the K_MAX tail of a receiver patch right after its selectLights call; false if it is zero. */
function patchTail(job: BakeJob, x: number, y: number, z: number, nx: number, ny: number, nz: number, c: number, byRegion = false): boolean {
  tailSum(job, x, y, z, nx, ny, nz, c, 1 << nearestBit(job, c, y), byRegion);
  tailE[0] = tail.r; tailE[1] = tail.g; tailE[2] = tail.b; tailE[3] = tail.vx; tailE[4] = tail.vy; tailE[5] = tail.vz;
  return tail.r + tail.g + tail.b > 0;
}
/** Pre-fill the patch texels with the tail (texels evaluated later overwrite it with `store`, tail included). */
function addTail(R: DirectResult, T: TexelSet, a: number, b: number): void {
  for (let k = a; k < b; k++) {
    const t = T.pList[k];
    for (let j = 0; j < 3; j++) { R.e[t * 3 + j] = tailE[j]; R.v[t * 3 + j] = tailE[3 + j]; }
  }
}
const clearTail = (): void => { tailE.fill(0); };

/** Set the classification sample points of patch p (4 extreme texels + the centroid). */
function setPatchPoints(T: TexelSet, p: number): void {
  for (let k = 0; k < 4; k++) {
    const t = T.pCorner[p * 4 + k];
    patchCorners[k * 3] = T.x[t]; patchCorners[k * 3 + 1] = T.y[t]; patchCorners[k * 3 + 2] = T.z[t];
  }
  // centroid of the patch texels (a valid-looking interior point)
  let sx = 0, sy = 0, sz = 0;
  const a = T.pStart[p], b = T.pStart[p + 1];
  for (let k = a; k < b; k++) { const t = T.pList[k]; sx += T.x[t]; sy += T.y[t]; sz += T.z[t]; }
  const inv = 1 / (b - a);
  patchCorners[12] = sx * inv; patchCorners[13] = sy * inv; patchCorners[14] = sz * inv;
  void PATCH_PTS;
}

/** Channel assertion: two dynamic lights of the same channel must never reach the same receiver. */
function assertChannels(job: BakeJob, md: number): void {
  for (let i = 0; i < md; i++) for (let j = i + 1; j < md; j++) {
    if (job.L.channel[dsel[i]] === job.L.channel[dsel[j]]) {
      throw new Error(`bakeTile: two dynamic lights of flicker channel ${job.L.channel[dsel[i]]} reach the same receiver (${job.L.key[dsel[i]]}, ${job.L.key[dsel[j]]})`);
    }
  }
}

/** Sub-block size (texels) of the PARTIAL-patch refinement. */
export const SUB = 4;
let sbCls = new Uint8Array(64 * 32);
let sbVis = new Float32Array(64 * 32);
/** A PARTIAL light whose unshadowed estimate is below this fraction of the receiver's total gets its visibility
 * per sub-block (fraction of visible classification segments) instead of per-texel shadow rays. */
export const WEAK_LIGHT = 0.05;
let sbOf = new Int32Array(256);
const sbExt = new Int32Array(4 * 64); // extreme texels per sub-block (by u+v, u-v)
const sbKey = new Float64Array(4 * 64);
const sbSum = new Float64Array(4 * 64); // x y z count
const sbRect = new Int32Array(4 * 64); // u0 v0 u1 v1 of the texels present
let sbCorner = new Float32Array(64 * 32 * 4); // CLS_INTERP: visibility at the 4 rectangle corners
/** Max spread of the 4 corner visibilities for which a sub-block interpolates a PARTIAL light's visibility
 * bilinearly instead of casting per-texel shadow rays (smooth penumbrae of area lights; hard edges keep rays). */
export const INTERP_SPREAD = 0.5;

/**
 * Split a patch that has PARTIAL lights into SUB x SUB texel sub-blocks (world-aligned on grid charts) and
 * re-classify every PARTIAL light per sub-block (4 inset corners + centre x 4 emitter points, no bitset
 * early-out): sub-blocks entirely lit or entirely shadowed need no per-texel shadow rays. Fills sbOf (per patch
 * texel, in pList order) and sbCls (per sub-block, m + md classes). Returns the sub-block count.
 */
function subdivide(job: BakeJob, T: TexelSet, p: number, gridOff: number, group: number, m: number, md: number, slot: Int32Array): number {
  const a = T.pStart[p], b = T.pStart[p + 1];
  let u0 = 1 << 30, v0 = 1 << 30, u1 = -(1 << 30), v1 = -(1 << 30);
  for (let k = a; k < b; k++) {
    const t = T.pList[k];
    const bu = Math.floor((T.u[t] - gridOff) / SUB), bv = Math.floor((T.v[t] - gridOff) / SUB);
    if (bu < u0) u0 = bu; if (bu > u1) u1 = bu; if (bv < v0) v0 = bv; if (bv > v1) v1 = bv;
  }
  const nu = u1 - u0 + 1, nsb = nu * (v1 - v0 + 1);
  if (nsb > 64) return 0; // cannot happen for cell-sized patches; fall back to per-texel shadows
  if (sbOf.length < b - a) sbOf = new Int32Array(2 * (b - a));
  const stride = m + md;
  if (sbCls.length < nsb * stride) { sbCls = new Uint8Array(2 * nsb * stride); sbVis = new Float32Array(2 * nsb * stride); }
  // "weak" is relative to the lights that can actually reach the patch: a light classified NONE (fully occluded,
  // e.g. the bright room behind the wall) must not make the light that really lights a dim wall "weak", or that
  // wall gets the coarse per-sub-block visibility and turns into 4x4-texel blotches (dark-zone walls next to lit
  // rooms, corridors around a flickering panel).
  let estSum = 0;
  let strongest = -1;
  for (let i = 0; i < m; i++) {
    if (cls[i] !== CLS_NONE) estSum += selEstP[i];
    if (cls[i] === CLS_PARTIAL && (strongest < 0 || selEstP[i] > selEstP[strongest])) strongest = i;
  }
  for (let q = 0; q < nsb; q++) {
    sbExt[q * 4] = -1;
    sbKey[q * 4] = Infinity; sbKey[q * 4 + 1] = -Infinity; sbKey[q * 4 + 2] = Infinity; sbKey[q * 4 + 3] = -Infinity;
    sbSum[q * 4] = 0; sbSum[q * 4 + 1] = 0; sbSum[q * 4 + 2] = 0; sbSum[q * 4 + 3] = 0;
    sbRect[q * 4] = 1 << 30; sbRect[q * 4 + 1] = 1 << 30; sbRect[q * 4 + 2] = -(1 << 30); sbRect[q * 4 + 3] = -(1 << 30);
  }
  for (let k = a; k < b; k++) {
    const t = T.pList[k];
    const q = (Math.floor((T.v[t] - gridOff) / SUB) - v0) * nu + (Math.floor((T.u[t] - gridOff) / SUB) - u0);
    sbOf[k - a] = q;
    const s1 = T.u[t] + T.v[t], s2 = T.u[t] - T.v[t];
    if (s1 < sbKey[q * 4]) { sbKey[q * 4] = s1; sbExt[q * 4] = t; }
    if (s1 > sbKey[q * 4 + 1]) { sbKey[q * 4 + 1] = s1; sbExt[q * 4 + 1] = t; }
    if (s2 < sbKey[q * 4 + 2]) { sbKey[q * 4 + 2] = s2; sbExt[q * 4 + 2] = t; }
    if (s2 > sbKey[q * 4 + 3]) { sbKey[q * 4 + 3] = s2; sbExt[q * 4 + 3] = t; }
    sbSum[q * 4] += T.x[t]; sbSum[q * 4 + 1] += T.y[t]; sbSum[q * 4 + 2] += T.z[t]; sbSum[q * 4 + 3]++;
    const uu = T.u[t], vv = T.v[t];
    if (uu < sbRect[q * 4]) sbRect[q * 4] = uu; if (vv < sbRect[q * 4 + 1]) sbRect[q * 4 + 1] = vv;
    if (uu > sbRect[q * 4 + 2]) sbRect[q * 4 + 2] = uu; if (vv > sbRect[q * 4 + 3]) sbRect[q * 4 + 3] = vv;
  }
  if (sbCorner.length < nsb * stride * 4) sbCorner = new Float32Array(2 * nsb * stride * 4);
  for (let q = 0; q < nsb; q++) {
    const o = q * stride;
    for (let i = 0; i < m; i++) sbCls[o + i] = cls[i];
    for (let i = 0; i < md; i++) sbCls[o + m + i] = dcls[i];
    if (sbExt[q * 4] < 0) continue; // empty sub-block
    for (let k = 0; k < 4; k++) {
      const t = sbExt[q * 4 + k];
      patchCorners[k * 3] = T.x[t]; patchCorners[k * 3 + 1] = T.y[t]; patchCorners[k * 3 + 2] = T.z[t];
    }
    const inv = 1 / sbSum[q * 4 + 3];
    patchCorners[12] = sbSum[q * 4] * inv; patchCorners[13] = sbSum[q * 4 + 1] * inv; patchCorners[14] = sbSum[q * 4 + 2] * inv;
    const c = T.pCell[p];
    // complete rectangular sub-block: shadow-sample its 4 corner texels (the same per-texel estimate they would get;
    // memoized, so a corner texel evaluated again per texel costs no rays)
    const u0 = sbRect[q * 4], v0 = sbRect[q * 4 + 1], u1 = sbRect[q * 4 + 2], v1 = sbRect[q * 4 + 3];
    let rect = false;
    if (sbSum[q * 4 + 3] === (u1 - u0 + 1) * (v1 - v0 + 1)) {
      const ref = sbExt[q * 4];
      cornerBase = T.atlas[ref] - T.v[ref] * T.atlasW - T.u[ref];
      cornerChart = T.chart[ref];
      if (u1 > u0 && v1 > v0) {
        corners4[0] = cornerAt(T, p, u0, v0); corners4[1] = cornerAt(T, p, u1, v0);
        corners4[2] = cornerAt(T, p, u0, v1); corners4[3] = cornerAt(T, p, u1, v1);
        rect = corners4[0] >= 0 && corners4[1] >= 0 && corners4[2] >= 0 && corners4[3] >= 0;
      }
    }
    for (let i = 0; i < m; i++) {
      if (cls[i] !== CLS_PARTIAL) continue;
      const weak = i !== strongest && selEstP[i] < WEAK_LIGHT * estSum;
      if (rect) {
        // corners all lit -> FULL, all dark -> NONE, a smooth penumbra -> bilinear visibility, weak -> the mean
        let lo = 1, hi = 0, sum = 0;
        const co = (o + i) * 4;
        for (let k = 0; k < 4; k++) {
          const t = corners4[k];
          const f = weak ? centreMemo(job, T, i, m, t, slot[t], group) : shadowMemo(job, T, i, m, t, slot[t], group);
          sbCorner[co + k] = f;
          sum += f;
          if (f < lo) lo = f;
          if (f > hi) hi = f;
        }
        if (lo >= 1) sbCls[o + i] = CLS_FULL;
        else if (hi <= 0) sbCls[o + i] = CLS_NONE;
        else if (hi - lo <= INTERP_SPREAD) sbCls[o + i] = CLS_INTERP;
        else if (weak) { sbCls[o + i] = CLS_FRAC; sbVis[o + i] = sum * 0.25; }
        else sbCls[o + i] = CLS_PARTIAL;
      } else if (weak) {
        const f = centreFraction(job, sel[i], group);
        sbCls[o + i] = f <= 0 ? CLS_NONE : f >= 1 ? CLS_FULL : CLS_FRAC;
        sbVis[o + i] = f;
      } else sbCls[o + i] = classifyPatch(job, sel[i], c, group, false, 0);
    }
    // dynamic lights: the same corner scheme (DYN_SHADOW_SAMPLES per corner), so their penumbrae interpolate
    // smoothly like the static ones instead of carrying per-texel sampling noise
    for (let i = 0; i < md; i++) {
      if (dcls[i] !== CLS_PARTIAL) continue;
      const oi = o + m + i;
      if (!rect) { sbCls[oi] = classifyPatch(job, dsel[i], c, group, false, 0); continue; }
      let lo = 1, hi = 0;
      const co = oi * 4;
      for (let k = 0; k < 4; k++) {
        const t = corners4[k];
        const f = shadowMemo(job, T, m + i, m, t, slot[t], group);
        sbCorner[co + k] = f;
        if (f < lo) lo = f;
        if (f > hi) hi = f;
      }
      sbCls[oi] = lo >= 1 ? CLS_FULL : hi <= 0 ? CLS_NONE : hi - lo <= INTERP_SPREAD ? CLS_INTERP : CLS_PARTIAL;
    }
  }
  return nsb;
}
const corners4 = new Int32Array(4);
let cornerBase = 0, cornerChart = 0;
/** Compact index of the VALID texel (u, v) of the current chart if it belongs to patch p, else -1. */
function cornerAt(T: TexelSet, p: number, u: number, v: number): number {
  if (u < 0 || v < 0 || u >= T.chartW[cornerChart] || v >= T.chartH[cornerChart]) return -1;
  const s = T.map[cornerBase + v * T.atlasW + u];
  return s >= 0 && T.chart[s] === cornerChart && T.patch[s] === p ? s : -1;
}

export function directFull(job: BakeJob, T: TexelSet): DirectResult {
  const anyDyn = hasDynamic(job);
  const R: DirectResult = { e: new Float32Array(T.n * 3), v: new Float32Array(T.n * 3), flick: anyDyn ? new Float32Array(T.n * 4) : null, anyDynamic: anyDyn };
  const done = new Uint8Array(T.n);
  const slot = new Int32Array(T.n); // texel -> position in its patch list (sub-block lookup)
  const noisy = new Uint8Array(T.n); // texel evaluated with per-texel shadow samples
  for (let p = 0; p < T.nPatch; p++) {
    const c = T.pCell[p], group = T.pGroup[p];
    const tower = isTowerCell(job, c);
    const t0 = T.pList[T.pStart[p]];
    const nx = T.nx[t0], ny = T.ny[t0], nz = T.nz[t0];
    const px = T.pc[p * 3], py = T.pc[p * 3 + 1], pz = T.pc[p * 3 + 2];
    const m = selectLights(job, px, py, pz, nx, ny, nz, c, group, T.pExt[p], tower ? FILTER_NONE : FILTER_UNION9, sel);
    for (let i = 0; i < m; i++) selEstP[i] = selEst[i];
    const hasTail = !tower && patchTail(job, px, py, pz, nx, ny, nz, c);
    if (!hasTail) clearTail();
    const md = anyDyn ? selectDynamic(job, px, py, pz, group, dsel) : 0;
    if (md > 1) assertChannels(job, md);
    let partial = false, any = false;
    let need = 0;
    if (m + md > 0) {
      setPatchPoints(T, p); need = patchNeed(job, c, T.pYmin[p], T.pYmax[p]);
      beamReset();
      for (let k = T.pStart[p], ke = T.pStart[p + 1]; k < ke; k++) { const t = T.pList[k]; beamAdd(T.x[t], T.y[t], T.z[t]); }
    }
    for (let i = 0; i < m; i++) {
      cls[i] = classifyPatch(job, sel[i], c, group, !tower, need, T.pYmin[p], true, T.pYmax[p]);
      job.diag.pairs[cls[i]]++;
      if (cls[i] === CLS_PARTIAL) partial = true;
      if (cls[i] !== CLS_NONE) any = true;
    }
    for (let i = 0; i < md; i++) {
      dcls[i] = classifyPatch(job, dsel[i], c, group, !tower, need, T.pYmin[p], true, T.pYmax[p]);
      if (dcls[i] === CLS_PARTIAL) partial = true;
      if (dcls[i] !== CLS_NONE) any = true;
    }
    const a = T.pStart[p], b = T.pStart[p + 1];
    if (hasTail) addTail(R, T, a, b);
    // (a patch facing the sun in a neighbourhood with sun apertures is always evaluated: sunAt decides)
    if (!any && job.sun !== null && group === 0 && nx * job.sun.dx + ny * job.sun.dy + nz * job.sun.dz > 0) any = true;
    if (!any) { for (let k = a; k < b; k++) done[T.pList[k]] = 1; continue; } // all zero (+ tail)
    const ch = T.pChart[p];
    const gridOff = T.grid[ch] !== 0 ? 1 : 0; // world-aligned lattice on grid charts
    // (periodic tower patches are not subdivided: 4-texel sub-blocks do not divide the 3 m period)
    for (let k = a; k < b; k++) slot[T.pList[k]] = k - a;
    memoReset(b - a, m, md);
    let estSum = 0;
    for (let i = 0; i < m; i++) if (cls[i] !== CLS_NONE) estSum += selEstP[i];
    for (let i = 0; i < m; i++) adaptL[i] = selEstP[i] < ADAPT_SHARE * estSum ? 1 : 0;
    const nsb = partial && !tower ? subdivide(job, T, p, gridOff, group, m, md, slot) : 0;
    const stride = m + md;
    for (let i = 0; i < m; i++) patchCls[i] = cls[i];
    for (let i = 0; i < md; i++) patchCls[m + i] = dcls[i];
    let seamReady = false;
    const evalTexel = (t: number, parts: number): void => {
      let pt = false;
      if (T.seam[t] !== 0) {
        // shared with the neighbouring tile: bitset classes only (tile-independent), shadow rays otherwise
        if (!seamReady) {
          for (let i = 0; i < m; i++) seamCls[i] = bitsetClass(job, sel[i], c, need, tower, T.pYmin[p]);
          for (let i = 0; i < md; i++) seamCls[m + i] = bitsetClass(job, dsel[i], c, need, tower, T.pYmin[p]);
          seamReady = true;
        }
        for (let i = 0; i < m; i++) { cls[i] = seamCls[i]; if (cls[i] === CLS_PARTIAL) pt = true; }
        for (let i = 0; i < md; i++) { dcls[i] = seamCls[m + i]; if (dcls[i] === CLS_PARTIAL) pt = true; }
      } else if (nsb > 0) {
        const q = sbOf[slot[t]], o = q * stride;
        for (let i = 0; i < m; i++) {
          let ci = sbCls[o + i];
          if (ci === CLS_INTERP) {
            const u0 = sbRect[q * 4], v0 = sbRect[q * 4 + 1], u1 = sbRect[q * 4 + 2], v1 = sbRect[q * 4 + 3];
            const fu = (T.u[t] - u0) / (u1 - u0), fv = (T.v[t] - v0) / (v1 - v0);
            const co = (o + i) * 4;
            const top = sbCorner[co] + (sbCorner[co + 1] - sbCorner[co]) * fu;
            const bot = sbCorner[co + 2] + (sbCorner[co + 3] - sbCorner[co + 2]) * fu;
            pvis[i] = top + (bot - top) * fv;
            ci = CLS_FRAC;
          } else pvis[i] = sbVis[o + i];
          cls[i] = ci;
          if (ci === CLS_PARTIAL) pt = true;
        }
        for (let i = 0; i < md; i++) {
          let ci = sbCls[o + m + i];
          if (ci === CLS_INTERP) {
            const u0 = sbRect[q * 4], v0 = sbRect[q * 4 + 1], u1 = sbRect[q * 4 + 2], v1 = sbRect[q * 4 + 3];
            const fu = (T.u[t] - u0) / (u1 - u0), fv = (T.v[t] - v0) / (v1 - v0);
            const co = (o + m + i) * 4;
            const top = sbCorner[co] + (sbCorner[co + 1] - sbCorner[co]) * fu;
            const bot = sbCorner[co + 2] + (sbCorner[co + 3] - sbCorner[co + 2]) * fu;
            dvis[i] = top + (bot - top) * fv;
            ci = CLS_FRAC;
          }
          dcls[i] = ci;
          if (ci === CLS_PARTIAL) pt = true;
        }
      } else {
        for (let i = 0; i < m; i++) cls[i] = patchCls[i];
        for (let i = 0; i < md; i++) dcls[i] = patchCls[m + i];
        pt = partial;
      }
      if (pt) { job.diag.shadowTexels++; noisy[t] = 1; }
      memoSlot = slot[t];
      curSeam = T.seam[t] !== 0;
      evalPoint(job, T.x[t], T.y[t], T.z[t], nx, ny, nz, group, tower, m, md, 0, EXACT_FULL, parts);
      memoSlot = -1;
      if (sunPartial && T.seam[t] === 0) noisy[t] = 1;
      store(R, t, parts);
    };
    // ---- adaptive 2x2 refinement: lattice texels are evaluated; the others are interpolated from their lattice
    // neighbours when those agree within 2% (inside penumbrae they differ, so shadow edges get every texel), and
    // otherwise reuse their neighbours' per-light visibility where it agrees (latVis)
    latReset(b - a, stride);
    for (let k = a; k < b; k++) {
      const t = T.pList[k];
      if (((T.u[t] - gridOff) & 1) === 0 && ((T.v[t] - gridOff) & 1) === 0) {
        latSlot = k - a;
        evalTexel(t, 3);
        done[t] = 2; // lattice
      }
    }
    latSlot = -1;
    for (let k = a; k < b; k++) {
      const t = T.pList[k];
      if (done[t] === 2) continue;
      const parts = interpolate(T, R, t, p, gridOff);
      if (parts !== 0) {
        reuseN = T.seam[t] === 0 ? interpN : 0;
        for (let j = 0; j < reuseN; j++) reuseSlot[j] = slot[latNbr[j]];
        evalTexel(t, parts);
        reuseN = 0;
      }
      done[t] = 1;
    }
    for (let k = a; k < b; k++) done[T.pList[k]] = 1;
  }
  denoiseShadows(T, R, noisy);
  return R;
}

/**
 * Shadow-sample denoise. Texels evaluated with per-texel shadow samples (hard penumbrae, q.shadowSamples = 4 at
 * high) carry sampling noise of up to +-1/S of the partial light; in dim places (dark zones metered up, walls lit
 * only through a doorway) it showed as blotchy walls. Each such texel (and its patch neighbours) is replaced by a
 * 3x3 tent average over the
 * texels of the SAME patch (same chart and owner cell: occluding edges lie on cell lines, so this never averages
 * across a wall and cannot leak). Seam texels (shared with a neighbouring tile) are left untouched, and every value
 * read is a pure function of world position, so seams stay exact. Static E/V and the flicker channels alike.
 */
function denoiseShadows(T: TexelSet, R: DirectResult, noisy: Uint8Array): void {
  const W = T.atlasW;
  // the filtered set is the noisy texels dilated by one texel within their patch: the adaptive 2x2 refinement
  // leaves exact (interpolated / FULL / NONE) texels between sampled ones, and filtering only the sampled ones
  // would turn an umbra edge into a dotted line
  const mark = new Uint8Array(T.n);
  for (let t = 0; t < T.n; t++) {
    if (noisy[t] === 0) continue;
    const p = T.patch[t], ch = T.chart[t], u = T.u[t], v = T.v[t], base = T.atlas[t];
    for (let dv = -1; dv <= 1; dv++) {
      for (let du = -1; du <= 1; du++) {
        const s = du === 0 && dv === 0 ? t : T.map[base + dv * W + du];
        if (s === undefined || s < 0 || T.chart[s] !== ch || T.patch[s] !== p || T.u[s] !== u + du || T.v[s] !== v + dv || T.state[s] !== TX_VALID) continue;
        mark[s] = 1;
      }
    }
  }
  let list = 0;
  for (let t = 0; t < T.n; t++) if (mark[t] !== 0 && T.seam[t] === 0) list++;
  if (list === 0) return;
  const idx = new Int32Array(list);
  const out = new Float32Array(list * 10);
  let k = 0;
  for (let t = 0; t < T.n; t++) {
    if (mark[t] === 0 || T.seam[t] !== 0) continue;
    const p = T.patch[t], ch = T.chart[t], u = T.u[t], v = T.v[t], base = T.atlas[t];
    let ws = 0;
    const o = k * 10;
    for (let dv = -1; dv <= 1; dv++) {
      for (let du = -1; du <= 1; du++) {
        const s = du === 0 && dv === 0 ? t : T.map[base + dv * W + du];
        if (s === undefined || s < 0 || T.chart[s] !== ch || T.patch[s] !== p || T.u[s] !== u + du || T.v[s] !== v + dv || T.state[s] !== TX_VALID) continue;
        const w = (du === 0 ? 2 : 1) * (dv === 0 ? 2 : 1);
        ws += w;
        for (let j = 0; j < 3; j++) { out[o + j] += w * R.e[s * 3 + j]; out[o + 3 + j] += w * R.v[s * 3 + j]; }
        if (R.flick) for (let j = 0; j < 4; j++) out[o + 6 + j] += w * R.flick[s * 4 + j];
      }
    }
    const inv = 1 / ws;
    for (let j = 0; j < 10; j++) out[o + j] *= inv;
    idx[k++] = t;
  }
  for (let i = 0; i < list; i++) {
    const t = idx[i], o = i * 10;
    for (let j = 0; j < 3; j++) { R.e[t * 3 + j] = out[o + j]; R.v[t * 3 + j] = out[o + 3 + j]; }
    if (R.flick) for (let j = 0; j < 4; j++) R.flick[t * 4 + j] = out[o + 6 + j];
  }
}

/** Lattice-neighbour count (in latNbr) of the last `interpolate` call. */
let interpN = 0;
/**
 * Interpolate texel t from its lattice neighbours of the same patch where they agree within 2%. The static term
 * (E, V) and the dynamic channels are decided separately, so static irradiance never depends on dynamic lights.
 * Returns the parts still to evaluate: bit 1 static, bit 2 dynamic (0 = fully interpolated).
 */
function interpolate(T: TexelSet, R: DirectResult, t: number, p: number, gridOff: number): number {
  const cnt = latticeNeighbours(T, t, p, gridOff);
  interpN = cnt;
  if (cnt === 0) return R.flick ? 3 : 1;
  const nbr = latNbr;
  let lo = Infinity, hi = -Infinity, flo = Infinity, fhi = -Infinity;
  for (let i = 0; i < cnt; i++) {
    const s = nbr[i];
    const q = 0.2126 * R.e[s * 3] + 0.7152 * R.e[s * 3 + 1] + 0.0722 * R.e[s * 3 + 2];
    if (q < lo) lo = q;
    if (q > hi) hi = q;
    if (R.flick) {
      const f = R.flick[s * 4] + R.flick[s * 4 + 1] + R.flick[s * 4 + 2] + R.flick[s * 4 + 3];
      if (f < flo) flo = f;
      if (f > fhi) fhi = f;
    }
  }
  const inv = 1 / cnt;
  let need = 0;
  if (hi - lo > 0.02 * hi + 1e-6) need |= 1;
  else {
    for (let j = 0; j < 3; j++) {
      let se = 0, sv = 0;
      for (let i = 0; i < cnt; i++) { se += R.e[nbr[i] * 3 + j]; sv += R.v[nbr[i] * 3 + j]; }
      R.e[t * 3 + j] = se * inv; R.v[t * 3 + j] = sv * inv;
    }
  }
  if (R.flick) {
    if (fhi - flo > 0.02 * fhi + 1e-6) need |= 2;
    else for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let i = 0; i < cnt; i++) s += R.flick[nbr[i] * 4 + j];
      R.flick[t * 4 + j] = s * inv;
    }
  }
  return need;
}

export function hasDynamic(job: BakeJob): boolean {
  const L = job.L;
  for (let l = 0; l < L.n; l++) if (L.dynamic[l] !== 0 && L.reachTile[l] !== 0) return true;
  return false;
}

// ---------------------------------------------------------------- preview

/** Preview visibility of light l for a receiver at height y in cell c. */
/** Preview visibility of light l at a block sample (x, y, z) of cell c: one ray for tower cells and next to
 * occluder boxes (returns -1 otherwise: use the bitset classes, `bitsetVis`). */
function previewRay(job: BakeJob, l: number, c: number, y: number, x: number, z: number, group: number, tower: boolean): number {
  if (tower || boxesBetween(job, c, l, Math.min(y, lightLowY(job, l)), Math.max(y, lightHighY(job, l)))) {
    // periodic tower cells have no bitset; next to occluder boxes (furniture, racks) the cell-centre bitset
    // cannot see sub-cell shadows: one ray from the block sample to the light centre
    const L = job.L, o = l * 3;
    return occluded(job.g, x, y, z, L.vis[o], L.vis[o + 1], L.vis[o + 2], group, true) ? 0 : 1;
  }
  return -1;
}
/** Bitset preview class of light l for receivers of cell c at bit height `bit`: the owner cell does not see it -> 0,
 * all 9 cells see it -> 1, otherwise 0.5 + 0.5 * (seeing cells / 9). */
function bitsetVis(job: BakeJob, l: number, c: number, bit: number): number {
  if ((visBits(job, l, c) & bit) === 0) return 0;
  const n = job.g.n;
  const hi = c % n, hj = (c - hi) / n;
  let seen = 0;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const i = hi + di, j = hj + dj;
    if (i >= 0 && j >= 0 && i < n && j < n && (visBits(job, l, j * n + i) & bit) !== 0) seen++;
  }
  return seen === 9 ? 1 : 0.5 + 0.5 * seen / 9;
}
const pvCache = new Float64Array((LIGHT.K_MAX + 16) * 5);

/** Exact-polygon factor of the preview (cheaper; still exact directly under a panel). */
const EXACT_PREVIEW = 1.2;

export function directPreview(job: BakeJob, T: TexelSet, surfaces: SurfaceSet): DirectResult {
  const anyDyn = hasDynamic(job);
  const R: DirectResult = { e: new Float32Array(T.n * 3), v: new Float32Array(T.n * 3), flick: anyDyn ? new Float32Array(T.n * 4) : null, anyDynamic: anyDyn };
  const W = surfaces.atlasW, H = surfaces.atlasH;
  const blockRep = new Int32Array(W * H).fill(-1); // atlas index of a block's anchor texel -> representative texel
  const n = job.g.n;
  for (let p = 0; p < T.nPatch; p++) {
    const c = T.pCell[p], group = T.pGroup[p];
    const tower = isTowerCell(job, c);
    const t0 = T.pList[T.pStart[p]];
    const nx = T.nx[t0], ny = T.ny[t0], nz = T.nz[t0];
    const px = T.pc[p * 3], py = T.pc[p * 3 + 1], pz = T.pc[p * 3 + 2];
    const m = selectLights(job, px, py, pz, nx, ny, nz, c, group, T.pExt[p], tower ? FILTER_NONE : FILTER_UNION9, sel);
    if (tower || !patchTail(job, px, py, pz, nx, ny, nz, c, true)) clearTail();
    const md = anyDyn ? selectDynamic(job, px, py, pz, group, dsel) : 0;
    if (md > 1) assertChannels(job, md);
    if (m + md === 0) { addTail(R, T, T.pStart[p], T.pStart[p + 1]); continue; }
    for (let i = 0; i < m; i++) cls[i] = 1;
    for (let i = 0; i < md; i++) dcls[i] = 1;
    pvCache.fill(-1, 0, (m + md) * 5);
    const ci = T.pChart[p];
    const grid = T.grid[ci] !== 0;
    const chart = surfaces.charts[ci];
    const hi = c % n, hj = (c - hi) / n;
    const a = T.pStart[p], b = T.pStart[p + 1];
    for (let k = a; k < b; k++) {
      const t = T.pList[k];
      const u = T.u[t], v = T.v[t];
      const bu = grid ? (u - 1) >> 1 : u >> 1, bv = grid ? (v - 1) >> 1 : v >> 1;
      const au = chart.x + (grid ? 2 * bu + 1 : 2 * bu), av = chart.y + (grid ? 2 * bv + 1 : 2 * bv);
      const key = au >= 0 && av >= 0 && au < W && av < H ? av * W + au : -1;
      const prev = key >= 0 ? blockRep[key] : -1;
      if (prev >= 0 && T.patch[prev] === p) {
        R.e[t * 3] = R.e[prev * 3]; R.e[t * 3 + 1] = R.e[prev * 3 + 1]; R.e[t * 3 + 2] = R.e[prev * 3 + 2];
        R.v[t * 3] = R.v[prev * 3]; R.v[t * 3 + 1] = R.v[prev * 3 + 1]; R.v[t * 3 + 2] = R.v[prev * 3 + 2];
        if (R.flick) for (let j = 0; j < 4; j++) R.flick[t * 4 + j] = R.flick[prev * 4 + j];
        continue;
      }
      if (key >= 0 && prev < 0) blockRep[key] = t;
      // block sample point: world-aligned block centre on grid charts, the texel itself otherwise
      let x = T.x[t], y = T.y[t], z = T.z[t];
      if (grid) {
        const uc = 2 * bu + 1 + 0.5, vc = 2 * bv + 1 + 0.5; // continuous texel coordinate of the block centre
        const lx = chart.origin[0] + (uc + 0.5) * chart.axisU[0] + (vc + 0.5) * chart.axisV[0];
        const lz = chart.origin[2] + (uc + 0.5) * chart.axisU[2] + (vc + 0.5) * chart.axisV[2];
        let bx = HALO_OFF + quant(lx * INV_CELL), bz = HALO_OFF + quant(lz * INV_CELL);
        bx = bx < hi ? hi : bx >= hi + 1 ? hi + 1 - 1 / 1048576 : bx;
        bz = bz < hj ? hj : bz >= hj + 1 ? hj + 1 - 1 / 1048576 : bz;
        clampSample(job, c, bx, y, bz, group);
        x = clampOut.x; z = clampOut.z;
      }
      const bitIdx = tower ? 0 : nearestBit(job, c, y), bit = 1 << bitIdx;
      for (let i = 0; i < m + md; i++) {
        const l = i < m ? sel[i] : dsel[i - m];
        let pv = previewRay(job, l, c, y, x, z, group, tower);
        if (pv < 0) {
          pv = pvCache[i * 5 + bitIdx];
          if (pv < 0) { pv = bitsetVis(job, l, c, bit); pvCache[i * 5 + bitIdx] = pv; }
        }
        if (i < m) pvis[i] = pv; else dvis[i - m] = pv;
      }
      evalPoint(job, x, y, z, nx, ny, nz, group, tower, m, md, 1, EXACT_PREVIEW);
      store(R, t);
    }
  }
  return R;
}
