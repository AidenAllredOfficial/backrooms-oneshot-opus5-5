// src/world/zones/deepcommon.ts — shared helpers for the deep-strata zone generators (WP3): cell/edge access,
// walkability (mirrors WP1's connectivity rule), custom fixture placement with the WP4 colour/luminance rule,
// greedy WaterRect emission, carving helpers for the solid-mass zones (PIPEWORKS, CONCRETE), seam builders,
// artery-lane lookups for world-anchored structure (beams, girders, columns) and paint-stripe decals.
// Pure module: no three / DOM / Math.random.

import { ARTERY, CELL, CEIL_TILE, CHUNK_CELLS, CHUNK_CELL_COUNT, CHUNK_SIZE } from '../../core/constants.ts';
import { EDGE_WALKABLE } from '../../core/edges.ts';
import { cellIdx, clamp, exIdx, ezIdx } from '../../core/grid.ts';
import {
  CellFlag, DECAL_PAINT_STRIPE, EdgeKind, LightState, SolidFlag, type FixtureKindId, type MatId,
} from '../../core/ids.ts';
import { NO_WATER, type ChunkLayout } from '../../core/layout.ts';
import { hash01, hash2, hash4, SALT } from '../../core/rng.ts';
import {
  elevatorFootprint, towerFootprint, type ChunkGrid, type ElevatorSite, type LandmarkSite, type SeamEdges, type ZoneGenContext,
} from '../../core/world.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';

export const N = CHUNK_CELLS;
export const STEP_CM = 36; // player step (connectivity rule)
export const WADE_CM = 110; // deeper water is NOWALK

/** Solid flag sets used by the deep zones. */
export const BOX_FLAGS = SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.RENDER;
export const WALK_FLAGS = BOX_FLAGS | SolidFlag.WALKABLE_TOP;
export const RAIL_FLAGS = SolidFlag.COLLIDE | SolidFlag.RENDER;
export const PIPE_FLAGS = SolidFlag.COLLIDE | SolidFlag.RENDER;

/** Direction tables: 0 = +x, 1 = -x, 2 = +z, 3 = -z (same encoding as Solid ramp `dir`). */
export const DX = [1, -1, 0, 0] as const;
export const DZ = [0, 0, 1, -1] as const;

export const HALF_PI = Math.PI / 2;

/** Local cell inside the chunk. */
export const inChunk = (li: number, lj: number): boolean => li >= 0 && lj >= 0 && li < N && lj < N;

const NOT_WALK = CellFlag.SOLID | CellFlag.VOID | CellFlag.NOWALK | CellFlag.TOWER | CellFlag.ELEVATOR;

/** Walkable cell (WP1 rule): not SOLID|VOID|NOWALK|TOWER|ELEVATOR, water depth <= 1.1 m, no blocker. */
export function cellWalkable(l: ChunkLayout, c: number): boolean {
  if ((l.flags[c] & NOT_WALK) !== 0 || l.blockCm[c] !== 0) return false;
  const w = l.waterCm[c];
  return w === NO_WATER || w - l.floorCm[c] <= WADE_CM;
}

export const isReservedCell = (l: ChunkLayout, c: number): boolean => (l.flags[c] & CellFlag.RESERVED) !== 0;

/** Edge kind on the side `dir` of local cell (li, lj) (the edge may lie on a seam line). */
export function sideKind(l: ChunkLayout, li: number, lj: number, dir: number): number {
  switch (dir) {
    case 0: return l.ex.kind[exIdx(li + 1, lj)];
    case 1: return l.ex.kind[exIdx(li, lj)];
    case 2: return l.ez.kind[ezIdx(li, lj + 1)];
    default: return l.ez.kind[ezIdx(li, lj)];
  }
}
/** hA of the edge on side `dir` of local cell (li, lj). */
export function sideHA(l: ChunkLayout, li: number, lj: number, dir: number): number {
  switch (dir) {
    case 0: return l.ex.hA[exIdx(li + 1, lj)];
    case 1: return l.ex.hA[exIdx(li, lj)];
    case 2: return l.ez.hA[ezIdx(li, lj + 1)];
    default: return l.ez.hA[ezIdx(li, lj)];
  }
}
/** Writes the edge on side `dir` of local cell (li, lj) through the grid (respects frozen / reserved). */
export function setSide(g: ChunkGrid, li: number, lj: number, dir: number, kind: number, o?: Parameters<ChunkGrid['setEdge']>[4]): boolean {
  switch (dir) {
    case 0: return g.setEdge('x', li + 1, lj, kind, o);
    case 1: return g.setEdge('x', li, lj, kind, o);
    case 2: return g.setEdge('z', li, lj + 1, kind, o);
    default: return g.setEdge('z', li, lj, kind, o);
  }
}

/** Walkable edge kind (HEADER only with an underside >= 190 cm). */
export const kindWalkable = (kind: number, hA: number): boolean =>
  EDGE_WALKABLE[kind] && (kind !== EdgeKind.HEADER || hA >= 190);

/** Edge kinds whose pieces leave the band above the higher floor open, so water can spill through them. */
export const kindOpenAtWater = (kind: number): boolean =>
  kind === EdgeKind.OPEN || kind === EdgeKind.DOORWAY || kind === EdgeKind.HEADER || kind === EdgeKind.ARCH;

/** A seam of 32 edges, all of one kind. */
export function uniformSeam(kind: number): SeamEdges {
  const e: SeamEdges = { kind: new Uint8Array(N), hA: new Int16Array(N), hB: new Int16Array(N) };
  if (kind !== 0) e.kind.fill(kind);
  return e;
}

/** Longest WALL run of a seam. */
export function longestWallRun(kind: Uint8Array): number {
  let best = 0, run = 0;
  for (let i = 0; i < kind.length; i++) {
    run = kind[i] === EdgeKind.WALL ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** Field byte of a cell as [0,1). */
export const fieldAt = (arr: Uint8Array, c: number): number => arr[c] / 256;

// ---------------------------------------------------------------- custom fixtures

export interface FixtureSpec {
  kind: FixtureKindId;
  shape: 0 | 1;
  px: number; py: number; pz: number; // chunk-local metres (emitting surface centre)
  nx: number; ny: number; nz: number;
  tx: number; ty: number; tz: number;
  w: number; h: number;
  cct: readonly [number, number]; // Kelvin range; the warmth field interpolates
  luminance: number; // nits (RECT) or cd (SPHERE / HIGHBAY disk)
  hum: number;
}

/** Places custom fixtures with the same colour/luminance rule as WP4's lattice placer:
 *  color = kelvinToLinearRGB(lerp(cctHi, cctLo, warmth), 0.02 + 0.03·hash01), luminance ×(1 ± 0.06·hash).
 *  Guarantees one fixture per (kind, 0.6 m lattice tile) so ids stay unique within the chunk. */
export interface FixturePlacer {
  add(f: FixtureSpec): number; // fixture id, or -1 when the lattice tile is taken
  taken(kind: number, px: number, pz: number): boolean;
}
export function createFixturePlacer(ctx: ZoneGenContext): FixturePlacer {
  const g = ctx.grid;
  const used = new Set<number>();
  for (const f of g.layout.fixtures) used.add(tileKey(f.kind, f.px, f.pz));
  return {
    taken: (kind, px, pz) => used.has(tileKey(kind, px, pz)),
    add(f) {
      const key = tileKey(f.kind, f.px, f.pz);
      if (used.has(key)) return -1;
      used.add(key);
      const wx = g.gi0 * CELL + f.px, wz = g.gj0 * CELL + f.pz;
      const latticeI = Math.floor(wx / CEIL_TILE + 1e-7), latticeJ = Math.floor(wz / CEIL_TILE + 1e-7);
      const h = hash4(ctx.seed, SALT.FIXTURE, latticeI, latticeJ) ^ f.kind;
      // warmth field: warm (1) -> the low-K end of the range (same rule as WP4's lattice placer)
      const warmth = ctx.fields.warmth(wx, wz);
      const lo = Math.min(f.cct[0], f.cct[1]), hi = Math.max(f.cct[0], f.cct[1]);
      const cct = hi + (lo - hi) * warmth;
      const color = kelvinToLinearRGB(cct, 0.02 + 0.03 * hash01(h));
      const lum = f.luminance * (1 + 0.06 * (2 * hash01(hash2(h, 1)) - 1));
      return g.addFixture({
        kind: f.kind, state: LightState.ON, shape: f.shape,
        px: f.px, py: f.py, pz: f.pz, nx: f.nx, ny: f.ny, nz: f.nz, tx: f.tx, ty: f.ty, tz: f.tz,
        w: f.w, h: f.h, color, luminance: lum, hum: f.hum, bakeGroup: 0,
      }, { latticeI, latticeJ });
    },
  };
}
/** (kind, local 0.6 m lattice tile) key. Chunk-local lattice tiles map 1:1 to global ones (64 per chunk). */
function tileKey(kind: number, px: number, pz: number): number {
  const ti = Math.floor(px / CEIL_TILE + 1e-7) + 8, tj = Math.floor(pz / CEIL_TILE + 1e-7) + 8;
  return (kind * 128 + ti) * 128 + tj;
}

/** A downward point / sphere fixture (CAGE_BULB). */
export function bulbSpec(px: number, py: number, pz: number, cd: number, cct: readonly [number, number], hum: number): FixtureSpec {
  return {
    kind: 4 /* CAGE_BULB */ as FixtureKindId, shape: 1, px, py, pz, nx: 0, ny: -1, nz: 0, tx: 1, ty: 0, tz: 0,
    w: 0.1, h: 0.1, cct, luminance: cd, hum,
  };
}
/** A downward RECT fixture whose long side runs along x (alongX) or z. */
export function downRectSpec(kind: FixtureKindId, px: number, py: number, pz: number, alongX: boolean, w: number, h: number,
  nits: number, cct: readonly [number, number], hum: number): FixtureSpec {
  return {
    kind, shape: 0, px, py, pz, nx: 0, ny: -1, nz: 0, tx: alongX ? 1 : 0, ty: 0, tz: alongX ? 0 : 1,
    w, h, cct, luminance: nits, hum,
  };
}

// ---------------------------------------------------------------- water

/** Greedy rectangles over cells with water. `kindOf[c]` = WaterRect kind (0 pool, 1 flooded, 2 film) or -1.
 * Cells merge when water height, floor height and kind agree. */
export function emitWaterRects(g: ChunkGrid, kindOf: Int8Array): number {
  const l = g.layout;
  const used = new Uint8Array(CHUNK_CELL_COUNT);
  let n = 0;
  const same = (a: number, b: number): boolean =>
    !used[b] && kindOf[b] === kindOf[a] && l.waterCm[b] === l.waterCm[a] && l.floorCm[b] === l.floorCm[a];
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      const c = cellIdx(li, lj);
      if (used[c] || kindOf[c] < 0 || l.waterCm[c] === NO_WATER) continue;
      let li1 = li + 1;
      while (li1 < N && same(c, cellIdx(li1, lj))) li1++;
      let lj1 = lj + 1;
      for (; lj1 < N; lj1++) {
        let ok = true;
        for (let i = li; i < li1 && ok; i++) ok = same(c, cellIdx(i, lj1));
        if (!ok) break;
      }
      for (let j = lj; j < lj1; j++) for (let i = li; i < li1; i++) used[cellIdx(i, j)] = 1;
      g.addWater({
        x0: li * CELL, z0: lj * CELL, x1: li1 * CELL, z1: lj1 * CELL,
        y: l.waterCm[c] / 100, floorY: l.floorCm[c] / 100, kind: kindOf[c] as 0 | 1 | 2,
      });
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- carving (solid-mass zones)

/** Cells that must become walkable because a passable edge leads into them from outside the generator's domain:
 * seam ports (the other chunk's port cell is walkable by construction) and openings of reserved stamps (artery
 * side doors, tower/elevator exits, landmark entrances). Returns local cell indices. */
export function entryCells(l: ChunkLayout): number[] {
  const out: number[] = [];
  const seen = new Uint8Array(CHUNK_CELL_COUNT);
  const push = (c: number): void => { if (!seen[c] && !isReservedCell(l, c)) { seen[c] = 1; out.push(c); } };
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      const c = cellIdx(li, lj);
      if (isReservedCell(l, c)) continue;
      for (let d = 0; d < 4; d++) {
        const kind = sideKind(l, li, lj, d);
        if (!kindWalkable(kind, sideHA(l, li, lj, d))) continue;
        const ni = li + DX[d], nj = lj + DZ[d];
        if (!inChunk(ni, nj)) { push(c); continue; } // seam port
        const n = cellIdx(ni, nj);
        if (isReservedCell(l, n) && (l.flags[n] & (CellFlag.SOLID | CellFlag.VOID)) === 0) push(c);
      }
    }
  }
  return out;
}

/** BFS from cell `start` over non-reserved cells (4-neighbourhood, ignoring edges) to the nearest cell with
 * open[c] = 1; marks the path (including `start`) open. Deterministic (fixed neighbour order). */
export function carveToOpen(l: ChunkLayout, open: Uint8Array, start: number, prev: Int32Array, queue: Int32Array): boolean {
  if (open[start]) return true;
  prev.fill(-2);
  let qh = 0, qt = 0;
  queue[qt++] = start;
  prev[start] = -1;
  let hit = -1;
  while (qh < qt) {
    const c = queue[qh++];
    if (open[c] && c !== start) { hit = c; break; }
    const li = c & 31, lj = c >> 5;
    for (let d = 0; d < 4; d++) {
      const ni = li + DX[d], nj = lj + DZ[d];
      if (!inChunk(ni, nj)) continue;
      const n = cellIdx(ni, nj);
      if (prev[n] !== -2 || isReservedCell(l, n)) continue;
      prev[n] = c;
      queue[qt++] = n;
    }
  }
  if (hit < 0) return false;
  for (let c = prev[hit]; c >= 0; c = prev[c]) open[c] = 1;
  return true;
}

/** Writes `open` as the walkable mass: non-open, non-reserved cells become SOLID; open ones are cleared. Edges
 * between an open and a SOLID cell become WALL with `o` (interior lines only; seams are frozen). */
export function applyMass(g: ChunkGrid, open: Uint8Array, wallOpts: Parameters<ChunkGrid['setEdge']>[4] | null): void {
  const l = g.layout;
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
    if (isReservedCell(l, c)) continue;
    const li = c & 31, lj = c >> 5;
    if (open[c]) g.setCells(li, lj, li + 1, lj + 1, { flagsClear: CellFlag.SOLID });
    else g.setCells(li, lj, li + 1, lj + 1, { flagsSet: CellFlag.SOLID, blockCm: 0 });
  }
  if (!wallOpts) return;
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      const c = cellIdx(li, lj);
      if (li > 0) {
        const a = c - 1;
        if (!isReservedCell(l, a) && !isReservedCell(l, c) && open[a] !== open[c]) g.setEdge('x', li, lj, EdgeKind.WALL, wallOpts);
      }
      if (lj > 0) {
        const a = c - N;
        if (!isReservedCell(l, a) && !isReservedCell(l, c) && open[a] !== open[c]) g.setEdge('z', li, lj, EdgeKind.WALL, wallOpts);
      }
    }
  }
}

// ---------------------------------------------------------------- world-anchored helpers

/** Artery lane membership over GLOBAL cells, from the world query (both sides of a seam see the same spans). */
export function arteryLaneTest(ctx: ZoneGenContext): (gi: number, gj: number) => boolean {
  const spans = ctx.world.arteriesNear(ctx.key.s, ctx.key.cx, ctx.key.cz);
  if (spans.length === 0) return () => false;
  return (gi, gj) => {
    for (const a of spans) {
      if (a.axis === 'x') { if (gi >= a.g0 && gi < a.g1 && gj >= a.row && gj < a.row + ARTERY.WIDTH_CELLS) return true; }
      else if (gj >= a.g0 && gj < a.g1 && gi >= a.row && gi < a.row + ARTERY.WIDTH_CELLS) return true;
    }
    return false;
  };
}

/** Site queries WP1 implements on the WorldGen facade it passes as ctx.world, but which the WorldGenQuery contract
 * does not (yet) list (proposal: docs/contract-changes/WP3.md). Read duck-typed; absent (mock worlds) = no sites. */
interface SiteQueries {
  elevatorsNear?(s: number, cx: number, cz: number): readonly ElevatorSite[];
  landmarkAt?(s: number, cx: number, cz: number): LandmarkSite | null;
}
const siteQueries = (ctx: ZoneGenContext): SiteQueries => ctx.world as unknown as SiteQueries;

/** Elevator sites near chunk (cx, cz) (every storey stamps them), or [] when the world cannot tell. */
export function elevatorsNear(ctx: ZoneGenContext, cx: number, cz: number): readonly ElevatorSite[] {
  const q = siteQueries(ctx);
  return typeof q.elevatorsNear === 'function' ? q.elevatorsNear(ctx.key.s, cx, cz) : [];
}
/** Does chunk (cx, cz) of this storey carry a landmark stamp? Its footprint is private to WP4's generator, so callers
 * that must agree across a seam treat the whole chunk as possibly stamped (except its 2-cell seam margin). */
export function chunkHasLandmark(ctx: ZoneGenContext, cx: number, cz: number): boolean {
  const q = siteQueries(ctx);
  return typeof q.landmarkAt === 'function' && q.landmarkAt(ctx.key.s, cx, cz) !== null;
}

/** Cells that every chunk can know are taken by a stamp, over GLOBAL cells: artery lanes, plus tower and elevator
 * footprints with a 1-cell apron (all from the world query, so the two sides of a seam agree). Cached per chunk of
 * the queried cell. */
export function globalBlockedTest(ctx: ZoneGenContext): (gi: number, gj: number) => boolean {
  const s = ctx.key.s;
  const cache = new Map<string, (gi: number, gj: number) => boolean>();
  return (gi, gj) => {
    const cx = Math.floor(gi / CHUNK_CELLS), cz = Math.floor(gj / CHUNK_CELLS);
    const key = `${cx}:${cz}`;
    let f = cache.get(key);
    if (!f) {
      const lanes = arteryLaneTest({ ...ctx, key: { s, cx, cz } });
      const rects: [number, number, number, number][] = [];
      const push = (scx: number, scz: number, r: readonly [number, number, number, number]): void => {
        rects.push([scx * CHUNK_CELLS + r[0] - 1, scz * CHUNK_CELLS + r[1] - 1, scx * CHUNK_CELLS + r[2] + 1, scz * CHUNK_CELLS + r[3] + 1]);
      };
      for (const t of ctx.world.towersNear(s, cx, cz)) push(t.cx, t.cz, towerFootprint(t));
      for (const e of elevatorsNear(ctx, cx, cz)) push(e.cx, e.cz, elevatorFootprint(e));
      f = (a, b) => lanes(a, b) || rects.some((t) => a >= t[0] && a < t[2] && b >= t[1] && b < t[3]);
      cache.set(key, f);
    }
    return f(gi, gj);
  };
}

/** Maximal runs [a, b) of indices in [from, to) for which blocked(i) is false. */
export function freeRuns(from: number, to: number, blocked: (i: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let s = 0, open = false; // indices may be negative (global cells): no sentinel value
  for (let i = from; i <= to; i++) {
    const free = i < to && !blocked(i);
    if (free && !open) { s = i; open = true; }
    else if (!free && open) { out.push([s, i]); open = false; }
  }
  return out;
}

/** True when the chunk across `side` belongs to the same district (its seam is not a BOUNDARY). */
export function sameDistrictAcross(ctx: ZoneGenContext, dcx: number, dcz: number): boolean {
  return ctx.world.districtAt(ctx.key.s, ctx.key.cx + dcx, ctx.key.cz + dcz).id === ctx.district.id;
}

/** Paint stripe on the floor (DECAL_PAINT_STRIPE, FLOOR_PAINT layer). `alongX`: the stripe's length runs along x.
 * Per the DecalPlacement convention (+v along forwardXZ(rot)): along z => rot 0, along x => rot PI/2. */
export function paintStripe(g: ChunkGrid, cx: number, y: number, cz: number, alongX: boolean, len: number, width: number,
  color: readonly [number, number, number], alpha: number): void {
  g.addDecal({
    kind: DECAL_PAINT_STRIPE, sign: false, px: cx, py: y, pz: cz, nx: 0, ny: 1, nz: 0,
    rot: alongX ? HALF_PI : 0, w: width, h: len, alpha, color: [color[0], color[1], color[2]],
  });
}

/** Clamp a chunk-local coordinate range to the chunk. */
export const clampChunk = (v: number): number => clamp(v, 0, CHUNK_SIZE);

/** Sets a cell's floor material (+ optional extra patch) without touching reserved cells. */
export function setFloorMat(g: ChunkGrid, li: number, lj: number, mat: MatId): void {
  g.setCells(li, lj, li + 1, lj + 1, { floorMat: mat });
}
