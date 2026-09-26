// src/world/neighborhood.ts — makeNeighborhood: 3x3 chunk view (implements core LayoutNeighborhood) (WP1).
// Cell coords are relative to the CENTER chunk, valid in [-32, 64); edge line coords in [-32, 65).
// Accessors are allocation-free (except exH/ezH, whose contract returns a tuple). Light regions, translated
// fixtures and solids are computed lazily once per neighbourhood. fixturesNear uses a 4.8 m bucket grid over the
// halo, so bake-time queries touch only nearby fixtures.

import { CELL, CHUNK_CELLS, CHUNK_SIZE } from '../core/constants.ts';
import { EDGE_OCCLUDES, edgeSolidAt } from '../core/edges.ts';
import { cellIdx, exIdx, ezIdx } from '../core/grid.ts';
import { CellFlag } from '../core/ids.ts';
import { NO_WATER, type ChunkLayout, type EdgeGrid, type Fixture, type Solid } from '../core/layout.ts';
import type { LayoutNeighborhood } from '../core/world.ts';

const N = CHUNK_CELLS; // 32
const H = 3 * N; // 96: halo width in cells
const REGION_Y = 1.2; // m above the higher floor of the two cells

/** layouts: 9 entries, index (dcz+1)*3 + (dcx+1). */
export function makeNeighborhood(layouts: readonly ChunkLayout[]): LayoutNeighborhood {
  if (layouts.length !== 9) throw new Error(`makeNeighborhood: expected 9 layouts, got ${layouts.length}`);
  const center = layouts[4];
  const inHalo = (li: number, lj: number): boolean => li >= -N && lj >= -N && li < 2 * N && lj < 2 * N;
  // Layout index of the chunk containing halo cell (li, lj) (both in [-32, 64)); local cell = (li & 31, lj & 31).
  const cellL = (li: number, lj: number): number => ((lj >> 5) + 1) * 3 + (li >> 5) + 1;
  // Edge lookup scratch (no allocation): set by locEx / locEz.
  let eg: EdgeGrid = center.ex;
  let ek = 0;
  const locEx = (i: number, lj: number): boolean => {
    if (i < -N || i > 2 * N || lj < -N || lj >= 2 * N) return false;
    const dcx = i < 0 ? -1 : i > N ? 1 : 0;
    eg = layouts[((lj >> 5) + 1) * 3 + dcx + 1].ex;
    ek = exIdx(i - dcx * N, lj & 31);
    return true;
  };
  const locEz = (li: number, j: number): boolean => {
    if (j < -N || j > 2 * N || li < -N || li >= 2 * N) return false;
    const dcz = j < 0 ? -1 : j > N ? 1 : 0;
    eg = layouts[(dcz + 1) * 3 + (li >> 5) + 1].ez;
    ek = ezIdx(li & 31, j - dcz * N);
    return true;
  };

  const flags = (li: number, lj: number): number =>
    inHalo(li, lj) ? layouts[cellL(li, lj)].flags[cellIdx(li & 31, lj & 31)] : CellFlag.SOLID;
  const floorCm = (li: number, lj: number): number =>
    inHalo(li, lj) ? layouts[cellL(li, lj)].floorCm[cellIdx(li & 31, lj & 31)] : 0;

  // ---- light regions over the 96x96 halo (lazy, deterministic scan order)
  let regions: Uint16Array | null = null;
  const blocks = (kind: number, hA: number, hB: number, fA: number, fB: number): boolean => {
    if (!EDGE_OCCLUDES[kind]) return false;
    const sill = Math.max(fA, fB) / 100;
    return edgeSolidAt(kind, hA, hB, CELL / 2, sill + REGION_Y, sill);
  };
  const computeRegions = (): Uint16Array => {
    const r = new Uint16Array(H * H);
    const stack = new Int32Array(H * H);
    let label = 0;
    for (let c0 = 0; c0 < H * H; c0++) {
      if (r[c0] !== 0 || (flags((c0 % H) - N, ((c0 / H) | 0) - N) & CellFlag.SOLID) !== 0) continue;
      r[c0] = ++label;
      let sp = 0;
      stack[sp++] = c0;
      while (sp > 0) {
        const c = stack[--sp];
        const hi = c % H, hj = (c / H) | 0;
        const li = hi - N, lj = hj - N;
        const f0 = floorCm(li, lj);
        for (let d = 0; d < 4; d++) {
          let ni = li, nj = lj;
          if (d === 0) { if (hi === 0) continue; ni--; locEx(li, lj); }
          else if (d === 1) { if (hi === H - 1) continue; ni++; locEx(li + 1, lj); }
          else if (d === 2) { if (hj === 0) continue; nj--; locEz(li, lj); }
          else { if (hj === H - 1) continue; nj++; locEz(li, lj + 1); }
          const nc = (nj + N) * H + (ni + N);
          if (r[nc] !== 0 || (flags(ni, nj) & CellFlag.SOLID) !== 0) continue;
          if (blocks(eg.kind[ek], eg.hA[ek], eg.hB[ek], f0, floorCm(ni, nj))) continue;
          r[nc] = label;
          stack[sp++] = nc;
        }
      }
    }
    return r;
  };

  // ---- content converted to center-chunk-local coordinates (lazy, cached)
  const offX = (idx: number): number => ((idx % 3) - 1) * CHUNK_SIZE;
  const offZ = (idx: number): number => (((idx / 3) | 0) - 1) * CHUNK_SIZE;
  // Fixtures of all 9 layouts in centre-local coordinates, bucketed by BUCKET-cell squares of the halo.
  const BUCKET = 4; // cells (4.8 m)
  const NB = H / BUCKET; // 24 buckets per axis
  let fixtures: Fixture[] | null = null;
  let bucketStart: Int32Array | null = null; // NB*NB + 1 prefix offsets into bucketItems
  let bucketItems: Int32Array | null = null; // fixture indices
  const bucketOf = (x: number, z: number): number => {
    const bx = Math.min(NB - 1, Math.max(0, Math.floor((x / CELL + N) / BUCKET)));
    const bz = Math.min(NB - 1, Math.max(0, Math.floor((z / CELL + N) / BUCKET)));
    return bz * NB + bx;
  };
  const allFixtures = (): Fixture[] => {
    if (fixtures) return fixtures;
    const list: Fixture[] = [];
    for (let idx = 0; idx < 9; idx++) {
      const ox = offX(idx), oz = offZ(idx);
      for (const f of layouts[idx].fixtures) list.push(idx === 4 ? f : { ...f, px: f.px + ox, pz: f.pz + oz });
    }
    const counts = new Int32Array(NB * NB + 1);
    for (const f of list) counts[bucketOf(f.px, f.pz) + 1]++;
    for (let b = 0; b < NB * NB; b++) counts[b + 1] += counts[b];
    const fill = counts.slice(0, NB * NB);
    const items = new Int32Array(list.length);
    for (let i = 0; i < list.length; i++) items[fill[bucketOf(list[i].px, list[i].pz)]++] = i;
    bucketStart = counts;
    bucketItems = items;
    fixtures = list;
    return list;
  };
  let solids: Solid[] | null = null;
  const allSolids = (): Solid[] => {
    if (solids) return solids;
    solids = [];
    for (let idx = 0; idx < 9; idx++) {
      const ox = offX(idx), oz = offZ(idx);
      for (const s of layouts[idx].solids) {
        if (idx === 4) solids.push(s);
        else if (s.kind === 'box') solids.push({ ...s, min: [s.min[0] + ox, s.min[1], s.min[2] + oz], max: [s.max[0] + ox, s.max[1], s.max[2] + oz] });
        else if (s.kind === 'ramp') solids.push({ ...s, x0: s.x0 + ox, z0: s.z0 + oz, x1: s.x1 + ox, z1: s.z1 + oz });
        else solids.push({ ...s, a: [s.a[0] + ox, s.a[1], s.a[2] + oz], b: [s.b[0] + ox, s.b[1], s.b[2] + oz] });
      }
    }
    return solids;
  };

  return {
    center,
    get: (dcx, dcz) => layouts[(dcz + 1) * 3 + (dcx + 1)],
    flags,
    floorCm,
    ceilCm: (li, lj) => (inHalo(li, lj) ? layouts[cellL(li, lj)].ceilCm[cellIdx(li & 31, lj & 31)] : 0),
    blockCm: (li, lj) => (inHalo(li, lj) ? layouts[cellL(li, lj)].blockCm[cellIdx(li & 31, lj & 31)] : 0),
    waterCm: (li, lj) => (inHalo(li, lj) ? layouts[cellL(li, lj)].waterCm[cellIdx(li & 31, lj & 31)] : NO_WATER),
    room(li, lj) {
      if (!inHalo(li, lj)) return 0;
      const idx = cellL(li, lj);
      const r = layouts[idx].room[cellIdx(li & 31, lj & 31)];
      return r === 0 ? 0 : (idx << 12) | r;
    },
    region(li, lj) {
      if (!inHalo(li, lj)) return 0;
      regions ??= computeRegions();
      return regions[(lj + N) * H + (li + N)];
    },
    exKind: (i, lj) => (locEx(i, lj) ? eg.kind[ek] : 0),
    ezKind: (li, j) => (locEz(li, j) ? eg.kind[ek] : 0),
    exH: (i, lj) => (locEx(i, lj) ? [eg.hA[ek], eg.hB[ek]] : [0, 0]),
    ezH: (li, j) => (locEz(li, j) ? [eg.hA[ek], eg.hB[ek]] : [0, 0]),
    fixturesNear(x, z, r, out) {
      out.length = 0;
      const list = allFixtures();
      const starts = bucketStart as Int32Array, items = bucketItems as Int32Array;
      const r2 = r * r;
      const b0x = Math.max(0, Math.floor(((x - r) / CELL + N) / BUCKET)), b1x = Math.min(NB - 1, Math.floor(((x + r) / CELL + N) / BUCKET));
      const b0z = Math.max(0, Math.floor(((z - r) / CELL + N) / BUCKET)), b1z = Math.min(NB - 1, Math.floor(((z + r) / CELL + N) / BUCKET));
      for (let bz = b0z; bz <= b1z; bz++) {
        for (let bx = b0x; bx <= b1x; bx++) {
          const b = bz * NB + bx;
          for (let k = starts[b]; k < starts[b + 1]; k++) {
            const f = list[items[k]];
            const dx = f.px - x, dz = f.pz - z;
            if (dx * dx + dz * dz <= r2) out.push(f);
          }
        }
      }
      // fixtures outside the halo (clamped into edge buckets) are still found: edge buckets are always scanned
      // when the query touches them, and the distance test is exact.
      return out.length;
    },
    solids: () => allSolids(),
  };
}
