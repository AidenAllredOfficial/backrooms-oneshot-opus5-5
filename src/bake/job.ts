// src/bake/job.ts — the internal state of one tile bake: VisGrid, light set, per-chunk visibility / patch tables
// (fresh, or borrowed from the BakeCache) and per-cell layer heights. Pure module.

import { CHUNK_CELL_COUNT } from '../core/constants.ts';
import { chunkKeyStr, tileOriginX, tileOriginZ, type TileKey } from '../core/grid.ts';
import { CellFlag } from '../core/ids.ts';
import type { BakeQuality } from '../core/quality.ts';
import type { LayoutNeighborhood } from '../core/world.ts';
import { createPatchTable, type BakeCacheImpl, type ChunkCacheEntry, type PatchTable } from './cache.ts';
import { gatherLights, gatherSun, type LightSet, type SunSet } from './lights.ts';
import { H_LOW, H_TOP, HALO_OFF, SURF_OFF } from './util.ts';
import { buildVisGrid, slotDcx, slotDcz, type VisGrid } from './visgrid.ts';

export interface BakeDiag {
  receivers: number; // K_MAX selections made
  dropped: number; // receivers with a K_MAX tail (candidates beyond the K strongest, approximated by tailSum)
  dropMax: number; // max over receivers of (tail estimate sum / total estimate sum)
  dropSum: number; // sum of those ratios (mean = dropSum / receivers)
  patches: number; // patch irradiances computed (not cached)
  visBits: number; // (cell, light) bitsets computed (not cached)
  pairs: [number, number, number]; // classified (patch, light) pairs: NONE, FULL, PARTIAL
  shadowTexels: number; // texel evaluations with per-texel shadow rays
}

export interface BakeJob {
  readonly tile: TileKey;
  readonly q: BakeQuality;
  readonly nb: LayoutNeighborhood;
  readonly g: VisGrid;
  readonly L: LightSet;
  /** sun apertures (SKYLIGHT_HALL glazing) of the neighbourhood, null if none (lights.ts gatherSun) */
  readonly sun: SunSet | null;
  readonly originX: number; readonly originZ: number; // world metres of the tile origin
  readonly li0: number; readonly lj0: number; // first tile cell in neighbourhood coords
  /** visibility tables, index light * 9 + chunk slot: Uint8Array(1024), bits VIS_*, bit 7 = computed */
  readonly visTab: (Uint8Array | null)[];
  readonly patchTab: PatchTable[]; // per chunk slot
  readonly entries: (ChunkCacheEntry | null)[]; // cache entries per chunk slot (null without cache)
  /** per halo cell: 3 layer heights (low, mid, top), metres (probe layers) */
  readonly cellH: Float64Array;
  /** per halo cell: the 5 visibility-bit heights (VIS_BITS): low, mid, top, floor + 0.02, ceiling - 0.02 (m) */
  readonly cellY: Float64Array;
  /** per halo cell: number of occluder boxes bucketed there (any group) */
  readonly boxCount: Uint16Array;
  /** per halo cell: highest top (m) of the occluder boxes bucketed there (-Infinity if none) */
  readonly boxTop: Float64Array;
  /** per halo cell: highest box top over the 3x3 cells around it */
  readonly boxTop9: Float64Array;
  /** AO candidate edges per halo cell (lazy, ao.ts): [count, entries...] in AO_STRIDE slots; aoDone[c] = 1 once built */
  readonly aoList: Int32Array;
  readonly aoDone: Uint8Array;
  readonly diag: BakeDiag;
}

/** Slots per cell in BakeJob.aoList (count + 12 x-edges + 12 z-edges + 1 box flag). */
export const AO_STRIDE = 26;

export function createJob(nb: LayoutNeighborhood, tile: TileKey, q: BakeQuality, cache: BakeCacheImpl | null): BakeJob {
  const g = buildVisGrid(nb, tile);
  const L = gatherLights(nb, tile, g.hl0, g.hm0);
  const entries: (ChunkCacheEntry | null)[] = [];
  const patchTab: PatchTable[] = [];
  for (let slot = 0; slot < 9; slot++) {
    const e = cache ? cache.entry(chunkKeyStr({ s: tile.s, cx: tile.cx + slotDcx(slot), cz: tile.cz + slotDcz(slot) })) : null;
    entries.push(e);
    patchTab.push(e ? e.patches : createPatchTable());
  }
  const nn = g.n * g.n;
  const cellH = new Float64Array(nn * 3);
  const cellY = new Float64Array(nn * 5);
  for (let c = 0; c < nn; c++) {
    let base = g.blockTop[c] > g.floor[c] ? g.blockTop[c] : g.floor[c];
    let top = g.ceil[c];
    if ((g.flags[c] & CellFlag.TOWER) !== 0 && g.group[c] !== 0) { base = -1.5; top = 1.5; } // fundamental period
    const span = top - base;
    const lo = Math.min(H_LOW, 0.25 * span), hi = Math.min(H_TOP, 0.25 * span);
    cellH[c * 3] = base + lo;
    cellH[c * 3 + 1] = (base + top) * 0.5;
    cellH[c * 3 + 2] = top - hi;
    cellY[c * 5] = cellH[c * 3]; cellY[c * 5 + 1] = cellH[c * 3 + 1]; cellY[c * 5 + 2] = cellH[c * 3 + 2];
    const tower = (g.flags[c] & CellFlag.TOWER) !== 0 && g.group[c] !== 0;
    cellY[c * 5 + 3] = tower ? cellH[c * 3] : base + SURF_OFF;
    cellY[c * 5 + 4] = tower ? cellH[c * 3 + 2] : top - SURF_OFF;
  }
  const boxCount = new Uint16Array(nn);
  const boxTop = new Float64Array(nn).fill(-Infinity);
  for (let c = 0; c < nn; c++) {
    boxCount[c] = Math.min(65535, g.boxStart[c + 1] - g.boxStart[c]);
    for (let k = g.boxStart[c]; k < g.boxStart[c + 1]; k++) {
      const top = g.box[g.boxList[k] * 6 + 4];
      if (top > boxTop[c]) boxTop[c] = top;
    }
  }
  return {
    tile, q, nb, g, L, sun: gatherSun(nb, g.hl0, g.hm0),
    originX: tileOriginX(tile), originZ: tileOriginZ(tile),
    li0: g.hl0 + HALO_OFF, lj0: g.hm0 + HALO_OFF,
    visTab: new Array<Uint8Array | null>(L.n * 9).fill(null),
    patchTab, entries, cellH, cellY, boxCount, boxTop, boxTop9: max9(boxTop, g.n),
    aoList: new Int32Array(nn * AO_STRIDE), aoDone: new Uint8Array(nn),
    diag: { receivers: 0, dropped: 0, dropMax: 0, dropSum: 0, patches: 0, visBits: 0, pairs: [0, 0, 0], shadowTexels: 0 },
  };
}

/** Visibility table of (light, chunk slot): from the cache entry (created on demand) or fresh. */
export function visTable(job: BakeJob, l: number, slot: number): Uint8Array {
  const idx = l * 9 + slot;
  let t = job.visTab[idx];
  if (t) return t;
  const e = job.entries[slot];
  if (e) {
    const key = job.L.key[l];
    t = e.vis.get(key) ?? null;
    if (!t) { t = new Uint8Array(CHUNK_CELL_COUNT); e.vis.set(key, t); }
  } else t = new Uint8Array(CHUNK_CELL_COUNT);
  job.visTab[idx] = t;
  return t;
}

/** Visibility bits of the shared bitset: 3 probe layers + floor and ceiling receiver heights. */
export const VIS_LOW = 1, VIS_MID = 2, VIS_TOP = 4, VIS_FLOOR = 8, VIS_CEIL = 16, VIS_ALL = 31;

/** Visibility bit index (0..4) whose height in cell c is nearest to y. */
export function nearestBit(job: BakeJob, c: number, y: number): number {
  const h = job.cellY, o = c * 5;
  let best = 0, bd = Math.abs(y - h[o]);
  for (let k = 1; k < 5; k++) {
    const d = Math.abs(y - h[o + k]);
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

/** Index (0..2) of the layer height of cell c nearest to y. */
export function nearestLayer(job: BakeJob, c: number, y: number): number {
  const h = job.cellH;
  const a = Math.abs(y - h[c * 3]), b = Math.abs(y - h[c * 3 + 1]), d = Math.abs(y - h[c * 3 + 2]);
  return a <= b ? (a <= d ? 0 : 2) : (b <= d ? 1 : 2);
}

/** 3x3 maximum of a per-cell field. */
function max9(a: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n * n).fill(-Infinity);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let m = -Infinity;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= n) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii >= 0 && ii < n && a[jj * n + ii] > m) m = a[jj * n + ii];
        }
      }
      out[j * n + i] = m;
    }
  }
  return out;
}
