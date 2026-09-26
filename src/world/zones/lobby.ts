// src/world/zones/lobby.ts — LOBBY generator (WP2); also serves MANILA and DARK (variant from ctx.district.zone).
// PATTERN seams (default seam), recursive division rooms, erosion, stubs, thick blocks, ceiling bays.
//
// This is the spawn composition (D13): thin wallpapered walls splitting the chunk into irregular rooms, mostly
// doorless openings (OPEN / HEADER), L-rooms from partial walls, short stubs and free-standing wall pieces, chunky
// SOLID corners, raised ceiling bays / bulkhead bands, the odd sunken room, under a regular troffer lattice.
//
// R2 architecture (docs/contract-changes/R2-architecture.md), all drawn from a forked feature rng so the base
// division above is unchanged, and all kept out of the 3x3 onboarding chunks around the storey-0 origin:
//   - split-level halls (structures/splitLevel.ts) in ~15 % of districts: a 5.7-7.2 m tall sunken hall with a
//     gallery, parapet, stair, columns and pendants lit from below;
//   - tall rooms (~5 % of leaves, ceiling 4.5-6 m, pendant troffers at 3 m), sunken rooms (p 0.18, 45 / 90 cm),
//     raised stages (+45 cm), light wells (a railed 6 m shaft with water or a lit floor);
//   - missing ceilings in decayed districts (NO_CEIL plenum patches with ducts; scattered missing tiles; bays whose
//     fixtures were pulled out);
//   - room programs (closet, restroom, copy room, conference room, kitchenette) on 10-15 % of the leaves;
//   - district characters (water-damaged, mid-renovation, moved-out, pristine);
//   - windows to nowhere, door leaves (MANILA), zone-transition connectors at district boundaries.

import { CELL, CEIL_TILE, CHUNK_CELLS } from '../../core/constants.ts';
import { cellIdx, exIdx, ezIdx } from '../../core/grid.ts';
import { CellFlag, EdgeKind, FixtureKind, Mat, PropKind, SeamMode, SolidFlag, Zone, CeilKind } from '../../core/ids.ts';
import { hash01, hash3, type Rng } from '../../core/rng.ts';
import type { ChunkGrid, DistrictInfo, LightingProfile, PropRuleSet, ZoneGenContext, ZoneGenerator, ZonePalette } from '../../core/world.ts';
import { rectHitsEdges } from '../content/fixtures.ts';
import { FIXTURE_DIMS } from '../content/util.ts';
import { hangDoors } from '../structures/doors.ts';
import { missingTiles, openCeiling, removedFixtures } from '../structures/plenum.ts';
import { applyProgram, Character, CHARACTER_W, dressCharacter, Program, programFor } from '../structures/programs.ts';
import { buildLightWell, buildSplitHall, SPLIT_DEPTHS, type SplitHall } from '../structures/splitLevel.ts';
import { transitionStamps } from '../structures/transitions.ts';
import { restore, snapshot, solidsInRect, unreachedWalkable } from '../structures/util.ts';
import { windowWall } from '../structures/windows.ts';
import {
  addCustomFixtureUnique, chunkTag, EDGE_N, edgePassable, edgeWritable, num, portCells, storeyStyle, styleLighting, stylePalette,
} from './l0common.ts';

const N = CHUNK_CELLS;

/** District lattice choices (tiles along x, z) for the TROFFER_2x4 grid: §5.WP2 {[4,4],[4,6],[6,4]} plus the R2
 * sparser [6,6] and [4,8] (rooms fall off into gloom between the fixtures). */
export const LOBBY_LATTICES: readonly (readonly [number, number])[] = [[4, 4], [4, 6], [6, 4], [6, 6], [4, 8]];
/** Weights of LOBBY_LATTICES: the photo lattices stay the large majority (the spawn keeps its look). */
export const LOBBY_LATTICE_W: readonly number[] = [0.3, 0.25, 0.25, 0.1, 0.1];
const LOBBY_CEILS: readonly number[] = [260, 270, 270, 280];

/** R2 feature rates. */
export const SPLIT_DISTRICT_P = 0.2; // districts with split-level halls
export const SPLIT_CHUNK_P = 0.65; // chunks of such a district that get one
export const SPLIT_BASE_P = 0.08; // chunks of any other LOBBY-family district
export const TALL_P = 0.05; // leaves with a 4.5-6 m ceiling
export const SUNKEN_P = 0.18;
export const STAGE_P = 0.1;
export const WELL_P = 0.08; // chunks with a light well
export const PROGRAM_P = 0.13; // leaves given a room program
export const MANILA_DOOR_P = 0.35;
const TALL_CEILS: readonly number[] = [450, 480, 540, 600];

/** District character of a LOBBY-family district (NORMAL near the storey-0 origin: the onboarding keeps the photo). */
export function lobbyCharacter(d: DistrictInfo): number {
  if (d.zone !== Zone.LOBBY && d.zone !== Zone.MANILA) return Character.NORMAL;
  if (d.s === 0 && Math.hypot(d.siteX, d.siteZ) < 5) return Character.NORMAL;
  return Math.max(0, Math.min(4, num(d.params, 'character', 0) | 0));
}
/** Split-level district (hashed from the district id). */
export const splitDistrict = (seed: number, d: DistrictInfo): boolean => hash01(hash3(seed, d.id, 0x5b17)) < SPLIT_DISTRICT_P;

// Edge roles in the division model (0 = none).
const R_WALL = 1, R_OPENING = 2, R_GAP = 3, R_ERODED = 4, R_STUB = 5;
// Opening types (index into the typing weights).
const T_HEADER = 1, T_DOORWAY = 2; // T_OPEN = 0
const OPENING_KIND: readonly number[] = [EdgeKind.OPEN, EdgeKind.HEADER, EdgeKind.DOORWAY];
const TYPE_W_LOBBY: readonly number[] = [0.6, 0.35, 0.05];
const TYPE_W_MANILA: readonly number[] = [0.1, 0.2, 0.7];
const WIDTH_W: readonly number[] = [0.4, 0.4, 0.2]; // widths 1 / 2 / 3

export interface LeafRect { li0: number; lj0: number; li1: number; lj1: number }
/** Per-chunk debug record of the last generate() (test hooks). */
export interface LobbyDebug {
  leaves: LeafRect[];
  /** openings actually written, by type: [OPEN, HEADER, DOORWAY] */
  openings: [number, number, number];
  solidBlocks: number;
  bays: number; bulkheads: number; sunken: number; stubs: number; freeWalls: number;
  /** R2 features */
  splits: number; splitCells: number; columns: number; tall: number; stages: number; wells: number;
  openCeilings: number; missingTiles: number; gloomBays: number; programs: number[]; windows: number; doors: number;
  connectors: number; dithered: number; character: number; solidRemoved: number; solidAdded: number;
  /** cells of the thick blocks still standing (tests) */
  blockCells: number[];
}
const DEBUG = new Map<string, LobbyDebug>();
const DEBUG_MAX = 512;

interface St {
  g: ChunkGrid;
  rng: Rng;
  manila: boolean;
  density: number;
  kx: Uint8Array; kz: Uint8Array; // local edge kinds (interior lines; seam lines are frozen)
  hx: Int16Array; hz: Int16Array; // hA
  rx: Uint8Array; rz: Uint8Array; // roles
  wx: Uint8Array; wz: Uint8Array; // writable (not frozen, not touching a reserved cell)
  reservedPrefix: Int32Array; // 2D prefix sum of reserved cells, (N+1)^2
  seen: Uint8Array; queue: Int32Array; avoid: Uint8Array; // BFS scratch
  dbg: LobbyDebug;
  /** R2: cells claimed by a feature (split region, programs, wells, connectors): later features skip them */
  busy: Uint8Array;
  feat: Rng; // forked feature rng
  onboarding: boolean; // the 3x3 chunks around the storey-0 origin keep the plain photo composition
  style: number; // storey style (0 = the zone's Level 0 look)
}

// ------------------------------------------------------------------------------------------------ generator

export const lobbyGenerator: ZoneGenerator = {
  id: Zone.LOBBY,
  seamMode: 'pattern',
  // no seamPattern: LOBBY uses WP1's defaultPatternSeam
  districtParams(rng, _s) {
    const lattice = rng.weighted(LOBBY_LATTICE_W);
    const [lx, lz] = LOBBY_LATTICES[lattice];
    return {
      density: Math.round(rng.range(0.3, 0.8) * 1000) / 1000,
      lattice,
      phaseX: rng.int(0, lx - 1),
      phaseZ: rng.int(0, lz - 1),
      ceilCm: rng.pick(LOBBY_CEILS),
      character: rng.weighted(CHARACTER_W),
    };
  },
  generate(ctx) {
    generateLobby(ctx);
  },
  palette(s, d) {
    const manila = d.zone === Zone.MANILA, dark = d.zone === Zone.DARK;
    const moved = storeyStyle(d.zone, s) === 0 && lobbyCharacter(d) === Character.MOVED_OUT;
    const base: ZonePalette = {
      floorMat: moved ? Mat.CARPET_OFFICE : Mat.CARPET_L0, wallMat: manila ? Mat.WALLPAPER_MANILA : Mat.WALLPAPER_L0, ceilMat: Mat.CEILING_TILE,
      trimMat: Mat.TRIM_PAINT, ceilKind: CeilKind.TILES,
      ceilCm: manila ? 250 : dark ? 270 : num(d.params, 'ceilCm', 270), baseboard: true,
    };
    return stylePalette(storeyStyle(d.zone, s), base);
  },
  lighting(s, d) {
    let base: LightingProfile;
    if (d.zone === Zone.MANILA) {
      base = {
        kind: FixtureKind.TROFFER_2x2, placement: 'lattice', lattice: [4, 4],
        phase: [num(d.params, 'phaseX', 0) % 4, num(d.params, 'phaseZ', 0) % 4], axis: 1,
        cctRange: [4800, 5300], luminance: 2600, zoneMul: 0.9, mountCm: 0, // R2: sickly cool office light
      };
    } else {
      const li = Math.min(LOBBY_LATTICES.length - 1, Math.max(0, num(d.params, 'lattice', 0) | 0));
      const [lx, lz] = LOBBY_LATTICES[li];
      const pristine = lobbyCharacter(d) === Character.PRISTINE;
      base = {
        kind: FixtureKind.TROFFER_2x4, placement: 'lattice', lattice: [lx, lz],
        phase: [num(d.params, 'phaseX', 0) % lx, num(d.params, 'phaseZ', 0) % lz], axis: 1,
        cctRange: pristine ? [4000, 4800] : [3700, 4600], luminance: pristine ? 3800 : 3300, zoneMul: d.zone === Zone.DARK ? 0.35 : 1, mountCm: 0,
      };
      if (d.zone === Zone.DARK) base.decayAdd = 0.2;
    }
    return styleLighting(storeyStyle(d.zone, s), base, d.params);
  },
  props: {
    rules: [
      { kind: PropKind.OUTLET, where: 'wallMounted', per100m2: 2.5, variants: 2, minSpacing: 2.4, yCm: 30 },
      // ceil - 0.35 m: WP4 reads a negative yCm as |yCm| below the ceiling of the mounting cell
      { kind: PropKind.VENT_GRILLE, where: 'wallMounted', per100m2: 0.6, variants: 2, minSpacing: 4.8, yCm: -35 },
      { kind: PropKind.TRASH_CAN, where: 'corner', per100m2: 0.3, variants: 2, minSpacing: 6, yCm: 0 },
      { kind: PropKind.CHAIR_STACKING, where: 'wall', per100m2: 0.4, variants: 3, minSpacing: 3, yCm: 0 },
      { kind: PropKind.WATER_COOLER, where: 'wall', per100m2: 0.08, variants: 1, minSpacing: 20, yCm: 0 },
    ],
  } satisfies PropRuleSet,
};

/** Test hook: the recursive-division leaves of the last LOBBY generate() for this chunk (local cell rects). */
export function lobbyLeaves(ctx: ZoneGenContext): { li0: number; lj0: number; li1: number; lj1: number }[] {
  const d = DEBUG.get(chunkTag(ctx));
  return d ? d.leaves.map((r) => ({ ...r })) : [];
}

/** Test hook: counters of the last LOBBY generate() for this chunk (openings by type, blocks, ceiling features). */
export function lobbyDebug(ctx: ZoneGenContext): LobbyDebug | null {
  return DEBUG.get(chunkTag(ctx)) ?? null;
}

// ------------------------------------------------------------------------------------------------ pipeline

function generateLobby(ctx: ZoneGenContext): void {
  const g = ctx.grid;
  const zone = ctx.district.zone;
  const manila = zone === Zone.MANILA;
  let density = num(ctx.district.params, 'density', 0.55);
  if (zone === Zone.DARK) density += 0.15;
  density = Math.min(0.95, Math.max(0.3, density));

  const st: St = {
    g, rng: ctx.rng, manila, density,
    kx: new Uint8Array(EDGE_N), kz: new Uint8Array(EDGE_N),
    hx: new Int16Array(EDGE_N), hz: new Int16Array(EDGE_N),
    rx: new Uint8Array(EDGE_N), rz: new Uint8Array(EDGE_N),
    wx: new Uint8Array(EDGE_N), wz: new Uint8Array(EDGE_N),
    reservedPrefix: reservedPrefix(g),
    seen: new Uint8Array(N * N), queue: new Int32Array(N * N), avoid: new Uint8Array(N * N),
    dbg: {
      leaves: [], openings: [0, 0, 0], solidBlocks: 0, bays: 0, bulkheads: 0, sunken: 0, stubs: 0, freeWalls: 0,
      splits: 0, splitCells: 0, columns: 0, tall: 0, stages: 0, wells: 0, openCeilings: 0, missingTiles: 0, gloomBays: 0,
      programs: [0, 0, 0, 0, 0, 0], windows: 0, doors: 0, connectors: 0, dithered: 0, character: 0, solidRemoved: 0, solidAdded: 0,
      blockCells: [],
    },
    busy: new Uint8Array(N * N),
    feat: ctx.rng.fork(0xb5a1),
    onboarding: ctx.key.s === 0 && Math.abs(ctx.key.cx) <= 1 && Math.abs(ctx.key.cz) <= 1,
    style: storeyStyle(zone, ctx.key.s),
  };
  for (let j = 0; j < N; j++) for (let i = 0; i <= N; i++) st.wx[exIdx(i, j)] = edgeWritable(g, 'x', i, j) ? 1 : 0;
  for (let j = 0; j <= N; j++) for (let i = 0; i < N; i++) st.wz[ezIdx(i, j)] = edgeWritable(g, 'z', i, j) ? 1 : 0;

  // 1. recursive division over the free region
  divide(st, 0, 0, N, N);
  // 2. erosion
  erode(st);
  // 3. stubs at open wall ends, free-standing walls in big leaves
  stubs(st);
  freeWalls(st);
  // write the division model
  writeModel(st);
  // 4. thick blocks (the chunky corner)
  thickBlocks(st);
  // R2 6. split-level hall (before the ceiling bays: it owns its region's ceiling), 7. room programs
  if (!st.onboarding && st.style !== 2) splitLevel(st, ctx);
  if (!st.onboarding && st.style === 0) programs(st, ctx);
  // 5. ceiling bays / bulkhead bands / tall rooms, 5b. sunken rooms and stages, R2 8. light well
  ceilings(st, ctx);
  sunkenRooms(st, ctx);
  if (!st.onboarding) lightWell(st, ctx);
  // R2 9. ceiling decay, 10. district character, 11. windows, 12. doors, 13. zone transitions
  if (st.style === 0) ceilingDecay(st, ctx);
  if (st.style === 0 && !st.onboarding) {
    st.dbg.character = lobbyCharacter(ctx.district);
    dressCharacter(st.dbg.character, { ctx, rng: st.feat.fork(0xc4a2), busy: st.busy, leaves: st.dbg.leaves, walls: divisionWalls(st) });
  }
  if (st.style === 0 && !st.onboarding) windows(st, ctx);
  if (manila && st.style !== 2) {
    st.dbg.doors = hangDoors(ctx, { p: MANILA_DOOR_P, variant: (h) => ((h >>> 7) & 1 ? 0 : 3), tag: 0x4d41 }).leaves;
  }
  if (!st.onboarding) {
    const tr = transitionStamps(ctx, st.busy);
    st.dbg.connectors = tr.connectors; st.dbg.dithered = tr.dithered;
  }

  if (DEBUG.size >= DEBUG_MAX) DEBUG.delete(DEBUG.keys().next().value as string);
  DEBUG.set(chunkTag(ctx), st.dbg);
}

function reservedPrefix(g: ChunkGrid): Int32Array {
  const P = new Int32Array((N + 1) * (N + 1));
  for (let j = 0; j < N; j++) {
    let row = 0;
    for (let i = 0; i < N; i++) {
      row += g.isReserved(i, j) ? 1 : 0;
      P[(j + 1) * (N + 1) + i + 1] = P[j * (N + 1) + i + 1] + row;
    }
  }
  return P;
}
const reservedIn = (st: St, i0: number, j0: number, i1: number, j1: number): number => {
  const P = st.reservedPrefix, W = N + 1;
  return P[j1 * W + i1] - P[j0 * W + i1] - P[j1 * W + i0] + P[j0 * W + i0];
};

// ------------------------------------------------------------------------------------------------ 1. division

function divide(st: St, i0: number, j0: number, i1: number, j1: number): void {
  const rng = st.rng;
  const w = i1 - i0, h = j1 - j0;
  const area = w * h;
  if (reservedIn(st, i0, j0, i1, j1) >= area) return; // fully reserved: no room here
  const stop = st.manila ? rng.range(9, 30) : rng.range(16, 64) * (1.3 - st.density);
  if (area < stop || Math.min(w, h) < 4) {
    st.dbg.leaves.push({ li0: i0, lj0: j0, li1: i1, lj1: j1 });
    return;
  }
  // split the longer axis (the shorter one with p 0.3); splitX = the wall stands on an x-line (divides the width)
  let splitX = w > h ? true : w < h ? false : rng.chance(0.5);
  if (rng.chance(0.3)) splitX = !splitX;
  const len = splitX ? w : h;
  const o = splitX ? i0 : j0;
  // offset in [2, len-2], biased toward even (absolute) lines so rooms sit on the 2-cell troffer rhythm
  let k = rng.int(2, len - 2);
  if (((o + k) & 1) !== 0 && rng.chance(0.75)) {
    const a = rng.chance(0.5) ? k - 1 : k + 1;
    if (a >= 2 && a <= len - 2) k = a;
    else if (k - 1 >= 2) k--;
    else if (k + 1 <= len - 2) k++;
  }
  const line = o + k;
  wallLine(st, splitX ? 'x' : 'z', line, splitX ? j0 : i0, splitX ? j1 : i1);
  if (splitX) {
    divide(st, i0, j0, line, j1);
    divide(st, line, j0, i1, j1);
  } else {
    divide(st, i0, j0, i1, line);
    divide(st, i0, line, i1, j1);
  }
}

const eIdx = (axis: 'x' | 'z', line: number, c: number): number => (axis === 'x' ? exIdx(line, c) : ezIdx(c, line));

/** One division wall on `line` over cells [s0, s1): optional L-gap, then 1-3 typed openings per writable segment. */
function wallLine(st: St, axis: 'x' | 'z', line: number, s0: number, s1: number): void {
  const rng = st.rng;
  const W = axis === 'x' ? st.wx : st.wz, R = axis === 'x' ? st.rx : st.rz;
  const L = s1 - s0;
  let a = s0, b = s1;
  if (rng.chance(0.25)) {
    const cov = Math.max(1, Math.min(L - 1, Math.round(L * rng.range(0.4, 0.8))));
    if (rng.chance(0.5)) b = s0 + cov; else a = s1 - cov;
    for (let c = s0; c < s1; c++) if ((c < a || c >= b) && W[eIdx(axis, line, c)]) R[eIdx(axis, line, c)] = R_GAP;
  }
  let p = a;
  while (p < b) {
    while (p < b && !W[eIdx(axis, line, p)]) p++;
    let q = p;
    while (q < b && W[eIdx(axis, line, q)]) q++;
    if (q > p) wallSegment(st, axis, line, p, q);
    p = q;
  }
}

function wallSegment(st: St, axis: 'x' | 'z', line: number, p: number, q: number): void {
  const rng = st.rng;
  const K = axis === 'x' ? st.kx : st.kz, H = axis === 'x' ? st.hx : st.hz, R = axis === 'x' ? st.rx : st.rz;
  const segLen = q - p;
  for (let c = p; c < q; c++) {
    const e = eIdx(axis, line, c);
    K[e] = EdgeKind.WALL; H[e] = 0; R[e] = R_WALL;
  }
  // 1-3 openings of width 1/2/3 (§5.WP2). An opening that does not fit is dropped: openings keep >= 1 wall edge
  // between them, and together never take more than half the segment (rounded up), so a short wall stays a wall.
  // DOORWAY openings are always 1 cell: a DOORWAY edge is one framed door (jambs + casing per edge), and a run of
  // them would read as a row of separate doors side by side.
  const n = rng.int(1, 3);
  const budget = Math.max(1, (segLen + 1) >> 1);
  let used = 0;
  const opPos: number[] = [], opW: number[] = [], opT: number[] = [];
  const typeW = st.manila ? TYPE_W_MANILA : TYPE_W_LOBBY;
  for (let o = 0; o < n; o++) {
    const t = rng.weighted(typeW);
    let w = t === T_DOORWAY ? 1 : 1 + rng.weighted(WIDTH_W);
    if (o === 0) w = Math.min(w, budget); // the first opening always fits (narrowed if needed)
    if (used + w > budget) continue;
    let placed = false;
    for (let attempt = 0; attempt < 8 && !placed; attempt++) {
      const pos = rng.int(p, q - w);
      let ok = true;
      for (let k = 0; k < opPos.length && ok; k++) if (pos < opPos[k] + opW[k] + 1 && pos + w + 1 > opPos[k]) ok = false;
      if (ok) { opPos.push(pos); opW.push(w); opT.push(t); used += w; placed = true; }
    }
  }
  for (let k = 0; k < opPos.length; k++) {
    const t = opT[k];
    for (let c = opPos[k]; c < opPos[k] + opW[k]; c++) {
      const e = eIdx(axis, line, c);
      K[e] = OPENING_KIND[t];
      H[e] = t === T_HEADER ? 220 : t === T_DOORWAY ? 210 : 0;
      R[e] = R_OPENING;
    }
    st.dbg.openings[t]++;
  }
}

// ------------------------------------------------------------------------------------------------ 2. erosion

function erode(st: St): void {
  const rng = st.rng;
  // single edges, p 0.08
  for (let e = 0; e < EDGE_N; e++) if (st.rx[e] === R_WALL && st.kx[e] === EdgeKind.WALL && rng.chance(0.08)) { st.kx[e] = EdgeKind.OPEN; st.rx[e] = R_ERODED; }
  for (let e = 0; e < EDGE_N; e++) if (st.rz[e] === R_WALL && st.kz[e] === EdgeKind.WALL && rng.chance(0.08)) { st.kz[e] = EdgeKind.OPEN; st.rz[e] = R_ERODED; }
  // short runs (<= 2 edges) of division wall, p 0.3
  for (const axis of ['x', 'z'] as const) {
    const K = axis === 'x' ? st.kx : st.kz, R = axis === 'x' ? st.rx : st.rz;
    for (let line = 1; line < N; line++) {
      let c = 0;
      while (c < N) {
        if (!(R[eIdx(axis, line, c)] === R_WALL && K[eIdx(axis, line, c)] === EdgeKind.WALL)) { c++; continue; }
        let d = c;
        while (d < N && R[eIdx(axis, line, d)] === R_WALL && K[eIdx(axis, line, d)] === EdgeKind.WALL) d++;
        if (d - c <= 2 && rng.chance(0.3)) {
          for (let x = c; x < d; x++) { K[eIdx(axis, line, x)] = EdgeKind.OPEN; R[eIdx(axis, line, x)] = R_ERODED; }
        }
        c = d;
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ 3. stubs

/** Kind of an edge in the combined state (local model where writable, else the grid). */
function kindAt(st: St, axis: 'x' | 'z', i: number, j: number): number {
  if (axis === 'x') {
    if (i < 0 || i > N || j < 0 || j >= N) return EdgeKind.OPEN;
    const e = exIdx(i, j);
    return st.wx[e] ? st.kx[e] : st.g.getEdge('x', i, j);
  }
  if (i < 0 || i >= N || j < 0 || j > N) return EdgeKind.OPEN;
  const e = ezIdx(i, j);
  return st.wz[e] ? st.kz[e] : st.g.getEdge('z', i, j);
}

/** Can a stub / free wall claim this edge: writable, currently OPEN and not part of an opening. */
function claimable(st: St, axis: 'x' | 'z', i: number, j: number): boolean {
  if (axis === 'x') {
    if (i <= 0 || i >= N || j < 0 || j >= N) return false;
    const e = exIdx(i, j);
    return st.wx[e] === 1 && st.kx[e] === EdgeKind.OPEN && st.rx[e] !== R_OPENING;
  }
  if (j <= 0 || j >= N || i < 0 || i >= N) return false;
  const e = ezIdx(i, j);
  return st.wz[e] === 1 && st.kz[e] === EdgeKind.OPEN && st.rz[e] !== R_OPENING;
}

/** Cells a and b (4-adjacent or not) are joined by a walk that avoids SOLID / reserved cells, the cells in
 * `avoid` (a cell mask or null) and non-passable edges of the combined local + grid state. Used to keep stubs,
 * free-standing walls and thick blocks from ever sealing a pocket off. */
function joined(st: St, a: number, b: number, avoid: Uint8Array | null): boolean {
  if (a === b) return true;
  const g = st.g;
  const seen = st.seen;
  seen.fill(0);
  const q = st.queue;
  let head = 0, tail = 0;
  q[tail++] = a; seen[a] = 1;
  const blocked = (c: number): boolean => {
    const li = c & 31, lj = c >> 5;
    return (avoid !== null && avoid[c] === 1) || g.isReserved(li, lj) || g.hasFlag(li, lj, CellFlag.SOLID | CellFlag.VOID);
  };
  const pass = (axis: 'x' | 'z', i: number, j: number): boolean => {
    const k = kindAt(st, axis, i, j);
    return k === EdgeKind.OPEN || k === EdgeKind.HEADER || k === EdgeKind.DOORWAY || k === EdgeKind.ARCH;
  };
  while (head < tail) {
    const c = q[head++];
    if (c === b) return true;
    const li = c & 31, lj = c >> 5;
    const visit = (n: number): void => { if (!seen[n] && !blocked(n)) { seen[n] = 1; q[tail++] = n; } };
    if (li > 0 && pass('x', li, lj)) visit(c - 1);
    if (li < N - 1 && pass('x', li + 1, lj)) visit(c + 1);
    if (lj > 0 && pass('z', li, lj)) visit(c - N);
    if (lj < N - 1 && pass('z', li, lj + 1)) visit(c + N);
  }
  return false;
}

/** After tentatively walling edges, every walled pair of cells must still be joined some other way. */
function edgesKeepJoined(st: St, edges: number[]): boolean {
  for (let k = 0; k < edges.length; k += 3) {
    const axis = edges[k] === 0 ? 'x' : 'z', i = edges[k + 1], j = edges[k + 2];
    const a = axis === 'x' ? cellIdx(i - 1, j) : cellIdx(i, j - 1), b = cellIdx(i, j);
    if (st.g.isReserved(a & 31, a >> 5) || st.g.isReserved(b & 31, b >> 5)) continue;
    if (st.g.hasFlag(a & 31, a >> 5, CellFlag.SOLID) || st.g.hasFlag(b & 31, b >> 5, CellFlag.SOLID)) continue;
    if (!joined(st, a, b, null)) return false;
  }
  return true;
}

function clearLocal(st: St, axis: 'x' | 'z', i: number, j: number): void {
  if (axis === 'x') { const e = exIdx(i, j); st.kx[e] = EdgeKind.OPEN; st.rx[e] = 0; }
  else { const e = ezIdx(i, j); st.kz[e] = EdgeKind.OPEN; st.rz[e] = 0; }
}

function setLocal(st: St, axis: 'x' | 'z', i: number, j: number, role: number): void {
  if (axis === 'x') { const e = exIdx(i, j); st.kx[e] = EdgeKind.WALL; st.hx[e] = 0; st.rx[e] = role; }
  else { const e = ezIdx(i, j); st.kz[e] = EdgeKind.WALL; st.hz[e] = 0; st.rz[e] = role; }
}

function stubs(st: St): void {
  const rng = st.rng;
  // candidates first (decisions on the pre-stub state), then apply
  const cand: number[] = [];
  for (let vj = 1; vj < N; vj++) {
    for (let vi = 1; vi < N; vi++) {
      const n0 = kindAt(st, 'x', vi, vj - 1), n1 = kindAt(st, 'x', vi, vj); // x-line edges above / below the vertex
      const w0 = kindAt(st, 'z', vi - 1, vj), w1 = kindAt(st, 'z', vi, vj); // z-line edges left / right
      const deg = (n0 !== EdgeKind.OPEN ? 1 : 0) + (n1 !== EdgeKind.OPEN ? 1 : 0) + (w0 !== EdgeKind.OPEN ? 1 : 0) + (w1 !== EdgeKind.OPEN ? 1 : 0);
      if (deg !== 1) continue;
      // the single edge must be a plain wall (a free end), not a header / doorway piece
      if (n0 !== EdgeKind.WALL && n1 !== EdgeKind.WALL && w0 !== EdgeKind.WALL && w1 !== EdgeKind.WALL) continue;
      cand.push(vj * 64 + vi, n0 !== EdgeKind.OPEN || n1 !== EdgeKind.OPEN ? 1 : 0);
    }
  }
  for (let k = 0; k < cand.length; k += 2) {
    if (!rng.chance(0.15)) continue;
    const vi = cand[k] & 63, vj = cand[k] >> 6;
    const onXLine = cand[k + 1] === 1; // the free wall lies on the x-line through the vertex => stub along x
    const len = rng.int(1, 2);
    const sgn = rng.chance(0.5) ? 1 : -1;
    // collect the stub edges and require all claimable
    let ok = true;
    for (let s = 0; s < len && ok; s++) {
      if (onXLine) ok = claimable(st, 'z', sgn > 0 ? vi + s : vi - 1 - s, vj);
      else ok = claimable(st, 'x', vi, sgn > 0 ? vj + s : vj - 1 - s);
    }
    if (!ok) continue;
    const edges: number[] = [];
    for (let s = 0; s < len; s++) {
      if (onXLine) edges.push(1, sgn > 0 ? vi + s : vi - 1 - s, vj);
      else edges.push(0, vi, sgn > 0 ? vj + s : vj - 1 - s);
    }
    if (!tryWalls(st, edges)) continue;
    st.dbg.stubs++;
  }
}

/** Walls the edges (axis 0 = x, 1 = z; i; j triples) unless that would seal something off; then reverts. */
function tryWalls(st: St, edges: number[]): boolean {
  for (let k = 0; k < edges.length; k += 3) setLocal(st, edges[k] === 0 ? 'x' : 'z', edges[k + 1], edges[k + 2], R_STUB);
  if (edgesKeepJoined(st, edges)) return true;
  for (let k = 0; k < edges.length; k += 3) clearLocal(st, edges[k] === 0 ? 'x' : 'z', edges[k + 1], edges[k + 2]);
  return false;
}

function freeWalls(st: St): void {
  const rng = st.rng;
  for (const lf of st.dbg.leaves) {
    const w = lf.li1 - lf.li0, h = lf.lj1 - lf.lj0;
    if (w * h <= 40) continue;
    if (!rng.chance(0.5)) continue;
    let len = rng.int(2, 5);
    const onX = rng.chance(0.5); // wall on an x-line (runs along z)
    const across = onX ? w : h, along = onX ? h : w;
    if (across < 4) continue;
    len = Math.min(len, along - 2);
    if (len < 2) continue;
    const line = (onX ? lf.li0 : lf.lj0) + rng.int(2, across - 2);
    const c0 = (onX ? lf.lj0 : lf.li0) + rng.int(1, along - 1 - len);
    let ok = true;
    for (let c = c0; c < c0 + len && ok; c++) ok = onX ? claimable(st, 'x', line, c) : claimable(st, 'z', c, line);
    if (!ok) continue;
    const edges: number[] = [];
    for (let c = c0; c < c0 + len; c++) { if (onX) edges.push(0, line, c); else edges.push(1, c, line); }
    if (!tryWalls(st, edges)) continue;
    st.dbg.freeWalls++;
  }
}

function writeModel(st: St): void {
  const g = st.g;
  for (let j = 0; j < N; j++) {
    for (let i = 1; i < N; i++) {
      const e = exIdx(i, j);
      if (st.wx[e] && st.kx[e] !== EdgeKind.OPEN) g.setEdge('x', i, j, st.kx[e], st.hx[e] ? { hA: st.hx[e] } : undefined);
    }
  }
  for (let j = 1; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const e = ezIdx(i, j);
      if (st.wz[e] && st.kz[e] !== EdgeKind.OPEN) g.setEdge('z', i, j, st.kz[e], st.hz[e] ? { hA: st.hz[e] } : undefined);
    }
  }
}

// ------------------------------------------------------------------------------------------------ 4. thick blocks

/** Cells that must stay clear of blocks: both sides of every opening / gap / eroded edge, port cells and cells
 * behind passable edges into reserved stamps, dilated by one cell (Chebyshev). */
function blockForbidden(st: St): Uint8Array {
  const g = st.g;
  const near = portCells(g);
  const mark = (li: number, lj: number): void => { if (li >= 0 && lj >= 0 && li < N && lj < N) near[cellIdx(li, lj)] = 1; };
  for (let j = 0; j < N; j++) {
    for (let i = 1; i < N; i++) {
      const r = st.rx[exIdx(i, j)];
      const opening = r === R_OPENING || r === R_GAP || r === R_ERODED;
      const intoStamp = (g.isReserved(i - 1, j) !== g.isReserved(i, j)) && edgePassable(g, 'x', i, j);
      if (opening || intoStamp) { mark(i - 1, j); mark(i, j); }
    }
  }
  for (let j = 1; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const r = st.rz[ezIdx(i, j)];
      const opening = r === R_OPENING || r === R_GAP || r === R_ERODED;
      const intoStamp = (g.isReserved(i, j - 1) !== g.isReserved(i, j)) && edgePassable(g, 'z', i, j);
      if (opening || intoStamp) { mark(i, j - 1); mark(i, j); }
    }
  }
  const out = new Uint8Array(N * N);
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      let f = 0;
      for (let dj = -1; dj <= 1 && !f; dj++) for (let di = -1; di <= 1 && !f; di++) {
        const a = li + di, b = lj + dj;
        if (a >= 0 && b >= 0 && a < N && b < N && near[cellIdx(a, b)]) f = 1;
      }
      out[cellIdx(li, lj)] = f;
    }
  }
  return out;
}

/** Number of plain WALL edges around a cell, as bits W=1 E=2 N=4 S=8. */
function wallBits(g: ChunkGrid, li: number, lj: number): number {
  return (g.getEdge('x', li, lj) === EdgeKind.WALL ? 1 : 0) | (g.getEdge('x', li + 1, lj) === EdgeKind.WALL ? 2 : 0)
    | (g.getEdge('z', li, lj) === EdgeKind.WALL ? 4 : 0) | (g.getEdge('z', li, lj + 1) === EdgeKind.WALL ? 8 : 0);
}

function blockCandidate(st: St, forbid: Uint8Array, li: number, lj: number): boolean {
  if (li < 0 || lj < 0 || li >= N || lj >= N) return false;
  const c = cellIdx(li, lj);
  if (forbid[c] || st.g.isReserved(li, lj) || st.g.hasFlag(li, lj, CellFlag.SOLID | CellFlag.VOID)) return false;
  return true;
}

function thickBlocks(st: St): void {
  const g = st.g, rng = st.rng;
  const forbid = blockForbidden(st);
  const corners: number[] = [], sides: number[] = [];
  for (const lf of st.dbg.leaves) {
    if (!rng.chance(0.1)) continue;
    const w = lf.li1 - lf.li0, h = lf.lj1 - lf.lj0;
    if (Math.min(w, h) < 2 || w * h < 6) continue; // a block in a 2-wide leaf leaves a 1-cell squeeze (the photo)
    // candidates against a wall: corners (2 perpendicular walls) first, then plain wall cells, each in random order;
    // the first one that seals nothing off becomes the block
    corners.length = 0; sides.length = 0;
    for (let lj = lf.lj0; lj < lf.lj1; lj++) {
      for (let li = lf.li0; li < lf.li1; li++) {
        if (!blockCandidate(st, forbid, li, lj)) continue;
        const b = wallBits(g, li, lj);
        if ((b & 3) !== 0 && (b & 12) !== 0) corners.push(cellIdx(li, lj));
        else if (b !== 0) sides.push(cellIdx(li, lj));
      }
    }
    rng.shuffle(corners); rng.shuffle(sides);
    const one = rng.chance(0.5); // 1x1, else try 1x2
    let tries = 0;
    for (const list of [corners, sides]) {
      let done = false;
      for (let k = 0; k < list.length && tries < 6 && !done; k++, tries++) done = placeBlock(st, forbid, lf, list[k], one);
      if (done) { st.dbg.solidBlocks++; break; }
    }
  }
}

/** Tries a 1x1 (or 1x2 along its wall) SOLID block at cell c of leaf lf; false (nothing written) if it would seal
 * any of its open neighbours off from the others. */
function placeBlock(st: St, forbid: Uint8Array, lf: LeafRect, c: number, one: boolean): boolean {
  const g = st.g;
  const li = c & 31, lj = c >> 5;
  const cells: number[] = [li, lj];
  if (!one) {
    // 1x2: extend along the wall the cell leans on
    const b = wallBits(g, li, lj);
    const dirs: number[] = [];
    if (b & 3) dirs.push(0, 1, 0, -1); // wall on an x-line => extend along z
    if (b & 12) dirs.push(1, 0, -1, 0); // wall on a z-line => extend along x
    for (let k = 0; k < dirs.length; k += 2) {
      const ni = li + dirs[k], nj = lj + dirs[k + 1];
      if (ni < lf.li0 || nj < lf.lj0 || ni >= lf.li1 || nj >= lf.lj1) continue;
      if (!blockCandidate(st, forbid, ni, nj)) continue;
      if ((wallBits(g, ni, nj) & b) === 0) continue; // must lean on the same wall line
      cells.push(ni, nj);
      break;
    }
  }
  // the block must not seal anything off: its open neighbours stay joined around it
  const avoid = st.avoid;
  avoid.fill(0);
  for (let k = 0; k < cells.length; k += 2) avoid[cellIdx(cells[k], cells[k + 1])] = 1;
  // open neighbours of the block: outside it, not SOLID / VOID / reserved, reached through a non-WALL edge
  const nbrs: number[] = [];
  const addNbr = (ni: number, nj: number): void => {
    const n = cellIdx(ni, nj);
    if (avoid[n] || g.isReserved(ni, nj) || g.hasFlag(ni, nj, CellFlag.SOLID | CellFlag.VOID)) return;
    nbrs.push(n);
  };
  for (let k = 0; k < cells.length; k += 2) {
    const bi = cells[k], bj = cells[k + 1];
    if (bi > 0 && g.getEdge('x', bi, bj) !== EdgeKind.WALL) addNbr(bi - 1, bj);
    if (bi < N - 1 && g.getEdge('x', bi + 1, bj) !== EdgeKind.WALL) addNbr(bi + 1, bj);
    if (bj > 0 && g.getEdge('z', bi, bj) !== EdgeKind.WALL) addNbr(bi, bj - 1);
    if (bj < N - 1 && g.getEdge('z', bi, bj + 1) !== EdgeKind.WALL) addNbr(bi, bj + 1);
  }
  for (let k = 1; k < nbrs.length; k++) if (!joined(st, nbrs[0], nbrs[k], avoid)) return false;
  for (let k = 0; k < cells.length; k += 2) {
    const bi = cells[k], bj = cells[k + 1];
    g.setCells(bi, bj, bi + 1, bj + 1, { flagsSet: CellFlag.SOLID });
    st.dbg.blockCells.push(cellIdx(bi, bj));
  }
  // perimeter edges become walls so the block faces sit flush with the adjoining wall faces (posts, baseboards)
  const inBlock = (a: number, b: number): boolean => {
    for (let m = 0; m < cells.length; m += 2) if (cells[m] === a && cells[m + 1] === b) return true;
    return false;
  };
  for (let k = 0; k < cells.length; k += 2) {
    const bi = cells[k], bj = cells[k + 1];
    if (!inBlock(bi - 1, bj)) g.setEdge('x', bi, bj, EdgeKind.WALL);
    if (!inBlock(bi + 1, bj)) g.setEdge('x', bi + 1, bj, EdgeKind.WALL);
    if (!inBlock(bi, bj - 1)) g.setEdge('z', bi, bj, EdgeKind.WALL);
    if (!inBlock(bi, bj + 1)) g.setEdge('z', bi, bj + 1, EdgeKind.WALL);
  }
  return true;
}

// ------------------------------------------------------------------------------------------------ 5. ceilings

function ceilings(st: St, ctx: ZoneGenContext): void {
  const g = st.g, rng = st.rng, L = g.layout;
  for (const lf of st.dbg.leaves) {
    if (!rng.chance(0.12)) continue;
    const bay = rng.chance(0.5);
    const d = 10 * rng.int(3, 6);
    if (leafBusy(st, lf)) continue;
    if (bay) {
      for (let lj = lf.lj0; lj < lf.lj1; lj++) {
        for (let li = lf.li0; li < lf.li1; li++) {
          if (g.isReserved(li, lj)) continue;
          g.setCells(li, lj, li + 1, lj + 1, { ceilCm: L.ceilCm[cellIdx(li, lj)] + d });
        }
      }
      st.dbg.bays++;
    } else {
      // 40 cm bulkhead band: a 1-cell ring at ceilCm - 40 (never below a HEADER underside); the ring skips cells
      // next to a stair tower (its caged entrance bulb hangs over the door at up to 2.38 m)
      if (ctx.palette.ceilCm - 40 < 220 || Math.min(lf.li1 - lf.li0, lf.lj1 - lf.lj0) < 3) continue;
      for (let lj = lf.lj0; lj < lf.lj1; lj++) {
        for (let li = lf.li0; li < lf.li1; li++) {
          const ring = li === lf.li0 || lj === lf.lj0 || li === lf.li1 - 1 || lj === lf.lj1 - 1;
          if (!ring || g.isReserved(li, lj) || nextToTower(g, li, lj)) continue;
          g.setCells(li, lj, li + 1, lj + 1, { ceilCm: L.ceilCm[cellIdx(li, lj)] - 40 });
        }
      }
      st.dbg.bulkheads++;
    }
  }
  // R2 tall rooms: a 4.5-6 m ceiling with troffers hung on pendants at 3 m (the lattice slots inside the room)
  if (st.onboarding || st.style !== 0) return;
  const fr = st.feat.fork(0x7a11);
  for (const lf of st.dbg.leaves) {
    const w = lf.li1 - lf.li0, h = lf.lj1 - lf.lj0;
    if (w * h < 16 || Math.min(w, h) < 4 || !fr.chance(TALL_P) || leafBusy(st, lf)) continue;
    const ceil = fr.pick(TALL_CEILS);
    let ok = true;
    for (let lj = lf.lj0; lj < lf.lj1 && ok; lj++) for (let li = lf.li0; li < lf.li1 && ok; li++) if (g.isReserved(li, lj)) ok = false;
    if (!ok) continue;
    g.setCells(lf.li0, lf.lj0, lf.li1, lf.lj1, { ceilCm: ceil });
    tallPendants(st, ctx, lf);
    for (let lj = lf.lj0; lj < lf.lj1; lj++) for (let li = lf.li0; li < lf.li1; li++) st.busy[cellIdx(li, lj)] = 1;
    st.dbg.tall++;
  }
}

const nextToTower = (g: ChunkGrid, li: number, lj: number): boolean =>
  g.hasFlag(li - 1, lj, CellFlag.TOWER) || g.hasFlag(li + 1, lj, CellFlag.TOWER) || g.hasFlag(li, lj - 1, CellFlag.TOWER) || g.hasFlag(li, lj + 1, CellFlag.TOWER);

function leafBusy(st: St, lf: LeafRect): boolean {
  for (let lj = lf.lj0; lj < lf.lj1; lj++) for (let li = lf.li0; li < lf.li1; li++) if (st.busy[cellIdx(li, lj)]) return true;
  return false;
}

/** PENDANT_LINEAR troffers on the district lattice slots inside a tall leaf, 3 m above its floor. Their footprint
 * (1 x 2 tiles) occupies the slot, so WP4's lattice placer leaves those slots to them. */
function tallPendants(st: St, ctx: ZoneGenContext, lf: LeafRect): void {
  const g = st.g, l = g.layout, lp = ctx.lighting;
  const dims = FIXTURE_DIMS[lp.kind];
  if (lp.placement !== 'lattice' || !dims) return;
  const wx = lp.axis === 0 ? dims.tl : dims.ts, wz = lp.axis === 0 ? dims.ts : dims.tl;
  const latX = Math.max(1, lp.lattice[0] | 0), latZ = Math.max(1, lp.lattice[1] | 0);
  const mod = (a: number, m: number): number => ((a % m) + m) % m;
  const fx = mod(lp.phase[0] - g.gi0 * 2, latX), fz = mod(lp.phase[1] - g.gj0 * 2, latZ);
  for (let tz = fz; tz < 2 * N; tz += latZ) {
    for (let tx = fx; tx < 2 * N; tx += latX) {
      if (tx < 2 * lf.li0 + 1 || tx + wx > 2 * lf.li1 - 1 || tz < 2 * lf.lj0 + 1 || tz + wz > 2 * lf.lj1 - 1) continue;
      if ((tx < 32 && tx + wx > 32) || (tz < 32 && tz + wz > 32)) continue;
      let ok = true;
      for (let z = tz; z < tz + wz && ok; z++) for (let x = tx; x < tx + wx && ok; x++) if (g.hasFlag(x >> 1, z >> 1, CellFlag.SOLID | CellFlag.RESERVED)) ok = false;
      const c = cellIdx(tx >> 1, tz >> 1);
      const y = l.floorCm[c] / 100 + 3.0;
      if (!ok || rectHitsEdges(l, tx * CEIL_TILE, tz * CEIL_TILE, (tx + wx) * CEIL_TILE, (tz + wz) * CEIL_TILE, (y - 0.5) * 100)) continue;
      addCustomFixtureUnique(ctx, {
        kind: FixtureKind.PENDANT_LINEAR, x: (tx + wx / 2) * CEIL_TILE, y, z: (tz + wz / 2) * CEIL_TILE, nx: 0, ny: -1, nz: 0,
        tx: lp.axis === 0 ? 1 : 0, ty: 0, tz: lp.axis === 0 ? 0 : 1, w: 1.2, h: 0.2,
        cct0: lp.cctRange[0], cct1: lp.cctRange[1], luminance: 9000, hum: 0.4,
      });
    }
  }
}

// ------------------------------------------------------------------------------------------------ 5b. sunken rooms, stages

function sunkenRooms(st: St, ctx: ZoneGenContext): void {
  const rng = st.rng;
  const fr = st.feat.fork(0x5a4c);
  for (const lf of st.dbg.leaves) {
    const w = lf.li1 - lf.li0, h = lf.lj1 - lf.lj0;
    if (w * h < 16) continue;
    const sunk = rng.chance(SUNKEN_P);
    const stage = !sunk && !st.onboarding && fr.chance(STAGE_P);
    if (!sunk && !stage) continue;
    if (w < 4 || h < 4 || leafBusy(st, lf)) continue; // an interior (inset 1) of at least 2 x 2 cells (a conversation pit)
    const deep = sunk && fr.chance(0.3);
    if (insetFloor(st, ctx, lf, sunk ? (deep ? -90 : -45) : 45, deep ? 2 : 1)) {
      if (sunk) st.dbg.sunken++; else st.dbg.stages++;
    }
  }
}

/** Lowers (delta < 0) or raises the leaf interior (inset 1) by |delta| with a ramp of `rampLen` cells at the rim,
 * rising toward the rim (sunken) or toward the interior (stage). */
function insetFloor(st: St, ctx: ZoneGenContext, lf: LeafRect, delta: number, rampLen: number): boolean {
  const g = st.g, rng = st.rng, L = g.layout;
  const i0 = lf.li0 + 1, j0 = lf.lj0 + 1, i1 = lf.li1 - 1, j1 = lf.lj1 - 1;
  let ok = true;
  for (let lj = j0; lj < j1 && ok; lj++) {
    for (let li = i0; li < i1 && ok; li++) {
      if (g.isReserved(li, lj) || g.hasFlag(li, lj, CellFlag.SOLID | CellFlag.VOID | CellFlag.WET | CellFlag.NOWALK)) ok = false;
      else if (L.floorCm[cellIdx(li, lj)] !== L.floorCm[cellIdx(i0, j0)]) ok = false;
      else if (delta > 0 && L.ceilCm[cellIdx(li, lj)] - L.floorCm[cellIdx(li, lj)] - delta < 210) ok = false;
    }
  }
  // the inset floor must be one clean room: no wall piece (stub / free-standing wall) between interior cells,
  // or part of it would be cut off from the steps by the drop
  for (let lj = j0; lj < j1 && ok; lj++) for (let li = i0 + 1; li < i1 && ok; li++) if (g.getEdge('x', li, lj) !== EdgeKind.OPEN) ok = false;
  for (let lj = j0 + 1; lj < j1 && ok; lj++) for (let li = i0; li < i1 && ok; li++) if (g.getEdge('z', li, lj) !== EdgeKind.OPEN) ok = false;
  // the ring must be plain floor too (no blocks on the rim)
  for (let lj = lf.lj0; lj < lf.lj1 && ok; lj++) {
    for (let li = lf.li0; li < lf.li1 && ok; li++) {
      if (g.hasFlag(li, lj, CellFlag.SOLID)) ok = false;
    }
  }
  if (!ok) return false;
  // sides with an opening on the leaf boundary: 0 W, 1 E, 2 N, 3 S; value = cell index along the side
  const sides: number[] = [];
  for (let lj = lf.lj0 + 1; lj < lf.lj1 - 1; lj++) {
    if (edgePassable(g, 'x', lf.li0, lj)) sides.push(0, lj);
    if (edgePassable(g, 'x', lf.li1, lj)) sides.push(1, lj);
  }
  for (let li = lf.li0 + 1; li < lf.li1 - 1; li++) {
    if (edgePassable(g, 'z', li, lf.lj0)) sides.push(2, li);
    if (edgePassable(g, 'z', li, lf.lj1)) sides.push(3, li);
  }
  let side: number, at: number;
  if (sides.length > 0) {
    const k = rng.int(0, (sides.length >> 1) - 1) * 2;
    side = sides[k]; at = sides[k + 1];
  } else {
    side = rng.int(0, 3);
    at = side < 2 ? (j0 + j1) >> 1 : (i0 + i1) >> 1;
  }
  const base = L.floorCm[cellIdx(i0, j0)];
  const target = base + delta;
  // ramp (rampLen cells deep, 1-2 cells wide) inside the inset floor at the chosen side
  const spanLo = side < 2 ? j0 : i0, spanHi = side < 2 ? j1 : i1;
  const depthAvail = side < 2 ? i1 - i0 : j1 - j0;
  if (depthAvail < rampLen + 1) return false;
  const rw = spanHi - spanLo >= 4 ? 2 : 1;
  let r0 = Math.max(spanLo, Math.min(spanHi - rw, at - (rw >> 1)));
  if (r0 < spanLo) r0 = spanLo;
  // the rim edges the steps climb through must be open
  for (let r = r0; r < r0 + rw; r++) {
    const k = side === 0 ? g.getEdge('x', i0, r) : side === 1 ? g.getEdge('x', i1, r) : side === 2 ? g.getEdge('z', r, j0) : g.getEdge('z', r, j1);
    if (k !== EdgeKind.OPEN) return false;
  }
  let x0: number, z0: number, x1: number, z1: number, out: 0 | 1 | 2 | 3; // out: ascent direction toward the rim
  if (side === 0) { x0 = i0 * CELL; x1 = (i0 + rampLen) * CELL; z0 = r0 * CELL; z1 = (r0 + rw) * CELL; out = 1; }
  else if (side === 1) { x0 = (i1 - rampLen) * CELL; x1 = i1 * CELL; z0 = r0 * CELL; z1 = (r0 + rw) * CELL; out = 0; }
  else if (side === 2) { z0 = j0 * CELL; z1 = (j0 + rampLen) * CELL; x0 = r0 * CELL; x1 = (r0 + rw) * CELL; out = 3; }
  else { z0 = (j1 - rampLen) * CELL; z1 = j1 * CELL; x0 = r0 * CELL; x1 = (r0 + rw) * CELL; out = 2; }
  const inward: 0 | 1 | 2 | 3 = out === 0 ? 1 : out === 1 ? 0 : out === 2 ? 3 : 2;
  g.setCells(i0, j0, i1, j1, { floorCm: target });
  if (delta > 0) {
    // stage: the ramp cells stay at the base floor, the ramp climbs inward onto the stage
    for (let lj = Math.floor(z0 / CELL + 1e-6); lj < Math.round(z1 / CELL); lj++) {
      for (let li = Math.floor(x0 / CELL + 1e-6); li < Math.round(x1 / CELL); li++) g.setCells(li, lj, li + 1, lj + 1, { floorCm: base });
    }
  }
  const lo = Math.min(base, target), hi = Math.max(base, target);
  g.addSolid({
    kind: 'ramp', x0, z0, x1, z1, y0: lo / 100, y1: hi / 100, dir: delta < 0 ? out : inward, steps: 3 * rampLen,
    mat: ctx.palette.floorMat, flags: SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.WALKABLE_TOP | SolidFlag.RENDER,
    bakeGroup: 0,
  });
  for (let lj = lf.lj0; lj < lf.lj1; lj++) for (let li = lf.li0; li < lf.li1; li++) st.busy[cellIdx(li, lj)] = 1;
  return true;
}

// ------------------------------------------------------------------------------------------------ R2 features

/** Local model := grid for every writable interior edge (after a stamp wrote the grid directly). */
function syncModel(st: St): void {
  const l = st.g.layout;
  for (let e = 0; e < EDGE_N; e++) {
    if (st.wx[e] && st.kx[e] !== l.ex.kind[e]) { st.kx[e] = l.ex.kind[e]; st.hx[e] = l.ex.hA[e]; st.rx[e] = 0; }
    if (st.wz[e] && st.kz[e] !== l.ez.kind[e]) { st.kz[e] = l.ez.kind[e]; st.hz[e] = l.ez.hA[e]; st.rz[e] = 0; }
  }
}

/** Division WALL edges still standing (axis 0 x / 1 z, i, j triples). */
function divisionWalls(st: St): number[] {
  const out: number[] = [], l = st.g.layout;
  for (let j = 0; j < N; j++) for (let i = 1; i < N; i++) { const e = exIdx(i, j); if (st.wx[e] && st.rx[e] === R_WALL && l.ex.kind[e] === EdgeKind.WALL) out.push(0, i, j); }
  for (let j = 1; j < N; j++) for (let i = 0; i < N; i++) { const e = ezIdx(i, j); if (st.wz[e] && st.rz[e] === R_WALL && l.ez.kind[e] === EdgeKind.WALL) out.push(1, i, j); }
  return out;
}

function splitLevel(st: St, ctx: ZoneGenContext): void {
  if (!st.feat.chance(splitDistrict(ctx.seed, ctx.district) ? SPLIT_CHUNK_P : SPLIT_BASE_P)) return;
  const g = st.g, l = g.layout, rng = st.feat.fork(0x5117);
  const depth = rng.chance(0.7) ? SPLIT_DEPTHS[0] : SPLIT_DEPTHS[1];
  const seen = new Uint8Array(N * N);
  const base0 = unreachedWalkable(l, seen);
  for (let attempt = 0; attempt < 10; attempt++) {
    const alongZ = rng.chance(0.5);
    const len = rng.int(11, 14), wid = rng.int(7, 10);
    const hw = alongZ ? wid : len, hd = alongZ ? len : wid;
    const i0 = rng.int(1, N - 1 - hw), j0 = rng.int(1, N - 1 - hd);
    const ri0 = i0 - 1, rj0 = j0 - 1, ri1 = i0 + hw + 1, rj1 = j0 + hd + 1;
    if (reservedIn(st, ri0, rj0, ri1, rj1) > 0) continue;
    let ok = true;
    for (let lj = rj0; lj < rj1 && ok; lj++) {
      for (let li = ri0; li < ri1 && ok; li++) {
        const c = cellIdx(li, lj);
        if ((l.flags[c] & (CellFlag.VOID | CellFlag.NOWALK | CellFlag.TOWER | CellFlag.ELEVATOR)) !== 0 || l.floorCm[c] !== 0 || l.blockCm[c] !== 0 || st.busy[c]) ok = false;
      }
    }
    if (!ok || solidsInRect(l, ri0, rj0, ri1, rj1)) continue;
    const snap = snapshot(l);
    let removed = 0;
    for (let lj = rj0; lj < rj1; lj++) for (let li = ri0; li < ri1; li++) if (l.flags[cellIdx(li, lj)] & CellFlag.SOLID) removed++;
    g.setCells(ri0, rj0, ri1, rj1, { flagsClear: CellFlag.SOLID, ceilCm: ctx.palette.ceilCm });
    for (let lj = rj0; lj < rj1; lj++) for (let li = ri0 + 1; li < ri1; li++) if (!g.isFrozenEdge('x', li, lj)) g.setEdge('x', li, lj, EdgeKind.OPEN);
    for (let lj = rj0 + 1; lj < rj1; lj++) for (let li = ri0; li < ri1; li++) if (!g.isFrozenEdge('z', li, lj)) g.setEdge('z', li, lj, EdgeKind.OPEN);
    const lp = ctx.lighting;
    const h: SplitHall = {
      i0, j0, i1: i0 + hw, j1: j0 + hd, depthCm: depth,
      stairAxis: alongZ ? 'z' : 'x', stairSide: rng.chance(0.5) ? -1 : 1, stairHead: rng.chance(0.5) ? -1 : 1,
      stairW: rng.int(2, 3), stairL: depth > 300 ? 7 : 5,
      wallMat: ctx.palette.wallMat, stairMat: ctx.palette.floorMat, parapetMat: ctx.palette.wallMat,
      columns: rng.chance(0.6),
      pendant: { kind: FixtureKind.PENDANT_LINEAR, luminance: 9000, cct: [lp.cctRange[0], lp.cctRange[1]], w: 1.2, h: 0.2 },
    };
    const info = buildSplitHall(ctx, h);
    if (unreachedWalkable(l, seen) > base0) { restore(l, snap); continue; }
    for (let lj = rj0; lj < rj1; lj++) for (let li = ri0; li < ri1; li++) st.busy[cellIdx(li, lj)] = 1;
    st.dbg.blockCells = st.dbg.blockCells.filter((c) => (l.flags[c] & CellFlag.SOLID) !== 0);
    st.dbg.splits++; st.dbg.splitCells += hw * hd; st.dbg.columns += info.columns;
    st.dbg.solidRemoved += removed; st.dbg.solidAdded += info.columns;
    syncModel(st);
    return;
  }
}

function programs(st: St, ctx: ZoneGenContext): void {
  const rng = st.feat.fork(0x9a0f);
  const p = { ctx, rng, busy: st.busy, seq: { n: 0 } };
  const l = st.g.layout;
  for (const lf of st.dbg.leaves) {
    if (!rng.chance(PROGRAM_P)) continue;
    const prog = programFor(lf, rng.float());
    if (prog === Program.NONE || leafBusy(st, lf)) continue;
    let solid = 0;
    for (let lj = lf.lj0; lj < lf.lj1; lj++) for (let li = lf.li0; li < lf.li1; li++) if (l.flags[cellIdx(li, lj)] & CellFlag.SOLID) solid++;
    if (solid > 0) continue;
    if (applyProgram(p, lf, prog)) st.dbg.programs[prog]++;
  }
  syncModel(st);
}

function lightWell(st: St, ctx: ZoneGenContext): void {
  if (!st.feat.chance(WELL_P)) return;
  const g = st.g, l = g.layout, rng = st.feat.fork(0x3e11);
  const size = rng.chance(0.6) ? 2 : 3;
  const seen = new Uint8Array(N * N);
  const base0 = unreachedWalkable(l, seen);
  for (let attempt = 0; attempt < 24; attempt++) {
    const i0 = rng.int(3, N - 3 - size), j0 = rng.int(3, N - 3 - size);
    const ri0 = i0 - 1, rj0 = j0 - 1, ri1 = i0 + size + 1, rj1 = j0 + size + 1;
    let ok = reservedIn(st, ri0, rj0, ri1, rj1) === 0;
    const f0 = l.floorCm[cellIdx(i0, j0)];
    for (let lj = rj0; lj < rj1 && ok; lj++) {
      for (let li = ri0; li < ri1 && ok; li++) {
        const c = cellIdx(li, lj);
        if ((l.flags[c] & (CellFlag.SOLID | CellFlag.VOID | CellFlag.NOWALK | CellFlag.WET)) !== 0 || l.floorCm[c] !== f0 || l.blockCm[c] !== 0 || st.busy[c]) ok = false;
        // edges inside the shaft and on its rim must be open (the rim becomes the railing); the ring beyond is free
        const inW = (a: number, b: number): boolean => a >= i0 && a < i0 + size && b >= j0 && b < j0 + size;
        if (ok && li > ri0 && (inW(li - 1, lj) || inW(li, lj)) && g.getEdge('x', li, lj) !== EdgeKind.OPEN) ok = false;
        if (ok && lj > rj0 && (inW(li, lj - 1) || inW(li, lj)) && g.getEdge('z', li, lj) !== EdgeKind.OPEN) ok = false;
      }
    }
    if (!ok) continue;
    let clash = false;
    for (const sd of l.solids) {
      const bx0 = sd.kind === 'box' ? sd.min[0] : sd.kind === 'ramp' ? sd.x0 : Math.min(sd.a[0], sd.b[0]);
      const bx1 = sd.kind === 'box' ? sd.max[0] : sd.kind === 'ramp' ? sd.x1 : Math.max(sd.a[0], sd.b[0]);
      const bz0 = sd.kind === 'box' ? sd.min[2] : sd.kind === 'ramp' ? sd.z0 : Math.min(sd.a[2], sd.b[2]);
      const bz1 = sd.kind === 'box' ? sd.max[2] : sd.kind === 'ramp' ? sd.z1 : Math.max(sd.a[2], sd.b[2]);
      if (bx0 < ri1 * CELL && bx1 > ri0 * CELL && bz0 < rj1 * CELL && bz1 > rj0 * CELL) clash = true;
    }
    for (const pr of l.props) if (pr.x > ri0 * CELL && pr.x < ri1 * CELL && pr.z > rj0 * CELL && pr.z < rj1 * CELL) clash = true;
    if (clash) continue;
    const snap = snapshot(l);
    buildLightWell(ctx, { i0, j0, i1: i0 + size, j1: j0 + size, water: rng.chance(0.5) }, attempt);
    if (unreachedWalkable(l, seen) > base0) { restore(l, snap); continue; }
    for (let lj = rj0; lj < rj1; lj++) for (let li = ri0; li < ri1; li++) st.busy[cellIdx(li, lj)] = 1;
    st.dbg.wells++;
    syncModel(st);
    return;
  }
}

/** Missing ceilings in decayed leaves: open plenum patches (decay > 0.6, 2-8 % of the rooms), scattered missing
 * tiles (decay > 0.45), and the odd bay whose fixtures were pulled out (gloom). */
function ceilingDecay(st: St, ctx: ZoneGenContext): void {
  const g = st.g, l = g.layout, rng = st.feat.fork(0xdeca);
  for (const lf of st.dbg.leaves) {
    const w = lf.li1 - lf.li0, h = lf.lj1 - lf.lj0;
    const wx = (g.gi0 + (lf.li0 + lf.li1) / 2) * CELL, wz = (g.gj0 + (lf.lj0 + lf.lj1) / 2) * CELL;
    const decay = ctx.fields.decay(wx, wz);
    if (!st.onboarding && decay > 0.6 && w * h >= 6 && rng.chance(0.02 + 0.2 * (decay - 0.6))) {
      const pw = Math.min(w, rng.int(2, 4)), ph = Math.min(h, rng.int(2, 5));
      const i0 = lf.li0 + rng.int(0, w - pw), j0 = lf.lj0 + rng.int(0, h - ph);
      let ok = true;
      const c0 = l.ceilCm[cellIdx(i0, j0)];
      for (let lj = j0; lj < j0 + ph && ok; lj++) {
        for (let li = i0; li < i0 + pw && ok; li++) {
          const c = cellIdx(li, lj);
          if (g.isReserved(li, lj) || (l.flags[c] & (CellFlag.SOLID | CellFlag.NO_CEIL)) !== 0 || l.ceilKind[c] !== CeilKind.TILES || l.ceilCm[c] !== c0 || st.busy[c]) ok = false;
        }
      }
      if (ok) {
        openCeiling(ctx, i0, j0, i0 + pw, j0 + ph, rng);
        st.dbg.openCeilings++;
        // the tiles around the hole are going too
        st.dbg.missingTiles += missingTiles(ctx, i0 - 1, j0 - 1, i0 + pw + 1, j0 + ph + 1, 0.3, rng);
        continue;
      }
    }
    if (decay > 0.45 && rng.chance(0.25)) {
      const pw = Math.min(w, rng.int(2, 5)), ph = Math.min(h, rng.int(2, 5));
      const i0 = lf.li0 + rng.int(0, w - pw), j0 = lf.lj0 + rng.int(0, h - ph);
      st.dbg.missingTiles += missingTiles(ctx, i0, j0, i0 + pw, j0 + ph, rng.range(0.1, 0.35), rng);
      continue;
    }
    if (!st.onboarding && w * h >= 12 && rng.chance(0.05) && !leafBusy(st, lf)) {
      removedFixtures(ctx, lf.li0, lf.lj0, lf.li1, lf.lj1);
      st.dbg.gloomBays++;
    }
  }
}

function windows(st: St, ctx: ZoneGenContext): void {
  const sides = (['W', 'N', 'E', 'S'] as const).filter((sd) => ctx.seams[sd].mode === SeamMode.BOUNDARY);
  if (!st.feat.chance(sides.length > 0 ? 0.45 : 0.08)) return;
  const rng = st.feat.fork(0x3d0e);
  const pick = sides.length === 0 ? undefined : (axis: 'x' | 'z', line: number): number => {
    let d = 99;
    for (const sd of sides) {
      if (axis === 'x' && sd === 'W') d = Math.min(d, line);
      if (axis === 'x' && sd === 'E') d = Math.min(d, N - line);
      if (axis === 'z' && sd === 'N') d = Math.min(d, line);
      if (axis === 'z' && sd === 'S') d = Math.min(d, N - line);
    }
    return d + rng.float() * 3;
  };
  const run = windowWall(ctx, rng, st.busy, ctx.palette.wallMat, pick);
  if (!run) return;
  st.dbg.windows += run.windows;
  st.dbg.solidAdded += run.c1 - run.c0;
  syncModel(st);
}
