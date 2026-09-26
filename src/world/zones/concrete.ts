// src/world/zones/concrete.ts — CONCRETE generator (WP3). PATTERN seams: corridor graph, utility rooms, loading drops.
//
// A solid-mass zone (everything not carved is SOLID CMU mass):
// - Corridor graph: a jittered 6-cell node lattice (5 x 5 nodes per chunk at 3 + 6k ± 1) plus one node per entry
//   (seam port run, stamp opening). Candidate edges join lattice neighbours; entries join their nearest lattice node
//   (and the second nearest with p 0.25). Kruskal MST over random weights plus 25% of the remaining edges. Each edge
//   is carved as an L-shaped corridor 1–3 cells wide (weights 0.45 / 0.4 / 0.15) that leaves a seam port straight
//   inward; paths that would cross a reserved stamp fall back to a BFS route around it (or are dropped: the stamp's
//   own openings are entries and get connected separately).
// - Utility rooms: 20% of lattice nodes grow into rooms of 4×4 to 6×8 cells (1-cell margin to seams, stamps and each
//   other; taller ceilings 300–360 cm). Every contact run between a room and a corridor gets one opening (DOORWAY 60%,
//   2-cell OPEN gap 25% on runs >= 3, HEADER otherwise); the rest of the run is CMU wall.
// - Loading drop (20% of utility rooms whose split half has no corridor contact): half the room drops 1.0 m, the
//   split line is a HALF edge (the parapet reads as the rail) with a 1-cell-wide, 2-cell-long stair ramp at one end,
//   HALF side rails, a yellow safety stripe along the edge and pallets / crates in the bay.
// - Walls: every open/solid and room/corridor boundary is a CMU_PAINTED WALL with the WAINSCOT trim bit (two-tone).
// - Lights: TUBE_STRIP battens along corridor centre lines every 4 cells (long axis along the corridor), CAGE_BULBs
//   on a 3-cell grid in rooms (and in loading bays).
// - Props: CRATE / PALLET clusters in rooms (+ rule-driven EXTINGUISHER / BUCKET / TRASH_CAN / CARDBOARD_BOX).
// - Emitters: VENT (1–2 per chunk), MACHINE hum in some rooms, DRIP where humid.
// Seams: 3–4 corridor-width ports (1–3 cells) per line, WALL elsewhere, no WALL run longer than 12.
// R2 (docs/contract-changes/R2-architecture.md):
// - Split-level machine hall (districts with hash < 0.3, p 0.5 per chunk): one extra-large utility room (hall
//   8-10 x 10-12 + a 1-cell gallery ring) whose interior drops 3.0 / 4.5 m under the room's 3.3-3.6 m ceiling:
//   HALF parapet + handrail, a concrete stair along one side, CMU columns, pendants lit from below, pallets below;
// - 35% of the DOORWAYs get metal door leaves (structures/doors.ts); zone-transition connectors on boundaries.

import { CELL, CHUNK_CELL_COUNT, WALL_T } from '../../core/constants.ts';
import { cellIdx } from '../../core/grid.ts';
import {
  CeilKind, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, Mat, PropKind, Zone, type PropKindId, type StoreyId,
} from '../../core/ids.ts';
import { hash01, hash3, hash5, Rng, SALT, type Rng as RngT } from '../../core/rng.ts';
import { hangDoors } from '../structures/doors.ts';
import { buildSplitHall } from '../structures/splitLevel.ts';
import { transitionStamps } from '../structures/transitions.ts';
import { restore, snapshot, unreachedWalkable } from '../structures/util.ts';
import type { DistrictInfo, LightingProfile, SeamEdges, ZoneGenContext, ZoneGenerator, ZonePalette } from '../../core/world.ts';
import {
  applyMass, bulbSpec, carveToOpen, createFixturePlacer, downRectSpec, DX, DZ, entryCells, fieldAt, HALF_PI, inChunk,
  isReservedCell, kindWalkable, longestWallRun, N, paintStripe, sideHA, sideKind, WALK_FLAGS,
} from './deepcommon.ts';

const TAG = Zone.CONCRETE * 16;
const PITCH = 6;
const NODES = 5; // lattice nodes per axis (3, 9, 15, 21, 27 + jitter)
const EXTRA_P = 0.25;
const ROOM_P = 0.2;
const LOADING_P = 0.2;
const DROP_CM = 100;
const CEIL_CM = 300;
const TUBE_EVERY = 4;
const TUBE_CCT: readonly [number, number] = [3900, 4400];
const BULB_CCT: readonly [number, number] = [2700, 3000];
const BULB_CD = 110;
const MIN_WALK = 0.5; // extra utility rooms are grown while the carved fraction is below this
const SAFETY: readonly [number, number, number] = [1.0, 0.72, 0.06];
const WALL_OPTS = { matNeg: Mat.CMU_PAINTED, matPos: Mat.CMU_PAINTED, trim: EdgeTrim.WAINSCOT };
export const HALL_DISTRICT_P = 0.3;
export const HALL_CHUNK_P = 0.5;
export const CONCRETE_DOOR_P = 0.35;

interface Node { i: number; j: number; w: number; entry: boolean; axis: 0 | 1 } // axis: first leg of corridors from an entry
interface Edge { a: number; b: number; wt: number }
interface Room {
  i0: number; j0: number; i1: number; j1: number; ceil: number;
  /** R2: split-level machine hall (the inset rect drops) */
  hall?: boolean;
  /** loading drop: lower half rect and the stair */
  drop: { i0: number; j0: number; i1: number; j1: number; axis: 0 | 1; lowSide: -1 | 1 } | null;
}

/** 3–4 corridor-width ports per seam line; no WALL run longer than 12. */
function seamPattern(rng: RngT, _d: DistrictInfo): SeamEdges {
  const kind = new Uint8Array(N).fill(EdgeKind.WALL);
  let pos = rng.int(2, 6);
  while (pos < N - 2) {
    const w = 1 + rng.weighted([0.45, 0.4, 0.15]);
    for (let c = pos; c < pos + w && c < N - 1; c++) kind[c] = EdgeKind.OPEN;
    pos += w + rng.int(5, 10);
  }
  while (longestWallRun(kind) > 12) { // cannot happen with the spacing above; kept as a guard
    let run = 0;
    for (let c = 0; c < N; c++) {
      run = kind[c] === EdgeKind.WALL ? run + 1 : 0;
      if (run > 12) { kind[c - 6] = EdgeKind.OPEN; break; }
    }
  }
  return { kind, hA: new Int16Array(N), hB: new Int16Array(N) };
}

function generate(ctx: ZoneGenContext): void {
  const g = ctx.grid, l = g.layout;
  const rng = ctx.rng;
  const gi0 = g.gi0, gj0 = g.gj0;
  const reserved = (c: number): boolean => isReservedCell(l, c);
  const open = new Uint8Array(CHUNK_CELL_COUNT);
  const corrAxis = new Uint8Array(CHUNK_CELL_COUNT); // bit 1: carved by an x-running leg, bit 2: z-running leg
  const roomOf = new Int16Array(CHUNK_CELL_COUNT).fill(-1);
  const placer = createFixturePlacer(ctx);

  // ---------------------------------------------------------------- nodes
  const nodes: Node[] = [];
  const lattice: number[] = new Array(NODES * NODES).fill(-1); // node index per lattice slot
  for (let b = 0; b < NODES; b++) {
    for (let a = 0; a < NODES; a++) {
      let i = 3 + PITCH * a + rng.int(-1, 1), j = 3 + PITCH * b + rng.int(-1, 1);
      // a node on a stamp moves to the nearest free cell within 2 cells, or is dropped
      if (reserved(cellIdx(i, j))) {
        let best = -1, bd = 99;
        for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
          const ni = i + di, nj = j + dj;
          if (!inChunk(ni, nj) || reserved(cellIdx(ni, nj))) continue;
          const d = Math.abs(di) + Math.abs(dj);
          if (d < bd) { bd = d; best = cellIdx(ni, nj); }
        }
        if (best < 0) continue;
        i = best & 31; j = best >> 5;
      }
      lattice[b * NODES + a] = nodes.length;
      nodes.push({ i, j, w: 1, entry: false, axis: 0 });
    }
  }
  const nLattice = nodes.length;
  // entries: maximal runs of entry cells along one border line / stamp side collapse into one node of that width
  const entries = entryCells(l);
  const isEntry = new Uint8Array(CHUNK_CELL_COUNT);
  for (const c of entries) isEntry[c] = 1;
  // out direction of each entry: the side whose passable edge leads out of the chunk / into the stamp
  const outDir = new Int8Array(CHUNK_CELL_COUNT).fill(-1);
  for (const c of entries) {
    const li = c & 31, lj = c >> 5;
    for (let d = 0; d < 4 && outDir[c] < 0; d++) {
      if (!kindWalkable(sideKind(l, li, lj, d), sideHA(l, li, lj, d))) continue;
      const ni = li + DX[d], nj = lj + DZ[d];
      if (!inChunk(ni, nj) || reserved(cellIdx(ni, nj))) outDir[c] = d;
    }
  }
  const taken = new Uint8Array(CHUNK_CELL_COUNT);
  for (const c of entries) {
    if (taken[c] || outDir[c] < 0) continue;
    const li = c & 31, lj = c >> 5;
    const legX = outDir[c] < 2; // the first leg runs perpendicular to the opening, away from it
    const step = legX ? N : 1; // the run of entry cells extends along the opening
    let w = 1;
    while (w < 3) {
      const ni = legX ? li : li + w, nj = legX ? lj + w : lj;
      if (!inChunk(ni, nj)) break;
      const n = cellIdx(ni, nj);
      if (!isEntry[n] || taken[n] || outDir[n] !== outDir[c]) break;
      w++;
    }
    for (let k = 0; k < w; k++) taken[c + step * k] = 1;
    nodes.push({ i: li, j: lj, w, entry: true, axis: legX ? 0 : 1 });
  }

  // ---------------------------------------------------------------- graph: MST + 25% extra edges
  const edges: Edge[] = [];
  for (let b = 0; b < NODES; b++) {
    for (let a = 0; a < NODES; a++) {
      const n = lattice[b * NODES + a];
      if (n < 0) continue;
      if (a + 1 < NODES && lattice[b * NODES + a + 1] >= 0) edges.push({ a: n, b: lattice[b * NODES + a + 1], wt: rng.float() });
      if (b + 1 < NODES && lattice[(b + 1) * NODES + a] >= 0) edges.push({ a: n, b: lattice[(b + 1) * NODES + a], wt: rng.float() });
    }
  }
  for (let e = nLattice; e < nodes.length; e++) {
    const en = nodes[e];
    let best = -1, second = -1, bd = 1e9, sd = 1e9;
    for (let n = 0; n < nLattice; n++) {
      const d = Math.abs(nodes[n].i - en.i) + Math.abs(nodes[n].j - en.j);
      if (d < bd) { second = best; sd = bd; best = n; bd = d; } else if (d < sd) { second = n; sd = d; }
    }
    if (best >= 0) edges.push({ a: e, b: best, wt: -1 }); // always in the tree
    if (second >= 0 && rng.chance(EXTRA_P)) edges.push({ a: e, b: second, wt: 2 });
  }
  edges.sort((x, y) => x.wt - y.wt);
  const parent = nodes.map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const chosen: Edge[] = [];
  const rest: Edge[] = [];
  for (const e of edges) {
    const ra = find(e.a), rb = find(e.b);
    if (ra !== rb) { parent[ra] = rb; chosen.push(e); } else rest.push(e);
  }
  for (const e of rest) if (e.wt <= 1 ? rng.chance(EXTRA_P) : true) chosen.push(e);

  // ---------------------------------------------------------------- corridors
  const markOpen = (i: number, j: number, axisBit: number): void => {
    if (!inChunk(i, j)) return;
    const c = cellIdx(i, j);
    if (reserved(c)) return;
    open[c] = 1;
    corrAxis[c] |= axisBit;
  };
  const rectFree = (i0: number, j0: number, i1: number, j1: number): boolean => {
    for (let j = Math.max(0, j0); j < Math.min(N, j1); j++) for (let i = Math.max(0, i0); i < Math.min(N, i1); i++) if (reserved(cellIdx(i, j))) return false;
    return true;
  };
  /** Horizontal leg on rows [j, j+w) from column x0 to x1 (inclusive, extended by w-1 to fill the corner). */
  const legX = (x0: number, x1: number, j: number, w: number, test: boolean): boolean => {
    const a = Math.min(x0, x1), b = Math.max(x0, x1) + w - 1;
    if (test) return rectFree(a, j, b + 1, j + w);
    for (let jj = j; jj < j + w; jj++) for (let i = a; i <= b; i++) markOpen(i, jj, 1);
    return true;
  };
  const legZ = (z0: number, z1: number, i: number, w: number, test: boolean): boolean => {
    const a = Math.min(z0, z1), b = Math.max(z0, z1) + w - 1;
    if (test) return rectFree(i, a, i + w, b + 1);
    for (let j = a; j <= b; j++) for (let ii = i; ii < i + w; ii++) markOpen(ii, j, 2);
    return true;
  };
  const clampW = (v: number, w: number): number => Math.max(0, Math.min(N - w, v));
  const prev = new Int32Array(CHUNK_CELL_COUNT), queue = new Int32Array(CHUNK_CELL_COUNT);
  const bfsPath = (from: number, to: number): number[] | null => {
    prev.fill(-2);
    let qh = 0, qt = 0;
    queue[qt++] = from;
    prev[from] = -1;
    while (qh < qt) {
      const c = queue[qh++];
      if (c === to) break;
      const li = c & 31, lj = c >> 5;
      for (let d = 0; d < 4; d++) {
        const ni = li + DX[d], nj = lj + DZ[d];
        if (!inChunk(ni, nj)) continue;
        const n = cellIdx(ni, nj);
        if (prev[n] !== -2 || reserved(n)) continue;
        prev[n] = c;
        queue[qt++] = n;
      }
    }
    if (prev[to] === -2) return null;
    const out: number[] = [];
    for (let c = to; c >= 0; c = prev[c]) out.push(c);
    return out;
  };
  const segments: { i0: number; j0: number; i1: number; j1: number; axis: 0 | 1 }[] = []; // corridor legs (for lights)
  for (const e of chosen) {
    let A = nodes[e.a], B = nodes[e.b];
    if (B.entry && !A.entry) { const t = A; A = B; B = t; }
    const w = A.entry ? A.w : 1 + rng.weighted([0.45, 0.4, 0.15]);
    const firstX = A.entry ? A.axis === 0 : rng.chance(0.5);
    // leg geometry: the corridor band starts at the node cell and extends toward +perp by w - 1
    const ai = clampW(A.i, A.entry && A.axis === 1 ? A.w : 1), aj = clampW(A.j, A.entry && A.axis === 0 ? A.w : 1);
    const bi = clampW(B.i, w), bj = clampW(B.j, w);
    const tryL = (xFirst: boolean, test: boolean): boolean => {
      if (xFirst) {
        const j = A.entry && A.axis === 0 ? aj : clampW(aj, w);
        return legX(ai, bi, j, A.entry && A.axis === 0 ? A.w : w, test) && legZ(j, bj, bi, w, test);
      }
      const i = A.entry && A.axis === 1 ? ai : clampW(ai, w);
      return legZ(aj, bj, i, A.entry && A.axis === 1 ? A.w : w, test) && legX(i, bi, bj, w, test);
    };
    let done = false;
    for (const xFirst of [firstX, !firstX]) {
      if (A.entry && xFirst !== firstX) break; // entries leave straight inward or not at all
      if (tryL(xFirst, true)) {
        tryL(xFirst, false);
        const j = xFirst ? (A.entry && A.axis === 0 ? aj : clampW(aj, w)) : bj;
        const i = xFirst ? bi : (A.entry && A.axis === 1 ? ai : clampW(ai, w));
        if (xFirst) {
          segments.push({ i0: Math.min(ai, bi), j0: j, i1: Math.max(ai, bi) + w, j1: j + w, axis: 0 });
          segments.push({ i0: bi, j0: Math.min(j, bj), i1: bi + w, j1: Math.max(j, bj) + w, axis: 1 });
        } else {
          segments.push({ i0: i, j0: Math.min(aj, bj), i1: i + w, j1: Math.max(aj, bj) + w, axis: 1 });
          segments.push({ i0: Math.min(i, bi), j0: bj, i1: Math.max(i, bi) + w, j1: bj + w, axis: 0 });
        }
        done = true;
        break;
      }
    }
    if (done) continue;
    const path = bfsPath(cellIdx(A.i, A.j), cellIdx(B.i, B.j));
    if (path && path.length <= 3 * (Math.abs(A.i - B.i) + Math.abs(A.j - B.j)) + 4) {
      for (const c of path) markOpen(c & 31, c >> 5, 3);
    }
  }
  for (const n of nodes) markOpen(n.i, n.j, 3);

  // ---------------------------------------------------------------- utility rooms
  const rooms: Room[] = [];
  const tryRoom = (n: Node, r: RngT): boolean => {
    let w = r.int(4, 6), d = r.int(4, 8);
    if (r.chance(0.5)) { const t = w; w = d; d = t; }
    for (let attempt = 0; attempt < 4; attempt++) {
      const i0 = Math.max(1, Math.min(N - 1 - w, n.i - r.int(1, w - 2)));
      const j0 = Math.max(1, Math.min(N - 1 - d, n.j - r.int(1, d - 2)));
      const i1 = i0 + w, j1 = j0 + d;
      if (n.i < i0 || n.i >= i1 || n.j < j0 || n.j >= j1) continue;
      let ok = true;
      for (let j = j0 - 1; j <= j1 && ok; j++) for (let i = i0 - 1; i <= i1 && ok; i++) {
        if (!inChunk(i, j)) continue;
        const c = cellIdx(i, j);
        if (reserved(c) || roomOf[c] >= 0 || isEntry[c]) ok = false;
      }
      if (!ok) continue;
      const id = rooms.length;
      rooms.push({ i0, j0, i1, j1, ceil: CEIL_CM + 30 * r.int(0, 2), drop: null });
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) { const c = cellIdx(i, j); roomOf[c] = id; open[c] = 1; corrAxis[c] = 0; }
      return true;
    }
    return false;
  };
  const roomRng = rng.fork(0x7007);
  // R2: one split-level machine hall first (it needs the room), in hall districts
  const hallRng = rng.fork(0x4a11);
  if (hash01(hash3(ctx.seed, ctx.district.id, 0x4a11)) < HALL_DISTRICT_P && hallRng.chance(HALL_CHUNK_P) && ctx.key.s !== 2) {
    const order0 = Array.from({ length: nLattice }, (_, k) => k);
    hallRng.shuffle(order0);
    for (const k of order0) {
      const n = nodes[k];
      const hw = hallRng.int(8, 10), hd = hallRng.int(10, 12);
      const alongX = hallRng.chance(0.5);
      const w = (alongX ? hd : hw) + 2, d = (alongX ? hw : hd) + 2;
      const i0 = Math.max(1, Math.min(N - 1 - w, n.i - (w >> 1))), j0 = Math.max(1, Math.min(N - 1 - d, n.j - (d >> 1)));
      let ok = true;
      for (let j = j0 - 1; j <= j0 + d && ok; j++) for (let i = i0 - 1; i <= i0 + w && ok; i++) {
        if (!inChunk(i, j)) { ok = false; continue; }
        const c = cellIdx(i, j);
        if (reserved(c) || roomOf[c] >= 0 || isEntry[c]) ok = false;
      }
      if (!ok) continue;
      const id = rooms.length;
      rooms.push({ i0, j0, i1: i0 + w, j1: j0 + d, ceil: CEIL_CM + 30 * hallRng.int(1, 2), drop: null, hall: true });
      for (let j = j0; j < j0 + d; j++) for (let i = i0; i < i0 + w; i++) { const c = cellIdx(i, j); roomOf[c] = id; open[c] = 1; corrAxis[c] = 0; }
      break;
    }
  }
  for (let k = 0; k < nLattice; k++) if (roomRng.chance(ROOM_P)) tryRoom(nodes[k], roomRng);
  // density guarantee: grow extra rooms while the carved area is thin
  const fraction = (): number => { let n = 0; for (let c = 0; c < CHUNK_CELL_COUNT; c++) if (open[c] && !reserved(c)) n++; return n / CHUNK_CELL_COUNT; };
  let freeCells = 0;
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) if (!reserved(c)) freeCells++;
  const target = MIN_WALK * freeCells / CHUNK_CELL_COUNT;
  const order = Array.from({ length: nLattice }, (_, k) => k);
  roomRng.shuffle(order);
  for (const k of order) {
    if (fraction() >= target) break;
    const n = nodes[k];
    if (roomOf[cellIdx(n.i, n.j)] >= 0) continue;
    tryRoom(n, roomRng);
  }

  // ---------------------------------------------------------------- connect entries, write the mass
  for (const c of entries) { open[c] = 1; carveToOpen(l, open, c, prev, queue); }
  // corridor cells of a room that the connectors re-opened stay room cells; a connector may have carved through a
  // room's margin — that is just more corridor
  applyMass(g, open, WALL_OPTS);

  // ---------------------------------------------------------------- room walls, openings, loading drops
  const contactOut = (li: number, lj: number, d: number): boolean => {
    const ni = li + DX[d], nj = lj + DZ[d];
    if (!inChunk(ni, nj)) return false;
    const n = cellIdx(ni, nj);
    return open[n] === 1 && roomOf[n] !== roomOf[cellIdx(li, lj)];
  };
  // decide loading drops first (the lower half must have no contact)
  let dropToken = 0;
  for (const r of rooms) {
    if (r.hall) continue;
    if (roomRng.chance(LOADING_P)) dropToken++;
    if (dropToken === 0) continue;
    const opts: { axis: 0 | 1; lowSide: -1 | 1 }[] = [];
    for (const axis of [0, 1] as const) {
      const len = axis === 0 ? r.i1 - r.i0 : r.j1 - r.j0;
      if (len < 6) continue;
      for (const lowSide of [-1, 1] as const) opts.push({ axis, lowSide });
    }
    roomRng.shuffle(opts);
    for (const o of opts) {
      const len = o.axis === 0 ? r.i1 - r.i0 : r.j1 - r.j0;
      const half = len >> 1;
      const lo = o.axis === 0
        ? (o.lowSide < 0 ? { i0: r.i0, j0: r.j0, i1: r.i0 + half, j1: r.j1 } : { i0: r.i1 - half, j0: r.j0, i1: r.i1, j1: r.j1 })
        : (o.lowSide < 0 ? { i0: r.i0, j0: r.j0, i1: r.i1, j1: r.j0 + half } : { i0: r.i0, j0: r.j1 - half, i1: r.i1, j1: r.j1 });
      let contact = false;
      for (let j = lo.j0; j < lo.j1 && !contact; j++) for (let i = lo.i0; i < lo.i1 && !contact; i++) {
        for (let d = 0; d < 4; d++) if (contactOut(i, j, d)) contact = true;
      }
      if (contact) continue;
      r.drop = { ...lo, axis: o.axis, lowSide: o.lowSide };
      dropToken--;
      break;
    }
  }
  for (let id = 0; id < rooms.length; id++) {
    const r = rooms[id];
    g.setCells(r.i0, r.j0, r.i1, r.j1, { ceilCm: r.ceil });
    // contact runs on each of the 4 sides
    for (let d = 0; d < 4; d++) {
      const alongX = d >= 2; // sides 2/3 (±z) run along x
      const a0 = alongX ? r.i0 : r.j0, a1 = alongX ? r.i1 : r.j1;
      const fixed = d === 0 ? r.i1 - 1 : d === 1 ? r.i0 : d === 2 ? r.j1 - 1 : r.j0;
      let runStart = -1;
      for (let a = a0; a <= a1; a++) {
        const li = alongX ? a : fixed, lj = alongX ? fixed : a;
        const c = a < a1 && contactOut(li, lj, d);
        if (c && runStart < 0) runStart = a;
        if (c || runStart < 0) continue;
        // run [runStart, a): walls, then one opening
        const len = a - runStart;
        const side = (k: number, kind: number, o: object): void => {
          const i = alongX ? k : fixed, j = alongX ? fixed : k;
          if (d === 0) g.setEdge('x', i + 1, j, kind, o);
          else if (d === 1) g.setEdge('x', i, j, kind, o);
          else if (d === 2) g.setEdge('z', i, j + 1, kind, o);
          else g.setEdge('z', i, j, kind, o);
        };
        for (let k = runStart; k < a; k++) side(k, EdgeKind.WALL, WALL_OPTS);
        const u = roomRng.float();
        const mid = runStart + ((len - 1) >> 1);
        if (len >= 3 && u < 0.25) {
          side(mid, EdgeKind.OPEN, WALL_OPTS);
          side(mid + 1, EdgeKind.OPEN, WALL_OPTS);
        } else if (u < 0.4) {
          side(mid, EdgeKind.HEADER, { ...WALL_OPTS, hA: 220 });
        } else {
          side(mid, EdgeKind.DOORWAY, { ...WALL_OPTS, hA: 210, trim: EdgeTrim.WAINSCOT | EdgeTrim.CASING });
        }
        runStart = -1;
      }
    }
    if (r.drop) buildDrop(ctx, r, placer, roomRng);
  }
  // R2: split-level halls (after the room walls, so the gallery ring keeps its doors)
  const hallInfo: { r: Room; stair: [number, number, number, number] }[] = [];
  for (const r of rooms) {
    if (!r.hall) continue;
    const hi0 = r.i0 + 1, hj0 = r.j0 + 1, hi1 = r.i1 - 1, hj1 = r.j1 - 1;
    const snap = snapshot(l);
    const seen = new Uint8Array(N * N);
    const base0 = unreachedWalkable(l, seen);
    const alongZ = hj1 - hj0 >= hi1 - hi0;
    const depth = hallRng.chance(0.6) ? 300 : 450;
    const info = buildSplitHall(ctx, {
      i0: hi0, j0: hj0, i1: hi1, j1: hj1, depthCm: depth, stairAxis: alongZ ? 'z' : 'x', stairSide: hallRng.chance(0.5) ? -1 : 1,
      stairHead: hallRng.chance(0.5) ? -1 : 1, stairW: 2, stairL: depth > 300 ? 7 : 5,
      wallMat: Mat.CMU_PAINTED, stairMat: Mat.CONCRETE_FLOOR, parapetMat: Mat.CMU_PAINTED, columns: hallRng.chance(0.7),
      pendant: { kind: FixtureKind.PENDANT_LINEAR, luminance: 7000, cct: [3900, 4300], w: 1.2, h: 0.2 },
    });
    if (unreachedWalkable(l, seen) > base0) { restore(l, snap); r.hall = false; continue; }
    hallInfo.push({ r, stair: info.stair });
    // a safety stripe along the parapet foot on the gallery, pallets on the hall floor
    const low = -depth / 100;
    for (let k = 0; k < hallRng.int(3, 6); k++) {
      const li = hallRng.int(hi0 + 1, hi1 - 2), lj = hallRng.int(hj0 + 1, hj1 - 2);
      const [a0, b0, a1, b1] = info.stair;
      if (li >= a0 - 1 && li <= a1 && lj >= b0 - 1 && lj <= b1) continue;
      if (l.flags[cellIdx(li, lj)] & 1) continue;
      const x = (li + 0.5) * CELL, z = (lj + 0.5) * CELL, yaw = hallRng.chance(0.5) ? 0 : HALF_PI;
      g.addProp({ kind: PropKind.PALLET, variant: hallRng.int(0, 2), x, y: low, z, yaw, scale: 1, flags: 0, seed: hallRng.next() });
      if (hallRng.chance(0.6)) g.addProp({ kind: hallRng.chance(0.6) ? PropKind.CRATE : PropKind.CARDBOARD_BOX, variant: hallRng.int(0, 2), x, y: low + 0.15, z, yaw, scale: 1, flags: 0, seed: hallRng.next() });
    }
  }

  // ---------------------------------------------------------------- lights
  const lit = new Uint8Array(CHUNK_CELL_COUNT);
  const crowded = (li: number, lj: number, rad: number): boolean => {
    for (let dj = -rad; dj <= rad; dj++) for (let di = -rad; di <= rad; di++) {
      if (inChunk(li + di, lj + dj) && lit[cellIdx(li + di, lj + dj)]) return true;
    }
    return false;
  };
  const corridorCell = (li: number, lj: number): boolean => {
    if (!inChunk(li, lj)) return false;
    const c = cellIdx(li, lj);
    return open[c] === 1 && roomOf[c] < 0 && !reserved(c);
  };
  // tubes: along each corridor leg's centre line, every TUBE_EVERY cells (world-anchored phase)
  const tubePhase = ctx.district.params.tubePhase ?? 0;
  segments.sort((p, q) => (p.i1 - p.i0) * (p.j1 - p.j0) - (q.i1 - q.i0) * (q.j1 - q.j0) || p.i0 - q.i0 || p.j0 - q.j0);
  for (let s = segments.length - 1; s >= 0; s--) {
    const sg = segments[s];
    const alongX = sg.axis === 0;
    const len = alongX ? sg.i1 - sg.i0 : sg.j1 - sg.j0;
    const wid = alongX ? sg.j1 - sg.j0 : sg.i1 - sg.i0;
    if (len < 3) continue;
    const a0 = alongX ? sg.i0 : sg.j0;
    const gA = alongX ? gi0 : gj0;
    for (let a = a0 + 1; a < a0 + len - 1; a++) {
      if (((gA + a + tubePhase) % TUBE_EVERY + TUBE_EVERY) % TUBE_EVERY !== 1) continue;
      const pm = (alongX ? sg.j0 : sg.i0) + wid / 2; // perpendicular centre (cells)
      const pc = Math.floor(pm - 0.001 + (wid % 2 === 1 ? 0.001 : 0));
      const li = alongX ? a : pc, lj = alongX ? pc : a;
      if (!corridorCell(li, lj)) continue;
      // the band across the corridor must be carved (no wall crossing the tube's cell)
      if (crowded(li, lj, 2)) continue;
      const c = cellIdx(li, lj);
      const x = alongX ? (li + 0.5) * CELL : pm * CELL, z = alongX ? pm * CELL : (lj + 0.5) * CELL;
      const ceilY = l.ceilCm[c] / 100;
      if (placer.add(downRectSpec(FixtureKind.TUBE_STRIP, x, ceilY - 0.06, z, alongX, 1.2, 0.1, 8600, TUBE_CCT, 0.6)) >= 0) lit[c] = 1;
    }
  }
  // corridor stretches the legs missed (connectors, BFS routes): one tube per unlit 4-cell neighbourhood
  for (let lj = 1; lj < N - 1; lj++) {
    for (let li = 1; li < N - 1; li++) {
      if (!corridorCell(li, lj) || crowded(li, lj, 3)) continue;
      const xRun = corridorCell(li - 1, lj) && corridorCell(li + 1, lj);
      const zRun = corridorCell(li, lj - 1) && corridorCell(li, lj + 1);
      if (!xRun && !zRun) continue;
      const c = cellIdx(li, lj);
      const alongX = xRun && (!zRun || (li + lj) % 2 === 0);
      if (placer.add(downRectSpec(FixtureKind.TUBE_STRIP, (li + 0.5) * CELL, l.ceilCm[c] / 100 - 0.06, (lj + 0.5) * CELL, alongX, 1.2, 0.1, 8600, TUBE_CCT, 0.6)) >= 0) lit[c] = 1;
    }
  }
  // rooms: cage bulbs on a ~3-cell grid
  for (const r of rooms) {
    const w = r.i1 - r.i0, d = r.j1 - r.j0;
    const nx = Math.max(1, Math.round(w / 3)), nz = Math.max(1, Math.round(d / 3));
    for (let b = 0; b < nz; b++) {
      for (let a = 0; a < nx; a++) {
        const x = (r.i0 + w * (a + 0.5) / nx) * CELL, z = (r.j0 + d * (b + 0.5) / nz) * CELL;
        const li = Math.floor(x / CELL), lj = Math.floor(z / CELL);
        const c = cellIdx(li, lj);
        if (placer.add(bulbSpec(x, l.ceilCm[c] / 100 - 0.3, z, BULB_CD, BULB_CCT, 0.25)) >= 0) lit[c] = 1;
      }
    }
  }

  // ---------------------------------------------------------------- props: crate / pallet clusters in rooms
  for (let id = 0; id < rooms.length; id++) {
    const r = rooms[id];
    const pr = new Rng(hash5(ctx.seed, SALT.PROP, TAG + 1, gi0 + r.i0, gj0 + r.j0));
    if (r.hall || !pr.chance(0.55)) continue;
    // a corner of the (upper) floor: both outer sides WALL, both inner sides plain room floor
    const fl = r.drop ? upperRect(r) : r;
    const corners: [number, number, 1 | -1, 1 | -1][] = [[fl.i0, fl.j0, 1, 1], [fl.i1 - 1, fl.j0, -1, 1], [fl.i0, fl.j1 - 1, 1, -1], [fl.i1 - 1, fl.j1 - 1, -1, -1]];
    pr.shuffle(corners);
    for (const [ci, cj, sx, sz] of corners) {
      const outX = sx > 0 ? 1 : 0, outZ = sz > 0 ? 3 : 2; // sides toward the corner's walls
      if (sideKind(l, ci, cj, outX) !== EdgeKind.WALL || sideKind(l, ci, cj, outZ) !== EdgeKind.WALL) continue;
      if (sideKind(l, ci, cj, outX ^ 1) !== EdgeKind.OPEN || sideKind(l, ci, cj, outZ ^ 1) !== EdgeKind.OPEN) continue;
      // may the cluster spill one cell along the x / z wall?
      const spillX = inChunk(ci + sx, cj) && roomOf[cellIdx(ci + sx, cj)] === id && sideKind(l, ci + sx, cj, outZ) === EdgeKind.WALL;
      const spillZ = inChunk(ci, cj + sz) && roomOf[cellIdx(ci, cj + sz)] === id && sideKind(l, ci, cj + sz, outX) === EdgeKind.WALL;
      clusterAt(g, ci, cj, sx, sz, l.floorCm[cellIdx(ci, cj)] / 100, spillX, spillZ, pr);
      break;
    }
  }

  // ---------------------------------------------------------------- emitters
  const er = new Rng(hash5(ctx.seed, SALT.EMITTER, TAG, ctx.key.cx, ctx.key.cz));
  const openCells: number[] = [];
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) if (open[c] && !reserved(c)) openCells.push(c);
  if (openCells.length) {
    const nv = er.int(1, 2);
    for (let k = 0; k < nv; k++) {
      const c = openCells[er.int(0, openCells.length - 1)];
      g.addEmitter(EmitterKind.VENT, ((c & 31) + 0.5) * CELL, l.ceilCm[c] / 100 - 0.1, ((c >> 5) + 0.5) * CELL, 0.25 + 0.15 * er.float());
    }
    for (let k = 0; k < 2; k++) {
      const c = openCells[er.int(0, openCells.length - 1)];
      if (fieldAt(l.humidity, c) > 0.6) g.addEmitter(EmitterKind.DRIP, ((c & 31) + 0.5) * CELL, l.ceilCm[c] / 100 - 0.02, ((c >> 5) + 0.5) * CELL, 0.3);
    }
  }
  for (const r of rooms) {
    if (!er.chance(0.3)) continue;
    const fl = r.drop ? upperRect(r) : r;
    g.addEmitter(EmitterKind.MACHINE, (fl.i0 + fl.i1) / 2 * CELL, r.hall ? 1.0 - 3.0 : 1.0, (fl.j0 + fl.j1) / 2 * CELL, 0.3);
  }
  void hallInfo;
  // R2: metal door leaves, zone transitions
  hangDoors(ctx, { p: CONCRETE_DOOR_P, variant: () => 2, tag: TAG + 3 });
  transitionStamps(ctx, null);
}

/** The part of a loading room that stays at floor level. */
function upperRect(r: Room): { i0: number; j0: number; i1: number; j1: number } {
  const d = r.drop!;
  if (d.axis === 0) return d.lowSide < 0 ? { i0: d.i1, j0: r.j0, i1: r.i1, j1: r.j1 } : { i0: r.i0, j0: r.j0, i1: d.i0, j1: r.j1 };
  return d.lowSide < 0 ? { i0: r.i0, j0: d.j1, i1: r.i1, j1: r.j1 } : { i0: r.i0, j0: r.j0, i1: r.i1, j1: d.j0 };
}

/** Loading drop: lower half −1.0 m, HALF parapet on the split line, a 1 × 2-cell stair at one end with side rails,
 * a safety stripe on the upper edge and stock in the bay. */
function buildDrop(ctx: ZoneGenContext, r: Room, placer: ReturnType<typeof createFixturePlacer>, rng: RngT): void {
  const g = ctx.grid;
  const d = r.drop!;
  g.setCells(d.i0, d.j0, d.i1, d.j1, { floorCm: -DROP_CM });
  // split line: axis 0 => an x line (x = const) between the halves, running along z
  const line = d.axis === 0 ? (d.lowSide < 0 ? d.i1 : d.i0) : (d.lowSide < 0 ? d.j1 : d.j0);
  const b0 = d.axis === 0 ? d.j0 : d.i0, b1 = d.axis === 0 ? d.j1 : d.i1;
  const stairB = rng.chance(0.5) ? b0 : b1 - 1; // stair column/row along the split line
  const railO = { ...WALL_OPTS, trim: 0 };
  for (let b = b0; b < b1; b++) {
    const kind = b === stairB ? EdgeKind.OPEN : EdgeKind.HALF;
    const o = kind === EdgeKind.HALF ? { ...railO, hA: 105 } : railO;
    if (d.axis === 0) g.setEdge('x', line, b, kind, o);
    else g.setEdge('z', b, line, kind, o);
  }
  // stair: 2 cells deep into the lower half, ascending toward the split line
  const inward = -d.lowSide; // direction (along the split axis) from the lower half toward the line
  const lowCell = d.lowSide < 0 ? line - 1 : line; // lower-half cell adjacent to the line
  const farCell = lowCell - inward; // second stair cell
  const s0 = Math.min(lowCell, farCell), s1 = Math.max(lowCell, farCell) + 1;
  const dir: 0 | 1 | 2 | 3 = d.axis === 0 ? (inward > 0 ? 0 : 1) : (inward > 0 ? 2 : 3);
  const x0 = d.axis === 0 ? s0 * CELL : stairB * CELL, x1 = d.axis === 0 ? s1 * CELL : (stairB + 1) * CELL;
  const z0 = d.axis === 0 ? stairB * CELL : s0 * CELL, z1 = d.axis === 0 ? (stairB + 1) * CELL : s1 * CELL;
  g.addSolid({ kind: 'ramp', x0, z0, x1, z1, y0: -DROP_CM / 100, y1: 0, dir, steps: 6, mat: Mat.CONCRETE_FLOOR, flags: WALK_FLAGS, bakeGroup: 0 });
  // side rail on the open side of the stair (the other side is the room wall or the bay)
  const sideB = stairB === b0 ? stairB + 1 : stairB; // line between the stair column and the bay
  for (const cellA of [lowCell, farCell]) {
    const top = cellA === lowCell ? 100 : 50; // 1 m above the stair's high end in that cell
    if (d.axis === 0) g.setEdge('z', cellA, sideB, EdgeKind.HALF, { ...railO, hA: top });
    else g.setEdge('x', sideB, cellA, EdgeKind.HALF, { ...railO, hA: top });
  }
  // safety stripe along the upper edge of the drop
  const upperOff = 0.12 * inward; // on the upper side of the line
  const lineM = line * CELL + upperOff;
  const sA = (stairB === b0 ? b0 + 1 : b0) * CELL, sB = (stairB === b0 ? b1 : b1 - 1) * CELL;
  if (sB - sA > 0.5) {
    if (d.axis === 0) paintStripe(g, lineM, 0, (sA + sB) / 2, false, sB - sA, 0.1, SAFETY, 0.85);
    else paintStripe(g, (sA + sB) / 2, 0, lineM, true, sB - sA, 0.1, SAFETY, 0.85);
  }
  // stock in the bay: 2–4 pallets (some with a crate) along the far wall
  const n = rng.int(2, 4);
  const farRow = d.lowSide < 0 ? (d.axis === 0 ? d.i0 : d.j0) : (d.axis === 0 ? d.i1 - 1 : d.j1 - 1);
  const used = new Set<number>();
  for (let k = 0; k < n; k++) {
    const b = rng.int(b0, b1 - 1);
    if (used.has(b) || (b === stairB)) continue;
    used.add(b);
    const cx = d.axis === 0 ? (farRow + 0.5) * CELL : (b + 0.5) * CELL, cz = d.axis === 0 ? (b + 0.5) * CELL : (farRow + 0.5) * CELL;
    const yaw = d.axis === 0 ? HALF_PI : 0;
    g.addProp({ kind: PropKind.PALLET, variant: rng.int(0, 2), x: cx, y: -DROP_CM / 100, z: cz, yaw, scale: 1, flags: 0, seed: rng.next() });
    if (rng.chance(0.6)) {
      g.addProp({ kind: rng.chance(0.5) ? PropKind.CRATE : PropKind.CARDBOARD_BOX, variant: rng.int(0, 2), x: cx, y: -DROP_CM / 100 + 0.15, z: cz, yaw, scale: 1, flags: 0, seed: rng.next() });
    }
  }
  // a bulb over the bay
  const bx = (d.i0 + d.i1) / 2 * CELL, bz = (d.j0 + d.j1) / 2 * CELL;
  placer.add(bulbSpec(bx, r.ceil / 100 - 0.3, bz, BULB_CD, BULB_CCT, 0.25));
}

/** A crate / pallet cluster tucked into the corner of cell (ci, cj); (sx, sz) point from the corner walls into the
 * room. Items sit 2 cm off the wall faces; spillX / spillZ allow a second item one cell along the x / z wall. */
function clusterAt(g: ZoneGenContext['grid'], ci: number, cj: number, sx: 1 | -1, sz: 1 | -1, y: number, spillX: boolean, spillZ: boolean, r: RngT): void {
  const faceX = (sx > 0 ? ci : ci + 1) * CELL + sx * (WALL_T / 2 + 0.02); // wall face + clearance
  const faceZ = (sz > 0 ? cj : cj + 1) * CELL + sz * (WALL_T / 2 + 0.02);
  const put = (kind: PropKindId, hx: number, hz: number, yaw: number, dx: number, dz: number, yy: number): void => {
    g.addProp({ kind, variant: r.int(0, 2), x: faceX + sx * (hx + dx), y: yy, z: faceZ + sz * (hz + dz), yaw, scale: 1, flags: 0, seed: r.next() });
  };
  if (r.chance(0.45)) {
    // a stack of 1–3 pallets (1.0 m side against the x wall), maybe a crate on top
    const h = r.int(1, 3);
    for (let k = 0; k < h; k++) put(PropKind.PALLET, 0.5, 0.6, HALF_PI + r.range(-0.03, 0.03), 0, 0, y + 0.15 * k);
    if (r.chance(0.5)) put(PropKind.CRATE, 0.5, 0.5, r.range(-0.08, 0.08), 0, 0.1, y + 0.15 * h);
  } else {
    // crates against the walls, cardboard boxes on some
    put(PropKind.CRATE, 0.5, 0.5, r.range(-0.06, 0.06), 0, 0, y);
    if (r.chance(0.4)) put(PropKind.CARDBOARD_BOX, 0.25, 0.2, r.range(-0.4, 0.4), 0.2, 0.25, y + 0.8);
    if (spillX && r.chance(0.6)) put(PropKind.CRATE, 0.5, 0.5, r.range(-0.06, 0.06), 1.1, 0, y);
    else if (spillZ && r.chance(0.6)) put(PropKind.CRATE, 0.5, 0.5, r.range(-0.06, 0.06), 0, 1.1, y);
    else if (spillZ && r.chance(0.5)) put(PropKind.CARDBOARD_BOX, 0.25, 0.2, r.range(-0.3, 0.3), 0.1, 1.1, y);
  }
}

export const concreteGenerator: ZoneGenerator = {
  id: Zone.CONCRETE,
  seamMode: 'pattern',
  seamPattern,
  districtParams(rng, _s) {
    return { tubePhase: rng.int(0, TUBE_EVERY - 1) };
  },
  generate,
  palette(_s: StoreyId, _d: DistrictInfo): ZonePalette {
    return {
      floorMat: Mat.CONCRETE_FLOOR, wallMat: Mat.CMU_PAINTED, ceilMat: Mat.CONCRETE_CEIL, trimMat: Mat.CMU_PAINTED,
      ceilKind: CeilKind.CONCRETE, ceilCm: CEIL_CM, baseboard: false,
    };
  },
  lighting(_s: StoreyId, _d: DistrictInfo): LightingProfile {
    return {
      kind: FixtureKind.TUBE_STRIP, placement: 'custom', lattice: [TUBE_EVERY * 2, TUBE_EVERY * 2], phase: [0, 0], axis: 0,
      cctRange: [TUBE_CCT[0], TUBE_CCT[1]], luminance: 8600, zoneMul: 1, mountCm: 6,
    };
  },
  props: {
    rules: [
      { kind: PropKind.EXTINGUISHER, where: 'wallMounted', per100m2: 0.3, variants: 1, minSpacing: 8, yCm: 60 },
      { kind: PropKind.PALLET, where: 'cluster', per100m2: 0.15, variants: 3, minSpacing: 6, yCm: 0 },
      { kind: PropKind.CRATE, where: 'corner', per100m2: 0.2, variants: 3, minSpacing: 5, yCm: 0 },
      { kind: PropKind.BUCKET, where: 'corner', per100m2: 0.15, variants: 2, minSpacing: 6, yCm: 0 },
      { kind: PropKind.TRASH_CAN, where: 'wall', per100m2: 0.1, variants: 2, minSpacing: 10, yCm: 0 },
      { kind: PropKind.VENT_GRILLE, where: 'wallMounted', per100m2: 0.3, variants: 1, minSpacing: 6, yCm: -35 },
    ],
  },
};
