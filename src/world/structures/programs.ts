// src/world/structures/programs.ts — R2 room programs and district character dressing for the LOBBY family
// (called from lobby.ts generate(); OFFICE reuses the closet / kitchenette / restroom programs for its rooms).
//
// Room programs (a leaf rect of the division model; every program is tried and reverted if it would leave a
// walkable cell unreachable from the ports):
//   CLOSET      (<= 6 cells): one DOORWAY kept (the other openings walled), a leaf ajar / closed in it (dead end),
//               floor-to-ceiling wire shelving, bucket + mop, a bare caged bulb, vent tiles over the lattice slots;
//   RESTROOM    (12-30 cells): POOL_TILE walls, POOL_MOSAIC floor, a row of PARTITION stalls along one wall,
//               a TERRAZZO vanity (blocker cells) along another;
//   COPY_ROOM   (8-16): a copier (box solids) + filing cabinets + boxes, paper on the floor;
//   CONFERENCE  (16-40, min side 4): office carpet, a conference table with chairs around it;
//   KITCHENETTE (9-24): VINYL_VCT floor, a WOOD counter (blocker cells), a vending machine with its VENDING panel,
//               a water cooler and a bin.
// District characters (districtParams.character; never within 5 chunks of the origin on storey 0): see
// dressCharacter(). Pure module: no three / DOM / Math.random.

import { CELL, WALL_T } from '../../core/constants.ts';
import { cellIdx, exIdx, ezIdx } from '../../core/grid.ts';
import { CellFlag, DECAL_PAINT_STRIPE, DecalKind, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, Mat, PropKind, TileState, type MatId, type PropKindId } from '../../core/ids.ts';
import { valueNoise2 } from '../../core/noise.ts';
import { hash2, type Rng } from '../../core/rng.ts';
import type { ZoneGenContext } from '../../core/world.ts';
import { addCustomFixtureUnique, maskRects, putProp, yawFacing } from '../zones/l0common.ts';
import { placeLeaf } from './doors.ts';
import { missingTiles, removedFixtures } from './plenum.ts';
import { BOX_SOLID, DECO_FLAGS, N, plainCell, putEdge, restore, snapshot, solidsInRect, unreachedWalkable } from './util.ts';

export interface Rect { li0: number; lj0: number; li1: number; lj1: number }
export const Program = { NONE: 0, CLOSET: 1, RESTROOM: 2, COPY_ROOM: 3, CONFERENCE: 4, KITCHENETTE: 5 } as const;
export const PROGRAM_NAMES = ['NONE', 'CLOSET', 'RESTROOM', 'COPY_ROOM', 'CONFERENCE', 'KITCHENETTE'];

export const Character = { NORMAL: 0, WATER_DAMAGED: 1, RENOVATION: 2, MOVED_OUT: 3, PRISTINE: 4 } as const;
export const CHARACTER_NAMES = ['NORMAL', 'WATER_DAMAGED', 'RENOVATION', 'MOVED_OUT', 'PRISTINE'];
/** districtParams weights of the characters (NORMAL keeps the photo look as the majority). */
export const CHARACTER_W: readonly number[] = [0.55, 0.15, 0.12, 0.1, 0.08];

// ------------------------------------------------------------------------------------------------ leaf geometry

type Side = 0 | 1 | 2 | 3; // 0: -x (W), 1: +x (E), 2: -z (N), 3: +z (S)
/** The edge on the leaf boundary at position k along side s (k = cell index along the side). */
function sideEdgeOf(r: Rect, s: Side, k: number): { axis: 'x' | 'z'; i: number; j: number } {
  if (s === 0) return { axis: 'x', i: r.li0, j: k };
  if (s === 1) return { axis: 'x', i: r.li1, j: k };
  if (s === 2) return { axis: 'z', i: k, j: r.lj0 };
  return { axis: 'z', i: k, j: r.lj1 };
}
const sideRange = (r: Rect, s: Side): [number, number] => (s < 2 ? [r.lj0, r.lj1] : [r.li0, r.li1]);
const kindOf = (ctx: ZoneGenContext, e: { axis: 'x' | 'z'; i: number; j: number }): number =>
  e.axis === 'x' ? ctx.grid.layout.ex.kind[exIdx(e.i, e.j)] : ctx.grid.layout.ez.kind[ezIdx(e.i, e.j)];
/** Cell just inside the leaf at position k along side s. */
function insideCell(r: Rect, s: Side, k: number): [number, number] {
  if (s === 0) return [r.li0, k];
  if (s === 1) return [r.li1 - 1, k];
  if (s === 2) return [k, r.lj0];
  return [k, r.lj1 - 1];
}
/** Inward unit direction of side s. */
const INWARD: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Longest run of WALL edges along a side: [start, end) or null. */
function wallRunOf(ctx: ZoneGenContext, r: Rect, s: Side): [number, number] | null {
  const [a, b] = sideRange(r, s);
  let best: [number, number] | null = null, st = -1;
  for (let k = a; k <= b; k++) {
    const w = k < b && kindOf(ctx, sideEdgeOf(r, s, k)) === EdgeKind.WALL;
    if (w && st < 0) st = k;
    if (!w && st >= 0) { if (!best || k - st > best[1] - best[0]) best = [st, k]; st = -1; }
  }
  return best;
}

function rectPlain(ctx: ZoneGenContext, r: Rect, busy: Uint8Array | null): boolean {
  const g = ctx.grid, l = g.layout;
  const f0 = l.floorCm[cellIdx(r.li0, r.lj0)];
  for (let lj = r.lj0; lj < r.lj1; lj++) for (let li = r.li0; li < r.li1; li++) {
    if (!plainCell(g, li, lj)) return false;
    const c = cellIdx(li, lj);
    if (l.floorCm[c] !== f0 || (busy && busy[c])) return false;
  }
  return !solidsInRect(l, r.li0, r.lj0, r.li1, r.lj1);
}

/** Wall faces of the leaf boundary (and walls inside it) that look into the leaf get `mat`. */
function lineLeaf(ctx: ZoneGenContext, r: Rect, mat: MatId): void {
  const l = ctx.grid.layout;
  for (let lj = r.lj0; lj < r.lj1; lj++) {
    for (let i = Math.max(1, r.li0); i <= Math.min(N - 1, r.li1); i++) { // seam lines are frozen (shared)
      const k = exIdx(i, lj);
      if (l.ex.kind[k] === EdgeKind.OPEN) continue;
      if (i > r.li0) l.ex.matNeg[k] = mat; // face looking toward -x lies in cell i-1 (inside when i > li0)
      if (i < r.li1) l.ex.matPos[k] = mat;
    }
  }
  for (let j = Math.max(1, r.lj0); j <= Math.min(N - 1, r.lj1); j++) {
    for (let li = r.li0; li < r.li1; li++) {
      const k = ezIdx(li, j);
      if (l.ez.kind[k] === EdgeKind.OPEN) continue;
      if (j > r.lj0) l.ez.matNeg[k] = mat;
      if (j < r.lj1) l.ez.matPos[k] = mat;
    }
  }
}

// ------------------------------------------------------------------------------------------------ programs

export interface ProgramCtx { ctx: ZoneGenContext; rng: Rng; busy: Uint8Array | null; seq: { n: number } }
const pseed = (p: ProgramCtx): number => hash2(p.ctx.seed ^ (p.ctx.key.cx * 73856093) ^ (p.ctx.key.cz * 19349663), 0x5eed0 + p.seq.n++);

/** A prop against the wall of side s at position `along` (cells, fractional), `depth` metres from the wall face. */
function wallProp(p: ProgramCtx, r: Rect, s: Side, kind: PropKindId, variant: number, along: number, depth: number, y: number, yawJitter = 0): void {
  const [dx, dz] = INWARD[s];
  const lineM = (s === 0 ? r.li0 : s === 1 ? r.li1 : s === 2 ? r.lj0 : r.lj1) * CELL;
  const n = lineM + (s === 0 || s === 2 ? 1 : -1) * (WALL_T / 2 + depth);
  const x = s < 2 ? n : along * CELL, z = s < 2 ? along * CELL : n;
  putProp(p.ctx.grid, kind, variant, x, y, z, yawFacing(dx, dz) + (yawJitter ? p.rng.range(-yawJitter, yawJitter) : 0), pseed(p));
}

/** Tries program `prog` on leaf r; returns true when it stays. */
export function applyProgram(p: ProgramCtx, r: Rect, prog: number): boolean {
  const l = p.ctx.grid.layout;
  if (!rectPlain(p.ctx, r, p.busy)) return false;
  const snap = snapshot(l);
  const seen = new Uint8Array(N * N);
  const base = unreachedWalkable(l, seen);
  let ok = false;
  switch (prog) {
    case Program.CLOSET: ok = closet(p, r); break;
    case Program.RESTROOM: ok = restroom(p, r); break;
    case Program.COPY_ROOM: ok = copyRoom(p, r); break;
    case Program.CONFERENCE: ok = conference(p, r); break;
    case Program.KITCHENETTE: ok = kitchenette(p, r); break;
    default: break;
  }
  if (ok && unreachedWalkable(l, seen) > base) ok = false;
  if (!ok) { restore(l, snap); return false; }
  if (p.busy) for (let lj = r.lj0; lj < r.lj1; lj++) for (let li = r.li0; li < r.li1; li++) p.busy[cellIdx(li, lj)] = 1;
  return true;
}

/** Program for a leaf by size (or NONE). */
export function programFor(r: Rect, u: number): number {
  const w = r.li1 - r.li0, h = r.lj1 - r.lj0, a = w * h, m = Math.min(w, h);
  if (a <= 6 && a >= 2) return Program.CLOSET;
  if (m >= 3 && a >= 8 && a <= 16 && u < 0.4) return Program.COPY_ROOM;
  if (m >= 3 && a >= 12 && a <= 30 && u < 0.7) return Program.RESTROOM;
  if (m >= 4 && a >= 16 && a <= 40 && u < 0.85) return Program.CONFERENCE;
  if (m >= 3 && a >= 9 && a <= 24) return Program.KITCHENETTE;
  return Program.NONE;
}

function closet(p: ProgramCtx, r: Rect): boolean {
  const ctx = p.ctx, g = ctx.grid, l = g.layout;
  // openings on the boundary: keep one (as a DOORWAY), wall the rest
  const opens: { axis: 'x' | 'z'; i: number; j: number; s: Side }[] = [];
  for (const s of [0, 1, 2, 3] as Side[]) {
    const [a, b] = sideRange(r, s);
    for (let k = a; k < b; k++) {
      const e = sideEdgeOf(r, s, k);
      const kind = kindOf(ctx, e);
      if (kind === EdgeKind.WALL) continue;
      if (g.isFrozenEdge(e.axis, e.i, e.j)) return false; // a closet on the chunk border: skip
      opens.push({ ...e, s });
    }
  }
  if (opens.length === 0) return false;
  const keep = opens[p.rng.int(0, opens.length - 1)];
  for (const e of opens) if (e !== keep && !putEdge(g, e.axis, e.i, e.j, EdgeKind.WALL, { hA: 0, trim: EdgeTrim.BASEBOARD })) return false;
  if (!putEdge(g, keep.axis, keep.i, keep.j, EdgeKind.DOORWAY, { hA: 210, trim: EdgeTrim.BASEBOARD | EdgeTrim.CASING })) return false;
  // door: ajar or closed into the closet (it is a dead end), sometimes open
  const into: -1 | 1 = keep.s === 0 || keep.s === 2 ? 1 : -1;
  const u = p.rng.float();
  const deg = u < 0.35 ? 0 : u < 0.8 ? p.rng.range(12, 35) : p.rng.range(80, 95);
  placeLeaf(g, keep.axis, keep.i, keep.j, into, p.rng.chance(0.5) ? -1 : 1, deg, p.rng.chance(0.5) ? 1 : 0, pseed(p));
  // shelving along the wall opposite the door (floor to ceiling: uprights + 5 shelves)
  const opp: Side = keep.s === 0 ? 1 : keep.s === 1 ? 0 : keep.s === 2 ? 3 : 2;
  const [a, b] = sideRange(r, opp);
  const lineM = (opp === 0 ? r.li0 : opp === 1 ? r.li1 : opp === 2 ? r.lj0 : r.lj1) * CELL;
  const sgn = opp === 0 || opp === 2 ? 1 : -1;
  const n0 = lineM + sgn * (WALL_T / 2 + 0.01), n1 = n0 + sgn * 0.42;
  const t0 = a * CELL + 0.15, t1 = b * CELL - 0.15;
  const f0 = l.floorCm[cellIdx(r.li0, r.lj0)] / 100, ceil = l.ceilCm[cellIdx(r.li0, r.lj0)] / 100;
  const box = (ta: number, tb: number, na: number, nb: number, y0: number, y1: number, flags: number): void => {
    const nlo = Math.min(na, nb), nhi = Math.max(na, nb);
    g.addSolid({ kind: 'box', min: opp < 2 ? [nlo, y0, ta] : [ta, y0, nlo], max: opp < 2 ? [nhi, y1, tb] : [tb, y1, nhi], mat: Mat.METAL_PAINTED, flags, bakeGroup: 0 });
  };
  const top = Math.min(ceil - 0.25, f0 + 2.1);
  for (const t of [t0, t1]) { box(t - 0.02, t + 0.02, n0, n0 + sgn * 0.03, f0, top, BOX_SOLID); box(t - 0.02, t + 0.02, n1 - sgn * 0.03, n1, f0, top, BOX_SOLID); }
  for (let k = 0; k < 5; k++) { const y = f0 + 0.15 + k * (top - f0 - 0.2) / 4; box(t0, t1, n0, n1, y, y + 0.02, BOX_SOLID); }
  // boxes on the shelves, bucket + mop in a corner by the door
  for (let k = 0; k < 4; k++) {
    if (!p.rng.chance(0.55)) continue;
    const y = f0 + 0.17 + p.rng.int(0, 3) * (top - f0 - 0.2) / 4;
    const along = (t0 + 0.3 + p.rng.float() * Math.max(0, t1 - t0 - 0.6)) / CELL;
    wallProp(p, r, opp, PropKind.CARDBOARD_BOX, p.rng.int(0, 2), along, 0.22, y, 0.2);
  }
  const [ka, kb] = sideRange(r, keep.s);
  const corner = p.rng.chance(0.5) ? ka + 0.35 : kb - 0.35;
  wallProp(p, r, keep.s, PropKind.BUCKET, p.rng.int(0, 1), corner, 0.25, f0, 0.8);
  wallProp(p, r, keep.s, PropKind.MOP, 0, corner, 0.18, f0, 0.5);
  // bare bulb in the middle; the lattice slots become vents (no troffer in a closet)
  const cx = (r.li0 + r.li1) / 2 * CELL, cz = (r.lj0 + r.lj1) / 2 * CELL;
  removedFixtures(ctx, r.li0, r.lj0, r.li1, r.lj1, TileState.VENT);
  addCustomFixtureUnique(ctx, { kind: FixtureKind.CAGE_BULB, x: cx, y: ceil - 0.22, z: cz, nx: 0, ny: -1, nz: 0, tx: 1, ty: 0, tz: 0, w: 0.1, h: 0.1, cct0: 2600, cct1: 2900, luminance: 75, hum: 0.5 });
  return true;
}

function restroom(p: ProgramCtx, r: Rect): boolean {
  const ctx = p.ctx, g = ctx.grid, l = g.layout;
  // a restroom is an enclosed room: no glazing (office rooms have corridor windows) and at most 3 open boundary
  // edges (an eroded LOBBY leaf gaping into the hall reads as a tiled corner of the lobby, not a restroom)
  let gaps = 0;
  for (const s of [0, 1, 2, 3] as Side[]) {
    const [a0, a1] = sideRange(r, s);
    for (let k = a0; k < a1; k++) {
      const kd = kindOf(ctx, sideEdgeOf(r, s, k));
      if (kd === EdgeKind.WINDOW) return false;
      if (kd !== EdgeKind.WALL && kd !== EdgeKind.DOORWAY && kd !== EdgeKind.PARTITION) gaps++;
    }
  }
  if (gaps > 3) return false;
  // stalls against the side with the longest wall run (>= 3); the vanity against another wall
  let best: { s: Side; run: [number, number] } | null = null;
  for (const s of [0, 1, 2, 3] as Side[]) {
    const run = wallRunOf(ctx, r, s);
    if (run && run[1] - run[0] >= 3 && (!best || run[1] - run[0] > best.run[1] - best.run[0])) best = { s, run };
  }
  if (!best) return false;
  // stall cells: the row along the wall run minus its last cell; partitions between them (1 cell deep)
  const [a, b] = best.run;
  const nStall = Math.min(4, b - a - 1);
  if (nStall < 2) return false;
  // the row in front of the stalls must stay walkable: depth >= 3
  const depth = best.s < 2 ? r.li1 - r.li0 : r.lj1 - r.lj0;
  if (depth < 3) return false;
  const part = { hA: 150, matNeg: Mat.METAL_PAINTED, matPos: Mat.METAL_PAINTED, trim: 0 };
  for (let k = a + 1; k <= a + nStall; k++) {
    const [li, lj] = insideCell(r, best.s, k);
    // partition between stall k-1 and k (perpendicular to the wall)
    const ok = best.s < 2 ? putEdge(g, 'z', li, lj, EdgeKind.PARTITION, part) : putEdge(g, 'x', li, lj, EdgeKind.PARTITION, part);
    if (!ok) return false;
  }
  // materials
  g.setCells(r.li0, r.lj0, r.li1, r.lj1, { floorMat: Mat.POOL_MOSAIC });
  lineLeaf(ctx, r, Mat.POOL_TILE);
  // re-apply the metal to the partitions (lineLeaf tiled them)
  for (let k = a + 1; k <= a + nStall; k++) {
    const [li, lj] = insideCell(r, best.s, k);
    if (best.s < 2) { const e = ezIdx(li, lj); l.ez.matNeg[e] = Mat.METAL_PAINTED; l.ez.matPos[e] = Mat.METAL_PAINTED; }
    else { const e = exIdx(li, lj); l.ex.matNeg[e] = Mat.METAL_PAINTED; l.ex.matPos[e] = Mat.METAL_PAINTED; }
  }
  // vanity: 2 blocker cells against the opposite side's wall run, if it has one
  const opp: Side = best.s === 0 ? 1 : best.s === 1 ? 0 : best.s === 2 ? 3 : 2;
  const vr = wallRunOf(ctx, r, opp);
  if (vr && vr[1] - vr[0] >= 3) {
    const k0 = vr[0] + p.rng.int(0, vr[1] - vr[0] - 2);
    for (let k = k0; k < k0 + 2; k++) {
      const [li, lj] = insideCell(r, opp, k);
      g.setCells(li, lj, li + 1, lj + 1, { blockCm: 85, floorMat: Mat.TERRAZZO });
    }
  }
  // a bin by the door side, a wet-floor sign sometimes
  const sb = sideRange(r, best.s)[1];
  if (p.rng.chance(0.6)) {
    const [li, lj] = insideCell(r, best.s, sb - 1);
    const c = cellIdx(li, lj);
    if (l.blockCm[c] === 0) wallProp(p, r, best.s, PropKind.TRASH_CAN, 0, sb - 0.5, 0.22, l.floorCm[c] / 100, 0.4);
  }
  if (p.rng.chance(0.35)) {
    const cx = (r.li0 + r.li1) / 2, cz = (r.lj0 + r.lj1) / 2;
    putProp(g, PropKind.WET_FLOOR_SIGN, 0, cx * CELL, l.floorCm[cellIdx(Math.floor(cx), Math.floor(cz))] / 100, cz * CELL, p.rng.range(0, 6.28), pseed(p));
  }
  return true;
}

function copyRoom(p: ProgramCtx, r: Rect): boolean {
  const ctx = p.ctx, g = ctx.grid, l = g.layout;
  let best: { s: Side; run: [number, number] } | null = null;
  for (const s of [0, 1, 2, 3] as Side[]) {
    const run = wallRunOf(ctx, r, s);
    if (run && run[1] - run[0] >= 2 && (!best || run[1] - run[0] > best.run[1] - best.run[0])) best = { s, run };
  }
  if (!best) return false;
  const f0 = l.floorCm[cellIdx(r.li0, r.lj0)] / 100;
  const [a, b] = best.run;
  // the copier: a cabinet body + a lid + a paper tray (box solids), against the wall
  const s = best.s;
  const lineM = (s === 0 ? r.li0 : s === 1 ? r.li1 : s === 2 ? r.lj0 : r.lj1) * CELL;
  const sgn = s === 0 || s === 2 ? 1 : -1;
  const n0 = lineM + sgn * (WALL_T / 2 + 0.05), n1 = n0 + sgn * 0.7;
  const tc = (a + 0.75) * CELL;
  const box = (ta: number, tb: number, na: number, nb: number, y0: number, y1: number, mat: MatId): void => {
    const nlo = Math.min(na, nb), nhi = Math.max(na, nb);
    g.addSolid({ kind: 'box', min: s < 2 ? [nlo, y0, ta] : [ta, y0, nlo], max: s < 2 ? [nhi, y1, tb] : [tb, y1, nhi], mat, flags: BOX_SOLID, bakeGroup: 0 });
  };
  box(tc - 0.5, tc + 0.5, n0, n1, f0, f0 + 0.95, Mat.PLASTIC);
  box(tc - 0.45, tc + 0.35, n0 + sgn * 0.05, n1 - sgn * 0.05, f0 + 0.95, f0 + 1.08, Mat.PLASTIC);
  box(tc + 0.5, tc + 0.78, n0 + sgn * 0.15, n1 - sgn * 0.2, f0 + 0.72, f0 + 0.76, Mat.PLASTIC);
  // filing cabinets along the rest of the run, boxes, paper on the floor
  for (let k = a + 2; k < b; k++) if (p.rng.chance(0.7)) wallProp(p, r, s, PropKind.FILING_CABINET, p.rng.int(0, 1), k + 0.5, 0.31, f0);
  const cx = (r.li0 + r.li1) / 2, cz = (r.lj0 + r.lj1) / 2;
  for (let k = 0; k < p.rng.int(1, 3); k++) {
    putProp(g, PropKind.CARDBOARD_BOX, p.rng.int(0, 2), (cx + p.rng.range(-0.8, 0.8)) * CELL, f0, (cz + p.rng.range(-0.8, 0.8)) * CELL, p.rng.range(0, 6.28), pseed(p));
  }
  for (let k = 0; k < p.rng.int(3, 7); k++) {
    g.addDecal({ kind: DecalKind.PAPER, sign: false, px: (cx + p.rng.range(-1, 1)) * CELL, py: f0 + 0.002, pz: (cz + p.rng.range(-1, 1)) * CELL, nx: 0, ny: 1, nz: 0, rot: p.rng.range(0, 6.28), w: 0.3, h: 0.3, alpha: 0.9 });
  }
  return true;
}

function conference(p: ProgramCtx, r: Rect): boolean {
  const ctx = p.ctx, g = ctx.grid, l = g.layout;
  const w = r.li1 - r.li0, h = r.lj1 - r.lj0;
  const f0 = l.floorCm[cellIdx(r.li0, r.lj0)] / 100;
  g.setCells(r.li0, r.lj0, r.li1, r.lj1, { floorMat: Mat.CARPET_OFFICE });
  const cx = (r.li0 + r.li1) / 2 * CELL, cz = (r.lj0 + r.lj1) / 2 * CELL;
  const alongX = w >= h;
  // CONFERENCE_TABLE: 3.0 x 1.2, long axis = local x; facing +z puts local x along world x
  putProp(g, PropKind.CONFERENCE_TABLE, p.rng.int(0, 1), cx, f0, cz, alongX ? Math.PI : Math.PI / 2, pseed(p));
  const n = p.rng.int(6, 10);
  const perSide = Math.min(4, (n - 2) >> 1);
  for (const sg of [-1, 1]) {
    for (let k = 0; k < perSide; k++) {
      const t = perSide === 1 ? 0 : -1.05 + (2.1 * k) / (perSide - 1);
      const x = alongX ? cx + t : cx + sg * 0.95, z = alongX ? cz + sg * 0.95 : cz + t;
      if (p.rng.chance(0.12)) continue;
      putProp(g, PropKind.OFFICE_CHAIR, p.rng.int(0, 2), x + p.rng.range(-0.08, 0.08), f0, z + p.rng.range(-0.08, 0.08),
        yawFacing(alongX ? 0 : -sg, alongX ? -sg : 0) + p.rng.range(-0.4, 0.4), pseed(p));
    }
  }
  for (const sg of [-1, 1]) {
    if (!p.rng.chance(0.7)) continue;
    const x = alongX ? cx + sg * 1.9 : cx, z = alongX ? cz : cz + sg * 1.9;
    putProp(g, PropKind.OFFICE_CHAIR, p.rng.int(0, 2), x, f0, z, yawFacing(alongX ? -sg : 0, alongX ? 0 : -sg) + p.rng.range(-0.3, 0.3), pseed(p));
  }
  return true;
}

function kitchenette(p: ProgramCtx, r: Rect): boolean {
  const ctx = p.ctx, g = ctx.grid, l = g.layout;
  let best: { s: Side; run: [number, number] } | null = null;
  for (const s of [0, 1, 2, 3] as Side[]) {
    const run = wallRunOf(ctx, r, s);
    if (run && run[1] - run[0] >= 3 && (!best || run[1] - run[0] > best.run[1] - best.run[0])) best = { s, run };
  }
  if (!best) return false;
  g.setCells(r.li0, r.lj0, r.li1, r.lj1, { floorMat: Mat.VINYL_VCT });
  const [a, b] = best.run;
  const f0 = l.floorCm[cellIdx(r.li0, r.lj0)] / 100;
  // counter: 2 blocker cells at one end of the run; the vending machine at the other end
  const atStart = p.rng.chance(0.5);
  const c0 = atStart ? a : b - 2;
  for (let k = c0; k < c0 + 2; k++) {
    const [li, lj] = insideCell(r, best.s, k);
    g.setCells(li, lj, li + 1, lj + 1, { blockCm: 90, floorMat: Mat.WOOD });
  }
  const vk = atStart ? b - 1 : a;
  const [dx, dz] = INWARD[best.s];
  wallProp(p, r, best.s, PropKind.VENDING_MACHINE, p.rng.int(0, 2), vk + 0.5, 0.43, f0);
  {
    const lineM = (best.s === 0 ? r.li0 : best.s === 1 ? r.li1 : best.s === 2 ? r.lj0 : r.lj1) * CELL;
    const n = lineM + (best.s === 0 || best.s === 2 ? 1 : -1) * (WALL_T / 2 + 0.03 + 0.8 + 0.01);
    const x = best.s < 2 ? n : (vk + 0.5) * CELL, z = best.s < 2 ? (vk + 0.5) * CELL : n;
    addCustomFixtureUnique(ctx, {
      kind: FixtureKind.VENDING, x, y: f0 + 1.05, z, nx: dx, ny: 0, nz: dz, tx: dz !== 0 ? 1 : 0, ty: 0, tz: dx !== 0 ? 1 : 0,
      w: 0.7, h: 1.4, cct0: 5200, cct1: 6200, luminance: 600, hum: 0.8,
    });
  }
  // water cooler and bin against another wall of the room
  for (const s of [0, 1, 2, 3] as Side[]) {
    if (s === best.s) continue;
    const run = wallRunOf(ctx, r, s);
    if (!run || run[1] - run[0] < 2) continue;
    wallProp(p, r, s, PropKind.WATER_COOLER, 0, run[0] + 0.5, 0.19, f0);
    wallProp(p, r, s, PropKind.TRASH_CAN, p.rng.int(0, 1), run[0] + 1.5, 0.23, f0, 0.4);
    break;
  }
  return true;
}

// ------------------------------------------------------------------------------------------------ characters

export interface CharacterInput {
  ctx: ZoneGenContext; rng: Rng; busy: Uint8Array | null;
  leaves: readonly Rect[];
  /** division walls the dressing may re-skin / strip (axis 0 x / 1 z, i, j triples) */
  walls: readonly number[];
}

/** Dresses the chunk for its district character. Returns the number of dressing items (tests). */
export function dressCharacter(ch: number, inp: CharacterInput): number {
  switch (ch) {
    case Character.WATER_DAMAGED: return waterDamaged(inp);
    case Character.RENOVATION: return renovation(inp);
    case Character.MOVED_OUT: return movedOut(inp);
    case Character.PRISTINE: return pristine(inp);
    default: return 0;
  }
}

function waterDamaged(inp: CharacterInput): number {
  const { ctx, rng } = inp, g = ctx.grid, l = g.layout;
  // large wet areas: a low-frequency noise blob mask over the walkable floor (2 cm film, WET flag)
  const mask = new Uint8Array(N * N);
  let n = 0;
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      const c = cellIdx(li, lj);
      if (!plainCell(g, li, lj) || l.waterCm[c] !== -32768 || (inp.busy && inp.busy[c])) continue;
      const wx = (g.gi0 + li) * CELL, wz = (g.gj0 + lj) * CELL;
      const v = valueNoise2(ctx.seed ^ 0x3a7e, wx / 9, wz / 9) * 0.7 + valueNoise2(ctx.seed ^ 0x51c3, wx / 3.5, wz / 3.5) * 0.3;
      if (v > 0.56) { mask[c] = 1; n++; }
    }
  }
  // group by floor height, then emit film rects
  const heights = new Set<number>();
  for (let c = 0; c < N * N; c++) if (mask[c]) heights.add(l.floorCm[c]);
  for (const f of heights) {
    const m = new Uint8Array(N * N);
    for (let c = 0; c < N * N; c++) if (mask[c] && l.floorCm[c] === f) m[c] = 1;
    for (const [i0, j0, i1, j1] of maskRects(m)) {
      g.setCells(i0, j0, i1, j1, { flagsSet: CellFlag.WET, waterCm: f + 2 });
      g.addWater({ x0: i0 * CELL, z0: j0 * CELL, x1: i1 * CELL, z1: j1 * CELL, y: (f + 2) / 100, floorY: f / 100, kind: 2 });
    }
  }
  // stained / sagging tiles over the wet areas and scattered elsewhere; drips under a few
  for (const r of inp.leaves) {
    if (!rng.chance(0.6)) continue;
    missingTiles(ctx, r.li0, r.lj0, r.li1, r.lj1, rng.range(0.1, 0.3), rng, TileState.STAINED);
    missingTiles(ctx, r.li0, r.lj0, r.li1, r.lj1, rng.range(0.02, 0.08), rng, TileState.SAGGING);
    if (rng.chance(0.2)) missingTiles(ctx, r.li0, r.lj0, r.li1, r.lj1, 0.05, rng, TileState.MISSING);
  }
  let drips = 0;
  for (let c = 0; c < N * N && drips < 3; c++) {
    if (!mask[c] || !rng.chance(0.03)) continue;
    g.addEmitter(EmitterKind.DRIP, ((c & 31) + 0.5) * CELL, l.ceilCm[c] / 100 - 0.02, ((c >> 5) + 0.5) * CELL, 0.35);
    drips++;
  }
  return n;
}

function renovation(inp: CharacterInput): number {
  const { ctx, rng, walls } = inp, g = ctx.grid, l = g.layout;
  let items = 0;
  // bare drywall on a third of the division walls
  for (let k = 0; k < walls.length; k += 3) {
    if (!rng.chance(0.33)) continue;
    const axis = walls[k] === 0 ? 'x' : 'z', i = walls[k + 1], j = walls[k + 2];
    const e = axis === 'x' ? l.ex : l.ez, ki = axis === 'x' ? exIdx(i, j) : ezIdx(i, j);
    if (e.kind[ki] !== EdgeKind.WALL) continue;
    e.matNeg[ki] = Mat.DRYWALL; e.matPos[ki] = Mat.DRYWALL;
    items++;
  }
  // exposed studs: 1-2 division walls stripped to their frame (RAIL 5 cm = the bottom plate; studs + top plate as
  // box solids). Connectivity is unchanged (WALL and RAIL are both non-walkable); light passes between the studs.
  const runs = wallRuns(inp);
  rng.shuffle(runs);
  let stripped = 0;
  for (const [axis, line, c0, c1] of runs) {
    if (stripped >= 2) break;
    if (c1 - c0 < 2 || c1 - c0 > 5) continue;
    const ok = (() => {
      for (let c = c0; c < c1; c++) {
        const i = axis === 'x' ? line : c, j = axis === 'x' ? c : line;
        const ca = axis === 'x' ? cellIdx(i - 1, j) : cellIdx(i, j - 1), cb = cellIdx(i, j);
        if ((l.flags[ca] | l.flags[cb]) & (CellFlag.SOLID | CellFlag.RESERVED)) return false;
        if (l.floorCm[ca] !== l.floorCm[cb]) return false;
      }
      return true;
    })();
    if (!ok) continue;
    for (let c = c0; c < c1; c++) {
      const i = axis === 'x' ? line : c, j = axis === 'x' ? c : line;
      putEdge(g, axis, i, j, EdgeKind.RAIL, { hA: l.floorCm[cellIdx(i, j)] + 5, matNeg: Mat.WOOD, matPos: Mat.WOOD, trim: 0 });
    }
    const lineM = line * CELL;
    const f0 = l.floorCm[cellIdx(axis === 'x' ? line : c0, axis === 'x' ? c0 : line)] / 100;
    let ceil = 99;
    for (let c = c0; c < c1; c++) {
      const i = axis === 'x' ? line : c, j = axis === 'x' ? c : line;
      ceil = Math.min(ceil, l.ceilCm[cellIdx(i, j)] / 100, l.ceilCm[axis === 'x' ? cellIdx(i - 1, j) : cellIdx(i, j - 1)] / 100);
    }
    const stud = (t: number): void => {
      g.addSolid({ kind: 'box', min: axis === 'x' ? [lineM - 0.045, f0 + 0.05, t - 0.02] : [t - 0.02, f0 + 0.05, lineM - 0.045], max: axis === 'x' ? [lineM + 0.045, ceil - 0.04, t + 0.02] : [t + 0.02, ceil - 0.04, lineM + 0.045], mat: Mat.WOOD, flags: BOX_SOLID, bakeGroup: 0 });
    };
    for (let t = c0 * CELL + 0.06; t <= c1 * CELL - 0.05; t += 0.4) stud(t);
    stud(c1 * CELL - 0.06);
    g.addSolid({ kind: 'box', min: axis === 'x' ? [lineM - 0.045, ceil - 0.08, c0 * CELL] : [c0 * CELL, ceil - 0.08, lineM - 0.045], max: axis === 'x' ? [lineM + 0.045, ceil - 0.04, c1 * CELL] : [c1 * CELL, ceil - 0.04, lineM + 0.045], mat: Mat.WOOD, flags: BOX_SOLID, bakeGroup: 0 });
    // plastic sheeting stapled over part of the frame
    if (rng.chance(0.6)) {
      const s0 = c0 * CELL + 0.05, s1 = Math.min(c1 * CELL - 0.05, s0 + rng.range(1.0, 2.2));
      const off = rng.chance(0.5) ? 0.06 : -0.06;
      g.addSolid({ kind: 'box', min: axis === 'x' ? [lineM + off - 0.004, f0 + 0.15, s0] : [s0, f0 + 0.15, lineM + off - 0.004], max: axis === 'x' ? [lineM + off + 0.004, ceil - 0.05, s1] : [s1, ceil - 0.05, lineM + off + 0.004], mat: Mat.PLASTIC, flags: DECO_FLAGS, bakeGroup: 0 });
    }
    // paint buckets and a box at its foot
    const side = rng.chance(0.5) ? 1 : -1;
    for (let k = 0; k < rng.int(1, 3); k++) {
      const t = rng.range(c0 * CELL + 0.3, c1 * CELL - 0.3), nn = lineM + side * rng.range(0.3, 0.6);
      putProp(g, PropKind.BUCKET, rng.int(0, 1), axis === 'x' ? nn : t, f0, axis === 'x' ? t : nn, rng.range(0, 6.28), rng.next());
    }
    stripped++;
    items++;
  }
  // new (bright) replacement tiles and a few holes
  for (const r of inp.leaves) {
    if (!rng.chance(0.5)) continue;
    missingTiles(ctx, r.li0, r.lj0, r.li1, r.lj1, rng.range(0.1, 0.3), rng, TileState.NEW);
    if (rng.chance(0.3)) missingTiles(ctx, r.li0, r.lj0, r.li1, r.lj1, 0.06, rng, TileState.MISSING);
  }
  return items;
}

function movedOut(inp: CharacterInput): number {
  const { ctx, rng } = inp, g = ctx.grid, l = g.layout;
  let items = 0;
  const outline = (x: number, z: number, w: number, d: number, f: number): void => {
    // the dent / fade line where a desk stood for years: four thin dark stripes
    const col: [number, number, number] = [0.09, 0.07, 0.04];
    g.addDecal({ kind: DECAL_PAINT_STRIPE, sign: false, px: x, py: f + 0.002, pz: z - d / 2, nx: 0, ny: 1, nz: 0, rot: Math.PI / 2, w: 0.035, h: w, alpha: 0.35, color: col });
    g.addDecal({ kind: DECAL_PAINT_STRIPE, sign: false, px: x, py: f + 0.002, pz: z + d / 2, nx: 0, ny: 1, nz: 0, rot: Math.PI / 2, w: 0.035, h: w, alpha: 0.35, color: col });
    g.addDecal({ kind: DECAL_PAINT_STRIPE, sign: false, px: x - w / 2, py: f + 0.002, pz: z, nx: 0, ny: 1, nz: 0, rot: 0, w: 0.035, h: d, alpha: 0.35, color: col });
    g.addDecal({ kind: DECAL_PAINT_STRIPE, sign: false, px: x + w / 2, py: f + 0.002, pz: z, nx: 0, ny: 1, nz: 0, rot: 0, w: 0.035, h: d, alpha: 0.35, color: col });
  };
  for (const r of inp.leaves) {
    const w = r.li1 - r.li0, h = r.lj1 - r.lj0;
    if (w < 4 || h < 3 || !rng.chance(0.5)) continue;
    if (inp.busy) { let b = false; for (let lj = r.lj0; lj < r.lj1 && !b; lj++) for (let li = r.li0; li < r.li1 && !b; li++) if (inp.busy[cellIdx(li, lj)]) b = true; if (b) continue; }
    const f = l.floorCm[cellIdx(r.li0, r.lj0)] / 100;
    // a grid of desk footprints (1.5 x 0.75) where the cubicles were
    for (let z = r.lj0 * CELL + 1.1; z < r.lj1 * CELL - 0.8; z += 1.9) {
      for (let x = r.li0 * CELL + 1.3; x < r.li1 * CELL - 1.0; x += 2.3) {
        if (!rng.chance(0.75)) continue;
        outline(x, z, 1.5, 0.75, f);
        items++;
      }
    }
    // a cable bundle snaking from the wall toward the middle of the room
    if (rng.chance(0.6)) {
      const r0 = rng.chance(0.5);
      let x = r0 ? r.li0 * CELL + 0.1 : r.li1 * CELL - 0.1, z = rng.range(r.lj0 * CELL + 0.4, r.lj1 * CELL - 0.4);
      const rad = rng.range(0.012, 0.02);
      for (let s = 0; s < 3; s++) {
        const nx = x + (r0 ? 1 : -1) * rng.range(0.5, 1.1), nz = z + rng.range(-0.5, 0.5);
        g.addSolid({ kind: 'pipe', a: [x, f + rad, z], b: [nx, f + rad, nz], r: rad, mat: Mat.RUBBER, flags: DECO_FLAGS });
        x = nx; z = nz;
      }
      items++;
    }
    // leftovers: a box or two, a stack of chairs against a wall
    if (rng.chance(0.5)) {
      putProp(g, PropKind.CARDBOARD_BOX, rng.int(0, 2), (r.li0 + 0.5 + rng.float() * (w - 1)) * CELL, f, (r.lj0 + 0.5) * CELL, rng.range(-0.4, 0.4), rng.next());
      items++;
    }
  }
  return items;
}

function pristine(inp: CharacterInput): number {
  const { ctx, rng } = inp;
  let n = 0;
  for (const r of inp.leaves) if (rng.chance(0.4)) n += missingTiles(ctx, r.li0, r.lj0, r.li1, r.lj1, 0.12, rng, TileState.NEW);
  return n;
}

/** Maximal runs of the listed division walls on one line: [axis, line, c0, c1). */
function wallRuns(inp: CharacterInput): ['x' | 'z', number, number, number][] {
  const l = inp.ctx.grid.layout;
  const set = new Set<number>();
  for (let k = 0; k < inp.walls.length; k += 3) set.add(inp.walls[k] * 4096 + inp.walls[k + 1] * 64 + inp.walls[k + 2]);
  const out: ['x' | 'z', number, number, number][] = [];
  for (const axis of [0, 1]) {
    for (let line = 1; line < N; line++) {
      let c = 0;
      while (c < N) {
        const key = (cc: number): number => (axis === 0 ? axis * 4096 + line * 64 + cc : axis * 4096 + cc * 64 + line);
        const isWall = (cc: number): boolean => set.has(key(cc)) && (axis === 0 ? l.ex.kind[exIdx(line, cc)] : l.ez.kind[ezIdx(cc, line)]) === EdgeKind.WALL;
        if (!isWall(c)) { c++; continue; }
        let d = c;
        while (d < N && isWall(d)) d++;
        out.push([axis === 0 ? 'x' : 'z', line, c, d]);
        c = d;
      }
    }
  }
  return out;
}
