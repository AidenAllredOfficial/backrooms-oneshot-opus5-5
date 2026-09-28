// src/world/content/util.ts — shared placement helpers for WP4 content (private to WP4).
// Pure: no three/DOM, no Math.random. Layout decisions use only + - * / floor sqrt and core hashing.

import { CELL, CEIL_TILE, CHUNK_CELLS, CHUNK_SIZE, TILE_CELLS, WALL_T } from '../../core/constants.ts';
import { EDGE_WALKABLE } from '../../core/edges.ts';
import { cellIdx, exIdx, ezIdx, worldToCell } from '../../core/grid.ts';
import { CellFlag, EdgeKind, FixtureKind } from '../../core/ids.ts';
import type { FixtureKindId } from '../../core/ids.ts';
import { NO_WATER } from '../../core/layout.ts';
import type { ChunkLayout, Fixture } from '../../core/layout.ts';
import type { ChunkGrid, TowerSite, ZoneGenContext } from '../../core/world.ts';

export const N = CHUNK_CELLS;
export const inChunk = (li: number, lj: number): boolean => li >= 0 && lj >= 0 && li < N && lj < N;

/** Cells that are never walkable floor for placement/connectivity purposes. */
export const NON_WALK_FLAGS = CellFlag.SOLID | CellFlag.VOID | CellFlag.NOWALK | CellFlag.TOWER | CellFlag.ELEVATOR;

/** Walkable per WP1's connectivity rule: not SOLID|VOID|NOWALK|TOWER|ELEVATOR, water <= 1.1 m, no blocker. */
export function isWalkableCell(l: ChunkLayout, c: number): boolean {
  if ((l.flags[c] & NON_WALK_FLAGS) !== 0) return false;
  if (l.blockCm[c] !== 0) return false;
  const w = l.waterCm[c];
  return w === NO_WATER || w - l.floorCm[c] <= 110;
}
/** Dry, walkable and not reserved: where loose content (props, vignettes, decals on floors) may go. */
export function isOpenFloor(l: ChunkLayout, c: number): boolean {
  if (!isWalkableCell(l, c)) return false;
  if ((l.flags[c] & CellFlag.RESERVED) !== 0) return false;
  const w = l.waterCm[c];
  return w === NO_WATER || w <= l.floorCm[c];
}

/** Direction table: 0 +x, 1 -x, 2 +z, 3 -z. */
export const DX: readonly number[] = [1, -1, 0, 0];
export const DZ: readonly number[] = [0, 0, 1, -1];

/** Edge array index + axis of the edge on side d of cell (li, lj). */
export function sideEdge(li: number, lj: number, d: number): { axis: 'x' | 'z'; i: number; j: number; k: number } {
  switch (d) {
    case 0: return { axis: 'x', i: li + 1, j: lj, k: exIdx(li + 1, lj) };
    case 1: return { axis: 'x', i: li, j: lj, k: exIdx(li, lj) };
    case 2: return { axis: 'z', i: li, j: lj + 1, k: ezIdx(li, lj + 1) };
    default: return { axis: 'z', i: li, j: lj, k: ezIdx(li, lj) };
  }
}
export function sideKind(l: ChunkLayout, li: number, lj: number, d: number): number {
  const e = sideEdge(li, lj, d);
  return e.axis === 'x' ? l.ex.kind[e.k] : l.ez.kind[e.k];
}
export function sideHA(l: ChunkLayout, li: number, lj: number, d: number): number {
  const e = sideEdge(li, lj, d);
  return e.axis === 'x' ? l.ex.hA[e.k] : l.ez.hA[e.k];
}
export const edgeKindPassable = (kind: number, hA: number): boolean =>
  EDGE_WALKABLE[kind] && (kind !== EdgeKind.HEADER || hA >= 190);

/** Passable step from (li, lj) toward side d (both cells walkable and in the chunk, edge passable, |dFloor| <= 36). */
export function canStep(l: ChunkLayout, li: number, lj: number, d: number): boolean {
  const ni = li + DX[d], nj = lj + DZ[d];
  if (!inChunk(ni, nj)) return false;
  const a = cellIdx(li, lj), b = cellIdx(ni, nj);
  if (!isWalkableCell(l, a) || !isWalkableCell(l, b)) return false;
  if (!edgeKindPassable(sideKind(l, li, lj, d), sideHA(l, li, lj, d))) return false;
  return Math.abs(l.floorCm[a] - l.floorCm[b]) <= 36;
}

/** Edge kinds that read as a solid wall face at eye height (props lean on them, decals go on them). */
export const isWallKind = (k: number): boolean =>
  k === EdgeKind.WALL || k === EdgeKind.PARTITION || k === EdgeKind.WINDOW || k === EdgeKind.HALF;

/** True if side d of the cell presents a wall surface (a wall-like edge or a SOLID / blocker neighbour). */
export function sideIsWall(l: ChunkLayout, li: number, lj: number, d: number): boolean {
  if (isWallKind(sideKind(l, li, lj, d))) return true;
  const ni = li + DX[d], nj = lj + DZ[d];
  if (!inChunk(ni, nj)) return false;
  const c = cellIdx(ni, nj);
  return (l.flags[c] & CellFlag.SOLID) !== 0 || l.blockCm[c] > 0;
}

/** Global 0.6 m lattice index of a chunk-local coordinate (x or z) given the chunk's first global cell. */
export function latticeIndex(g0: number, m: number): number {
  const lc = worldToCell(m);
  let t = Math.floor((m - lc * CELL) / CEIL_TILE + 1e-7);
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return 2 * (g0 + lc) + t;
}
export function latticeKeyOf(g: ChunkGrid, x: number, z: number): { latticeI: number; latticeJ: number } {
  return { latticeI: latticeIndex(g.gi0, x), latticeJ: latticeIndex(g.gj0, z) };
}

/** addFixture with the lattice key of the fixture centre, unless a fixture of the same kind already owns that
 * lattice tile (the id would collide). Returns the id, or -1 when skipped. */
export function addLatticeFixture(g: ChunkGrid, f: Omit<Fixture, 'id' | 'seed' | 'dynamic'>): number {
  const key = latticeKeyOf(g, f.px, f.pz);
  const fx = g.layout.fixtures;
  for (let i = 0; i < fx.length; i++) {
    const o = fx[i];
    if (o.kind !== f.kind || o.bakeGroup !== 0) continue;
    if (latticeIndex(g.gi0, o.px) === key.latticeI && latticeIndex(g.gj0, o.pz) === key.latticeJ) return -1;
  }
  return g.addFixture(f, key);
}

/** True if a world-coordinate rect [x0,x1] straddles a render-tile line (chunk-local coords). */
export function straddlesTileLine(x0: number, z0: number, x1: number, z1: number): boolean {
  for (let k = 0; k <= 2; k++) {
    const t = k * TILE_CELLS * CELL;
    if (x0 < t - 1e-6 && t + 1e-6 < x1) return true;
    if (z0 < t - 1e-6 && t + 1e-6 < z1) return true;
  }
  return false;
}

/** Linear-RGB colours used by content. */
export const RED_LIGHT: [number, number, number] = [1, 0.08, 0.05];
export const EXIT_RED: [number, number, number] = [1, 0.06, 0.04];

/** Per-kind emitter dimensions: RECT w (long, along t) x h; SPHERE diameter w. tl/ts = footprint in 0.6 m
 * tiles along / across the long axis (lattice placement). */
export interface FixtureDims { shape: 0 | 1; w: number; h: number; tl: number; ts: number; hum: number }
export const FIXTURE_DIMS: Readonly<Record<number, FixtureDims>> = {
  [FixtureKind.TROFFER_2x4]: { shape: 0, w: 1.2, h: 0.6, tl: 2, ts: 1, hum: 0.5 },
  [FixtureKind.TROFFER_2x2]: { shape: 0, w: 0.6, h: 0.6, tl: 1, ts: 1, hum: 0.45 },
  [FixtureKind.SKY_PANEL]: { shape: 0, w: 1.2, h: 1.2, tl: 2, ts: 2, hum: 0.3 },
  [FixtureKind.TUBE_STRIP]: { shape: 0, w: 1.2, h: 0.1, tl: 2, ts: 1, hum: 0.6 },
  [FixtureKind.CAGE_BULB]: { shape: 1, w: 0.1, h: 0.1, tl: 1, ts: 1, hum: 0.6 },
  [FixtureKind.HIGHBAY]: { shape: 1, w: 0.45, h: 0.45, tl: 1, ts: 1, hum: 0.4 },
  [FixtureKind.PENDANT_LINEAR]: { shape: 0, w: 1.2, h: 0.12, tl: 2, ts: 1, hum: 0.35 },
  [FixtureKind.SODIUM]: { shape: 0, w: 0.45, h: 0.25, tl: 1, ts: 1, hum: 0.5 },
  [FixtureKind.EXIT_SIGN]: { shape: 0, w: 0.3, h: 0.15, tl: 1, ts: 1, hum: 0.1 },
  [FixtureKind.UNDERWATER]: { shape: 0, w: 0.3, h: 0.3, tl: 1, ts: 1, hum: 0.2 },
  [FixtureKind.VENDING]: { shape: 0, w: 0.7, h: 1.4, tl: 1, ts: 1, hum: 0.5 },
  [FixtureKind.RED_BULB]: { shape: 1, w: 0.08, h: 0.08, tl: 1, ts: 1, hum: 0.4 },
};

/** Lens luminance (nits) of the UNDERWATER pool lights: ~400 cd on axis through a ~26 cm lens (a 1300 lm pool light;
 * real ones put out 1500-5000 lm), so it glows in the water of a lit hall and throws light on the pool's floor and far
 * wall (1400 nits, ~95 cd, vanished in a lit poolroom; 10000 turned the pool's water milky around every lamp). */
export const UNDERWATER_NITS = 6000;

/** Base fixture record (state ON, bakeGroup 0) for a kind at a point with a normal and long axis. */
export function fixtureAt(kind: FixtureKindId, px: number, py: number, pz: number, n: readonly [number, number, number],
  t: readonly [number, number, number], color: [number, number, number], luminance: number, dims?: Partial<FixtureDims>): Omit<Fixture, 'id' | 'seed' | 'dynamic'> {
  const d = { ...FIXTURE_DIMS[kind], ...dims };
  return {
    kind, state: 0, shape: d.shape, px, py, pz, nx: n[0], ny: n[1], nz: n[2], tx: t[0], ty: t[1], tz: t[2],
    w: d.w, h: d.h, color, luminance, hum: d.hum, bakeGroup: 0,
  };
}

/** Towers whose site chunk is within Chebyshev `r` chunks of the context chunk (deduplicated by id, sorted). */
const towerCache = new WeakMap<ZoneGenContext, Map<number, TowerSite[]>>();
export function towersWithin(ctx: ZoneGenContext, r: number): TowerSite[] {
  let m = towerCache.get(ctx);
  if (!m) towerCache.set(ctx, (m = new Map()));
  const hit = m.get(r);
  if (hit) return hit;
  const { s, cx, cz } = ctx.key;
  const seen = new Map<number, TowerSite>();
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const list = ctx.world.towersNear(s, cx + dx, cz + dz);
      for (const t of list) if (Math.max(Math.abs(t.cx - cx), Math.abs(t.cz - cz)) <= r) seen.set(t.id, t);
    }
  }
  const out = [...seen.values()].sort((a, b) => a.id - b.id);
  m.set(r, out);
  return out;
}

/** Chunk-local metres of a point in another chunk's local frame. */
export const toLocalX = (ctx: ZoneGenContext, ocx: number, x: number): number => (ocx - ctx.key.cx) * CHUNK_SIZE + x;
export const toLocalZ = (ctx: ZoneGenContext, ocz: number, z: number): number => (ocz - ctx.key.cz) * CHUNK_SIZE + z;

/** Mean of a Uint8 field over non-SOLID cells, in [0,1). */
export function meanField(l: ChunkLayout, f: Uint8Array): number {
  let sum = 0, n = 0;
  for (let c = 0; c < f.length; c++) {
    if ((l.flags[c] & CellFlag.SOLID) !== 0) continue;
    sum += f[c]; n++;
  }
  return n === 0 ? 0 : sum / n / 256;
}

/** Wall face centre (chunk-local) of side d of a cell, offset WALL_T/2 into the cell, plus the inward normal. */
export function wallFaceOf(li: number, lj: number, d: number): { x: number; z: number; nx: number; nz: number; tx: number; tz: number } {
  const cx = (li + 0.5) * CELL, cz = (lj + 0.5) * CELL;
  const h = CELL / 2 - WALL_T / 2;
  const x = cx + DX[d] * h, z = cz + DZ[d] * h;
  return { x, z, nx: -DX[d], nz: -DZ[d], tx: DZ[d] !== 0 ? 1 : 0, tz: DX[d] !== 0 ? 1 : 0 };
}

/** Is side d of the cell a chunk seam edge (stored in both chunks)? */
export const isSeamSide = (li: number, lj: number, d: number): boolean =>
  (d === 0 && li === N - 1) || (d === 1 && li === 0) || (d === 2 && lj === N - 1) || (d === 3 && lj === 0);
