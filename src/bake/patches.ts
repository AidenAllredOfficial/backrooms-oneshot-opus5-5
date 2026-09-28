// src/bake/patches.ts — world-anchored patch irradiance (WP7 §Algorithms 6, patch cache). Pure module.
//
// Patches tile the floors, ceilings and walls on a world-anchored grid: 0.6 m patches (4 per cell floor/ceiling,
// 2 x 0.6 m bands per wall face) for probe hits closer than 5 m, 1.2 m patches beyond (the level is chosen from
// the hit distance, so a patch value never depends on which tile asks). Heights are quantized into bands, so the
// periodic tower stack and multi-level spaces get distinct patches. A patch's direct irradiance uses the K_MAX
// strongest lights of its cell and the bitset visibility of its owner cell at the nearest layer height (tower cells:
// one DDA ray per light). RECT emitters use the centre's point (2-point) form factor (exact polygon very close to the
// emitter). SPHERE and DISK emitters use the patch MEAN I * Omega / A (Omega: the solid angle the patch rectangle
// subtends at the source, pointOverRect): a cage bulb hanging 6.5 cm under a coarse ceiling patch's centre gave the
// centre's cos / d^2 (237 m^-2, about 60x the patch mean) to every probe ray landing anywhere on the 1.2 m patch --
// firefly probes, which the bilinear probe interpolation spread into round 2.4 m blotches.
// Irradiance (not radiance) is cached per world chunk, so albedo (and the wet x0.7 tint) is applied by the caller
// from the surface actually hit. Values are pure functions of world position (exact halo arithmetic).
// Each patch also stores the direct irradiance LUMINANCE of the dynamic (flicker-channel) lights, per channel
// (PATCH_STRIDE = 3 static RGB + 4 channels), so the probes can bounce the dynamic lights too (probes.ts). The
// static RGB never depends on the dynamic lights.

import { CELL } from '../core/constants.ts';
import { CellFlag } from '../core/ids.ts';
import { formFactor, pointOverRect } from './areaLight.ts';
import { FILTER_CELL, FILTER_NONE, isTowerCell, selectDynamic, selectLights, tail, tailSum } from './classify.ts';
import { occluded } from './dda.ts';
import { sunAt, sunOut } from './direct.ts';
import { nearestBit, type BakeJob } from './job.ts';
import { SHAPE_DISK, SHAPE_RECT, type LightSet } from './lights.ts';
import { growF32, windowDist2, windowW } from './util.ts';
import { visBits } from './visbits.ts';

export const PK_FLOOR = 0, PK_CEIL = 1, PK_WALL = 2;
/** Fine patches are used for hits closer than this (m). */
export const FINE_DIST = 5;
/** Exact-polygon factor for patches (only very close to an emitter). */
const PATCH_EXACT = 1.5;

const sel = new Int32Array(32);
const dsel = new Int32Array(16);
/** Floats per patch: static RGB irradiance (lux) at +0..2, dynamic channel luminance (lux) at +3..6. */
export const PATCH_STRIDE = 7;
/** Offset of the 4 dynamic channel luminances within a patch record. */
export const PATCH_DYN = 3;
/** Result of `patchE`: RGB irradiance at pref.e[pref.o .. pref.o + 2], channel luminances at pref.o + PATCH_DYN. */
export const pref: { e: Float32Array<ArrayBuffer>; o: number } = { e: new Float32Array(3), o: 0 };

const WALL_NX = [1, -1, 0, 0], WALL_NZ = [0, 0, 1, -1];

// The patch rectangle of the patch being evaluated (set by patchE): normal axis (0 x, 1 y, 2 z) and its sign, the
// plane (halo cells for x / z, m for y) and the in-plane ranges: U along x (floors, ceilings, walls facing z) or z
// (walls facing x), halo cells; V along z (floors, ceilings; halo cells) or y (walls; m).
let rAx = 1, rS = 1, rP = 0, rU0 = 0, rU1 = 0, rV0 = 0, rV1 = 0;

/**
 * Mean geometric factor of a SPHERE or DISK light l over the current patch rectangle: I * mean(cos / d^2) =
 * I * Omega / A (pointOverRect), 0 when the source is behind the patch plane. The source's height above the plane is
 * clamped to its radius (the soft core of formFactor). DISK emitters (one-sided) also get their emitter cosine
 * toward the patch centre. Differences are taken in halo units before scaling (exact in every halo frame).
 */
function meanFactor(L: LightSet, l: number): number {
  const o = l * 3;
  const lx = L.pos[o], ly = L.pos[o + 1], lz = L.pos[o + 2];
  let h: number, u0: number, u1: number, v0: number, v1: number;
  if (rAx === 1) {
    h = (ly - rP) * rS;
    u0 = (rU0 - lx) * CELL; u1 = (rU1 - lx) * CELL; v0 = (rV0 - lz) * CELL; v1 = (rV1 - lz) * CELL;
  } else {
    h = (rAx === 0 ? lx - rP : lz - rP) * CELL * rS;
    const lu = rAx === 0 ? lz : lx;
    u0 = (rU0 - lu) * CELL; u1 = (rU1 - lu) * CELL; v0 = rV0 - ly; v1 = rV1 - ly;
  }
  if (h <= 0) return 0;
  const r = L.w[l] * 0.5;
  const f = pointOverRect(h > r ? h : r, u0, u1, v0, v1);
  if (L.shape[l] !== SHAPE_DISK) return f;
  // emitter cosine toward the rectangle centre (world axes, m)
  const cu = -0.5 * (u0 + u1), cv = -0.5 * (v0 + v1);
  const wx = rAx === 1 ? cu : rAx === 0 ? h * rS : cu;
  const wy = rAx === 1 ? h * rS : cv;
  const wz = rAx === 1 ? cv : rAx === 0 ? cu : h * rS;
  const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
  const ce = wl > 1e-9 ? -(L.nrm[o] * wx + L.nrm[o + 1] * wy + L.nrm[o + 2] * wz) / wl : 0;
  return ce > 0 ? f * ce : 0;
}

/**
 * Irradiance of the patch of `kind` containing (x, y, z) in cell c (wall: face normal `dir`).
 * Result in `pref`.
 */
export function patchE(job: BakeJob, kind: number, c: number, x: number, y: number, z: number, dir: number, fine: boolean): void {
  const g = job.g;
  const n = g.n;
  const hi = c % n, hj = (c - hi) / n;
  const fx = x - hi, fz = z - hj;
  let sub = 0, band: number, bandH: number;
  if (kind === PK_WALL) {
    const along = dir <= 1 ? fz : fx;
    sub = fine && along >= 0.5 ? 1 : 0;
    bandH = fine ? 0.6 : 1.2;
    band = Math.floor((y + 12) / bandH);
  } else {
    if (fine) sub = (fx >= 0.5 ? 1 : 0) + (fz >= 0.5 ? 2 : 0);
    bandH = 0.25;
    band = Math.floor((y + 12) * 4);
    dir = 0;
  }
  band = band < 0 ? 0 : band > 127 ? 127 : band;
  const key = ((((band * 4 + dir) * 4 + sub) * 2 + (fine ? 1 : 0)) * 3 + kind) * 1024 + g.local[c];
  const tab = job.patchTab[g.slot[c]];
  const found = tab.map.get(key);
  if (found !== undefined) { pref.e = tab.e; pref.o = found; return; }

  // ---- patch centre and normal
  let px: number, pz: number, nx = 0, ny = 0, nz = 0;
  let py = (band + 0.5) * bandH - 12;
  const tower = isTowerCell(job, c);
  if (kind === PK_WALL) {
    const a = fine ? 0.25 + 0.5 * sub : 0.5; // dyadic offsets keep patch centres exact in every halo frame
    if (dir === 0) { px = hi + 0.078125; pz = hj + a; } else if (dir === 1) { px = hi + 0.921875; pz = hj + a; }
    else if (dir === 2) { px = hi + a; pz = hj + 0.078125; } else { px = hi + a; pz = hj + 0.921875; }
    nx = WALL_NX[dir]; nz = WALL_NZ[dir];
    // patch rectangle: the band's wall strip, clipped to the cell's open height (at least 0.1 m around the centre)
    let v0 = band * bandH - 12, v1 = v0 + bandH;
    if (!tower) {
      const fl = g.blockTop[c] > g.floor[c] ? g.blockTop[c] : g.floor[c];
      const lo = fl + 0.05, hiY = g.ceil[c] - 0.05;
      py = py < lo ? lo : py > hiY ? hiY : py;
      if (v0 < fl) v0 = fl;
      if (v1 > g.ceil[c]) v1 = g.ceil[c];
      if (v1 - v0 < 0.1) { v0 = py - 0.05; v1 = py + 0.05; }
    }
    const ha = fine ? 0.25 : 0.5; // half-extent along the wall (cells)
    rAx = dir <= 1 ? 0 : 2; rS = dir <= 1 ? nx : nz; rP = dir <= 1 ? px : pz;
    rU0 = (dir <= 1 ? pz : px) - ha; rU1 = rU0 + 2 * ha; rV0 = v0; rV1 = v1;
  } else {
    if (fine) { px = hi + 0.25 + 0.5 * (sub & 1); pz = hj + 0.25 + 0.5 * (sub >> 1); } else { px = hi + 0.5; pz = hj + 0.5; }
    ny = kind === PK_FLOOR ? 1 : -1;
    // patch rectangle: the real floor (or blocker top) / ceiling when it lies in the band, else the band centre
    const b0 = band * bandH - 12, b1 = b0 + bandH;
    let yP = py;
    if (kind === PK_FLOOR) {
      if (g.floor[c] >= b0 && g.floor[c] < b1) yP = g.floor[c];
      else if (g.blockTop[c] >= b0 && g.blockTop[c] < b1) yP = g.blockTop[c];
    } else if (g.ceil[c] >= b0 && g.ceil[c] < b1) yP = g.ceil[c];
    const ha = fine ? 0.25 : 0.5;
    rAx = 1; rS = ny; rP = yP;
    rU0 = px - ha; rU1 = px + ha; rV0 = pz - ha; rV1 = pz + ha;
  }
  // ---- direct irradiance
  const L = job.L;
  const group = g.group[c];
  let er = 0, eg = 0, eb = 0, d0 = 0, d1 = 0, d2 = 0, d3 = 0;
  if ((g.flags[c] & CellFlag.SOLID) === 0) {
    const ext = fine ? 0.3 : 0.6;
    const m = selectLights(job, px, py, pz, nx, ny, nz, c, group, ext, tower ? FILTER_NONE : FILTER_CELL, sel);
    const layer = tower ? 0 : kind === PK_FLOOR ? 3 : kind === PK_CEIL ? 4 : nearestBit(job, c, py);
    // dynamic lights (never in the static RGB): luminance per flicker channel, same visibility and form factor
    const md = selectDynamic(job, px, py, pz, group, dsel);
    for (let i = 0; i < md; i++) {
      const l = dsel[i];
      const f = L.shape[l] === SHAPE_RECT ? formFactor(L, l, px, py, pz, nx, ny, nz, PATCH_EXACT) : meanFactor(L, l);
      if (f <= 0) continue;
      const o = l * 3;
      if (tower) {
        if (occluded(g, px + nx * 0.0078125, py + ny * 0.01, pz + nz * 0.0078125, L.vis[o], L.vis[o + 1], L.vis[o + 2], group, true)) continue;
      } else if (((visBits(job, l, c) >> layer) & 1) === 0) continue;
      const w = windowW(windowDist2((L.pos[o] - px) * CELL, L.pos[o + 1] - py, (L.pos[o + 2] - pz) * CELL, L.hAllow[l]), L.invR2[l]);
      const Y = f * w * L.radLum[l];
      const ch = L.channel[l];
      if (ch === 0) d0 += Y; else if (ch === 1) d1 += Y; else if (ch === 2) d2 += Y; else if (ch === 3) d3 += Y;
    }
    if (!tower) { // K_MAX tail (weak lights beyond the K strongest), bitset visibility
      tailSum(job, px, py, pz, nx, ny, nz, c, 1 << layer);
      er += tail.r; eg += tail.g; eb += tail.b;
    }
    for (let i = 0; i < m; i++) {
      const l = sel[i];
      const f = L.shape[l] === SHAPE_RECT ? formFactor(L, l, px, py, pz, nx, ny, nz, PATCH_EXACT) : meanFactor(L, l);
      if (f <= 0) continue;
      const o = l * 3;
      if (tower) {
        if (occluded(g, px + nx * 0.0078125, py + ny * 0.01, pz + nz * 0.0078125, L.vis[o], L.vis[o + 1], L.vis[o + 2], group, true)) continue;
      } else if (((visBits(job, l, c) >> layer) & 1) === 0) continue;
      const w = windowW(windowDist2((L.pos[o] - px) * CELL, L.pos[o + 1] - py, (L.pos[o + 2] - pz) * CELL, L.hAllow[l]), L.invR2[l]);
      const k = f * w;
      er += k * L.rad[o]; eg += k * L.rad[o + 1]; eb += k * L.rad[o + 2];
    }
  }
  // ---- direct sun (SKYLIGHT_HALL glazing): the centre direction from 4 points spread over the patch, so a patch
  // half in a sun patch bounces half of it
  if (job.sun !== null && group === 0 && (g.flags[c] & CellFlag.SOLID) === 0 && nx * job.sun.dx + ny * job.sun.dy + nz * job.sun.dz > 0) {
    const hs = (fine ? 0.25 : 0.5) * 0.5; // quarter of the patch size, halo cells
    let sr = 0, sg = 0, sb = 0;
    for (let k = 0; k < 4; k++) {
      const a = k & 1 ? hs : -hs, b = k & 2 ? hs : -hs;
      let qx = px, qy = py, qz = pz;
      if (kind === PK_WALL) { if (dir <= 1) qz += a; else qx += a; qy += b * CELL; }
      else { qx += a; qz += b; }
      sunAt(job, qx, qy, qz, nx, ny, nz, group, 1);
      sr += sunOut.r; sg += sunOut.g; sb += sunOut.b;
    }
    er += 0.25 * sr; eg += 0.25 * sg; eb += 0.25 * sb;
  }
  const off = tab.n;
  tab.e = growF32(tab.e, off + PATCH_STRIDE);
  tab.e[off] = er; tab.e[off + 1] = eg; tab.e[off + 2] = eb;
  tab.e[off + PATCH_DYN] = d0; tab.e[off + PATCH_DYN + 1] = d1; tab.e[off + PATCH_DYN + 2] = d2; tab.e[off + PATCH_DYN + 3] = d3;
  tab.n = off + PATCH_STRIDE;
  tab.map.set(key, off);
  job.diag.patches++;
  pref.e = tab.e; pref.o = off;
}
