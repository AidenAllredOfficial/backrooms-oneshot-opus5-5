// src/bake/ao.ts — analytic ambient occlusion (WP7 §Algorithms 6, AO). Pure module.
//
// AO = prod (1 - 0.5 / (1 + (d / 0.25)^2)) over the nearby planes in front of the receiver:
//   - occluding edge faces within 1 cell (edges that occlude at the receiver height, and cell sides facing a SOLID,
//     out-of-group, blocker or higher-floor neighbour), distance to the face segment (rounded at its ends);
//   - the owner's floor and ceiling planes;
//   - occluder box faces (solids and PROP_OCCLUDERS parts) within 0.6 m;
// plus contact AO under every COLLIDE prop footprint: strength 0.5 at (and under) the footprint edge, falling off
// smoothly to 0 at 0.3 m beyond it. AO multiplies the indirect term only and is stored in irr.a.
// Full bakes with the near-field gather (nearfield.ts, bakeNearRays > 0) leave out the prop part boxes and the
// contact AO of footprints whose prop has part boxes (`skipProps`): the traced rays see those boxes exactly.
// The light volume uses a spherical variant (no hemisphere test, strength 0.35).
// Side results: `aoOut.wall` (product over walls only, for the grime mask) and `aoOut.wallDist` (m).
// Wall faces are accumulated per wall LINE (axis + line index; a receiver sees one side of a line): the edge
// segments of one straight line contribute their minimum distance ONCE. Multiplying per 1.2 m segment darkened
// receivers near every segment joint twice (a lumpy 1.2 m-periodic band along ceiling-wall junctions).

import { CELL, WALL_T } from '../core/constants.ts';
import { EDGE_OCCLUDES, edgeOccludesAt, edgeThickness } from '../core/edges.ts';
import { CellFlag } from '../core/ids.ts';
import { AO_STRIDE, type BakeJob } from './job.ts';
import { MAT_PROP } from './visgrid.ts';

export const aoOut = { ao: 1, wall: 1, wallDist: 10 };

const K2 = 1 / (0.25 * 0.25);
const lineD = new Float64Array(8);
const fac = (d: number, s: number): number => 1 - s / (1 + d * d * K2);

// ---- per-cell list of the occluder boxes bucketed in its 3x3 cells, each box once (in the (dj, di, bucket) order
// of its first cell inside the window), built lazily per VisGrid: aoAt visits the list instead of re-deduplicating
// the 9 buckets at every receiver.
let bxJob: BakeJob | null = null;
let bxStart = new Int32Array(0); // per cell: -1 = not built, else offset into bxList (count at bxList[offset])
let bxList = new Int32Array(1024);
let bxLen = 0;
/** The list `boxesAround` offsets point into (read it after the call: building a list may reallocate it). */
export const boxesAroundList = (): Int32Array => bxList;
/** Offset into `boxesAroundList()` of cell c's list of the occluder boxes bucketed in its 3x3 cells, each once
 * (count at the offset, box indices after it). Every box a segment from inside cell c can reach within 1 cell
 * is on it. */
export function boxesAround(job: BakeJob, c: number): number {
  const g = job.g, n = g.n;
  if (bxJob !== job) {
    bxJob = job;
    if (bxStart.length < n * n) bxStart = new Int32Array(n * n);
    bxStart.fill(-1, 0, n * n);
    bxLen = 0;
  }
  const s0 = bxStart[c];
  if (s0 >= 0) return s0;
  const hi = c % n, hj = (c - hi) / n;
  const at = bxLen;
  let cnt = 0;
  for (let dj = -1; dj <= 1; dj++) {
    const j = hj + dj;
    if (j < 0 || j >= n) continue;
    for (let di = -1; di <= 1; di++) {
      const i = hi + di;
      if (i < 0 || i >= n) continue;
      const cc = j * n + i;
      for (let k = g.boxStart[cc], ke = g.boxStart[cc + 1]; k < ke; k++) {
        const b = g.boxList[k], o = b * 6;
        const bi0 = Math.max(Math.floor(g.box[o]), hi - 1), bj0 = Math.max(Math.floor(g.box[o + 2]), hj - 1);
        if (i !== bi0 || j !== bj0) continue;
        if (at + 2 + cnt > bxList.length) { const nl = new Int32Array(bxList.length * 2); nl.set(bxList); bxList = nl; }
        bxList[at + 1 + cnt++] = b;
      }
    }
  }
  if (at + 1 > bxList.length) { const nl = new Int32Array(bxList.length * 2); nl.set(bxList); bxList = nl; }
  bxList[at] = cnt;
  bxLen = at + 1 + cnt;
  bxStart[c] = at;
  return at;
}

/** Does cell nc act as a wall (seen from a receiver of `group`) at height y? */
function cellBarrier(job: BakeJob, nc: number, y: number, group: number): boolean {
  const g = job.g;
  if ((g.flags[nc] & CellFlag.SOLID) !== 0) return true;
  if (g.group[nc] !== group && ((g.flags[nc] & CellFlag.TOWER) !== 0 || group !== 0)) return true;
  return y < g.floor[nc] - 0.01 || y > g.ceil[nc] + 0.01 || y < g.blockTop[nc];
}

/** Could the barrier status of 4-neighbour cells a and b differ at some height / for some group? */
function cellsDiffer(job: BakeJob, a: number, b: number): boolean {
  const g = job.g;
  return ((g.flags[a] ^ g.flags[b]) & (CellFlag.SOLID | CellFlag.TOWER)) !== 0 || g.group[a] !== g.group[b] ||
    g.floor[a] !== g.floor[b] || g.ceil[a] !== g.ceil[b] || g.blockTop[a] !== g.blockTop[b];
}

/** Build the AO candidate list of cell c: edges within the 3x3 neighbourhood that may act as walls. */
function buildCandidates(job: BakeJob, c: number): void {
  const g = job.g, n = g.n;
  const hi = c % n, hj = (c - hi) / n;
  const L = job.aoList, base = c * AO_STRIDE;
  let m = 0;
  for (let X = hi - 1; X <= hi + 2; X++) {
    if (X < 0 || X > n) continue;
    for (let r = hj - 1; r <= hj + 1; r++) {
      if (r < 0 || r >= n) continue;
      const e = r * (n + 1) + X;
      const k = g.exKind[e];
      if ((k !== 0 && EDGE_OCCLUDES[k]) || (X > 0 && X < n && cellsDiffer(job, r * n + X - 1, r * n + X))) L[base + 1 + m++] = e * 2;
    }
  }
  for (let Z = hj - 1; Z <= hj + 2; Z++) {
    if (Z < 0 || Z > n) continue;
    for (let col = hi - 1; col <= hi + 1; col++) {
      if (col < 0 || col >= n) continue;
      const e = Z * n + col;
      const k = g.ezKind[e];
      if ((k !== 0 && EDGE_OCCLUDES[k]) || (Z > 0 && Z < n && cellsDiffer(job, (Z - 1) * n + col, Z * n + col))) L[base + 1 + m++] = e * 2 + 1;
    }
  }
  L[base] = m;
  let boxes = 0;
  for (let dj = -1; dj <= 1 && boxes === 0; dj++) {
    const j = hj + dj;
    if (j < 0 || j >= n) continue;
    for (let di = -1; di <= 1; di++) {
      const i = hi + di;
      if (i >= 0 && i < n && job.boxCount[j * n + i] > 0) { boxes = 1; break; }
    }
  }
  L[base + AO_STRIDE - 1] = boxes;
  job.aoDone[c] = 1;
}

/**
 * AO at (x, y, z) (halo cells / m), unit normal n, owner cell c. `spherical`: light-volume variant. `skipProps`:
 * leave out the prop boxes and the contact AO of footprints with prop boxes (the near-field gather traces them).
 * Result in aoOut.
 */
export function aoAt(job: BakeJob, x: number, y: number, z: number, nx: number, ny: number, nz: number, c: number, group: number, spherical: boolean, skipProps = false): void {
  const g = job.g, n = g.n;
  const s = spherical ? 0.35 : 0.5;
  let ao = 1, wall = 1, wd = 10;
  const tower = (g.flags[c] & CellFlag.TOWER) !== 0 && group !== 0;
  if (job.aoDone[c] === 0) buildCandidates(job, c);
  const AL = job.aoList, base = c * AO_STRIDE;
  const cnt = AL[base];
  const hi = c % n, hj = (c - hi) / n;
  // min face distance per candidate line: x-lines X = hi-1 .. hi+2, z-lines Z = hj-1 .. hj+2
  lineD[0] = lineD[1] = lineD[2] = lineD[3] = lineD[4] = lineD[5] = lineD[6] = lineD[7] = Infinity;
  for (let q = 0; q < cnt; q++) {
    const code = AL[base + 1 + q];
    const e = code >> 1;
    if ((code & 1) === 0) {
      // ---- x-line X, row r
      const r = (e / (n + 1)) | 0, X = e - r * (n + 1);
      const t = (z < r ? 0 : z > r + 1 ? 1 : z - r); // closest along (cells)
      const k = g.exKind[e];
      let isWall = k !== 0 && EDGE_OCCLUDES[k] && edgeOccludesAt(k, g.exA[e], g.exB[e], t * CELL, y, g.exSill[e]);
      let half = isWall ? edgeThickness(k) / 2 : 0;
      if (!isWall && X > 0 && X < n) {
        const a = r * n + X - 1, b = a + 1;
        const ba = cellBarrier(job, a, y, group), bb = cellBarrier(job, b, y, group);
        if (ba !== bb) { isWall = true; half = 0; }
      }
      if (!isWall) continue;
      const dxm = (X - x) * CELL, dzm = (r + t - z) * CELL;
      // the face towards the receiver lies `half` in front of the line
      const side = dxm > 0 ? -1 : 1;
      const fx = dxm + side * half;
      if (!spherical && nx * fx + nz * dzm < -0.005) continue; // behind the receiver (e.g. its own wall)
      if ((dxm > 0 && fx < -0.001) || (dxm < 0 && fx > 0.001)) continue; // receiver inside the wall thickness zone
      const d = Math.sqrt(fx * fx + dzm * dzm);
      if (d > CELL * 1.25) continue;
      const li = X - hi + 1;
      if (d < lineD[li]) lineD[li] = d;
    } else {
      // ---- z-line Z, column col
      const Z = (e / n) | 0, col = e - Z * n;
      const t = (x < col ? 0 : x > col + 1 ? 1 : x - col);
      const k = g.ezKind[e];
      let isWall = k !== 0 && EDGE_OCCLUDES[k] && edgeOccludesAt(k, g.ezA[e], g.ezB[e], t * CELL, y, g.ezSill[e]);
      let half = isWall ? edgeThickness(k) / 2 : 0;
      if (!isWall && Z > 0 && Z < n) {
        const a = (Z - 1) * n + col, b = a + n;
        const ba = cellBarrier(job, a, y, group), bb = cellBarrier(job, b, y, group);
        if (ba !== bb) { isWall = true; half = 0; }
      }
      if (!isWall) continue;
      const dzm = (Z - z) * CELL, dxm = (col + t - x) * CELL;
      const side = dzm > 0 ? -1 : 1;
      const fz = dzm + side * half;
      if (!spherical && nx * dxm + nz * fz < -0.005) continue;
      if ((dzm > 0 && fz < -0.001) || (dzm < 0 && fz > 0.001)) continue;
      const d = Math.sqrt(dxm * dxm + fz * fz);
      if (d > CELL * 1.25) continue;
      const li = 4 + Z - hj + 1;
      if (d < lineD[li]) lineD[li] = d;
    }
  }
  for (let k = 0; k < 8; k++) {
    const d = lineD[k];
    if (d === Infinity) continue;
    const f = fac(d, s);
    ao *= f; wall *= f;
    if (d < wd) wd = d;
  }
  // ---- floor and ceiling planes of the owner cell
  if (!tower) {
    const fl = g.blockTop[c] > g.floor[c] ? g.blockTop[c] : g.floor[c];
    if (spherical || ny < 0.5) { const d = y - fl; if (d > 0.03 || spherical) ao *= fac(d > 0 ? d : 0, s); }
    if (spherical || ny > -0.5) { const d = g.ceil[c] - y; if (d > 0.03 || spherical) ao *= fac(d > 0 ? d : 0, s); }
  }
  // ---- occluder boxes within 0.6 m
  if (AL[base + AO_STRIDE - 1] !== 0) {
    const at = boxesAround(job, c), bl = bxList;
    for (let k = at + 1, ke = at + 1 + bl[at]; k < ke; k++) {
      const b = bl[k];
      if (g.boxGroup[b] !== group || (skipProps && g.boxMat[b] === MAT_PROP)) continue;
      const o = b * 6;
      const qx = x < g.box[o] ? g.box[o] : x > g.box[o + 3] ? g.box[o + 3] : x;
      const qz = z < g.box[o + 2] ? g.box[o + 2] : z > g.box[o + 5] ? g.box[o + 5] : z;
      const dx = (qx - x) * CELL, dz = (qz - z) * CELL;
      if (dx * dx + dz * dz >= 0.36 + 1e-9) continue; // (d >= 0.6 whatever the height)
      const qy = y < g.box[o + 1] ? g.box[o + 1] : y > g.box[o + 4] ? g.box[o + 4] : y;
      const dy = qy - y;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= 0.6) continue;
      if (!spherical && nx * dx + ny * dy + nz * dz < -0.01) continue;
      if (d < 1e-4) continue; // receiver inside/on the box: handled by validity
      ao *= fac(d, s);
    }
  }
  // ---- contact AO (floor-like receivers)
  if (!spherical && ny > 0.9) {
    for (let k = g.contactStart[c], ke = g.contactStart[c + 1]; k < ke; k++) {
      const b = g.contactList[k];
      if (g.contactGroup[b] !== group || (skipProps && g.contactBox[b] !== 0)) continue;
      if (Math.abs(g.contactY[b] - (y - 0.02)) > 0.3) continue;
      const o = b * 4;
      const dx = x < g.contact[o] ? g.contact[o] - x : x > g.contact[o + 2] ? x - g.contact[o + 2] : 0;
      const dz = z < g.contact[o + 1] ? g.contact[o + 1] - z : z > g.contact[o + 3] ? z - g.contact[o + 3] : 0;
      const d = Math.sqrt(dx * dx + dz * dz) * CELL;
      if (d >= 0.3) continue;
      const u = 1 - d / 0.3;
      ao *= 1 - 0.5 * u * u * (3 - 2 * u);
    }
  }
  aoOut.ao = ao < 0.05 ? 0.05 : ao;
  aoOut.wall = wall;
  aoOut.wallDist = wd;
}

export const WALL_HALF = WALL_T / 2;
