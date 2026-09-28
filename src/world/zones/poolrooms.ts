// src/world/zones/poolrooms.ts — POOLROOMS generator (WP3). GLOBAL seams: 8x8-cell room lattice, pools, arches.
//
// World model (everything below is a pure function of (seed, storey, global lattice coordinates), so both sides
// of a seam — and every chunk touched by a merged hall — compute identical data):
// - Room lattice: global 8x8-cell rooms (rx = floor(gi/8), rz = floor(gj/8)). Every lattice wall has an id
//   (axis, line, index) and is removed when hash01(id) < 0.35 (merged halls, seam lines included: globalSeam
//   derives the same wall from the id); every other wall is a tiled WALL with 1–3 ARCH openings (1–3 cells wide: an
//   arcade of 1 m round arches) at positions hashed from the wall id.
// - Groups: a merged room is the whole connected component of rooms joined by removed walls (bond percolation at
//   p 0.35 is subcritical, so components are small; the BFS is exact, whichever member starts it). The rooms share
//   one data record keyed by the lowest room id (the anchor): ceiling height, flood level, and the pool/terrace
//   features. Features live in the group's largest fully merged rectangle of rooms that contains the anchor and lies
//   inside the anchor's chunk (R), so pools never cross seams.
// - Pools (p 0.6): R inset 1–2 cells, shallow end −40..−90 cm, deep end −130..−180 cm (NOWALK, float rope along the
//   boundary), a stepped entry ramp (0.3 m treads) at the shallow end, a POOL_LADDER near the deep end, optional
//   UNDERWATER wall lights (p 0.3). Water at −10 cm, or at the flood level of a flooded room.
// - Flooded rooms (p 0.2): +20..+30 cm of water over the whole floor; openings towards drier floors get a 36 cm
//   tiled curb so the water surface is always contained by a face.
// - Terraces (p 0.25): one interior side of R raised +45 cm (2 cells deep) with a 3-step ramp; arches that open onto
//   a terrace get a 3-step ramp on their lower side.
// - Channels: where the rooms on both sides of an arch have pools at the same water level, a sunken channel
//   (−30 cm floor, 1–2 cells) runs from pool to pool through the arch. A channel through a seam arch is cut only when
//   both chunks can prove both pools exist (no landmark in either anchor chunk; artery / tower / elevator cells come
//   from the world query), so a channel never dead-ends at a pool the other chunk had to drop.
//
// R2 (B4) district variants (districtParams.variant, drawn after the WP3 params so those keep their values):
// - CLASSIC (40%): the model above.
// - TUNNELS (15%): no merged rooms; every lattice wall has one 2-cell arch at its middle with a 210 cm crown, and
//   each room is solid except a 2-cell-wide cross of tiled tube corridors (250 cm ceiling) joining the four arches,
//   flooded knee deep (+30; the curb rule contains it at other districts).
// - TERRACES (15%): every group gets a terrace, raised 60 or 90 cm (a 5-step ramp), with 1-2 waterfalls on its
//   riser (a glowing sheet of water decal, wet floor, a WATER emitter) falling toward the pool.
// - SUNLIT (15%): vaulted 720 cm halls under a dense daylight skylight lattice (6500-7000 K, bright).
// - DRAINED (15%): the pools are empty: walkable basins 150-210 cm deep reached by a long stepped entry, stained and
//   littered with fallen tiles, their underwater lights still burning on dry tile. No flooded rooms.

import { CELL, CHUNK_CELLS, CHUNK_CELL_COUNT } from '../../core/constants.ts';
import { cellIdx, floorDiv, mod } from '../../core/grid.ts';
import { CeilKind, CellFlag, DecalKind, EdgeKind, EmitterKind, FixtureKind, Mat, PropKind, SolidFlag, Zone, type StoreyId } from '../../core/ids.ts';
import { NO_WATER } from '../../core/layout.ts';
import { hash01, hash2, hash4, hash5, hash6, Rng, SALT } from '../../core/rng.ts';
import type {
  CellPatch, DistrictInfo, GlobalSeamQuery, LightingProfile, SeamEdges, ZoneGenContext, ZoneGenerator, ZonePalette,
} from '../../core/world.ts';
import {
  cellWalkable, chunkHasLandmark, globalBlockedTest, createFixturePlacer, DX, DZ, emitWaterRects, fieldAt, HALF_PI, inChunk,
  isReservedCell, kindOpenAtWater, N, sameDistrictAcross, sideKind, STEP_CM, WADE_CM, WALK_FLAGS,
} from './deepcommon.ts';
import { UNDERWATER_NITS } from '../content/util.ts';

const ROOM = 8; // cells per lattice room
/** Safety cap of the merged-room BFS. Components at p 0.35 are small (simulated over 10^6 rooms: 99.7% of rooms lie in
 * components under 100 rooms, the largest ~150; the tail falls off exponentially), so the cap is never reached. */
const MAX_GROUP_ROOMS = 4096;
const RPC = CHUNK_CELLS / ROOM; // rooms per chunk side (4)
const MERGE_P = 0.35;
const POOL_P = 0.6;
const FLOOD_P = 0.2;
const TERRACE_P = 0.25;
const LIGHTS_P = 0.3;
const TERRACE_CM = 45;
const CHANNEL_FLOOR_CM = -30;
const POOL_WATER_CM = -10;
const CURB_CM = 36;
const TAG = Zone.POOLROOMS * 16;
const UNDERWATER_CCT: readonly [number, number] = [7200, 8200];
/** R2 (B4) district variants (see the header). */
export const PoolVariant = { CLASSIC: 0, TUNNELS: 1, TERRACES: 2, SUNLIT: 3, DRAINED: 4 } as const;
const VARIANT_WEIGHTS: readonly number[] = [40, 15, 15, 15, 15];
const TUNNEL = { crownCm: 210, ceilCm: 250, levelCm: 30, arm: [3, 5] as const } as const;
const SKY_CCT: [number, number] = [6000, 6800];

// cell roles inside one chunk
const R_DECK = 0, R_POOL = 1, R_CHANNEL = 2, R_TERRACE = 3, R_RAMP = 4, R_CURB = 5, R_RES = 6;

// ---------------------------------------------------------------- lattice walls

interface Opening { off: number; w: number }
interface WallInfo { removed: boolean; kinds: Uint8Array; crown: number; openings: Opening[]; h: number }

const wallHash = (seed: number, s: number, axisBit: number, line: number, index: number): number =>
  hash6(seed, SALT.GLOBAL_FEATURE, TAG + s, axisBit, line, index);
const roomId = (seed: number, s: number, rx: number, rz: number): number => hash5(seed, SALT.GLOBAL_FEATURE, TAG + 8 + s, rx, rz);

/** axisBit 0: the wall on line x = 8·L between rooms (L−1, idx) and (L, idx); axisBit 1: line z = 8·L between
 * rooms (idx, L−1) and (idx, L). */
function wallRemoved(seed: number, s: number, axisBit: number, L: number, idx: number): boolean {
  return hash01(wallHash(seed, s, axisBit, L, idx)) < MERGE_P;
}
/** Collision-free numeric key of a lattice room (|rx|, |rz| < 2^20 rooms = 5 000 km). */
const roomKey = (rx: number, rz: number): number => (rx + 0x100000) * 0x200000 + (rz + 0x100000);

function computeWall(seed: number, s: number, vaulted: boolean, axisBit: number, L: number, idx: number, variant = 0): WallInfo {
  const h = wallHash(seed, s, axisBit, L, idx);
  const kinds = new Uint8Array(ROOM);
  if (variant === PoolVariant.TUNNELS) {
    // tube network: one 2-cell arch in the middle of every lattice wall (the corridor arms meet it)
    kinds.fill(EdgeKind.WALL);
    kinds[TUNNEL.arm[0]] = kinds[TUNNEL.arm[0] + 1] = EdgeKind.ARCH;
    return { removed: false, kinds, crown: TUNNEL.crownCm, openings: [{ off: TUNNEL.arm[0], w: 2 }], h };
  }
  if (hash01(h) < MERGE_P) return { removed: true, kinds, crown: 0, openings: [], h };
  kinds.fill(EdgeKind.WALL);
  const rng = new Rng(hash2(h, 0x5a17));
  const count = 1 + rng.weighted([0.35, 0.45, 0.2]);
  const openings: Opening[] = [];
  for (let k = 0; k < count; k++) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const w = 1 + rng.weighted([0.45, 0.4, 0.15]);
      const off = rng.int(1, ROOM - 1 - w); // openings stay in [1, 6]: never next to a corner post
      let free = true;
      for (let c = off - 1; c <= off + w && free; c++) if (c >= 0 && c < ROOM && kinds[c] !== EdgeKind.WALL) free = false;
      if (!free) continue;
      for (let c = off; c < off + w; c++) kinds[c] = EdgeKind.ARCH;
      openings.push({ off, w });
      break;
    }
  }
  if (openings.length === 0) { kinds[3] = kinds[4] = EdgeKind.ARCH; openings.push({ off: 3, w: 2 }); }
  const crown = 260 + 20 * rng.int(0, 2) + (vaulted ? 80 : 0);
  return { removed: false, kinds, crown, openings, h };
}

// ---------------------------------------------------------------- groups (merged rooms) and their features

interface Rect { i0: number; j0: number; i1: number; j1: number } // global cells, half-open
interface PoolInfo extends Rect {
  axis: 0 | 1; shallowLow: boolean; shallowF: number; deepF: number; deepCount: number;
  entry: Rect & { dir: 0 | 1 | 2 | 3 };
  ladder: { gi: number; gj: number; dir: number }; // pool cell + direction toward its pool wall
  lights: boolean;
  dry: boolean; // DRAINED variant: no water
}
interface TerraceInfo { strip: Rect; ramp: Rect & { dir: 0 | 1 | 2 | 3 }; side: number; h: number }
interface Group {
  anchor: number; // room id of the anchor
  arx: number; arz: number;
  R: Rect; // rooms-derived rect in global cells (inside the anchor's chunk)
  ceil: number; level: number; flooded: boolean;
  pool: PoolInfo | null;
  terrace: TerraceInfo | null;
}

const inRect = (r: Rect, gi: number, gj: number): boolean => gi >= r.i0 && gi < r.i1 && gj >= r.j0 && gj < r.j1;

class PoolWorld {
  private groups = new Map<number, Group>();
  private walls = new Map<string, WallInfo>();
  readonly seed: number;
  readonly s: StoreyId;
  readonly vaulted: boolean;
  readonly variant: number;
  constructor(seed: number, s: StoreyId, vaulted: boolean, variant = 0) {
    this.seed = seed;
    this.s = s;
    this.vaulted = vaulted;
    this.variant = variant;
  }

  wall(axisBit: number, L: number, idx: number): WallInfo {
    const k = `${axisBit}:${L}:${idx}`;
    let w = this.walls.get(k);
    if (!w) this.walls.set(k, (w = computeWall(this.seed, this.s, this.vaulted, axisBit, L, idx, this.variant)));
    return w;
  }

  /** Is the wall between room (rx, rz) and its neighbour in direction d removed? */
  private open(rx: number, rz: number, d: number): boolean {
    if (this.variant === PoolVariant.TUNNELS) return false;
    switch (d) {
      case 0: return wallRemoved(this.seed, this.s, 0, rx + 1, rz);
      case 1: return wallRemoved(this.seed, this.s, 0, rx, rz);
      case 2: return wallRemoved(this.seed, this.s, 1, rz + 1, rx);
      default: return wallRemoved(this.seed, this.s, 1, rz, rx);
    }
  }

  group(rx: number, rz: number): Group {
    const hit = this.groups.get(roomKey(rx, rz));
    if (hit) return hit;
    // BFS through removed walls: the merged room is the whole connected component
    const member = new Set<number>([roomKey(rx, rz)]);
    const qx: number[] = [rx], qz: number[] = [rz];
    for (let q = 0; q < qx.length && qx.length < MAX_GROUP_ROOMS; q++) {
      for (let d = 0; d < 4; d++) {
        const nx = qx[q] + DX[d], nz = qz[q] + DZ[d];
        const k = roomKey(nx, nz);
        if (member.has(k) || !this.open(qx[q], qz[q], d)) continue;
        member.add(k);
        qx.push(nx); qz.push(nz);
      }
    }
    let arx = rx, arz = rz, aid = roomId(this.seed, this.s, rx, rz);
    for (let q = 1; q < qx.length; q++) {
      const id = roomId(this.seed, this.s, qx[q], qz[q]);
      if (id < aid || (id === aid && (qx[q] < arx || (qx[q] === arx && qz[q] < arz)))) { aid = id; arx = qx[q]; arz = qz[q]; }
    }
    const g = this.groups.get(roomKey(arx, arz)) ?? this.buildGroup(aid, arx, arz, member);
    for (let q = 0; q < qx.length; q++) this.groups.set(roomKey(qx[q], qz[q]), g);
    return g;
  }

  private buildGroup(aid: number, arx: number, arz: number, member: ReadonlySet<number>): Group {
    // R: the largest fully merged rectangle of member rooms containing the anchor, inside the anchor's chunk
    const acx = floorDiv(arx, RPC), acz = floorDiv(arz, RPC);
    const cx0 = acx * RPC, cz0 = acz * RPC;
    let best: [number, number, number, number] = [arx, arz, arx + 1, arz + 1];
    let bestArea = 1;
    for (let x0 = cx0; x0 <= arx; x0++) for (let x1 = arx + 1; x1 <= cx0 + RPC; x1++) {
      for (let z0 = cz0; z0 <= arz; z0++) for (let z1 = arz + 1; z1 <= cz0 + RPC; z1++) {
        const area = (x1 - x0) * (z1 - z0);
        if (area <= bestArea) continue;
        let ok = true;
        for (let z = z0; z < z1 && ok; z++) for (let x = x0; x < x1 && ok; x++) {
          if (!member.has(roomKey(x, z))) ok = false;
          else if (x + 1 < x1 && !this.open(x, z, 0)) ok = false;
          else if (z + 1 < z1 && !this.open(x, z, 2)) ok = false;
        }
        if (ok) { best = [x0, z0, x1, z1]; bestArea = area; }
      }
    }
    const R: Rect = { i0: best[0] * ROOM, j0: best[1] * ROOM, i1: best[2] * ROOM, j1: best[3] * ROOM };
    const rng = new Rng(hash2(aid, 0x9001));
    const V = this.variant;
    let ceil = this.vaulted ? 720 : 360 + 30 * rng.int(0, 8);
    let flooded = rng.chance(FLOOD_P);
    let level = flooded ? 20 + 5 * rng.int(0, 2) : POOL_WATER_CM;
    let wantPool = rng.chance(POOL_P);
    let wantTerrace = rng.chance(TERRACE_P);
    // R2 variants (draws after the classic ones: CLASSIC groups are unchanged)
    const vrng = new Rng(hash2(aid, 0x7a41));
    if (V === PoolVariant.TUNNELS) {
      ceil = TUNNEL.ceilCm; flooded = true; level = TUNNEL.levelCm; wantPool = false; wantTerrace = false;
    } else if (V === PoolVariant.TERRACES) {
      wantTerrace = true; flooded = false; level = POOL_WATER_CM;
    } else if (V === PoolVariant.DRAINED) {
      flooded = false; level = POOL_WATER_CM; wantPool = vrng.chance(0.85);
    }
    const terraceCm = V === PoolVariant.TERRACES ? (vrng.chance(0.5) ? 60 : 90) : TERRACE_CM;
    const side0 = rng.int(0, 3);
    const insets = [rng.int(1, 2), rng.int(1, 2), rng.int(1, 2), rng.int(1, 2)]; // W N E S
    // ---- terrace on an interior side of R (never on a chunk seam line: all its arches lead into this chunk)
    let terrace: TerraceInfo | null = null;
    const F: Rect = { ...R };
    if (wantTerrace) {
      for (let k = 0; k < 4 && !terrace; k++) {
        const side = (side0 + k) & 3;
        const line = side === 0 ? R.i0 : side === 1 ? R.j0 : side === 2 ? R.i1 : R.j1;
        if (mod(line, CHUNK_CELLS) === 0) continue;
        const alongX = side === 1 || side === 3;
        const a0 = alongX ? R.i0 : R.j0, a1 = alongX ? R.i1 : R.j1;
        const p = rng.int(a0 + 2, a1 - 4); // ramp: 2 cells wide, inside the strip's span
        let strip: Rect, ramp: Rect & { dir: 0 | 1 | 2 | 3 };
        switch (side) {
          case 0: strip = { i0: R.i0, j0: R.j0 + 1, i1: R.i0 + 2, j1: R.j1 - 1 }; ramp = { i0: R.i0 + 2, j0: p, i1: R.i0 + 3, j1: p + 2, dir: 1 }; F.i0 = R.i0 + 2; break;
          case 1: strip = { i0: R.i0 + 1, j0: R.j0, i1: R.i1 - 1, j1: R.j0 + 2 }; ramp = { i0: p, j0: R.j0 + 2, i1: p + 2, j1: R.j0 + 3, dir: 3 }; F.j0 = R.j0 + 2; break;
          case 2: strip = { i0: R.i1 - 2, j0: R.j0 + 1, i1: R.i1, j1: R.j1 - 1 }; ramp = { i0: R.i1 - 3, j0: p, i1: R.i1 - 2, j1: p + 2, dir: 0 }; F.i1 = R.i1 - 2; break;
          default: strip = { i0: R.i0 + 1, j0: R.j1 - 2, i1: R.i1 - 1, j1: R.j1 }; ramp = { i0: p, j0: R.j1 - 3, i1: p + 2, j1: R.j1 - 2, dir: 2 }; F.j1 = R.j1 - 2; break;
        }
        terrace = { strip, ramp, side, h: terraceCm };
        insets[side] = 2; // ramp row + one deck row before the pool
      }
    }
    // ---- pool
    let pool: PoolInfo | null = null;
    if (wantPool) {
      const P: Rect = { i0: F.i0 + insets[0], j0: F.j0 + insets[1], i1: F.i1 - insets[2], j1: F.j1 - insets[3] };
      const wx = P.i1 - P.i0, wz = P.j1 - P.j0;
      if (wx >= 2 && wz >= 2) {
        const axis: 0 | 1 = wx >= wz ? 0 : 1;
        const len = axis === 0 ? wx : wz, wid = axis === 0 ? wz : wx;
        const shallowLow = rng.chance(0.5);
        const dry = V === PoolVariant.DRAINED;
        const shallowF = dry ? -150 - 10 * vrng.int(0, 6) : Math.max(-40 - 10 * rng.int(0, 5), level - 100);
        const deepF = -130 - 10 * rng.int(0, 5);
        const allShallow = dry || len < 4 || rng.chance(0.3);
        const deepCount = allShallow ? 0 : Math.max(2, Math.min(len - 2, Math.floor(len * 0.4)));
        const shallowCount = len - deepCount;
        const rl = Math.min(dry ? 3 : -shallowF <= 60 ? 1 : 2, shallowCount - 1);
        const we = Math.min(2, wid);
        const perp0 = axis === 0 ? P.j0 : P.i0;
        const q0 = rng.int(perp0, perp0 + wid - we);
        const a0 = axis === 0 ? P.i0 : P.j0, a1 = axis === 0 ? P.i1 : P.j1;
        const e0 = shallowLow ? a0 : a1 - rl, e1 = e0 + rl;
        const dir: 0 | 1 | 2 | 3 = axis === 0 ? (shallowLow ? 1 : 0) : (shallowLow ? 3 : 2);
        const entry = axis === 0
          ? { i0: e0, j0: q0, i1: e1, j1: q0 + we, dir }
          : { i0: q0, j0: e0, i1: q0 + we, j1: e1, dir };
        // ladder: deep (far) end, on one long side, backing onto that pool wall
        const farCell = shallowLow ? a1 - 1 : a0;
        const along = len >= 3 ? farCell + (shallowLow ? -1 : 1) : farCell;
        const lowSide = rng.chance(0.5);
        const perpCell = lowSide ? perp0 : perp0 + wid - 1;
        const ladder = axis === 0
          ? { gi: along, gj: perpCell, dir: lowSide ? 3 : 2 }
          : { gi: perpCell, gj: along, dir: lowSide ? 1 : 0 };
        pool = { ...P, axis, shallowLow, shallowF, deepF, deepCount, entry, ladder, lights: rng.chance(LIGHTS_P) || (dry && vrng.chance(0.6)), dry };
      }
    }
    return { anchor: aid, arx, arz, R, ceil, level, flooded, pool, terrace };
  }

  /** Floor (cm) of a global cell inside group g's R rect (pool / terrace / deck; channels excluded). */
  static featureFloor(g: Group, gi: number, gj: number): number {
    const p = g.pool;
    if (p && inRect(p, gi, gj)) {
      if (p.deepCount === 0) return p.shallowF;
      const a = p.axis === 0 ? gi : gj;
      const a0 = p.axis === 0 ? p.i0 : p.j0, a1 = p.axis === 0 ? p.i1 : p.j1;
      const deep = p.shallowLow ? a >= a1 - p.deepCount : a < a0 + p.deepCount;
      return deep ? p.deepF : p.shallowF;
    }
    if (g.terrace && inRect(g.terrace.strip, gi, gj)) return g.terrace.h;
    return 0;
  }
}

/** Channel cells (global) from the arch cells of wall (axisBit, Lg) into group g's pool on the side `sgn`, or null. */
function channelPath(g: Group, axisBit: number, Lg: number, sgn: -1 | 1, b0: number, cw: number): [number, number][] | null {
  const p = g.pool;
  if (!p) return null;
  // (a, b): a across the wall, b along it
  const pa0 = axisBit === 0 ? p.i0 : p.j0, pa1 = axisBit === 0 ? p.i1 : p.j1;
  const pb0 = axisBit === 0 ? p.j0 : p.i0, pb1 = axisBit === 0 ? p.j1 : p.i1;
  const aS = sgn < 0 ? Lg - 1 : Lg;
  const aN = sgn < 0 ? pa1 : pa0 - 1;
  if ((sgn < 0 && aN > aS) || (sgn > 0 && aN < aS)) return null;
  const out: [number, number][] = [];
  const put = (a: number, b: number): void => { out.push(axisBit === 0 ? [a, b] : [b, a]); };
  const straight = b0 >= pb0 && b0 + cw <= pb1;
  const width = straight ? cw : 1;
  for (let a = aS; sgn < 0 ? a >= aN : a <= aN; a += sgn) for (let b = b0; b < b0 + width; b++) put(a, b);
  if (!straight) {
    if (b0 < pb0) for (let b = b0 + 1; b <= pb0; b++) put(aN, b);
    else for (let b = b0 - 1; b >= pb1 - 1; b--) put(aN, b);
  }
  // conflicts with the group's own features
  for (const [gi, gj] of out) {
    if (!inRect(g.R, gi, gj) || inRect(p, gi, gj)) return null;
    const t = g.terrace;
    if (t && (inRect(t.strip, gi, gj) || inRect(t.ramp, gi, gj))) return null;
  }
  return out;
}

// ---------------------------------------------------------------- generator

const params = (d: DistrictInfo): { vaulted: boolean; variant: number } => {
  const variant = d.params.variant ?? PoolVariant.CLASSIC;
  return { vaulted: (d.params.vaulted ?? 0) > 0 || variant === PoolVariant.SUNLIT, variant };
};

function poolSeam(q: GlobalSeamQuery): SeamEdges {
  const e: SeamEdges = { kind: new Uint8Array(N), hA: new Int16Array(N), hB: new Int16Array(N) };
  const pp = params(q.district);
  const world = new PoolWorld(q.seed, q.s, pp.vaulted, pp.variant);
  const axisBit = q.axis === 'x' ? 0 : 1;
  if (mod(q.line, ROOM) !== 0) return e; // not a lattice line (never happens for chunk seams)
  const L = q.line / ROOM;
  for (let c = 0; c < N; c++) {
    const g = q.g0 + c;
    const idx = floorDiv(g, ROOM);
    const w = world.wall(axisBit, L, idx);
    const k = w.kinds[g - idx * ROOM];
    e.kind[c] = k;
    e.hA[c] = k === EdgeKind.ARCH ? w.crown : 0;
  }
  return e;
}

function generate(ctx: ZoneGenContext): void {
  const g = ctx.grid, l = g.layout;
  const { s } = ctx.key;
  const pp = params(ctx.district);
  const variant = pp.variant;
  const world = new PoolWorld(ctx.seed, s, pp.vaulted, variant);
  const gi0 = g.gi0, gj0 = g.gj0;
  const rx0 = floorDiv(gi0, ROOM), rz0 = floorDiv(gj0, ROOM);
  const tileOpts = { matNeg: Mat.POOL_TILE, matPos: Mat.POOL_TILE, trim: 0 };

  // ---- 1. interior lattice walls (seam lines 0 / 32 are frozen and come from globalSeam / the boundary rule)
  for (let axisBit = 0; axisBit < 2; axisBit++) {
    for (let k = 1; k < RPC; k++) {
      const L = (axisBit === 0 ? rx0 : rz0) + k;
      for (let r = 0; r < RPC; r++) {
        const idx = (axisBit === 0 ? rz0 : rx0) + r;
        const w = world.wall(axisBit, L, idx);
        for (let c = 0; c < ROOM; c++) {
          const kind = w.kinds[c];
          const o = kind === EdgeKind.ARCH ? { ...tileOpts, hA: w.crown } : tileOpts;
          if (axisBit === 0) g.setEdge('x', k * ROOM, r * ROOM + c, kind, o);
          else g.setEdge('z', r * ROOM + c, k * ROOM, kind, o);
        }
      }
    }
  }

  // ---- 2. per-cell group, ceilings, roles
  const role = new Uint8Array(CHUNK_CELL_COUNT);
  const cellGroup: Group[] = new Array(CHUNK_CELL_COUNT);
  const anchored: Group[] = [];
  for (let rj = 0; rj < RPC; rj++) {
    for (let ri = 0; ri < RPC; ri++) {
      const grp = world.group(rx0 + ri, rz0 + rj);
      for (let lj = rj * ROOM; lj < rj * ROOM + ROOM; lj++) for (let li = ri * ROOM; li < ri * ROOM + ROOM; li++) cellGroup[cellIdx(li, lj)] = grp;
      g.setCells(ri * ROOM, rj * ROOM, ri * ROOM + ROOM, rj * ROOM + ROOM, { ceilCm: grp.ceil });
      if (floorDiv(grp.arx, RPC) === ctx.key.cx && floorDiv(grp.arz, RPC) === ctx.key.cz && !anchored.includes(grp)) anchored.push(grp);
    }
  }
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) if (isReservedCell(l, c)) role[c] = R_RES;

  // global blockers both sides of a seam can see (artery lanes, tower footprints + apron)
  const globalBlocked = globalBlockedTest(ctx);
  const rectGlobalClear = (r: Rect, margin: number): boolean => {
    for (let gj = r.j0 - margin; gj < r.j1 + margin; gj++) for (let gi = r.i0 - margin; gi < r.i1 + margin; gi++) if (globalBlocked(gi, gj)) return false;
    return true;
  };
  const rectLocalClear = (r: Rect, margin: number): boolean => {
    for (let gj = r.j0 - margin; gj < r.j1 + margin; gj++) for (let gi = r.i0 - margin; gi < r.i1 + margin; gi++) {
      const li = gi - gi0, lj = gj - gj0;
      if (inChunk(li, lj) && isReservedCell(l, cellIdx(li, lj))) return false;
    }
    return true;
  };
  /** Pool realized (global part of the rule; channels of the neighbouring chunk rely on it). */
  const poolLive = (grp: Group): boolean => grp.pool !== null && rectGlobalClear(grp.pool, 1);
  /** Pool realized, as every chunk can prove it: the global rule, and no landmark stamp in the anchor chunk (the only
   * stamp whose footprint the world query does not expose). Implies the anchor chunk's local rule. */
  const provablyLive = (grp: Group): boolean =>
    poolLive(grp) && !chunkHasLandmark(ctx, floorDiv(grp.arx, RPC), floorDiv(grp.arz, RPC));
  const terraceLive = (grp: Group): boolean => grp.terrace !== null && rectGlobalClear(grp.terrace.strip, 1) && rectGlobalClear(grp.terrace.ramp, 1);

  const patch = (c: number, p: CellPatch): void => g.setCells(c & 31, c >> 5, (c & 31) + 1, (c >> 5) + 1, p);
  const loc = (gi: number, gj: number): number => {
    const li = gi - gi0, lj = gj - gj0;
    return inChunk(li, lj) ? cellIdx(li, lj) : -1;
  };
  /** Tiled masonry steps (terrace ramps, arch steps, pool entries): FILLED bodies down to the floor. */
  const addRamp = (r: Rect, dir: 0 | 1 | 2 | 3, y0: number, y1: number, steps: number): void => {
    g.addSolid({
      kind: 'ramp', x0: (r.i0 - gi0) * CELL, z0: (r.j0 - gj0) * CELL, x1: (r.i1 - gi0) * CELL, z1: (r.j1 - gj0) * CELL,
      y0, y1, dir, steps, mat: Mat.POOL_TILE, flags: WALK_FLAGS | SolidFlag.FILLED, bakeGroup: 0,
    });
  };
  const placer = createFixturePlacer(ctx);
  const propSeed = (gi: number, gj: number, k: number): number => hash4(ctx.seed, SALT.PROP, gi * 4 + k, gj);

  if (variant === PoolVariant.TUNNELS) {
    // the tube network: every room is solid tile mass except the 2-cell cross joining its four arches
    const [a0, a1] = TUNNEL.arm;
    for (let lj = 0; lj < N; lj++) for (let li = 0; li < N; li++) {
      const c = cellIdx(li, lj);
      if (role[c] === R_RES) continue;
      const ri = mod(gi0 + li, ROOM), rj = mod(gj0 + lj, ROOM);
      if ((ri >= a0 && ri < a1) || (rj >= a0 && rj < a1)) continue;
      patch(c, { flagsSet: CellFlag.SOLID });
      role[c] = R_RES;
    }
  }

  /** TERRACES: 1-2 waterfalls on the terrace riser: a sheet of falling water (a glowing decal), wet floor and a
   * WATER emitter at its foot. */
  const waterfalls = (grp: Group, t: TerraceInfo): void => {
    const rng = new Rng(hash2(grp.anchor, 0xfa11));
    const n = 1 + (rng.chance(0.5) ? 1 : 0);
    const alongX = t.side === 1 || t.side === 3;
    const a0 = alongX ? t.strip.i0 : t.strip.j0, a1 = alongX ? t.strip.i1 : t.strip.j1;
    const rampA0 = alongX ? t.ramp.i0 : t.ramp.j0, rampA1 = alongX ? t.ramp.i1 : t.ramp.j1;
    for (let k = 0; k < n; k++) {
      const a = rng.int(a0 + 1, a1 - 2);
      if (a + 1 > rampA0 - 1 && a < rampA1 + 1) continue; // keep clear of the ramp
      // riser line: the strip's inner edge; the face looks away from the strip
      const dir = t.side; // 0 W 1 N 2 E 3 S: the strip is on that side of R, the room lies toward the opposite side
      const nx = dir === 0 ? 1 : dir === 2 ? -1 : 0, nz = dir === 1 ? 1 : dir === 3 ? -1 : 0;
      const line = dir === 0 ? t.strip.i1 : dir === 2 ? t.strip.i0 : dir === 1 ? t.strip.j1 : t.strip.j0;
      const ga = a + 1; // centre along the riser (global cell line)
      const x = alongX ? (ga - gi0) * CELL : (line - gi0) * CELL + nx * 0.006;
      const z = alongX ? (line - gj0) * CELL + nz * 0.006 : (ga - gj0) * CELL;
      if (x < 0.3 || z < 0.3 || x > N * CELL - 0.3 || z > N * CELL - 0.3) continue;
      g.addDecal({ kind: 15, sign: true, px: x, py: t.h / 200, pz: z, nx, ny: 0, nz, rot: 0, w: 1.3, h: t.h / 100, alpha: 0.85, emit: 170, color: [0.72, 0.9, 1.0] });
      g.addDecal({ kind: DecalKind.WATER_STAIN, sign: false, px: x + nx * 0.7, py: 0.004, pz: z + nz * 0.7, nx: 0, ny: 1, nz: 0, rot: 0, w: 1.6, h: 1.1, alpha: 0.55 });
      const fc = loc(Math.floor(x / CELL) + gi0 + nx, Math.floor(z / CELL) + gj0 + nz);
      if (fc >= 0 && role[fc] === R_DECK) patch(fc, { flagsSet: CellFlag.WET });
      g.addEmitter(EmitterKind.WATER, x + nx * 0.4, 0.2, z + nz * 0.4, 0.55);
    }
  };
  /** DRAINED: stains and mould on the basin floor, fallen tiles, a drip. */
  const drainedDressing = (grp: Group, p: PoolInfo): void => {
    const rng = new Rng(hash2(grp.anchor, 0xd7a1));
    const at = (gi: number, gj: number): [number, number] => [(gi - gi0) * CELL, (gj - gj0) * CELL];
    for (let k = 0; k < 4; k++) {
      const [x, z] = at(rng.range(p.i0 + 0.5, p.i1 - 0.5), rng.range(p.j0 + 0.5, p.j1 - 0.5));
      g.addDecal({ kind: k & 1 ? DecalKind.MOLD : DecalKind.WATER_STAIN, sign: false, px: x, py: p.shallowF / 100 + 0.004, pz: z, nx: 0, ny: 1, nz: 0, rot: rng.range(0, 6.28), w: rng.range(1.2, 2.4), h: rng.range(0.9, 1.6), alpha: 0.6 });
    }
    for (let k = 0; k < 5; k++) {
      const gi = rng.range(p.i0 + 0.3, p.i1 - 0.3), gj = rng.range(p.j0 + 0.3, p.j1 - 0.3);
      if (inRect(p.entry, Math.floor(gi), Math.floor(gj))) continue;
      const [x, z] = at(gi, gj);
      g.addProp({ kind: k < 4 ? PropKind.TILE_FRAGMENT : PropKind.CEILING_DEBRIS, variant: rng.int(0, 3), x, y: p.shallowF / 100, z, yaw: rng.range(0, 6.28), scale: 1, flags: 0, seed: propSeed(Math.floor(gi), Math.floor(gj), 11 + k) });
    }
    const [dx, dz] = at((p.i0 + p.i1) / 2, (p.j0 + p.j1) / 2);
    g.addEmitter(EmitterKind.DRIP, dx, p.shallowF / 100 + 0.02, dz, 0.3);
  };

  // ---- 3. features of the groups anchored in this chunk (their R lies entirely inside it)
  const livePools: Group[] = [];
  for (const grp of anchored) {
    const t = grp.terrace;
    if (t && terraceLive(grp) && rectLocalClear(t.strip, 1) && rectLocalClear(t.ramp, 1)) {
      for (let gj = t.strip.j0; gj < t.strip.j1; gj++) for (let gi = t.strip.i0; gi < t.strip.i1; gi++) {
        const c = loc(gi, gj);
        if (c < 0 || role[c] === R_RES) continue;
        role[c] = R_TERRACE;
        patch(c, { floorCm: t.h });
      }
      for (let gj = t.ramp.j0; gj < t.ramp.j1; gj++) for (let gi = t.ramp.i0; gi < t.ramp.i1; gi++) { const c = loc(gi, gj); if (c >= 0) role[c] = R_RAMP; }
      addRamp(t.ramp, t.ramp.dir, 0, t.h / 100, Math.max(3, Math.round(t.h / 15)));
      if (variant === PoolVariant.TERRACES) waterfalls(grp, t);
    }
    const p = grp.pool;
    if (!p || !poolLive(grp) || !rectLocalClear(p, 1)) continue;
    livePools.push(grp);
    for (let gj = p.j0; gj < p.j1; gj++) for (let gi = p.i0; gi < p.i1; gi++) {
      const c = loc(gi, gj);
      if (c < 0) continue;
      role[c] = R_POOL;
      patch(c, { floorCm: PoolWorld.featureFloor(grp, gi, gj), floorMat: Mat.POOL_MOSAIC });
    }
    // stepped entry (0.3 m treads) from the deck down to the shallow floor
    const e = p.entry;
    const lenM = ((e.dir === 0 || e.dir === 1) ? e.i1 - e.i0 : e.j1 - e.j0) * CELL;
    addRamp(e, e.dir, p.shallowF / 100, 0, Math.max(3, Math.round(lenM / 0.3)));
    // ladder at the deep end, back against the pool wall
    const lc = loc(p.ladder.gi, p.ladder.gj);
    if (lc >= 0) {
      const d = p.ladder.dir;
      const lx = (p.ladder.gi - gi0 + 0.5) * CELL + DX[d] * (CELL / 2 - 0.27);
      const lz = (p.ladder.gj - gj0 + 0.5) * CELL + DZ[d] * (CELL / 2 - 0.27);
      // WP6 (props/pool.ts): the ladder's coping level is local y = 1.0, so p.y = deckY − 1.0 (deck at 0). Pick a
      // tread count whose lowest tread clears the pool floor (v1: 2 treads from −0.55, v0/v2: 3 from −0.75, v3: 4 from −0.9).
      const floor = l.floorCm[lc], lh = propSeed(p.ladder.gi, p.ladder.gj, 0);
      const variant = floor <= -95 ? [0, 2, 3][lh % 3] : floor <= -80 ? [0, 2][lh & 1] : 1;
      g.addProp({
        kind: PropKind.POOL_LADDER, variant, x: lx, y: -1.0, z: lz,
        yaw: backYaw(d), scale: 1, flags: 0, seed: lh,
      });
    }
    // water sound (a drained pool: stains, fallen tiles and a drip instead)
    const area = (p.i1 - p.i0) * (p.j1 - p.j0);
    if (p.dry) drainedDressing(grp, p);
    else {
      g.addEmitter(EmitterKind.WATER, ((p.i0 + p.i1) / 2 - gi0) * CELL, grp.level / 100, ((p.j0 + p.j1) / 2 - gj0) * CELL,
        Math.min(1, Math.max(0.3, area / 40)));
    }
  }

  // ---- 4. channels through arches between two pooled rooms (both sides compute the same global path)
  const doneWalls = new Set<string>();
  for (let rj = 0; rj < RPC; rj++) {
    for (let ri = 0; ri < RPC; ri++) {
      const rx = rx0 + ri, rz = rz0 + rj;
      for (let d = 0; d < 4; d++) {
        const axisBit = d < 2 ? 0 : 1;
        const L = d === 0 ? rx + 1 : d === 1 ? rx : d === 2 ? rz + 1 : rz;
        const idx = axisBit === 0 ? rz : rx;
        const wkey = `${axisBit}:${L}:${idx}`;
        if (doneWalls.has(wkey)) continue;
        doneWalls.add(wkey);
        const w = world.wall(axisBit, L, idx);
        if (w.removed || w.openings.length === 0) continue;
        // rooms on the negative / positive side of the wall
        const nrx = axisBit === 0 ? L - 1 : idx, nrz = axisBit === 0 ? idx : L - 1;
        const prx = axisBit === 0 ? L : idx, prz = axisBit === 0 ? idx : L;
        const gN = world.group(nrx, nrz), gP = world.group(prx, prz);
        if (gN === gP || gN.level !== gP.level) continue;
        const Lg = L * ROOM;
        if (!inRect(gN.R, axisBit === 0 ? Lg - 1 : idx * ROOM, axisBit === 0 ? idx * ROOM : Lg - 1)) continue;
        if (!inRect(gP.R, axisBit === 0 ? Lg : idx * ROOM, axisBit === 0 ? idx * ROOM : Lg)) continue;
        const seamLine = mod(Lg, CHUNK_CELLS) === 0;
        if (seamLine) {
          // both chunks decide from data they share: the pools' global rule and the sites of both anchor chunks
          const dcx = axisBit === 0 ? (Lg === gi0 ? -1 : 1) : 0, dcz = axisBit === 1 ? (Lg === gj0 ? -1 : 1) : 0;
          if (!sameDistrictAcross(ctx, dcx, dcz) || !provablyLive(gN) || !provablyLive(gP)) continue;
        } else if (!livePools.includes(gN) || !livePools.includes(gP)) continue; // both anchored here
        const op = w.openings[(w.h >>> 3) % w.openings.length];
        const cw = op.w >= 2 && (w.h & 1) === 1 ? 2 : 1;
        const b0 = idx * ROOM + op.off;
        // the arch must really be there (frozen seam / reserved stamps may have changed it)
        let archOk = true;
        for (let b = b0; b < b0 + cw && archOk; b++) {
          const li = axisBit === 0 ? Lg - gi0 : b - gi0, lj = axisBit === 0 ? b - gj0 : Lg - gj0;
          const kind = axisBit === 0 ? g.getEdge('x', li, lj) : g.getEdge('z', li, lj);
          if (kind !== EdgeKind.ARCH) archOk = false;
        }
        if (!archOk) continue;
        const pathN = channelPath(gN, axisBit, Lg, -1, b0, cw);
        const pathP = channelPath(gP, axisBit, Lg, 1, b0, cw);
        if (!pathN || !pathP) continue;
        const path = [...pathN, ...pathP];
        // all or nothing: never a channel stub (stamps seen by both sides, then this side's own cells)
        if (path.some(([gi, gj]) => globalBlocked(gi, gj))) continue;
        if (path.some(([gi, gj]) => { const c = loc(gi, gj); return c >= 0 && role[c] !== R_DECK && role[c] !== R_CHANNEL; })) continue;
        for (const [gi, gj] of path) {
          const c = loc(gi, gj);
          if (c < 0 || role[c] !== R_DECK) continue;
          role[c] = R_CHANNEL;
          patch(c, { floorCm: CHANNEL_FLOOR_CM, floorMat: Mat.POOL_MOSAIC });
        }
      }
    }
  }

  // ---- 5. arches that open onto a terrace: a 3-step ramp on the lower side
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      const c = cellIdx(li, lj);
      if (role[c] !== R_TERRACE) continue;
      for (let d = 0; d < 4; d++) {
        const ni = li + DX[d], nj = lj + DZ[d];
        if (!inChunk(ni, nj)) continue;
        const kind = sideKind(l, li, lj, d);
        if (kind !== EdgeKind.ARCH && kind !== EdgeKind.OPEN) continue;
        const n = cellIdx(ni, nj);
        if (role[n] !== R_DECK || l.floorCm[c] - l.floorCm[n] <= STEP_CM) continue;
        if (kind === EdgeKind.OPEN && cellGroup[n] === cellGroup[c]) continue; // same hall: the terrace ramp serves it
        role[n] = R_RAMP;
        const r: Rect = { i0: gi0 + ni, j0: gj0 + nj, i1: gi0 + ni + 1, j1: gj0 + nj + 1 };
        addRamp(r, (d ^ 1) as 0 | 1 | 2 | 3, l.floorCm[n] / 100, l.floorCm[c] / 100, Math.max(3, Math.round((l.floorCm[c] - l.floorCm[n]) / 15)));
      }
    }
  }

  // ---- 6. water: pools / channels at the group level, flooded rooms over the whole floor
  const kindOf = new Int8Array(CHUNK_CELL_COUNT).fill(-1);
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
    const r = role[c];
    if (r === R_RES) continue;
    const grp = cellGroup[c];
    if (r === R_POOL || r === R_CHANNEL) {
      if (variant === PoolVariant.DRAINED) continue; // empty basins and dry channels
      patch(c, { waterCm: grp.level }); kindOf[c] = 0;
    }
    else if (grp.flooded && (r === R_DECK || r === R_RAMP) && grp.level > l.floorCm[c]) { patch(c, { waterCm: grp.level }); kindOf[c] = 1; }
  }
  // curbs: a flooded cell whose water could spill through an opening onto a lower or drier floor
  const neighbourWater = (li: number, lj: number, d: number): { floor: number; water: number } => {
    const ni = li + DX[d], nj = lj + DZ[d];
    if (inChunk(ni, nj)) {
      const n = cellIdx(ni, nj);
      if (l.flags[n] & CellFlag.SOLID) return { floor: 32767, water: NO_WATER }; // a solid mass holds the water (TUNNELS)
      return { floor: l.floorCm[n], water: l.waterCm[n] };
    }
    const dcx = ni < 0 ? -1 : ni >= N ? 1 : 0, dcz = nj < 0 ? -1 : nj >= N ? 1 : 0;
    if (!sameDistrictAcross(ctx, dcx, dcz) || globalBlocked(gi0 + ni, gj0 + nj)) return { floor: 0, water: NO_WATER };
    const grp = world.group(floorDiv(gi0 + ni, ROOM), floorDiv(gj0 + nj, ROOM));
    return { floor: 0, water: grp.flooded ? grp.level : NO_WATER };
  };
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      const c = cellIdx(li, lj);
      const W = l.waterCm[c];
      if (W === NO_WATER || role[c] === R_RES || W <= 0) continue; // only flood water stands above deck level
      for (let d = 0; d < 4; d++) {
        if (!kindOpenAtWater(sideKind(l, li, lj, d))) continue;
        const nb = neighbourWater(li, lj, d);
        if (nb.floor >= W || (nb.water !== NO_WATER && nb.water >= W)) continue;
        role[c] = R_CURB;
        patch(c, { floorCm: CURB_CM, floorMat: Mat.POOL_TILE, waterCm: NO_WATER });
        kindOf[c] = -1;
        break;
      }
    }
  }
  // deep water is NOWALK; splash zone around pools is WET
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
    if (role[c] === R_RES) continue;
    const W = l.waterCm[c];
    if (W !== NO_WATER && W - l.floorCm[c] > WADE_CM) patch(c, { flagsSet: CellFlag.NOWALK });
  }
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      const c = cellIdx(li, lj);
      if (role[c] !== R_DECK || l.waterCm[c] !== NO_WATER) continue;
      let near = false;
      for (let dj = -1; dj <= 1 && !near; dj++) for (let di = -1; di <= 1 && !near; di++) {
        const i = li + di, j = lj + dj;
        if (inChunk(i, j) && role[cellIdx(i, j)] === R_POOL) near = true;
      }
      if (near) patch(c, { flagsSet: CellFlag.WET });
    }
  }

  // ---- 7. float ropes on every wadeable | NOWALK water boundary (the deep edge is visible, not an invisible wall)
  const wadeable = (c: number): boolean => l.waterCm[c] !== NO_WATER && cellWalkable(l, c);
  const deepCell = (c: number): boolean => l.waterCm[c] !== NO_WATER && (l.flags[c] & CellFlag.NOWALK) !== 0;
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      const c = cellIdx(li, lj);
      for (let d = 0; d < 3; d += 2) { // +x and +z neighbours: each interior edge once
        const ni = li + DX[d], nj = lj + DZ[d];
        if (!inChunk(ni, nj)) continue;
        const n = cellIdx(ni, nj);
        if (!((wadeable(c) && deepCell(n)) || (deepCell(c) && wadeable(n)))) continue;
        const y = Math.min(l.waterCm[c], l.waterCm[n]) / 100 - 0.06;
        const x = d === 0 ? (li + 1) * CELL : (li + 0.5) * CELL;
        const z = d === 0 ? (lj + 0.5) * CELL : (lj + 1) * CELL;
        g.addProp({
          kind: PropKind.FLOAT_ROPE, variant: 0, x, y, z, yaw: d === 0 ? HALF_PI : 0, scale: 1, flags: 0,
          seed: propSeed(gi0 + li, gj0 + lj, d + 1),
        });
      }
    }
  }

  // ---- 8. underwater lights in pool walls (p 0.3 per pool)
  for (const grp of livePools) {
    const p = grp.pool as PoolInfo;
    if (!p.lights) continue;
    const perpDirs = p.axis === 0 ? [3, 2] : [1, 0];
    const a0 = p.axis === 0 ? p.i0 : p.j0, a1 = p.axis === 0 ? p.i1 : p.j1;
    for (const d of perpDirs) {
      for (let a = a0 + 1; a < a1; a += 2) {
        const gi = p.axis === 0 ? a : (d === 1 ? p.i0 : p.i1 - 1);
        const gj = p.axis === 0 ? (d === 3 ? p.j0 : p.j1 - 1) : a;
        const c = loc(gi, gj);
        if (c < 0 || inRect(p.entry, gi, gj) || (gi === p.ladder.gi && gj === p.ladder.gj)) continue;
        const outer = loc(gi + DX[d], gj + DZ[d]);
        if (outer < 0 || l.floorCm[outer] < 0) continue; // the wall face must exist (no channel behind it)
        const floor = l.floorCm[c];
        const depth = grp.level - floor;
        if (depth < 60) continue; // too shallow for a submerged lens
        const yCm = Math.min(grp.level - 22, -15, floor + depth * 0.5);
        if (yCm < floor + 15) continue;
        const li = gi - gi0, lj = gj - gj0;
        // WP6 draws the lens + bezel flush with the fixture origin: p is the pool wall face (the cell line), nudged
        // 2 mm into the pool cell so the owner cell / tile lookups land on the pool side
        const px = (li + 0.5) * CELL + DX[d] * (CELL / 2 - 0.002), pz = (lj + 0.5) * CELL + DZ[d] * (CELL / 2 - 0.002);
        placer.add({
          kind: FixtureKind.UNDERWATER, shape: 0, px, py: yCm / 100, pz,
          nx: -DX[d], ny: 0, nz: -DZ[d], tx: DZ[d] !== 0 ? 1 : 0, ty: 0, tz: DX[d] !== 0 ? 1 : 0,
          w: 0.26, h: 0.26, cct: UNDERWATER_CCT, luminance: UNDERWATER_NITS, hum: 0.05,
        });
      }
    }
  }

  // ---- 9. deck furniture: loungers against the wall along a pool's long side, a lifebuoy near each pool
  for (const grp of livePools) {
    const p = grp.pool as PoolInfo;
    const rng = new Rng(hash2(grp.anchor, 0x10c));
    const R = grp.R;
    const sides = p.axis === 0 ? [3, 2] : [1, 0];
    for (const d of sides) {
      // outer deck row along this side (adjacent to the R boundary), only when the deck strip is 2 cells deep
      const gap = d === 3 ? p.j0 - R.j0 : d === 2 ? R.j1 - p.j1 : d === 1 ? p.i0 - R.i0 : R.i1 - p.i1;
      if (gap < 2 || (grp.terrace && grp.terrace.side === (d === 3 ? 1 : d === 2 ? 3 : d === 1 ? 0 : 2))) continue;
      const a0 = p.axis === 0 ? p.i0 : p.j0, a1 = p.axis === 0 ? p.i1 : p.j1;
      let placed = 0;
      for (let a = a0; a + 1 < a1 && placed < 3; a += 3) {
        if (!rng.chance(0.65)) continue;
        const cells: [number, number][] = p.axis === 0
          ? [[a, d === 3 ? R.j0 : R.j1 - 1], [a + 1, d === 3 ? R.j0 : R.j1 - 1]]
          : [[d === 1 ? R.i0 : R.i1 - 1, a], [d === 1 ? R.i0 : R.i1 - 1, a + 1]];
        let ok = true;
        for (const [gi, gj] of cells) {
          const c = loc(gi, gj);
          if (c < 0 || role[c] !== R_DECK || l.waterCm[c] !== NO_WATER) { ok = false; break; }
          const li = gi - gi0, lj = gj - gj0;
          if (sideKind(l, li, lj, d) !== EdgeKind.WALL) { ok = false; break; }
          // keep arch approaches clear
          for (const e of [0, 1, 2, 3]) if (e !== (d ^ 1) && sideKind(l, li, lj, e) === EdgeKind.ARCH) ok = false;
        }
        if (!ok) continue;
        const [ga, gb] = cells[0];
        const cx = p.axis === 0 ? (ga - gi0 + 1) * CELL : (ga - gi0 + 0.5) * CELL + DX[d] * 0.12;
        const cz = p.axis === 0 ? (gb - gj0 + 0.5) * CELL + DZ[d] * 0.12 : (gb - gj0 + 1) * CELL;
        g.addProp({
          kind: PropKind.LOUNGE_CHAIR, variant: rng.int(0, 2), x: cx, y: 0, z: cz, yaw: p.axis === 0 ? HALF_PI : 0,
          scale: 1, flags: 0, seed: propSeed(ga, gb, 7),
        });
        placed++;
      }
    }
    if (rng.chance(0.6)) {
      // lifebuoy on the R boundary wall facing the pool's long side
      const d = sides[rng.int(0, 1)];
      const a = (p.axis === 0 ? p.i0 + p.i1 : p.j0 + p.j1) >> 1;
      const gi = p.axis === 0 ? a : (d === 1 ? R.i0 : R.i1 - 1);
      const gj = p.axis === 0 ? (d === 3 ? R.j0 : R.j1 - 1) : a;
      const c = loc(gi, gj);
      if (c >= 0 && role[c] !== R_RES && sideKind(l, gi - gi0, gj - gj0, d) === EdgeKind.WALL) {
        const li = gi - gi0, lj = gj - gj0;
        g.addProp({
          kind: PropKind.LIFEBUOY, variant: 0, x: (li + 0.5) * CELL + DX[d] * (CELL / 2 - 0.075 - 0.07),
          y: l.floorCm[c] / 100 + 1.25, z: (lj + 0.5) * CELL + DZ[d] * (CELL / 2 - 0.075 - 0.07), yaw: backYaw(d), scale: 1,
          flags: 0, seed: propSeed(gi, gj, 9),
        });
      }
    }
  }

  // ---- 10. drips from the ceiling of humid rooms
  for (const grp of anchored) {
    const rng = new Rng(hash2(grp.anchor, 0xd21));
    const R = grp.R;
    const gi = rng.int(R.i0 + 1, R.i1 - 2), gj = rng.int(R.j0 + 1, R.j1 - 2);
    const c = loc(gi, gj);
    if (c < 0 || role[c] === R_RES) continue;
    if (fieldAt(l.humidity, c) > 0.55 && rng.chance(0.5)) {
      g.addEmitter(EmitterKind.DRIP, (gi - gi0 + 0.5) * CELL, l.ceilCm[c] / 100 - 0.02, (gj - gj0 + 0.5) * CELL, 0.35);
    }
  }

  emitWaterRects(g, kindOf);
}

/** Yaw that turns a prop's back (+Z local) toward direction d (0 +x, 1 −x, 2 +z, 3 −z). */
function backYaw(d: number): number {
  return d === 0 ? HALF_PI : d === 1 ? -HALF_PI : d === 2 ? 0 : Math.PI;
}

export const poolroomsGenerator: ZoneGenerator = {
  id: Zone.POOLROOMS,
  seamMode: 'global',
  districtParams(rng, _s) {
    return {
      vaulted: rng.chance(0.22) ? 1 : 0,
      phaseX: rng.int(0, 5),
      phaseZ: rng.int(0, 5),
      variant: rng.weighted(VARIANT_WEIGHTS), // R2 (B4): drawn last so the WP3 params above keep their values
    };
  },
  globalSeam: poolSeam,
  generate,
  palette(_s: StoreyId, d: DistrictInfo): ZonePalette {
    return {
      floorMat: Mat.POOL_TILE, wallMat: Mat.POOL_TILE, ceilMat: Mat.POOL_TILE, trimMat: Mat.POOL_TILE,
      ceilKind: CeilKind.TILE_GLAZED, ceilCm: params(d).variant === PoolVariant.TUNNELS ? TUNNEL.ceilCm : params(d).vaulted ? 720 : 360, baseboard: false,
    };
  },
  lighting(_s: StoreyId, d: DistrictInfo): LightingProfile {
    const v = params(d).variant;
    // SUNLIT: a dense lattice of bright daylight panels; TUNNELS: a tighter lattice so every tube arm gets panels
    const dense = v === PoolVariant.SUNLIT || v === PoolVariant.TUNNELS;
    return {
      kind: FixtureKind.SKY_PANEL, placement: 'lattice', lattice: dense ? [4, 4] : [6, 6],
      phase: [d.params.phaseX ?? 0, d.params.phaseZ ?? 0], axis: 0,
      cctRange: v === PoolVariant.SUNLIT ? [6500, 7000] : SKY_CCT,
      luminance: v === PoolVariant.SUNLIT ? 5200 : v === PoolVariant.TUNNELS ? 1800 : 2500, zoneMul: 1, mountCm: 0,
    };
  },
  props: {
    rules: [
      { kind: PropKind.LIFEBUOY, where: 'wallMounted', per100m2: 0.35, variants: 1, minSpacing: 6, yCm: 125 },
      { kind: PropKind.BENCH_TILED, where: 'wall', per100m2: 0.5, variants: 2, minSpacing: 4, yCm: 0 },
      { kind: PropKind.LOUNGE_CHAIR, where: 'wall', per100m2: 0.35, variants: 3, minSpacing: 2.5, yCm: 0 },
      { kind: PropKind.TOWEL, where: 'wall', per100m2: 0.15, variants: 3, minSpacing: 3, yCm: 0 },
    ],
  },
};

/** Test hook: the pool / terrace / group data of a global lattice room (pure). */
export function poolroomsRoomInfo(seed: number, s: StoreyId, vaulted: boolean, rx: number, rz: number, variant = 0): {
  anchor: number; R: Rect; ceil: number; level: number; flooded: boolean;
  pool: (Rect & { shallowF: number; deepF: number; deepCount: number; entry: Rect }) | null; terrace: { strip: Rect; ramp: Rect } | null;
} {
  const grp = new PoolWorld(seed, s, vaulted, variant).group(rx, rz);
  return { anchor: grp.anchor, R: grp.R, ceil: grp.ceil, level: grp.level, flooded: grp.flooded, pool: grp.pool, terrace: grp.terrace };
}

/** Test hook: is the lattice wall (axisBit, L, idx) removed (merged rooms)? axisBit 0: line x = 8·L, idx = rz. */
export const poolroomsWallRemoved = (seed: number, s: StoreyId, axisBit: 0 | 1, L: number, idx: number): boolean =>
  wallRemoved(seed, s, axisBit, L, idx);
