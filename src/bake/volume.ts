// src/bake/volume.ts — per-tile prop light volume and wall mask (WP7 §Algorithms 11). Pure module.
//
// LV.NX x LV.NY x LV.NZ samples at tile-local ((i + 0.5) * STEP, LV.Y[k], (j + 0.5) * STEP), index
// ((j * NY + k) * NX + i) * 4 (Data3DTexture(NX, NY, NZ), accepted contract).
// Per sample: each static light as a directional delta (K_MAX strongest, irradiance at normal incidence, bitset
// visibility at the nearest layer; tower cells: one DDA ray, baked with the tower's own bake group so the WP9
// y-wrap reads periodic values) plus the indirect term (probe SH, full; diffused radiosity, preview) x the
// spherical AO, with per-channel multi-bounce (indirect.ts). Near-field samples (full bake with q.nearRays > 0, a
// prop box within NEAR.R, nearfield.ts): lights a box could cut off (or hide from the bitset's cell-centre point)
// get one DDA ray from the sample itself instead of the cell bitset (a chair under a desk is in the desk's shadow,
// a monitor above it is not), the probe SH is corrected by q.nearRays traced sphere rays (prop faces replace the far
// field they hide), and the stored AO drops by the rays' box-hit fraction; full bakes with q.nearRays > 0 leave
// out the analytic AO of prop boxes. Encoding (consistent with the shell lightmap decode in WP9):
//   a.rgb = total irradiance on a surface facing the dominant direction's light (sum of the light deltas' E plus
//           the L0 (direction-averaged) indirect irradiance), a.a = spherical AO;
//   b.xyz = normalized luminance-weighted dominant direction * 0.5 + 0.5 (direct deltas + the indirect L1 vector),
//   b.w   = directionality |V| / E in [0, 1];
//   c     = per-channel dynamic luminance (direct + bounce: probe L0 in the full bake, the per-light constant in
//           the preview), only when the tile has dynamic light.
// Samples inside solids are invalid and dilated (6-neighbour average, repeated).
// wallMask: 18 x 18 (tile cells + ring), r = bits N1 E2 S4 W8 of the cell sides that occlude at 1.2 m above the
// higher floor (or face a SOLID / out-of-group neighbour).

import { CELL, LV } from '../core/constants.ts';
import { EDGE_OCCLUDES, edgeOccludesAt } from '../core/edges.ts';
import { HALF_MAX, toHalf } from '../core/half.ts';
import { CellFlag } from '../core/ids.ts';
import { NO_WATER } from '../core/layout.ts';
import type { BakeTerm } from '../core/worker.ts';
import { formFactor } from './areaLight.ts';
import { aoAt, aoOut } from './ao.ts';
import { addBounce, addDynIndirect, type DynInfo } from './channels.ts';
import { FILTER_CELL, FILTER_NONE, boxesBetween, isTowerCell, lightLowY, selectDynamic, selectLights, tail, tailSum } from './classify.ts';
import { occluded } from './dda.ts';
import { dynIndirectL0, interp, interpolateProbes, multiBounce } from './indirect.ts';
import { nearestBit, type BakeJob } from './job.ts';
import { nearSphereCorrect, nearWeight } from './nearfield.ts';
import { diffusedAt, type Diffusion } from './preview.ts';
import type { ProbeSet } from './probes.ts';
import { SH_E1, shIrradianceL0 } from './sh.ts';
import { HALO_OFF, LB, LG, LR, luma, quant, windowDist2, windowW } from './util.ts';
import { insideBox } from './visgrid.ts';
import { visBits } from './visbits.ts';

const sel = new Int32Array(16);
const dsel = new Int32Array(16);
const tmp3 = new Float64Array(3);
const fl4 = new Float64Array(4);
const dyn4 = new Float64Array(4);

const clampH = (v: number): number => toHalf(v > HALF_MAX ? HALF_MAX : v < 0 ? 0 : v);

export interface VolumeOut { a: Uint16Array; b: Uint8Array; c: Uint16Array | null; wallMask: Uint8Array }

/** `nearRays`: the full bake's near-field rays (0 = off, and for preview bakes). */
export function bakeVolume(job: BakeJob, P: ProbeSet | null, D: Diffusion | null, dyn: DynInfo | null, term: BakeTerm, nearRays = 0): VolumeOut {
  const g = job.g, n = g.n, L = job.L;
  const NX = LV.NX, NY = LV.NY, NZ = LV.NZ;
  const ns = NX * NY * NZ;
  const E = new Float64Array(ns * 3), V = new Float64Array(ns * 3), AO = new Float64Array(ns), F = dyn ? new Float64Array(ns * 4) : null;
  const valid = new Uint8Array(ns);
  const doDirect = term !== 'indirect', doInd = term !== 'direct';
  for (let j = 0; j < NZ; j++) {
    const z = HALO_OFF + quant(((j + 0.5) * LV.STEP) / CELL);
    for (let k = 0; k < NY; k++) {
      const y = LV.Y[k];
      for (let i = 0; i < NX; i++) {
        const s = (j * NY + k) * NX + i;
        const x = HALO_OFF + quant(((i + 0.5) * LV.STEP) / CELL);
        const c = Math.floor(z) * n + Math.floor(x);
        if ((g.flags[c] & CellFlag.SOLID) !== 0) continue;
        const group = g.group[c];
        const tower = isTowerCell(job, c);
        if (!tower) {
          const fl = g.blockTop[c] > g.floor[c] ? g.blockTop[c] : g.floor[c];
          if (y <= fl || y >= g.ceil[c]) continue;
        }
        if (insideBox(g, c, x, y, z, group)) continue;
        valid[s] = 1;
        const nw = nearRays > 0 && !tower ? nearWeight(job, c, x, y, z, 0, 0, 0, group, false) : 0;
        const near = nw > 0;
        aoAt(job, x, y, z, 0, 0, 0, c, group, true, nearRays > 0);
        const ao = aoOut.ao;
        AO[s] = ao;
        let er = 0, eg = 0, eb = 0, vx = 0, vy = 0, vz = 0;
        if (doDirect) {
          const m = selectLights(job, x, y, z, 0, 0, 0, c, group, 0, tower ? FILTER_NONE : FILTER_CELL, sel);
          const layer = tower ? 0 : nearestBit(job, c, y);
          if (!tower) { // K_MAX tail: weak lights as omni point deltas with bitset visibility
            tailSum(job, x, y, z, 0, 0, 0, c, 1 << layer, P === null);
            er += tail.r; eg += tail.g; eb += tail.b; vx += tail.vx; vy += tail.vy; vz += tail.vz;
          }
          for (let q = 0; q < m; q++) {
            const l = sel[q];
            const e = near ? lightDeltaNear(job, l, x, y, z, c, group, layer) : lightDelta(job, l, x, y, z, c, group, tower, layer);
            if (e <= 0) continue;
            const o = l * 3;
            er += e * L.rad[o]; eg += e * L.rad[o + 1]; eb += e * L.rad[o + 2];
            const el = e * L.radLum[l];
            vx += el * tmp3[0]; vy += el * tmp3[1]; vz += el * tmp3[2];
          }
          if (F) {
            const md = selectDynamic(job, x, y, z, group, dsel);
            let seen = 0;
            for (let q = 0; q < md; q++) {
              const l = dsel[q];
              const ch = L.channel[l];
              if ((seen & (1 << ch)) !== 0) throw new Error(`bakeTile: two dynamic lights of flicker channel ${ch} reach the same light-volume sample`);
              seen |= 1 << ch;
              const e = near ? lightDeltaNear(job, l, x, y, z, c, group, layer) : lightDelta(job, l, x, y, z, c, group, tower, layer);
              if (e > 0) F[s * 4 + ch] += e * L.radLum[l];
            }
          }
        }
        let aoDyn = ao;
        if (doInd) {
          dyn4.fill(0);
          if (P) {
            if (interpolateProbes(job, P, x, y, z, c, true, false)) {
              if (P.dyn) dynIndirectL0(dyn4);
              if (near) {
                aoDyn = ao * (1 - nearSphereCorrect(job, x, y, z, group, nearRays, k, interp.sh, nw));
                AO[s] = aoDyn;
              }
              const rho = interp.rho3;
              const mr = ao * multiBounce(rho[0]), mg = ao * multiBounce(rho[1]), mbb = ao * multiBounce(rho[2]);
              const mb = ao * multiBounce(luma(rho[0], rho[1], rho[2]));
              er += shIrradianceL0(interp.sh, 0) * mr; eg += shIrradianceL0(interp.sh, 4) * mg; eb += shIrradianceL0(interp.sh, 8) * mbb;
              // L1 luminance vector (SH order y, z, x)
              const c1 = LR * interp.sh[1] + LG * interp.sh[5] + LB * interp.sh[9];
              const c2 = LR * interp.sh[2] + LG * interp.sh[6] + LB * interp.sh[10];
              const c3 = LR * interp.sh[3] + LG * interp.sh[7] + LB * interp.sh[11];
              vx += SH_E1 * c3 * mb; vy += SH_E1 * c1 * mb; vz += SH_E1 * c2 * mb;
            }
          } else if (D) {
            diffusedAt(job, D, x, z, c, tmp3);
            er += Math.PI * tmp3[0] * ao; eg += Math.PI * tmp3[1] * ao; eb += Math.PI * tmp3[2] * ao;
          }
          if (F && dyn) {
            fl4.fill(0);
            if (P) addDynIndirect(job, x, y, z, group, dyn4, aoDyn, fl4);
            else addBounce(job, dyn, x, y, z, c, ao, fl4);
            for (let q = 0; q < 4; q++) F[s * 4 + q] += fl4[q];
          }
        }
        E[s * 3] = er; E[s * 3 + 1] = eg; E[s * 3 + 2] = eb;
        V[s * 3] = vx; V[s * 3 + 1] = vy; V[s * 3 + 2] = vz;
      }
    }
  }
  dilate3D(valid, [E, V, AO, F], [3, 3, 1, 4], NX, NY, NZ);
  const a = new Uint16Array(ns * 4), b = new Uint8Array(ns * 4), cOut = F ? new Uint16Array(ns * 4) : null;
  for (let s = 0; s < ns; s++) {
    const o = s * 4;
    a[o] = clampH(E[s * 3]); a[o + 1] = clampH(E[s * 3 + 1]); a[o + 2] = clampH(E[s * 3 + 2]); a[o + 3] = clampH(valid[s] ? AO[s] : AO[s] || 1);
    const vx = V[s * 3], vy = V[s * 3 + 1], vz = V[s * 3 + 2];
    const vl = Math.hypot(vx, vy, vz);
    const el = luma(E[s * 3], E[s * 3 + 1], E[s * 3 + 2]);
    let w = el > 1e-9 ? vl / el : 0;
    w = w > 1 ? 1 : w < 0 ? 0 : w;
    if (vl > 1e-12) {
      b[o] = Math.round((vx / vl * 0.5 + 0.5) * 255); b[o + 1] = Math.round((vy / vl * 0.5 + 0.5) * 255); b[o + 2] = Math.round((vz / vl * 0.5 + 0.5) * 255);
    } else { b[o] = 128; b[o + 1] = 255; b[o + 2] = 128; w = 0; }
    b[o + 3] = Math.round(w * 255);
    if (cOut && F) for (let q = 0; q < 4; q++) cOut[o + q] = clampH(F[s * 4 + q]);
  }
  return { a, b, c: cOut, wallMask: bakeWallMask(job) };
}

/** Irradiance factor (x radiance = E at normal incidence) of light l at a volume sample; direction in tmp3. */
function lightDelta(job: BakeJob, l: number, x: number, y: number, z: number, c: number, group: number, tower: boolean, layer: number): number {
  const L = job.L, o = l * 3;
  const dx = (L.pos[o] - x) * CELL, dy = L.pos[o + 1] - y, dz = (L.pos[o + 2] - z) * CELL;
  const w = windowW(windowDist2(dx, dy, dz, L.hAllow[l]), L.invR2[l]);
  if (w <= 0) return 0;
  if (tower) {
    if (occluded(job.g, x, y, z, L.vis[o], L.vis[o + 1], L.vis[o + 2], group, false)) return 0;
  } else if (((visBits(job, l, c) >> layer) & 1) === 0) return 0;
  const d = Math.hypot(dx, dy, dz) || 1e-6;
  const wx = dx / d, wy = dy / d, wz = dz / d;
  const f = formFactor(L, l, x, y, z, wx, wy, wz, 1.0);
  tmp3[0] = wx; tmp3[1] = wy; tmp3[2] = wz;
  return f * w;
}

/** lightDelta for near-field samples: when the sample's own cell holds a box rising above the sample or above the
 * bitset's cell-centre point at the nearest bit height (a chair under a desk; a monitor sample above a desk top that
 * hides the light from the bit below it; rack decks between the bits of a tall hall), and a box could cut the segment
 * to the emitter (classify.ts boxesBetween), one DDA ray from the sample to the emitter centre decides instead of
 * the bitset (like tower samples). */
function lightDeltaNear(job: BakeJob, l: number, x: number, y: number, z: number, c: number, group: number, layer: number): number {
  const yc = Math.min(y, job.cellY[c * 5 + layer]);
  const ray = job.boxTop[c] > yc && boxesBetween(job, c, l, Math.min(yc, lightLowY(job, l)));
  return lightDelta(job, l, x, y, z, c, group, ray, layer);
}

const nbs = new Int32Array(6);

/**
 * Iterative 6-neighbour dilation of invalid samples (each pass averages filled neighbours, Jacobi order).
 * Neighbours in the sample's OWN cell (LV.STEP = CELL / 2: cell = (i >> 1, j >> 1); the vertical neighbours always)
 * take precedence: a sample below a raised floor or inside a box must not average in the sample across the wall
 * (another room at another floor height), which the props shader's in-cell y interpolation would read. Only
 * samples with no filled same-cell neighbour (whole SOLID cells: never read, the wall mask clamps lookups inside
 * the fragment's own cell) average across cells.
 */
function dilate3D(valid: Uint8Array, arrs: (Float64Array | null)[], comps: number[], NX: number, NY: number, NZ: number): void {
  const ns = NX * NY * NZ;
  let filled = valid.slice();
  for (let pass = 0; pass < 12; pass++) {
    const next = filled.slice();
    let changed = 0, remaining = 0;
    for (let s = 0; s < ns; s++) {
      if (filled[s]) continue;
      const i = s % NX, k = ((s - i) / NX) % NY, j = Math.floor(s / (NX * NY));
      // same-cell neighbours first: vertical (k +- 1) and the in-cell horizontal partner along x / z
      nbs[0] = k > 0 ? s - NX : -1; nbs[1] = k < NY - 1 ? s + NX : -1;
      nbs[2] = (i & 1) === 0 ? (i + 1 < NX ? s + 1 : -1) : s - 1;
      nbs[3] = (j & 1) === 0 ? (j + 1 < NZ ? s + NX * NY : -1) : s - NX * NY;
      // other cells
      nbs[4] = (i & 1) === 0 ? (i > 0 ? s - 1 : -1) : (i + 1 < NX ? s + 1 : -1);
      nbs[5] = (j & 1) === 0 ? (j > 0 ? s - NX * NY : -1) : (j + 1 < NZ ? s + NX * NY : -1);
      let cnt = 0;
      for (let q = 0; q < 4; q++) { const t = nbs[q]; if (t >= 0 && filled[t]) cnt++; }
      let nUse = 4;
      if (cnt === 0) {
        nUse = 6;
        for (let q = 4; q < 6; q++) { const t = nbs[q]; if (t >= 0 && filled[t]) cnt++; }
      }
      if (cnt === 0) { remaining++; continue; }
      for (let a = 0; a < arrs.length; a++) {
        const arr = arrs[a];
        if (!arr) continue;
        const cc = comps[a];
        for (let q = 0; q < cc; q++) {
          let sum = 0;
          for (let r = 0; r < nUse; r++) { const t = nbs[r]; if (t >= 0 && filled[t]) sum += arr[t * cc + q]; }
          arr[s * cc + q] = sum / cnt;
        }
      }
      next[s] = 1;
      changed++;
    }
    filled = next;
    if (remaining === 0 || changed === 0) break;
  }
}

/** WaterRect kind (0 pool, 1 flooded, 2 film) of the water over neighbourhood cell (li, lj), or 0 when no rect
 * covers its centre (rects cover every water cell: world/zones/deepcommon.ts emitWaterRects). */
function waterKindAt(job: BakeJob, li: number, lj: number): number {
  const dcx = li < 0 ? -1 : li >= 32 ? 1 : 0, dcz = lj < 0 ? -1 : lj >= 32 ? 1 : 0;
  const l = job.nb.get(dcx, dcz);
  const x = (li - dcx * 32 + 0.5) * CELL, z = (lj - dcz * 32 + 0.5) * CELL;
  for (const w of l.water) {
    if (x >= Math.min(w.x0, w.x1) && x < Math.max(w.x0, w.x1) && z >= Math.min(w.z0, w.z1) && z < Math.max(w.z0, w.z1)) return w.kind;
  }
  return 0;
}

/** Wall mask texture: 18 x 18 RGBA8, r = N1 E2 S4 W8; package E's water channels: g/a = the cell's water surface
 * (waterCm + 32768: high byte, low byte), b = WaterRect kind + 1 (0 = dry or SOLID). Shaders: brWaterCell. */
export function bakeWallMask(job: BakeJob): Uint8Array {
  const g = job.g, n = g.n;
  const out = new Uint8Array(18 * 18 * 4);
  for (let lj = -1; lj <= 16; lj++) {
    for (let li = -1; li <= 16; li++) {
      const ni = job.li0 + li, nj = job.lj0 + lj;
      const w = job.nb.waterCm(ni, nj);
      if (w === NO_WATER || (job.nb.flags(ni, nj) & CellFlag.SOLID) !== 0) continue;
      const v = w + 32768, o = ((lj + 1) * 18 + (li + 1)) * 4;
      out[o + 1] = v >> 8;
      out[o + 2] = waterKindAt(job, ni, nj) + 1;
      out[o + 3] = v & 255;
    }
  }
  const occX = (X: number, row: number, y: number): boolean => {
    const e = row * (n + 1) + X, k = g.exKind[e];
    return k !== 0 && EDGE_OCCLUDES[k] && edgeOccludesAt(k, g.exA[e], g.exB[e], CELL / 2, y, g.exSill[e]);
  };
  const occZ = (Z: number, col: number, y: number): boolean => {
    const e = Z * n + col, k = g.ezKind[e];
    return k !== 0 && EDGE_OCCLUDES[k] && edgeOccludesAt(k, g.ezA[e], g.ezB[e], CELL / 2, y, g.ezSill[e]);
  };
  const barrier = (a: number, b: number): boolean =>
    (g.flags[b] & CellFlag.SOLID) !== 0 || (g.group[b] !== g.group[a] && ((g.flags[b] & CellFlag.TOWER) !== 0 || (g.flags[a] & CellFlag.TOWER) !== 0));
  for (let lj = -1; lj <= 16; lj++) {
    for (let li = -1; li <= 16; li++) {
      const hi = HALO_OFF + li, hj = HALO_OFF + lj, c = hj * n + hi;
      let bits = 0;
      const yN = Math.max(g.floor[c], g.floor[c - n]) + 1.2;
      const yS = Math.max(g.floor[c], g.floor[c + n]) + 1.2;
      const yW = Math.max(g.floor[c], g.floor[c - 1]) + 1.2;
      const yE = Math.max(g.floor[c], g.floor[c + 1]) + 1.2;
      if (occZ(hj, hi, yN) || barrier(c, c - n)) bits |= 1;
      if (occX(hi + 1, hj, yE) || barrier(c, c + 1)) bits |= 2;
      if (occZ(hj + 1, hi, yS) || barrier(c, c + n)) bits |= 4;
      if (occX(hi, hj, yW) || barrier(c, c - 1)) bits |= 8;
      out[((lj + 1) * 18 + (li + 1)) * 4] = bits;
    }
  }
  return out;
}
