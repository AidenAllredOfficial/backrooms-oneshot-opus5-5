// src/world/zones/l0common.ts — shared helpers of the Level 0 zone family (WP2): per-storey palette / lighting
// styles, prop and custom-fixture helpers, local edge models, and the GLOBAL feature process (LOW_EXPANSE walls,
// L corners, blocks and rooms; PILLAR_HALL wall fragments) that generate() and globalSeam() both rasterize, so the
// two sides of a GLOBAL seam agree bit for bit. Pure module: no three, no DOM, no Math.random.

import { CEIL_TILE, CELL, CHUNK_CELLS, CHUNK_SIZE, DOOR_CM } from '../../core/constants.ts';
import { EDGE_WALKABLE } from '../../core/edges.ts';
import { cellIdx, exIdx, ezIdx, floorDiv, lerp } from '../../core/grid.ts';
import {
  CeilKind, CellFlag, EdgeKind, FixtureKind, LightState, Mat, SolidFlag, Zone,
  type FixtureKindId, type PropKindId, type StoreyId, type ZoneId,
} from '../../core/ids.ts';
import { PROP_DEFS } from '../../core/props.ts';
import { fixtureId } from '../../core/layout.ts';
import { hash01, hash2, hash6, Rng, SALT } from '../../core/rng.ts';
import type { ChunkGrid, LightingProfile, SeamEdges, ZoneGenContext, ZonePalette } from '../../core/world.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';

const N = CHUNK_CELLS;
/** Number of edges on one axis of a chunk (33 lines x 32 cells). */
export const EDGE_N = (N + 1) * N;

// ------------------------------------------------------------------------------------------------ storey styles

/** 0 = the zone's own Level 0 look; 1 = storey-1 concrete sublevel (CMU, concrete, tube strips);
 * 2 = storey-2 pool tile (POOL_TILE everywhere, glazed ceiling, sky panels). §5.WP2 "Palettes switch per storey". */
export type StoreyStyle = 0 | 1 | 2;

export function storeyStyle(zone: ZoneId, s: StoreyId): StoreyStyle {
  if (s === 1 && (zone === Zone.LOBBY || zone === Zone.MAZE || zone === Zone.DARK)) return 1;
  if (s === 2 && (zone === Zone.PILLAR_HALL || zone === Zone.LOW_EXPANSE || zone === Zone.MANILA)) return 2;
  return 0;
}

export function stylePalette(style: StoreyStyle, base: ZonePalette): ZonePalette {
  if (style === 1) {
    return {
      floorMat: Mat.CONCRETE_FLOOR, wallMat: Mat.CMU_PAINTED, ceilMat: Mat.CONCRETE_CEIL, trimMat: Mat.TRIM_PAINT,
      ceilKind: CeilKind.CONCRETE, ceilCm: base.ceilCm, baseboard: false,
    };
  }
  if (style === 2) {
    return {
      floorMat: Mat.POOL_TILE, wallMat: Mat.POOL_TILE, ceilMat: Mat.POOL_TILE, trimMat: Mat.POOL_TILE,
      ceilKind: CeilKind.TILE_GLAZED, ceilCm: base.ceilCm, baseboard: false,
    };
  }
  return base;
}

/** Tube strip battens hang this far below a concrete ceiling (emitting surface). */
export const TUBE_STRIP_MOUNT_CM = 8;

export function styleLighting(style: StoreyStyle, base: LightingProfile, p: Readonly<Record<string, number>>): LightingProfile {
  if (style === 1) {
    return {
      kind: FixtureKind.TUBE_STRIP, placement: 'lattice', lattice: base.lattice, phase: base.phase, axis: base.axis,
      cctRange: [3900, 4100], luminance: 8600, zoneMul: base.zoneMul, mountCm: TUBE_STRIP_MOUNT_CM,
      ...(base.decayAdd !== undefined ? { decayAdd: base.decayAdd } : {}),
    };
  }
  if (style === 2) {
    const px = num(p, 'phaseX', 0), pz = num(p, 'phaseZ', 0);
    return {
      kind: FixtureKind.SKY_PANEL, placement: 'lattice', lattice: [6, 6], phase: [px % 6, pz % 6], axis: 1,
      cctRange: [6300, 6700], luminance: 2500, zoneMul: base.zoneMul, mountCm: 0,
      ...(base.decayAdd !== undefined ? { decayAdd: base.decayAdd } : {}),
    };
  }
  return base;
}

/** District param with a fallback (params may be empty, e.g. for tests or a stubbed district). */
export const num = (p: Readonly<Record<string, number>>, k: string, d: number): number => {
  const v = p[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
};

// ------------------------------------------------------------------------------------------------ yaw / props

export const YAW_NEG_Z = 0;
export const YAW_POS_Z = Math.PI;
export const YAW_NEG_X = Math.PI / 2;
export const YAW_POS_X = -Math.PI / 2;
/** Yaw whose forward (the prop FRONT, local -Z) points along the axis direction (dx, dz) (one of them 0). */
export function yawFacing(dx: number, dz: number): number {
  if (dz < 0) return YAW_NEG_Z;
  if (dz > 0) return YAW_POS_Z;
  return dx < 0 ? YAW_NEG_X : YAW_POS_X;
}

/** Default PropPlacement.flags of a kind: COLLIDE / OCCLUDE from PROP_DEFS. */
export function propFlags(kind: PropKindId): number {
  const d = PROP_DEFS[kind];
  return (d.collide ? SolidFlag.COLLIDE : 0) | (d.occlude ? SolidFlag.OCCLUDE : 0);
}

/** Adds a prop at chunk-local (x, z); y = storey-relative base height (m). */
export function putProp(g: ChunkGrid, kind: PropKindId, variant: number, x: number, y: number, z: number, yaw: number, seed: number): void {
  g.addProp({ kind, variant, x, y, z, yaw, scale: 1, flags: propFlags(kind), seed: seed >>> 0 });
}

// ------------------------------------------------------------------------------------------------ custom fixtures

export interface CustomFixtureSpec {
  kind: FixtureKindId;
  x: number; y: number; z: number; // chunk-local centre of the emitting surface (m)
  nx: number; ny: number; nz: number;
  tx: number; ty: number; tz: number;
  w: number; h: number;
  cct0: number; cct1: number; // Kelvin range; the warmth field interpolates (as placeFixtures does)
  luminance: number;
  hum: number;
}

/** Lognormal luminance jitter shared with WP4's lattice placer (R2: exp(0.18 * gauss), a real ballast / lamp-age
 * spread instead of the old uniform ±6 %). `h` is the fixture hash; pure. */
export function lumJitter(h: number): number {
  const u1 = Math.max(1e-6, hash01(hash2(h, 1))), u2 = hash01(hash2(h, 2));
  const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.exp(0.18 * Math.max(-3, Math.min(3, gauss)));
}

/** Custom fixture through grid.addFixture with the lattice tile of its centre (world metres / 0.6), colour and
 * luminance jitter following the WP4 lattice rules (kelvinToLinearRGB, lognormal luminance). Returns the id. */
export function addCustomFixture(ctx: ZoneGenContext, f: CustomFixtureSpec): number {
  const wx = ctx.grid.gi0 * CELL + f.x, wz = ctx.grid.gj0 * CELL + f.z;
  const latticeI = Math.floor(wx / CEIL_TILE), latticeJ = Math.floor(wz / CEIL_TILE);
  const h = hash6(ctx.seed, SALT.FIXTURE, ctx.key.s, latticeI, latticeJ, f.kind);
  const warmth = clamp01(ctx.fields.warmth(wx, wz));
  // warmth 1 -> the low-Kelvin (warm) end, whatever the order of the pair (STATUS.md 2026-09-25)
  const lo = Math.min(f.cct0, f.cct1), hi = Math.max(f.cct0, f.cct1);
  const color = kelvinToLinearRGB(lerp(hi, lo, warmth), 0.02 + 0.03 * hash01(h));
  const luminance = f.luminance * lumJitter(h);
  return ctx.grid.addFixture({
    kind: f.kind, state: LightState.ON, shape: 0,
    px: f.x, py: f.y, pz: f.z, nx: f.nx, ny: f.ny, nz: f.nz, tx: f.tx, ty: f.ty, tz: f.tz,
    w: f.w, h: f.h, color, luminance, hum: f.hum, bakeGroup: 0,
  }, { latticeI, latticeJ });
}

/** addCustomFixture unless its id (from the lattice tile of the centre, as addCustomFixture computes it) is already
 * taken in the chunk; returns -1 then. */
export function addCustomFixtureUnique(ctx: ZoneGenContext, f: CustomFixtureSpec): number {
  const g = ctx.grid;
  const latticeI = Math.floor((g.gi0 * CELL + f.x) / CEIL_TILE), latticeJ = Math.floor((g.gj0 * CELL + f.z) / CEIL_TILE);
  const id = fixtureId(ctx.seed, ctx.key.s, latticeI, latticeJ, f.kind);
  if (g.layout.fixtures.some((o) => o.id === id)) return -1;
  return addCustomFixture(ctx, f);
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ------------------------------------------------------------------------------------------------ cell / edge queries

const BLOCKING = CellFlag.SOLID | CellFlag.VOID | CellFlag.NOWALK | CellFlag.TOWER | CellFlag.ELEVATOR;
/** WP1 walkable-cell rule (water depth ignored: Level 0 zones only add 2 cm films). */
export function cellWalkable(g: ChunkGrid, li: number, lj: number): boolean {
  if (li < 0 || lj < 0 || li >= N || lj >= N) return false;
  const c = cellIdx(li, lj);
  return (g.layout.flags[c] & BLOCKING) === 0 && g.layout.blockCm[c] === 0;
}

/** Passable per WP1 (HEADER only when its underside is >= 190 cm). */
export function edgePassable(g: ChunkGrid, axis: 'x' | 'z', i: number, j: number): boolean {
  const e = axis === 'x' ? g.layout.ex : g.layout.ez;
  const k = axis === 'x' ? exIdx(i, j) : ezIdx(i, j);
  const kind = e.kind[k];
  return EDGE_WALKABLE[kind] && (kind !== EdgeKind.HEADER || e.hA[k] >= 190);
}

/** Whether a zone may write this interior edge: not a frozen seam edge, not touching a reserved cell. */
export function edgeWritable(g: ChunkGrid, axis: 'x' | 'z', i: number, j: number): boolean {
  if (axis === 'x') {
    if (i <= 0 || i >= N || j < 0 || j >= N) return false;
    if (g.isFrozenEdge('x', i, j)) return false;
    return !g.isReserved(i - 1, j) && !g.isReserved(i, j);
  }
  if (j <= 0 || j >= N || i < 0 || i >= N) return false;
  if (g.isFrozenEdge('z', i, j)) return false;
  return !g.isReserved(i, j - 1) && !g.isReserved(i, j);
}

/** Inner cells of passable seam edges ("ports"): a CHUNK_CELL_COUNT mask (1 = port cell). */
export function portCells(g: ChunkGrid): Uint8Array {
  const m = new Uint8Array(N * N);
  for (let c = 0; c < N; c++) {
    if (edgePassable(g, 'x', 0, c)) m[cellIdx(0, c)] = 1;
    if (edgePassable(g, 'x', N, c)) m[cellIdx(N - 1, c)] = 1;
    if (edgePassable(g, 'z', c, 0)) m[cellIdx(c, 0)] = 1;
    if (edgePassable(g, 'z', c, N)) m[cellIdx(c, N - 1)] = 1;
  }
  return m;
}

/** World-space centre of the chunk-local point (for field sampling). */
export const worldX = (g: ChunkGrid, x: number): number => g.gi0 * CELL + x;
export const worldZ = (g: ChunkGrid, z: number): number => g.gj0 * CELL + z;

/** Greedy rectangles over a cell mask (row-major, maximal width then height). Used for WaterRect films. */
export function maskRects(mask: Uint8Array): [number, number, number, number][] {
  const used = new Uint8Array(N * N);
  const out: [number, number, number, number][] = [];
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      const c = cellIdx(li, lj);
      if (!mask[c] || used[c]) continue;
      let i1 = li + 1;
      while (i1 < N && mask[cellIdx(i1, lj)] && !used[cellIdx(i1, lj)]) i1++;
      let j1 = lj + 1;
      for (; j1 < N; j1++) {
        let ok = true;
        for (let i = li; i < i1 && ok; i++) if (!mask[cellIdx(i, j1)] || used[cellIdx(i, j1)]) ok = false;
        if (!ok) break;
      }
      for (let j = lj; j < j1; j++) for (let i = li; i < i1; i++) used[cellIdx(i, j)] = 1;
      out.push([li, lj, i1, j1]);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ GLOBAL features

/** Zone tag mixed into the feature hash, so LOW_EXPANSE and PILLAR_HALL districts get different fields. */
export const FEATURE_TAG = { LOW_EXPANSE: 1, PILLAR_HALL: 2 } as const;
export const FEATURE_BLOCK = 6; // one candidate per 6x6 global cell block
/** Features reach at most this many cells beyond their own block (L corners grow backwards, walls forwards). */
const FEATURE_REACH = 6;

/** Head height of feature-room DOORWAYs under a ceiling of `ceilCm`: the standard 210 cm, lowered so a lintel of at
 * least 10 cm stays under low LOW_EXPANSE ceilings (210 cm -> 200 cm door). A GLOBAL seam only ever lies inside one
 * district (district boundaries are BOUNDARY seams), so both sides and globalSeam() see the same ceiling. */
export const featureDoorHa = (ceilCm: number): number => Math.min(DOOR_CM, ceilCm - 10);

/** Edge priority when features overlap: DOORWAY beats WALL beats OPEN, so the result is order-independent. */
const PRIORITY: readonly number[] = [0, 2, 3, 0, 0, 0, 0, 0, 0, 0];

/** Receives rasterized feature elements in GLOBAL coordinates.
 * edge(axis 0 = x-line (line = gi, cell = gj) | 1 = z-line (line = gj, cell = gi), kind). solid(gi, gj). */
export interface FeatureSink {
  edge(axis: 0 | 1, line: number, cell: number, kind: number): void;
  solid(gi: number, gj: number): void;
}

export interface FeatureParams {
  seed: number; s: StoreyId; tag: number;
  keepP: number; // candidate kept with this probability
  wallsOnly: boolean; // PILLAR_HALL fragments: wall segments and L corners only
  doorHa: number; // DOORWAY head height (featureDoorHa of the district ceiling)
}

/** Rasterizes the feature candidate of global block (bx, bz). Pure function of (params, bx, bz). */
export function rasterizeFeature(fp: FeatureParams, bx: number, bz: number, sink: FeatureSink): void {
  const h = hash6(fp.seed, SALT.GLOBAL_FEATURE, fp.s, fp.tag, bx, bz);
  if (hash01(h) >= fp.keepP) return;
  const r = new Rng(hash2(h, 0x51ed));
  const ax = bx * FEATURE_BLOCK + r.int(0, FEATURE_BLOCK - 1); // anchor vertex (hash offset inside the block)
  const az = bz * FEATURE_BLOCK + r.int(0, FEATURE_BLOCK - 1);
  const u = r.float();
  const type = fp.wallsOnly ? (u < 0.75 ? 0 : 1) : u < 0.6 ? 0 : u < 0.8 ? 1 : u < 0.95 ? 2 : 3;
  switch (type) {
    case 0: { // straight wall segment of 2-6 edges, random axis
      const len = r.int(2, 6);
      if (r.chance(0.5)) for (let k = 0; k < len; k++) sink.edge(0, ax, az + k, EdgeKind.WALL);
      else for (let k = 0; k < len; k++) sink.edge(1, az, ax + k, EdgeKind.WALL);
      break;
    }
    case 1: { // L corner: two perpendicular runs from the anchor vertex
      const lx = r.int(2, 5), lz = r.int(2, 5);
      const sx = r.chance(0.5) ? 1 : -1, sz = r.chance(0.5) ? 1 : -1;
      for (let k = 0; k < lx; k++) sink.edge(1, az, sx > 0 ? ax + k : ax - 1 - k, EdgeKind.WALL);
      for (let k = 0; k < lz; k++) sink.edge(0, ax, sz > 0 ? az + k : az - 1 - k, EdgeKind.WALL);
      break;
    }
    case 2: { // SOLID block 1x1-2x2 (never across a chunk line: its seam edges would become ports)
      const w = r.int(1, 2), d = r.int(1, 2);
      if (floorDiv(ax, N) !== floorDiv(ax + w - 1, N) || floorDiv(az, N) !== floorDiv(az + d - 1, N)) break;
      for (let j = az; j < az + d; j++) for (let i = ax; i < ax + w; i++) sink.solid(i, j);
      for (let k = 0; k < d; k++) { sink.edge(0, ax, az + k, EdgeKind.WALL); sink.edge(0, ax + w, az + k, EdgeKind.WALL); }
      for (let k = 0; k < w; k++) { sink.edge(1, az, ax + k, EdgeKind.WALL); sink.edge(1, az + d, ax + k, EdgeKind.WALL); }
      break;
    }
    default: { // closed 3x3-4x5 room with one DOORWAY
      let w = r.int(3, 4), d = r.int(3, 5);
      if (r.chance(0.5)) { const t = w; w = d; d = t; }
      const side = r.int(0, 3);
      const along = side < 2 ? d : w; // W/E sides run along z, N/S along x
      const door = r.int(1, along - 2);
      for (let k = 0; k < d; k++) {
        sink.edge(0, ax, az + k, side === 0 && k === door ? EdgeKind.DOORWAY : EdgeKind.WALL);
        sink.edge(0, ax + w, az + k, side === 1 && k === door ? EdgeKind.DOORWAY : EdgeKind.WALL);
      }
      for (let k = 0; k < w; k++) {
        sink.edge(1, az, ax + k, side === 2 && k === door ? EdgeKind.DOORWAY : EdgeKind.WALL);
        sink.edge(1, az + d, ax + k, side === 3 && k === door ? EdgeKind.DOORWAY : EdgeKind.WALL);
      }
      break;
    }
  }
}

/** Local (chunk) rasterization of every feature within reach of the chunk: edge kinds with the priority merge
 * (ex/ez index = exIdx/ezIdx, all 33 lines incl. the seam lines) and SOLID cells. */
export interface LocalFeatures { ex: Uint8Array; ez: Uint8Array; solid: Uint8Array }

/** SOLID mask with a 1-cell halo: local cells [-1, N] on both axes. */
const HALO = N + 2;
const haloIdx = (i: number, j: number): number => (j + 1) * HALO + (i + 1);

export function rasterizeFeaturesLocal(fp: FeatureParams, gi0: number, gj0: number): LocalFeatures {
  const ex = new Uint8Array(EDGE_N), ez = new Uint8Array(EDGE_N), solid = new Uint8Array(N * N);
  const halo = new Uint8Array(HALO * HALO);
  const put = (arr: Uint8Array, k: number, kind: number): void => {
    if (PRIORITY[kind] > PRIORITY[arr[k]]) arr[k] = kind;
  };
  const sink: FeatureSink = {
    edge(axis, line, cell, kind) {
      if (axis === 0) {
        const i = line - gi0, j = cell - gj0;
        if (i >= 0 && i <= N && j >= 0 && j < N) put(ex, exIdx(i, j), kind);
      } else {
        const j = line - gj0, i = cell - gi0;
        if (j >= 0 && j <= N && i >= 0 && i < N) put(ez, ezIdx(i, j), kind);
      }
    },
    solid(gi, gj) {
      const i = gi - gi0, j = gj - gj0;
      if (i >= -1 && i <= N && j >= -1 && j <= N) halo[haloIdx(i, j)] = 1;
      if (i >= 0 && i < N && j >= 0 && j < N) solid[cellIdx(i, j)] = 1;
    },
  };
  const bx0 = floorDiv(gi0 - FEATURE_REACH - FEATURE_BLOCK, FEATURE_BLOCK), bx1 = floorDiv(gi0 + N + FEATURE_REACH, FEATURE_BLOCK);
  const bz0 = floorDiv(gj0 - FEATURE_REACH - FEATURE_BLOCK, FEATURE_BLOCK), bz1 = floorDiv(gj0 + N + FEATURE_REACH, FEATURE_BLOCK);
  for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) rasterizeFeature(fp, bx, bz, sink);
  // a room door that lands on the face of another feature's SOLID block would open into the block: wall it
  // (featureSeam applies the same rule with the cells on both sides of the line, so the seam still agrees)
  for (let j = 0; j < N; j++) {
    for (let i = 0; i <= N; i++) {
      const k = exIdx(i, j);
      if (ex[k] === EdgeKind.DOORWAY && (halo[haloIdx(i - 1, j)] || halo[haloIdx(i, j)])) ex[k] = EdgeKind.WALL;
    }
  }
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i < N; i++) {
      const k = ezIdx(i, j);
      if (ez[k] === EdgeKind.DOORWAY && (halo[haloIdx(i, j - 1)] || halo[haloIdx(i, j)])) ez[k] = EdgeKind.WALL;
    }
  }
  return { ex, ez, solid };
}

/** The 32 edges of a seam line from the same feature process (GLOBAL seam). axis 'x' = line x = `line` (cells
 * gj = g0..g0+31), 'z' = line z = `line` (cells gi = g0..g0+31). */
export function featureSeam(fp: FeatureParams, axis: 'x' | 'z', line: number, g0: number): SeamEdges {
  const kind = new Uint8Array(N), hA = new Int16Array(N), hB = new Int16Array(N);
  const ax = axis === 'x' ? 0 : 1;
  const beside = new Uint8Array(N); // a feature SOLID cell on either side of the line at this position
  const sink: FeatureSink = {
    edge(a, l, cell, k) {
      if (a !== ax || l !== line) return;
      const c = cell - g0;
      if (c >= 0 && c < N && PRIORITY[k] > PRIORITY[kind[c]]) kind[c] = k;
    },
    solid(gi, gj) {
      // block perimeters arrive as WALL edges; the cells only matter for the door-into-block rule below
      const across = axis === 'x' ? gi : gj, c = (axis === 'x' ? gj : gi) - g0;
      if ((across === line - 1 || across === line) && c >= 0 && c < N) beside[c] = 1;
    },
  };
  // blocks whose features can touch the line segment (same reach rule as the chunk scan)
  const lo = floorDiv(line - FEATURE_REACH - FEATURE_BLOCK, FEATURE_BLOCK), hi = floorDiv(line + FEATURE_REACH, FEATURE_BLOCK);
  const c0 = floorDiv(g0 - FEATURE_REACH - FEATURE_BLOCK, FEATURE_BLOCK), c1 = floorDiv(g0 + N + FEATURE_REACH, FEATURE_BLOCK);
  for (let p = lo; p <= hi; p++) {
    for (let q = c0; q <= c1; q++) {
      if (axis === 'x') rasterizeFeature(fp, p, q, sink); else rasterizeFeature(fp, q, p, sink);
    }
  }
  for (let c = 0; c < N; c++) if (kind[c] === EdgeKind.DOORWAY && beside[c]) kind[c] = EdgeKind.WALL; // as rasterizeFeaturesLocal
  for (let c = 0; c < N; c++) if (kind[c] === EdgeKind.DOORWAY) hA[c] = fp.doorHa;
  return { kind, hA, hB };
}

/** Writes a local feature rasterization into the grid. The seam lines are included: once frozen the grid refuses
 * them (they come from globalSeam, which rasterizes the very same features), and unfrozen grids (tests) receive
 * them, which is how the both-sides agreement is checked. Returns the number of SOLID cells written. */
export function writeFeatures(g: ChunkGrid, f: LocalFeatures, doorHa: number): number {
  for (let j = 0; j < N; j++) {
    for (let i = 0; i <= N; i++) {
      const k = f.ex[exIdx(i, j)];
      if (k !== EdgeKind.OPEN) g.setEdge('x', i, j, k, k === EdgeKind.DOORWAY ? { hA: doorHa } : undefined);
    }
  }
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i < N; i++) {
      const k = f.ez[ezIdx(i, j)];
      if (k !== EdgeKind.OPEN) g.setEdge('z', i, j, k, k === EdgeKind.DOORWAY ? { hA: doorHa } : undefined);
    }
  }
  let n = 0;
  for (let c = 0; c < N * N; c++) {
    if (!f.solid[c]) continue;
    const li = c & 31, lj = c >> 5;
    if (g.isReserved(li, lj)) continue;
    g.setCells(li, lj, li + 1, lj + 1, { flagsSet: CellFlag.SOLID });
    n++;
  }
  return n;
}

// ------------------------------------------------------------------------------------------------ misc

/** Deterministic per-chunk seed for props (mixes the chunk key, a tag and an index). */
export const propSeed = (ctx: ZoneGenContext, tag: number, i: number): number =>
  hash6(ctx.seed, SALT.PROP, ctx.key.s, ctx.key.cx, ctx.key.cz, hash2(tag, i));

/** Chunk key string for per-chunk debug caches. */
export const chunkTag = (ctx: ZoneGenContext): string => `${ctx.seed}:${ctx.key.s}:${ctx.key.cx}:${ctx.key.cz}`;

/** District humidity class: the humidity field sampled at the district site (one value per district). */
export function districtHumidity(ctx: ZoneGenContext): number {
  const d = ctx.district;
  return ctx.fields.humidity(d.siteX * CHUNK_SIZE, d.siteZ * CHUNK_SIZE);
}

/** Stable small hash of a global vertex / cell (for "missing with p" style decisions shared across chunks). */
export const vertexHash = (seed: number, s: StoreyId, tag: number, gx: number, gz: number): number =>
  hash6(seed, SALT.ZONE_LAYOUT, s, tag, gx, gz);

