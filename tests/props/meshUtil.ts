// tests/props/meshUtil.ts — geometry checks shared by the WP6 tests (bounds, winding vs normals, sampled ray
// tests for outward normals, NaN / index / degenerate checks) and a tiny fake LayoutNeighborhood.

import { CellFlag, type StoreyId, type ZoneId } from '../../src/core/ids.ts';
import type { ChunkLayout, Fixture, Solid } from '../../src/core/layout.ts';
import type { MeshBuffers } from '../../src/core/mesh.ts';
import type { LayoutNeighborhood, WorldGen } from '../../src/core/world.ts';
import { makeNeighborhood } from '../../src/world/neighborhood.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';

export interface Tri { a: number; b: number; c: number }

export function triNormal(m: MeshBuffers, t: number, out: number[]): number {
  const P = m.position, I = m.index;
  const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
  const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
  const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const l = Math.hypot(nx, ny, nz);
  out[0] = nx / (l || 1); out[1] = ny / (l || 1); out[2] = nz / (l || 1);
  return l / 2; // area
}

/** Basic validity: finite attributes, indices in range, no degenerate triangles. Returns a list of problems. */
export function validate(m: MeshBuffers, minArea = 1e-10): string[] {
  const bad: string[] = [];
  for (let i = 0; i < m.position.length; i++) if (!Number.isFinite(m.position[i])) { bad.push(`NaN position @${i}`); break; }
  for (let i = 0; i < m.uv.length; i++) if (!Number.isFinite(m.uv[i])) { bad.push(`NaN uv @${i}`); break; }
  for (let i = 0; i < m.emit.length; i++) if (!Number.isFinite(m.emit[i]) || m.emit[i] < 0) { bad.push(`bad emit @${i}`); break; }
  for (let i = 0; i < m.index.length; i++) if (m.index[i] >= m.vertexCount) { bad.push(`index out of range @${i}`); break; }
  if (m.index.length % 3) bad.push('index count not a multiple of 3');
  const n = [0, 0, 0];
  let degenerate = 0;
  for (let t = 0; t < m.indexCount / 3; t++) if (triNormal(m, t, n) < minArea) degenerate++;
  if (degenerate) bad.push(`${degenerate} degenerate triangles`);
  for (let v = 0; v < m.vertexCount; v++) {
    const l = Math.hypot(m.normal[v * 4], m.normal[v * 4 + 1], m.normal[v * 4 + 2]) / 127;
    if (Math.abs(l - 1) > 0.02) { bad.push(`normal not unit @${v} (${l.toFixed(3)})`); break; }
  }
  return bad;
}

/** Fraction of triangles whose winding disagrees with their (averaged) vertex normals. */
export function windingMismatch(m: MeshBuffers): number {
  const n = [0, 0, 0];
  let bad = 0;
  const T = m.indexCount / 3;
  for (let t = 0; t < T; t++) {
    triNormal(m, t, n);
    let sx = 0, sy = 0, sz = 0;
    for (let k = 0; k < 3; k++) {
      const v = m.index[t * 3 + k];
      sx += m.normal[v * 4]; sy += m.normal[v * 4 + 1]; sz += m.normal[v * 4 + 2];
    }
    if (n[0] * sx + n[1] * sy + n[2] * sz <= 0) bad++;
  }
  return T ? bad / T : 0;
}

/** Sampled ray test: from each sampled triangle's centroid, cast along its geometric normal; if the first hit is
 * the BACK of another triangle, the start was inside a closed part (normal pointing inward). Returns the
 * fraction of sampled triangles with an inward-looking normal. */
export function inwardFraction(m: MeshBuffers, maxSamples = 400): number {
  const T = m.indexCount / 3;
  if (T === 0) return 0;
  const step = Math.max(1, Math.floor(T / maxSamples));
  const P = m.position, I = m.index;
  // precompute triangle data
  const tv = new Float64Array(T * 12);
  const n = [0, 0, 0];
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    triNormal(m, t, n);
    tv.set([P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2], n[0], n[1], n[2]], t * 12);
  }
  let samples = 0, inward = 0;
  for (let t = 0; t < T; t += step) {
    const o = t * 12;
    const dx = tv[o + 9], dy = tv[o + 10], dz = tv[o + 11];
    const ox = (tv[o] + tv[o + 3] + tv[o + 6]) / 3 + dx * 2e-4;
    const oy = (tv[o + 1] + tv[o + 4] + tv[o + 7]) / 3 + dy * 2e-4;
    const oz = (tv[o + 2] + tv[o + 5] + tv[o + 8]) / 3 + dz * 2e-4;
    let best = Infinity, bestFacing = 0;
    for (let s = 0; s < T; s++) {
      if (s === t) continue;
      const q = s * 12;
      const e1x = tv[q + 3] - tv[q], e1y = tv[q + 4] - tv[q + 1], e1z = tv[q + 5] - tv[q + 2];
      const e2x = tv[q + 6] - tv[q], e2y = tv[q + 7] - tv[q + 1], e2z = tv[q + 8] - tv[q + 2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) continue;
      const inv = 1 / det;
      const sx = ox - tv[q], sy = oy - tv[q + 1], sz = oz - tv[q + 2];
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (d > 1e-5 && d < best) { best = d; bestFacing = tv[q + 9] * dx + tv[q + 10] * dy + tv[q + 11] * dz; }
    }
    samples++;
    if (best < Infinity && bestFacing > 0) inward++;
  }
  return inward / samples;
}

export function bounds(m: MeshBuffers): [number, number, number, number, number, number] {
  const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.vertexCount; i++) {
    for (let k = 0; k < 3; k++) {
      const v = m.position[i * 3 + k];
      if (v < b[k]) b[k] = v;
      if (v > b[k + 3]) b[k + 3] = v;
    }
  }
  return b;
}

/** Minimal LayoutNeighborhood over a single centre layout (everything outside it is SOLID). */
export function fakeNeighborhood(center: ChunkLayout, extraSolids: readonly Solid[] = []): LayoutNeighborhood {
  const inC = (li: number, lj: number): boolean => li >= 0 && lj >= 0 && li < 32 && lj < 32;
  const k = (li: number, lj: number): number => lj * 32 + li;
  return {
    center,
    get: () => center,
    flags: (li, lj) => (inC(li, lj) ? center.flags[k(li, lj)] : CellFlag.SOLID),
    floorCm: (li, lj) => (inC(li, lj) ? center.floorCm[k(li, lj)] : 0),
    ceilCm: (li, lj) => (inC(li, lj) ? center.ceilCm[k(li, lj)] : 270),
    blockCm: (li, lj) => (inC(li, lj) ? center.blockCm[k(li, lj)] : 0),
    waterCm: (li, lj) => (inC(li, lj) ? center.waterCm[k(li, lj)] : -32768),
    room: () => 1,
    region: () => 1,
    exKind: () => 0,
    ezKind: () => 0,
    exH: () => [0, 0],
    ezH: () => [0, 0],
    fixturesNear: (_x: number, _z: number, _r: number, out: Fixture[]) => { out.length = 0; return 0; },
    solids: () => [...center.solids, ...extraSolids],
  };
}

/** Outside-visibility test for whole props (open and interpenetrating parts allowed): cast parallel rays from
 * nDirs directions (Fibonacci sphere) on a grid x grid lattice covering the bounds; the first surface each ray
 * hits must face the ray (front face). Returns { rays that hit, fraction whose first hit was a back face }. */
export function backfaceVisibility(m: MeshBuffers, nDirs = 32, grid = 10, skip?: (dx: number, dy: number, dz: number) => boolean): { hits: number; backFrac: number } {
  const T = m.indexCount / 3;
  const P = m.position, I = m.index;
  const tv = new Float64Array(T * 12);
  const n = [0, 0, 0];
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    triNormal(m, t, n);
    tv.set([P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2], n[0], n[1], n[2]], t * 12);
  }
  const bb = bounds(m);
  const cx = (bb[0] + bb[3]) / 2, cy = (bb[1] + bb[4]) / 2, cz = (bb[2] + bb[5]) / 2;
  const R = Math.hypot(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]) / 2 + 0.01;
  let hits = 0, back = 0;
  for (let d = 0; d < nDirs; d++) {
    const yy = 1 - (2 * (d + 0.5)) / nDirs, rr = Math.sqrt(1 - yy * yy), ph = d * 2.399963229728653;
    const dx = -rr * Math.cos(ph), dy = -yy, dz = -rr * Math.sin(ph); // ray direction (toward the centre)
    if (skip?.(dx, dy, dz)) continue;
    // basis perpendicular to d
    let ux = -dz, uy = 0, uz = dx;
    if (Math.hypot(ux, uz) < 1e-6) { ux = 1; uz = 0; }
    const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
    for (let gi = 0; gi < grid; gi++) {
      for (let gj = 0; gj < grid; gj++) {
        const s = ((gi + 0.5) / grid * 2 - 1) * R, t2 = ((gj + 0.5) / grid * 2 - 1) * R;
        const ox = cx - dx * 2 * R + ux * s + vx * t2, oy = cy - dy * 2 * R + uy * s + vy * t2, oz = cz - dz * 2 * R + uz * s + vz * t2;
        let best = Infinity, facing = 0;
        for (let q = 0; q < T * 12; q += 12) {
          const e1x = tv[q + 3] - tv[q], e1y = tv[q + 4] - tv[q + 1], e1z = tv[q + 5] - tv[q + 2];
          const e2x = tv[q + 6] - tv[q], e2y = tv[q + 7] - tv[q + 1], e2z = tv[q + 8] - tv[q + 2];
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-14) continue;
          const inv = 1 / det;
          const sx = ox - tv[q], sy = oy - tv[q + 1], sz = oz - tv[q + 2];
          const u = (sx * px + sy * py + sz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (dist > 0 && dist < best) { best = dist; facing = tv[q + 9] * dx + tv[q + 10] * dy + tv[q + 11] * dz; }
        }
        if (best < Infinity) { hits++; if (facing > 0) back++; }
      }
    }
  }
  return { hits, backFrac: hits ? back / hits : 0 };
}

const gens = new Map<string, WorldGen>();
/** 3x3 neighbourhood of chunk (s, cx, cz) from the real world generator (WP1-4), optionally with a forced zone. */
export function genNb(seed: number, s: StoreyId, cx: number, cz: number, forceZone: ZoneId | null = null): LayoutNeighborhood {
  const k = `${seed}|${forceZone}`;
  let g = gens.get(k);
  if (!g) {
    g = createWorldGen({ seed, seedText: String(seed), forceZone, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' });
    gens.set(k, g);
  }
  const ls: ChunkLayout[] = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) ls.push(g.generateChunk({ s, cx: cx + dx, cz: cz + dz }));
  return makeNeighborhood(ls);
}

/** Triangles on atlas layers (SIGNAGE 23, DECAL_ATLAS 24) whose uv mapping is mirrored as seen from their front
 * (the side the winding / normal faces): for a readable glyph, +u is the viewer's right and +v up, i.e. the uv-space
 * signed area of a counter-clockwise (front) triangle is positive. Returns the number of mirrored triangles. */
export function mirroredAtlasTris(m: MeshBuffers, layers: readonly number[] = [23, 24]): number {
  let bad = 0;
  for (let t = 0; t < m.indexCount / 3; t++) {
    const a = m.index[t * 3], b = m.index[t * 3 + 1], c = m.index[t * 3 + 2];
    if (!layers.includes(m.layer[a])) continue;
    const du1 = m.uv[b * 2] - m.uv[a * 2], dv1 = m.uv[b * 2 + 1] - m.uv[a * 2 + 1];
    const du2 = m.uv[c * 2] - m.uv[a * 2], dv2 = m.uv[c * 2 + 1] - m.uv[a * 2 + 1];
    if (du1 * dv2 - du2 * dv1 <= 0) bad++;
  }
  return bad;
}
