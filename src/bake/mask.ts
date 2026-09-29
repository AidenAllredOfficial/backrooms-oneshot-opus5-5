// src/bake/mask.ts — surface mask RGBA8 (WP7 §Algorithms 9). Pure module; deterministic from world position,
// fields and leaks (never from the tile), so it is seamless across tiles.
//   R stain:  walls within 1.2 m (horizontally, same light region) of a leak: a tide-line band from the ceiling
//             down to ceil - (0.4 + 0.8 * strength) with drip streaks in hashed 3-8 cm columns;
//             every wall (leak-independent, B3): rising damp (a wavy tide band from the floor, height grows with
//             humidity) and old ceiling seepage streaks (hashed 0.3 m world columns, 8-45 cm wide, 0.3-1.6 m long);
//             ceilings within 0.9 m of a leak: concentric rings; floors: none.
//   G grime:  decay * (0.6 * cornerness + 0.4 * baseboardBand), cornerness = 1 - AO over nearby walls (ceilings: only
//             within 0.4 m of a wall), baseboard band = wall texels below 0.25 m above the floor; walls add a hand-
//             smudge band (0.9-1.5 m) near jambs / wall ends / outside corners and a dust line under the ceiling;
//             ceilings add dust halos around recessed fixtures and supply diffusers (VENT tiles).
//   B wet:    humidity * lowFreqPuddle(hash noise), WET cells, leak puddles (1.2 m radius under each leak), and the
//             splash zone of pools (floors within 1.2 m of a pool WaterRect, above its water line, noise-broken).
//   A damage: walls: peeling and mould at the base and near leaks, scaled by decay; carpet floors: traffic wear
//             where the texel is away from walls in corridors (corridorWidth <= 3), threshold wear ellipses across
//             openings and lanes between openings of the same room.
// Decay is raised in DYING (+0.2) and DARK (+0.3) mood chunks (per-cell, bilinearly blended like the fields).

import { CELL, CHUNK_CELLS } from '../core/constants.ts';
import { cellIdx } from '../core/grid.ts';
import { EDGE_RENDERS } from '../core/edges.ts';
import { CellFlag, EdgeKind, Mat, Mood, TileState } from '../core/ids.ts';
import { getTile } from '../core/layout.ts';
import { fbm2, valueNoise2, valueNoise2P } from '../core/noise.ts';
import { hash01, hash3, SALT } from '../core/rng.ts';
import { corridorWidth } from '../world/rooms.ts';
import type { BakeJob } from './job.ts';
import { slotDcx, slotDcz } from './visgrid.ts';
import { occluded } from './dda.ts';

const SEED_PUDDLE = 0x5eed01 ^ SALT.BAKE, SEED_PEEL = 0x5eed02 ^ SALT.BAKE, SEED_WEAR = 0x5eed03 ^ SALT.BAKE, SEED_RING = 0x5eed04;
const SEED_TIDE = 0x5eed05 ^ SALT.BAKE, SEED_SEEP = 0x5eed06 ^ SALT.BAKE, SEED_HAND = 0x5eed07 ^ SALT.BAKE;
const SEED_SPLASH = 0x5eed08 ^ SALT.BAKE;
/** Pool splash zone: wetness up to SPLASH_MAX at the coping, gone SPLASH_REACH metres from the water's edge. */
const SPLASH_MAX = 0.75, SPLASH_REACH = 1.2;

const sstep = (e0: number, e1: number, x: number): number => {
  const t = (x - e0) / (e1 - e0);
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
};

export const maskOut = { r: 0, g: 0, b: 0, a: 0 };

/** Per-bake mask caches: corridor widths (-1 = unknown) and leak proximity (0 unknown, 1 none, 2 near) per cell,
 * the mood decay boost per halo cell, and (lazily) the opening / lane / fixture lists used by the wear and dust
 * terms. */
export interface MaskCache {
  cw: Int16Array; leakNear: Uint8Array; moodAdd: Float32Array;
  /** openings (x, z halo units of the edge midpoint, axis 0 = line x = const / 1 = line z = const, room A, room B) */
  open: Float64Array | null; nOpen: number;
  /** lanes: 4 per lane (x0 z0 x1 z1, halo units) */
  lanes: Float64Array | null; nLanes: number;
  /** per cell: indices into open (bit 30 set: lane index) within reach, built lazily */
  nearWear: (Int32Array | null)[];
  /** per cell: indices of recessed-ish lights near the ceiling, built lazily */
  nearFix: (Int32Array | null)[];
  /** pool (WaterRect kind 0) rectangles of the 3x3 neighbourhood: x0 z0 x1 z1 (halo cells) + water y (m), built lazily */
  pools: Float64Array | null; nPools: number;
  /** per cell: indices into pools within the splash reach, built lazily */
  nearPool: (Int32Array | null)[];
}
export function createMaskCache(job: BakeJob): MaskCache {
  const g = job.g;
  const nn = g.n * g.n;
  const moodAdd = new Float32Array(nn);
  for (let c = 0; c < nn; c++) {
    const slot = g.slot[c];
    const m = job.nb.get(slotDcx(slot) as -1 | 0 | 1, slotDcz(slot) as -1 | 0 | 1).mood;
    moodAdd[c] = m === Mood.DARK ? 0.3 * 255 : m === Mood.DYING ? 0.2 * 255 : 0;
  }
  return {
    cw: new Int16Array(nn).fill(-1), leakNear: new Uint8Array(nn), moodAdd, open: null, nOpen: 0, lanes: null, nLanes: 0,
    nearWear: new Array(nn).fill(null), nearFix: new Array(nn).fill(null), pools: null, nPools: 0, nearPool: new Array(nn).fill(null),
  };
}

const solidAt = (g: BakeJob['g'], i: number, j: number): boolean =>
  i < 0 || j < 0 || i >= g.n || j >= g.n ? false : (g.flags[j * g.n + i] & CellFlag.SOLID) !== 0;
/** Edge kind on line x = i (row j) / z = j (column i); OPEN outside the halo. */
const exK = (g: BakeJob['g'], i: number, j: number): number => (i < 0 || j < 0 || i > g.n || j >= g.n ? 0 : g.exKind[j * (g.n + 1) + i]);
const ezK = (g: BakeJob['g'], i: number, j: number): number => (i < 0 || j < 0 || i >= g.n || j > g.n ? 0 : g.ezKind[j * g.n + i]);
/** A wall (rendered edge or a SOLID cell on either side) on line x = i, row j. */
const wallX = (g: BakeJob['g'], i: number, j: number): boolean => EDGE_RENDERS[exK(g, i, j)] || solidAt(g, i - 1, j) || solidAt(g, i, j);
const wallZ = (g: BakeJob['g'], i: number, j: number): boolean => EDGE_RENDERS[ezK(g, i, j)] || solidAt(g, i, j - 1) || solidAt(g, i, j);
const passable = (k: number): boolean => k === EdgeKind.OPEN || k === EdgeKind.DOORWAY || k === EdgeKind.ARCH || k === EdgeKind.HEADER;

/** Openings in walls (doorways, arches, headers and OPEN gaps next to a wall) + lanes between openings of a room. */
function buildOpenings(g: BakeJob['g'], mc: MaskCache): void {
  const n = g.n;
  const out: number[] = [];
  const add = (x: number, z: number, ax: number, ra: number, rb: number): void => { out.push(x, z, ax, ra, rb); };
  for (let j = 0; j < n; j++) {
    for (let i = 1; i < n; i++) {
      const k = exK(g, i, j);
      if (!passable(k) || solidAt(g, i - 1, j) || solidAt(g, i, j)) continue;
      if (k === EdgeKind.OPEN && !(wallX(g, i, j - 1) || wallX(g, i, j + 1))) continue;
      add(i, j + 0.5, 0, g.room[j * n + i - 1], g.room[j * n + i]);
    }
  }
  for (let j = 1; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = ezK(g, i, j);
      if (!passable(k) || solidAt(g, i, j - 1) || solidAt(g, i, j)) continue;
      if (k === EdgeKind.OPEN && !(wallZ(g, i - 1, j) || wallZ(g, i + 1, j))) continue;
      add(i + 0.5, j, 1, g.room[(j - 1) * n + i], g.room[j * n + i]);
    }
  }
  mc.open = Float64Array.from(out);
  mc.nOpen = out.length / 5;
  // lanes: pairs of openings of the same room, 2.5-14 m apart (rooms with <= 8 openings)
  const byRoom = new Map<number, number[]>();
  for (let o = 0; o < mc.nOpen; o++) {
    for (const r of [out[o * 5 + 3], out[o * 5 + 4]]) {
      if (r < 0) continue;
      let l = byRoom.get(r);
      if (!l) { l = []; byRoom.set(r, l); }
      if (!l.includes(o)) l.push(o);
    }
  }
  const lanes: number[] = [];
  for (const l of byRoom.values()) {
    if (l.length < 2 || l.length > 8) continue;
    for (let a = 0; a < l.length; a++) {
      for (let b = a + 1; b < l.length; b++) {
        const oa = l[a] * 5, ob = l[b] * 5;
        const d = Math.hypot(out[oa] - out[ob], out[oa + 1] - out[ob + 1]) * CELL;
        if (d < 2.5 || d > 14) continue;
        lanes.push(out[oa], out[oa + 1], out[ob], out[ob + 1]);
      }
    }
  }
  mc.lanes = Float64Array.from(lanes);
  mc.nLanes = lanes.length / 4;
}

/** Openings (index) and lanes (index | 1 << 30) that may reach cell c. */
function wearNear(g: BakeJob['g'], mc: MaskCache, c: number): Int32Array {
  let r = mc.nearWear[c];
  if (r) return r;
  if (!mc.open) buildOpenings(g, mc);
  const o = mc.open as Float64Array, ln = mc.lanes as Float64Array;
  const hi = c % g.n, hj = (c - hi) / g.n;
  const cx = hi + 0.5, cz = hj + 0.5;
  const list: number[] = [];
  const reach = 0.95 / CELL + 0.75; // ellipse radius + half the cell diagonal (cells)
  for (let k = 0; k < mc.nOpen; k++) if (Math.abs(o[k * 5] - cx) < reach && Math.abs(o[k * 5 + 1] - cz) < reach) list.push(k);
  for (let k = 0; k < mc.nLanes; k++) {
    const d = segDist(cx, cz, ln[k * 4], ln[k * 4 + 1], ln[k * 4 + 2], ln[k * 4 + 3]);
    if (d < 0.75 / CELL + 0.75) list.push(k | (1 << 30));
  }
  r = Int32Array.from(list);
  mc.nearWear[c] = r;
  return r;
}
function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** Lights close under the ceiling of cell c (within 1.5 m horizontally), built lazily. */
function fixNear(job: BakeJob, mc: MaskCache, c: number): Int32Array {
  let r = mc.nearFix[c];
  if (r) return r;
  const g = job.g, L = job.L;
  const hi = c % g.n, hj = (c - hi) / g.n;
  const list: number[] = [];
  for (let k = 0; k < L.n; k++) {
    if (L.tower[k]) continue;
    const lx = L.pos[k * 3], ly = L.pos[k * 3 + 1], lz = L.pos[k * 3 + 2];
    if (Math.abs(ly - g.ceil[c]) > 0.25) continue;
    const reach = (L.size[k] * 0.5 + 0.35) / CELL + 0.75;
    if (Math.abs(lx - (hi + 0.5)) < reach && Math.abs(lz - (hj + 0.5)) < reach) list.push(k);
  }
  r = Int32Array.from(list);
  mc.nearFix[c] = r;
  return r;
}

/** Pool rectangles (kind 0) that may splash cell c. The rects come from every layout of the neighbourhood (world data
 * only, never the tile), so the splash field is seamless across tiles. */
function poolNear(job: BakeJob, mc: MaskCache, c: number): Int32Array {
  let r = mc.nearPool[c];
  if (r) return r;
  const g = job.g;
  if (!mc.pools) {
    const out: number[] = [];
    for (let dcz = -1; dcz <= 1; dcz++) {
      for (let dcx = -1; dcx <= 1; dcx++) {
        const offX = dcx * CHUNK_CELLS - g.hl0, offZ = dcz * CHUNK_CELLS - g.hm0;
        for (const w of job.nb.get(dcx as -1 | 0 | 1, dcz as -1 | 0 | 1).water) {
          if (w.kind !== 0) continue;
          out.push(offX + w.x0 / CELL, offZ + w.z0 / CELL, offX + w.x1 / CELL, offZ + w.z1 / CELL, w.y);
        }
      }
    }
    mc.pools = Float64Array.from(out);
    mc.nPools = out.length / 5;
  }
  const p = mc.pools;
  const hi = c % g.n, hj = (c - hi) / g.n;
  const reach = SPLASH_REACH / CELL + 0.75; // + half the cell diagonal (cells)
  const list: number[] = [];
  for (let k = 0; k < mc.nPools; k++) {
    const o = k * 5;
    const dx = Math.max(0, p[o] - (hi + 0.5), (hi + 0.5) - p[o + 2]), dz = Math.max(0, p[o + 1] - (hj + 0.5), (hj + 0.5) - p[o + 3]);
    if (dx < reach && dz < reach) list.push(k);
  }
  r = Int32Array.from(list);
  mc.nearPool[c] = r;
  return r;
}

function corridorOf(job: BakeJob, mc: MaskCache, c: number): number {
  const cache = mc.cw;
  let w = cache[c];
  if (w >= 0) return w;
  const g = job.g;
  const slot = g.slot[c];
  const l = job.nb.get(slotDcx(slot) as -1 | 0 | 1, slotDcz(slot) as -1 | 0 | 1);
  const loc = g.local[c];
  w = corridorWidth(l, loc & 31, loc >> 5);
  cache[c] = w < 0 ? 0 : w > 32000 ? 32000 : w;
  void cellIdx;
  return cache[c];
}

/** Bilinear interpolation of a per-cell halo field (n x n) at halo-cell coordinates (x, z), cell centres at +0.5. */
function cellBilerp(f: ArrayLike<number>, n: number, x: number, z: number): number {
  const fx = Math.min(n - 1, Math.max(0, x - 0.5)), fz = Math.min(n - 1, Math.max(0, z - 0.5));
  const i0 = Math.min(n - 2, Math.floor(fx)), j0 = Math.min(n - 2, Math.floor(fz));
  const tx = fx - i0, tz = fz - j0;
  const o = j0 * n + i0;
  const a = f[o] + (f[o + 1] - f[o]) * tx;
  const b = f[o + n] + (f[o + n + 1] - f[o + n]) * tx;
  return a + (b - a) * tz;
}

/** WET flag (0/1) of halo cell (i, j), clamped to the halo. */
function wetFlag(g: BakeJob['g'], i: number, j: number): number {
  const n = g.n;
  i = i < 0 ? 0 : i >= n ? n - 1 : i;
  j = j < 0 ? 0 : j >= n ? n - 1 : j;
  return (g.flags[j * n + i] & CellFlag.WET) !== 0 ? 1 : 0;
}

/** Damp-carpet amount at halo-cell point (x, z): the WET flags (0/1 at cell centres) bilinearly interpolated at a
 * domain-warped position (+-0.35 cells, 2.4 m wavelength) plus fine noise, then smoothstepped around 0.5. The
 * contour is a smooth meandering curve, so WET cells read as organic damp patches rather than axis-aligned cell
 * rectangles; a lone WET cell gives a ~1 m blob. Only WET flags (world data) and world position enter: seamless
 * across tiles. */
function wetFeather(g: BakeJob['g'], x: number, z: number, wx: number, wz: number): number {
  const ox = 0.7 * (fbm2(SEED_PUDDLE + 11, wx / 2.4, wz / 2.4, 2) - 0.5);
  const oz = 0.7 * (fbm2(SEED_PUDDLE + 13, wx / 2.4, wz / 2.4, 2) - 0.5);
  const fx = x + ox - 0.5, fz = z + oz - 0.5;
  const i0 = Math.floor(fx), j0 = Math.floor(fz);
  const tx = fx - i0, tz = fz - j0;
  const a = wetFlag(g, i0, j0), b = wetFlag(g, i0 + 1, j0), c = wetFlag(g, i0, j0 + 1), d = wetFlag(g, i0 + 1, j0 + 1);
  if (a + b + c + d === 0) return 0;
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz); // smooth weights: no bilinear creases
  const f = (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sz;
  const nz = 0.3 * (fbm2(SEED_PUDDLE + 17, wx / 0.7, wz / 0.7, 2) - 0.5);
  return sstep(0.3, 0.6, f + nz);
}

/**
 * Mask of a receiver at (x, y, z) (halo cells / m) with unit normal n in owner cell c.
 * `aoWall` / `wallDist`: from ao.ts. Result in maskOut (0..1).
 */
export function maskAt(job: BakeJob, cache: MaskCache, x: number, y: number, z: number, nx: number, ny: number, nz: number, c: number, aoWall: number, wallDist: number): void {
  const g = job.g;
  const wx = (g.gi0 + x) * CELL, wz = (g.gj0 + z) * CELL; // world metres
  // fields are stored per cell: interpolate between cell centres so the puddle / grime contours (thresholded
  // again in the surface shader) do not follow the 0.6 m cell grid as straight-edged steps
  // (tower-internal cells keep their own cell value: mixing in storey-dependent outside cells would break the
  // pixel-identical storey switch)
  const towerCell = (g.flags[c] & CellFlag.TOWER) !== 0 && g.group[c] !== 0;
  const decayF = towerCell ? g.decay[c] : cellBilerp(g.decay, g.n, x, z) + cellBilerp(cache.moodAdd, g.n, x, z);
  const decay = Math.min(1, decayF / 255);
  const hum = (towerCell ? g.humidity[c] : cellBilerp(g.humidity, g.n, x, z)) / 255;
  const floorY = g.blockTop[c] > g.floor[c] ? g.blockTop[c] : g.floor[c];
  const ceilY = g.ceil[c];
  const isFloor = ny > 0.5, isCeil = ny < -0.5, isWall = !isFloor && !isCeil;
  let r = 0, gr = 0, b = 0, a = 0;
  const hy = y - floorY; // height above floor
  // ---- leaks (only cells with a leak within reach: a per-cell flag, computed once)
  let near = cache.leakNear[c];
  if (near === 0) {
    near = 1;
    const hi = c % g.n, hj = (c - hi) / g.n;
    for (let k = 0; k < g.nLeak; k++) {
      const dx = Math.max(0, Math.abs(g.leak[k * 4] - (hi + 0.5)) - 0.5) * CELL;
      const dz = Math.max(0, Math.abs(g.leak[k * 4 + 2] - (hj + 0.5)) - 0.5) * CELL;
      if (dx * dx + dz * dz < 1.2 * 1.2) { near = 2; break; }
    }
    cache.leakNear[c] = near;
  }
  if (near === 2) for (let k = 0; k < g.nLeak; k++) {
    const o = k * 4;
    const lx = g.leak[o], lz = g.leak[o + 2], s = g.leak[o + 3];
    const dh = Math.hypot((x - lx) * CELL, (z - lz) * CELL);
    if (dh >= 1.2) continue;
    const lc = Math.floor(lz) * g.n + Math.floor(lx);
    if (lc < 0 || lc >= g.n * g.n) continue;
    if (isFloor) {
      // floor puddles spread over the floor until a wall stops them: a light-region test cut them along region
      // borders in open floor (straight-edged dark rectangles)
      if (g.flags[lc] & CellFlag.SOLID) continue;
      const fy = floorY + 0.05;
      if (occluded(g, lx, fy, lz, x, fy, z, g.group[c], false)) continue;
    } else if (g.region[lc] !== g.region[c]) continue;
    const fall = 1 - dh / 1.2;
    if (isWall) {
      const band = 0.4 + 0.8 * s;
      const depth = ceilY - y;
      let v = 0;
      if (depth < band) v = 0.35 + 0.65 * sstep(0.55 * band, band, depth); // darkest at the tide line
      // drip streaks: hashed columns (3-8 cm wide) along the wall
      const along = Math.abs(nx) > 0.5 ? wz : wx;
      const col = Math.floor(along / 0.1);
      const h = hash3(col, g.leakId[k], SEED_RING ^ SALT.LEAK);
      if (hash01(h) < 0.35) {
        const centre = (col + 0.2 + 0.6 * hash01(hash3(h, 1, 7))) * 0.1;
        const width = 0.03 + 0.05 * hash01(hash3(h, 2, 9));
        if (Math.abs(along - centre) < width * 0.5) {
          const len = band + (0.3 + 0.9 * hash01(hash3(h, 3, 11))) * s;
          if (depth < len) v = Math.max(v, 0.75 * (1 - Math.max(0, depth - band) / (len - band + 1e-6)));
        }
      }
      r = Math.max(r, v * s * Math.sqrt(fall));
      if (v > 0 && hy > 0) a = Math.max(a, 0.5 * v * s * decay);
    } else if (isCeil && dh < 0.9) {
      const rr = dh / 0.9;
      const ring = 0.5 + 0.5 * Math.cos(2 * Math.PI * dh / 0.11 + 6.283 * hash01(hash3(g.leakId[k], 5, SEED_RING)));
      const edge = sstep(0.75, 0.95, rr) * (1 - sstep(0.95, 1.0, rr)); // outer tide ring
      r = Math.max(r, s * ((1 - rr) * (0.55 + 0.45 * ring) + 0.6 * edge));
    } else if (isFloor) {
      // irregular puddle outline: the radius is noise-warped by up to +-0.3 m
      const pw = 1 - (dh + 0.6 * (fbm2(SEED_PUDDLE + 23, wx / 0.8, wz / 0.8, 2) - 0.5)) / 1.2;
      if (pw > 0) b = Math.max(b, s * sstep(0, 0.75, pw));
    }
  }
  // ---- leak-independent wall stains (not in periodic tower cells: they must stay 3 m periodic)
  if (isWall && !towerCell && hy >= 0) {
    const alongX = Math.abs(nx) > 0.5;
    const along = alongX ? wz : wx;
    // rising damp: a wavy tide band from the floor; the shader's stain threshold (~0.42-0.5) draws its tide line.
    // Its presence varies in ~3 m stretches along each wall (a slow noise on the gate), its height with humidity.
    const plane0 = Math.round((alongX ? wx : wz) / CELL);
    const nA = valueNoise2(SEED_TIDE + 2, along / 2.8, plane0 * 3.7);
    // WET cells (flooded rooms, spills): the paper wicks water well above the floor on every wall
    const wetCell = (g.flags[c] & CellFlag.WET) !== 0;
    const k = wetCell ? 1 : sstep(0.32, 0.62, hum + 0.25 * decay + 0.45 * (nA - 0.5));
    if (k > 0) {
      const tideH = (wetCell ? 0.35 : 0.08) + 0.5 * hum * (0.4 + 0.6 * valueNoise2(SEED_TIDE, along / 1.6, plane0 * 1.3)) + 0.07 * (valueNoise2(SEED_TIDE + 1, along / 0.35, 0) - 0.5);
      if (hy < tideH) r = Math.max(r, k * (0.52 + 0.12 * (1 - hy / tideH)));
    }
    // old ceiling seepage: hashed 0.3 m world columns (a streak can overlap the neighbouring columns)
    const depth = ceilY - y;
    const pSeep = 0.03 + 0.15 * hum * (0.5 + decay);
    if (depth < 1.7 && depth >= 0) {
      const plane = Math.round((alongX ? wx : wz) / CELL) * 2 + ((alongX ? nx : nz) > 0 ? 1 : 0);
      const col0 = Math.floor(along / 0.3);
      for (let dc = -1; dc <= 1; dc++) {
        const col = col0 + dc;
        const h = hash3(col, plane, SEED_SEEP);
        if (hash01(h) >= pSeep) continue;
        const len = 0.3 + 1.3 * hash01(hash3(h, 3, 11));
        if (depth > len) continue;
        const t = depth / len; // 0 at the ceiling, 1 at the streak's end
        const w = (0.08 + 0.37 * hash01(hash3(h, 2, 9))) * (0.7 + 0.5 * t);
        const wob = 0.04 * (valueNoise2(SEED_SEEP + 3, along * 0.3 + col * 7.1, depth / 0.25) - 0.5);
        const centre = (col + 0.2 + 0.6 * hash01(hash3(h, 1, 7))) * 0.3 + wob;
        const du = Math.abs(along - centre) / (w * 0.5);
        if (du >= 1) continue;
        const v = (0.55 + 0.25 * hash01(hash3(h, 4, 13))) * (1 - sstep(0.55, 1, du)) * (1 - sstep(0.35, 1, t));
        r = Math.max(r, v);
      }
    }
  }
  // ---- grime
  let cornerness = 1 - aoWall;
  cornerness = cornerness > 1 ? 1 : cornerness < 0 ? 0 : cornerness;
  if (isCeil) cornerness *= 1 - sstep(0.2, 0.4, wallDist); // ceiling corner grime hugs the walls
  const baseboard = isWall ? 1 - sstep(0.1, 0.25, hy) : 0;
  gr = decay * (0.6 * cornerness + 0.4 * baseboard);
  if (isWall && !towerCell) {
    // floor-level soiling gradient (mop splash, kicked dust) and a dusty band under the ceiling
    gr += 0.22 * (1 - sstep(0, 0.45, hy));
    gr += (0.08 + 0.3 * decay) * (1 - sstep(0.03, 0.1, ceilY - y));
    // hand smudges at 0.9-1.5 m near door jambs, wall ends and outside corners
    const band = sstep(0.8, 0.95, hy) * (1 - sstep(1.4, 1.6, hy));
    if (band > 0) {
      const dEnd = wallEndDist(g, x, z, nx, nz);
      if (dEnd < 0.35) {
        const n = valueNoise2(SEED_HAND, (Math.abs(nx) > 0.5 ? wz : wx) / 0.12, y / 0.15);
        gr += 0.45 * decay * band * (1 - sstep(0.08, 0.35, dEnd)) * (0.4 + 0.6 * n);
      }
    }
  } else if (isCeil && !towerCell) {
    // dust halos around recessed fixtures and supply diffusers (air flow deposits dirt beside the opening)
    let dust = 0;
    const fl = fixNear(job, cache, c);
    const L = job.L;
    for (let q = 0; q < fl.length; q++) {
      const k = fl[q];
      const dx = (x - L.pos[k * 3]) * CELL, dz = (z - L.pos[k * 3 + 2]) * CELL;
      let d: number;
      if (L.shape[k] === 0) {
        const tu = Math.abs(dx * L.tan[k * 3] + dz * L.tan[k * 3 + 2]) - L.w[k] / 2;
        const tv = Math.abs(dx * L.bit[k * 3] + dz * L.bit[k * 3 + 2]) - L.h[k] / 2;
        d = Math.hypot(Math.max(tu, 0), Math.max(tv, 0)) + Math.min(Math.max(tu, tv), 0);
      } else d = Math.hypot(dx, dz) - L.w[k] / 2;
      if (d > 0) dust = Math.max(dust, Math.exp(-d / 0.1));
    }
    // supply diffusers (VENT tiles): a smudge ring on the ceiling tiles around the diffuser frame
    const sx = Math.floor(x * 2), sz = Math.floor(z * 2); // halo 0.6 m sub-tile of the texel
    for (let dz2 = -1; dz2 <= 1; dz2++) {
      for (let dx2 = -1; dx2 <= 1; dx2++) {
        if ((dx2 === 0 && dz2 === 0) || !ventAt(job, sx + dx2, sz + dz2)) continue;
        const qx = Math.max(sx + dx2, Math.min(sx + dx2 + 1, x * 2)), qz = Math.max(sz + dz2, Math.min(sz + dz2 + 1, z * 2));
        const d = Math.hypot(x * 2 - qx, z * 2 - qz) * (CELL / 2);
        dust = Math.max(dust, 1.3 * Math.exp(-d / 0.07));
      }
    }
    gr += 0.4 * decay * dust + 0.12 * dust;
  }
  // ---- wetness
  const wet = (g.flags[c] & CellFlag.WET) !== 0;
  if (isFloor) {
    const pn = fbm2(SEED_PUDDLE, wx / 2.4, wz / 2.4, 2);
    b = Math.max(b, hum * sstep(0.58, 0.8, pn));
    const wf = wetFeather(g, x, z, wx, wz);
    if (wf > 0) b = Math.max(b, wf * (0.75 + 0.25 * valueNoise2(SEED_PUDDLE + 7, wx / 0.7, wz / 0.7)));
    // pool splash zone: decks within SPLASH_REACH of a pool's water edge (floors at or above its water line)
    const pl = poolNear(job, cache, c);
    if (pl.length > 0) {
      const p = cache.pools as Float64Array;
      let dMin = Infinity;
      for (let q = 0; q < pl.length; q++) {
        const o = pl[q] * 5;
        if (floorY < p[o + 4] - 0.02) continue; // the pool's own (submerged) floor
        const dx = Math.max(0, p[o] - x, x - p[o + 2]), dz = Math.max(0, p[o + 1] - z, z - p[o + 3]);
        dMin = Math.min(dMin, Math.hypot(dx, dz) * CELL);
      }
      if (dMin < SPLASH_REACH) {
        b = Math.max(b, SPLASH_MAX * (1 - sstep(0.15, SPLASH_REACH, dMin)) * (0.55 + 0.45 * valueNoise2(SEED_SPLASH, wx / 0.9, wz / 0.9)));
      }
    }
  } else if (isWall) {
    if (wet) b = Math.max(b, 0.5 * (1 - sstep(0, 0.3, hy)));
    b = Math.max(b, 0.25 * hum * (1 - sstep(0, 0.15, hy)));
  }
  // ---- damage
  if (isWall) {
    // periodic tower walls: the peel noise is 3 m-periodic in y (12 lattice units of 0.25 m; along the wall it wraps
    // every 4.2 m, longer than any tower wall)
    const base = decay * (1 - sstep(0.05, 0.4, hy));
    if (base > 0) {
      const along = (Math.abs(nx) > 0.5 ? wz : wx) / 0.35;
      const peel = towerCell ? valueNoise2P(SEED_PEEL, along, y / 0.25, 12) : valueNoise2(SEED_PEEL, along, y / 0.25);
      a = Math.max(a, base * sstep(0.45, 0.8, peel));
    }
    a = Math.max(a, decay * hum * 0.6 * (1 - sstep(0, 0.2, hy)));
  } else if (isFloor) {
    const fm = g.floorMat[c];
    // hard floors (texture realism v2 lane B): the same traffic burnishes concrete into glossy lanes, dulls terrazzo's
    // polish and wears VCT's wax, at 0.8 x the carpet amplitude (the shaders shape each response)
    const hard = fm === Mat.CONCRETE_FLOOR || fm === Mat.TERRAZZO || fm === Mat.VINYL_VCT;
    if (hard || fm === Mat.CARPET_L0 || fm === Mat.CARPET_OFFICE) {
      const wn = valueNoise2(SEED_WEAR, wx / 0.8, wz / 0.8);
      const amp = (0.3 + 0.7 * decay) * (0.55 + 0.45 * wn) * (hard ? 0.8 : 1);
      if (corridorOf(job, cache, c) <= 3) a = Math.max(a, amp * sstep(0.25, 0.55, wallDist));
      // thresholds (ellipses across openings) and lanes between openings of the same room
      const wl = wearNear(g, cache, c);
      if (wl.length > 0) {
        const o = cache.open as Float64Array, ln = cache.lanes as Float64Array;
        let w = 0;
        for (let q = 0; q < wl.length; q++) {
          const k = wl[q];
          if (k & (1 << 30)) {
            const i = (k & ~(1 << 30)) * 4;
            const d = segDist(x, z, ln[i], ln[i + 1], ln[i + 2], ln[i + 3]) * CELL;
            w = Math.max(w, 0.6 * (1 - sstep(0.2, 0.6, d)));
          } else {
            const i = k * 5;
            const dn = ((o[i + 2] === 0 ? x - o[i] : z - o[i + 1]) * CELL) / 0.9;
            const dt = ((o[i + 2] === 0 ? z - o[i + 1] : x - o[i]) * CELL) / 0.5;
            w = Math.max(w, 1 - sstep(0.35, 1, dn * dn + dt * dt));
          }
        }
        a = Math.max(a, amp * w);
      }
      // rack aisles on hard floors: forklift / pallet-jack wheel tracks between tall shelving on both sides (daily
      // traffic whatever the decay)
      if (hard && job.boxTop9[c] > floorY + AISLE_MIN_H) a = Math.max(a, (0.7 + 0.3 * decay) * (0.75 + 0.25 * wn) * aisleTracks(job, x, z, floorY, c));
    }
  }
  maskOut.r = r > 1 ? 1 : r; maskOut.g = gr > 1 ? 1 : gr; maskOut.b = b > 1 ? 1 : b; maskOut.a = a > 1 ? 1 : a;
  void nz;
}

/** Rack aisles (hard floors), near occluders at least AISLE_MIN_H tall (cars stay below): occluder boxes reaching
 * between 1 and 2.5 m above the floor (rack decks, uprights, stacked goods) and at least AISLE_MIN_LEN long along the
 * aisle count as shelving; an aisle is a gap of AISLE_MIN_W to AISLE_MAX_W between two of them. */
const AISLE_MIN_H = 1.8, AISLE_MIN_LEN = 0.9, AISLE_MIN_W = 1.0, AISLE_MAX_W = 4.2;
/** Per bake job: per halo cell, the shelving box rectangles (x0 z0 x1 z1, halo units) within 3 cells. */
const aisleRects = new WeakMap<BakeJob, (Float64Array | null)[]>();
/**
 * Wheel-track wear (0..1) of a floor texel (x, z halo units) in a rack aisle: the gap to the nearest tall box on
 * each side along x and along z (boxes whose extent across covers the texel); a gap of at most AISLE_MAX_W is an
 * aisle, worn in two tracks 0.45 m either side of its centre (one centre track in aisles under 1.6 m) and fading out
 * next to the racks. 0 under a box or outside aisles.
 */
function aisleTracks(job: BakeJob, x: number, z: number, floorY: number, c: number): number {
  const g = job.g;
  let per = aisleRects.get(job);
  if (!per) { per = new Array<Float64Array | null>(g.n * g.n).fill(null); aisleRects.set(job, per); }
  let rl = per[c];
  if (!rl) {
    const hi = c % g.n, hj = (c - hi) / g.n;
    const seen = new Set<number>();
    const out: number[] = [];
    for (let j = Math.max(0, hj - 3); j <= Math.min(g.n - 1, hj + 3); j++) {
      for (let i = Math.max(0, hi - 3); i <= Math.min(g.n - 1, hi + 3); i++) {
        const cc = j * g.n + i;
        for (let k = g.boxStart[cc]; k < g.boxStart[cc + 1]; k++) {
          const b = g.boxList[k];
          if (seen.has(b)) continue;
          seen.add(b);
          const o = b * 6;
          if (g.boxRamp[b] >= 0 || g.box[o + 4] < floorY + 1.0 || g.box[o + 1] > floorY + 2.5) continue;
          out.push(g.box[o], g.box[o + 2], g.box[o + 3], g.box[o + 5]);
        }
      }
    }
    rl = Float64Array.from(out);
    per[c] = rl;
  }
  const m = 0.1 / CELL, len = AISLE_MIN_LEN / CELL;
  let xl = Infinity, xr = Infinity, zl = Infinity, zr = Infinity;
  for (let q = 0; q < rl.length; q += 4) {
    const x0 = rl[q], z0 = rl[q + 1], x1 = rl[q + 2], z1 = rl[q + 3];
    if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return 0;
    if (z >= z0 - m && z <= z1 + m && z1 - z0 >= len) { if (x1 <= x) xl = Math.min(xl, x - x1); else if (x0 >= x) xr = Math.min(xr, x0 - x); }
    if (x >= x0 - m && x <= x1 + m && x1 - x0 >= len) { if (z1 <= z) zl = Math.min(zl, z - z1); else if (z0 >= z) zr = Math.min(zr, z0 - z); }
  }
  let w = 0;
  for (const [dl, dr] of [[xl * CELL, xr * CELL], [zl * CELL, zr * CELL]]) {
    const wd = dl + dr;
    if (!(wd <= AISLE_MAX_W) || wd < AISLE_MIN_W) continue; // (the flue between back-to-back racks is no aisle)
    const off = Math.abs(dl - dr) / 2; // metres from the aisle centre
    const track = wd < 1.6 ? Math.exp(-((off / 0.35) ** 2)) : Math.exp(-(((off - 0.45) / 0.22) ** 2));
    w = Math.max(w, track * sstep(0.15, 0.5, Math.min(dl, dr)));
  }
  return w;
}

/** Is the halo 0.6 m sub-tile (sx, sz) a VENT ceiling tile? */
function ventAt(job: BakeJob, sx: number, sz: number): boolean {
  const g = job.g;
  const hi = sx >> 1, hj = sz >> 1;
  if (hi < 0 || hj < 0 || hi >= g.n || hj >= g.n) return false;
  const c = hj * g.n + hi;
  const slot = g.slot[c];
  const lay = job.nb.get(slotDcx(slot) as -1 | 0 | 1, slotDcz(slot) as -1 | 0 | 1);
  return getTile(lay.tiles, g.local[c], (sz & 1) * 2 + (sx & 1)) === TileState.VENT;
}

/** Distance (m) along the wall from a wall texel to the nearest door jamb, wall end or outside corner (large if
 * none within the texel's cell). */
function wallEndDist(g: BakeJob['g'], x: number, z: number, nx: number, nz: number): number {
  const alongX = Math.abs(nx) > 0.5; // wall on a line x = const, running along z
  const hi = Math.floor(x), hj = Math.floor(z);
  let best = 9;
  if (alongX) {
    const L = Math.round(x);
    const side = nx > 0 ? L : L - 1; // the room-side cell column
    const t = z - hj;
    const own = exK(g, L, hj);
    if (own === EdgeKind.DOORWAY) best = Math.min(best, Math.abs(Math.abs(t - 0.5) * CELL - 0.45));
    // ends at t = 0 (towards hj - 1) and t = 1 (towards hj + 1)
    for (const [dj, lineZ, dt] of [[-1, hj, t], [1, hj + 1, 1 - t]] as const) {
      const nk = exK(g, L, hj + dj);
      if (nk === EdgeKind.DOORWAY) best = Math.min(best, dt * CELL + (CELL - 0.9) / 2);
      else if (!wallX(g, L, hj + dj) && !wallZ(g, side, lineZ)) best = Math.min(best, dt * CELL);
    }
  } else {
    const L = Math.round(z);
    const side = nz > 0 ? L : L - 1;
    const t = x - hi;
    const own = ezK(g, hi, L);
    if (own === EdgeKind.DOORWAY) best = Math.min(best, Math.abs(Math.abs(t - 0.5) * CELL - 0.45));
    for (const [di, lineX, dt] of [[-1, hi, t], [1, hi + 1, 1 - t]] as const) {
      const nk = ezK(g, hi + di, L);
      if (nk === EdgeKind.DOORWAY) best = Math.min(best, dt * CELL + (CELL - 0.9) / 2);
      else if (!wallZ(g, hi + di, L) && !wallX(g, lineX, side)) best = Math.min(best, dt * CELL);
    }
  }
  return best;
}
