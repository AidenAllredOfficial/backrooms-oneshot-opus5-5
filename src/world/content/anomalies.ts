// src/world/content/anomalies.ts — LATE_ECHO / REPEATED_ROOM / CEILING_FURNITURE sites (WP4, R2 B6).
//
// LATE_ECHO (p 0.05 per chunk): on a straight corridor run >= 10 cells with corridorWidth <= 2, r = 6 m.
// REPEATED_ROOM (p 0.04 per chunk, Level 0 family): two adjacent, DOORWAY-connected rectangular rooms of equal
//   size; the second gets byte-identical content (props, fixture states, ceiling tiles now; decals when placeDecals
//   runs, see repeatedRoomOf; tile ageing / leaks re-synced by syncRepeatedRoom). The site marks the second room.
//   R2 (B6): LOBBY / MANILA rooms are rarely closed rectangles, so when no natural pair exists the anomaly stamps
//   its own pair of equal 5 x 6 rooms joined by a DOORWAY into open floor, with the three doors in one line (an
//   enfilade: you see the same room twice), furnishes room A and repeats it.
// CEILING_FURNITURE (p 0.03 per chunk): one room's chairs / desks mirrored onto the ceiling (PropFlag.CEILING, base
//   at ceilCm, no collision, no occluders). R2 (B6): where no furniture group exists (LOBBY), a loose ring of
//   stacking chairs is set out first.

import { CELL, TILE_CELLS, WALL_T } from '../../core/constants.ts';
import { AnomalyKind, CellFlag, DecalKind, EdgeKind, EdgeTrim, isRecessedFixture, LightState, PROP_DEFS, PropFlag, PropKind, SALT, Zone, cellIdx, exIdx, ezIdx, rngFor } from '../../core/index.ts';
import type { ChunkLayout, Fixture, PropKindId, PropPlacement, Rng, ZoneGenContext } from '../../core/index.ts';
import { corridorWidth, labelRooms } from '../rooms.ts';
import { yawOf } from '../structures/frame.ts';
import { computeKeepClear } from './keepClear.ts';
import { OCC_N, OCC_RES, PlacementSpace, portReach, propAABB, propsInRect, reachKept } from './occupancy.ts';
import { PAPER_TINT, PropPlacer } from './props.ts';
import { canStep, inChunk, isOpenFloor, latticeKeyOf, N, straddlesTileLine } from './util.ts';
import { doorApproachFree, fixtureXZ, rectFree, removeFixtures, wallRect } from './vignettes.ts';

export const LATE_ECHO_P = 0.05;
export const REPEATED_ROOM_P = 0.04;
export const CEILING_FURNITURE_P = 0.03;

// ------------------------------------------------------------------------------------------ LATE_ECHO

export interface Run { axis: 0 | 1; li: number; lj: number; len: number } // start cell, along +x (0) or +z (1)

/** Maximal straight corridor runs (consecutive passable steps, width <= 2 by `width`) of at least `minLen` cells. */
export function corridorRuns(l: ChunkLayout, width: (l: ChunkLayout, li: number, lj: number) => number, minLen = 10): Run[] {
  const ok = new Uint8Array(N * N);
  for (let c = 0; c < N * N; c++) ok[c] = isOpenFloor(l, c) && width(l, c & 31, c >> 5) <= 2 ? 1 : 0;
  const out: Run[] = [];
  for (const axis of [0, 1] as const) {
    for (let a = 0; a < N; a++) {
      let start = -1;
      for (let b = 0; b <= N; b++) {
        const li = axis === 0 ? b : a, lj = axis === 0 ? a : b;
        const good = b < N && ok[cellIdx(li, lj)] === 1;
        const linked = good && start >= 0 && canStep(l, axis === 0 ? li - 1 : li, axis === 0 ? lj : lj - 1, axis === 0 ? 0 : 2);
        if (good && start < 0) start = b;
        else if (start >= 0 && (!good || !linked)) {
          const len = b - start;
          if (len >= minLen) out.push(axis === 0 ? { axis, li: start, lj: a, len } : { axis, li: a, lj: start, len });
          start = good ? b : -1;
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------ REPEATED_ROOM

export interface RoomRect { id: number; i0: number; j0: number; i1: number; j1: number }
export interface RoomPair { a: RoomRect; b: RoomRect }
const pairs = new WeakMap<ChunkLayout, RoomPair>();
/** The REPEATED_ROOM pairing chosen for this layout (read by placeDecals, which runs later). */
export const repeatedRoomOf = (l: ChunkLayout): RoomPair | undefined => pairs.get(l);

/** Rectangular interior rooms bounded only by WALL / DOORWAY edges (at least one DOORWAY). */
export function rectRooms(l: ChunkLayout): RoomRect[] {
  const box = new Map<number, RoomRect & { n: number }>();
  for (let c = 0; c < N * N; c++) {
    const r = l.room[c];
    if (r === 0) continue;
    const li = c & 31, lj = c >> 5;
    const b = box.get(r);
    if (!b) box.set(r, { id: r, i0: li, j0: lj, i1: li + 1, j1: lj + 1, n: 1 });
    else { b.i0 = Math.min(b.i0, li); b.j0 = Math.min(b.j0, lj); b.i1 = Math.max(b.i1, li + 1); b.j1 = Math.max(b.j1, lj + 1); b.n++; }
  }
  const out: RoomRect[] = [];
  for (const b of box.values()) {
    if (b.n !== (b.i1 - b.i0) * (b.j1 - b.j0) || b.n < 4 || b.n > 64) continue;
    if (b.i0 < 1 || b.j0 < 1 || b.i1 > N - 1 || b.j1 > N - 1) continue;
    let ok = true, doors = 0;
    const f0 = l.floorCm[cellIdx(b.i0, b.j0)], c0 = l.ceilCm[cellIdx(b.i0, b.j0)];
    for (let lj = b.j0; lj < b.j1 && ok; lj++) for (let li = b.i0; li < b.i1 && ok; li++) {
      const c = cellIdx(li, lj);
      if (!isOpenFloor(l, c) || l.floorCm[c] !== f0 || l.ceilCm[c] !== c0) ok = false;
    }
    const edge = (k: number): void => { if (k === EdgeKind.DOORWAY) doors++; else if (k !== EdgeKind.WALL) ok = false; };
    for (let li = b.i0; li < b.i1; li++) { edge(l.ez.kind[ezIdx(li, b.j0)]); edge(l.ez.kind[ezIdx(li, b.j1)]); }
    for (let lj = b.j0; lj < b.j1; lj++) { edge(l.ex.kind[exIdx(b.i0, lj)]); edge(l.ex.kind[exIdx(b.i1, lj)]); }
    if (ok && doors > 0) out.push({ id: b.id, i0: b.i0, j0: b.j0, i1: b.i1, j1: b.j1 });
  }
  return out.sort((p, q) => p.j0 * N + p.i0 - (q.j0 * N + q.i0));
}

/** Pairs of equal-size rooms sharing a DOORWAY edge. */
export function roomPairs(l: ChunkLayout): RoomPair[] {
  const rooms = rectRooms(l);
  const out: RoomPair[] = [];
  for (let x = 0; x < rooms.length; x++) {
    for (let y = 0; y < rooms.length; y++) {
      if (x === y) continue;
      const a = rooms[x], b = rooms[y];
      if (a.i1 - a.i0 !== b.i1 - b.i0 || a.j1 - a.j0 !== b.j1 - b.j0) continue;
      let door = false;
      if (a.i1 === b.i0 && a.j0 === b.j0) for (let lj = a.j0; lj < a.j1; lj++) door ||= l.ex.kind[exIdx(a.i1, lj)] === EdgeKind.DOORWAY;
      if (a.j1 === b.j0 && a.i0 === b.i0) for (let li = a.i0; li < a.i1; li++) door ||= l.ez.kind[ezIdx(li, a.j1)] === EdgeKind.DOORWAY;
      if (door) out.push({ a, b });
    }
  }
  return out;
}

const inRect = (r: RoomRect, x: number, z: number): boolean => x >= r.i0 * CELL && x < r.i1 * CELL && z >= r.j0 * CELL && z < r.j1 * CELL;

/** Copy room A's props / fixture states / ceiling tiles into room B (translated). False (nothing changed) if a
 * copied prop would not fit B (B's doors are elsewhere). */
export function repeatRoom(ctx: ZoneGenContext, pair: RoomPair): boolean {
  const g = ctx.grid, l = g.layout;
  const { a, b } = pair;
  const dx = (b.i0 - a.i0) * CELL, dz = (b.j0 - a.j0) * CELL;
  const keepProps = l.props.filter((p) => !inRect(b, p.x, p.z));
  const copies: PropPlacement[] = l.props.filter((p) => inRect(a, p.x, p.z)).map((p) => ({ ...p, x: p.x + dx, z: p.z + dz }));
  // validate against B without its own props
  // a copied recessed fixture must not straddle a render-tile line in B (validateLayout)
  for (const f of l.fixtures) {
    if (f.bakeGroup !== 0 || !inRect(a, f.px, f.pz) || !isRecessedFixture(f.kind) || f.shape !== 0) continue;
    const [x0, z0, x1, z1] = fixtureXZ(f);
    if (straddlesTileLine(x0 + dx, z0 + dz, x1 + dx, z1 + dz)) return false;
  }
  const probe = new PlacementSpace({ ...l, props: keepProps.filter((p) => !inRect(a, p.x, p.z)) }, computeKeepClear(l));
  for (const p of copies) {
    if ((p.flags & PropFlag.CEILING) !== 0) continue;
    const wall = p.kind === PropKind.OUTLET || p.kind === PropKind.VENT_GRILLE || p.kind === PropKind.THERMOSTAT || p.kind === PropKind.EXTINGUISHER || p.kind === PropKind.LIFEBUOY;
    if (!probe.fits(p.kind, p.x, p.z, p.yaw, p.y, { wallMounted: wall, allowKeepClear: false })) return false;
    probe.commit(p);
  }
  l.props.length = 0;
  for (const p of keepProps) l.props.push(p);
  for (const p of copies) g.addProp(p);
  // ceiling tiles (fixture recesses, stains, missing tiles) byte-identical
  for (let lj = 0; lj < a.j1 - a.j0; lj++) for (let li = 0; li < a.i1 - a.i0; li++) {
    l.tiles[cellIdx(b.i0 + li, b.j0 + lj)] = l.tiles[cellIdx(a.i0 + li, a.j0 + lj)];
    const wet = l.flags[cellIdx(a.i0 + li, a.j0 + lj)] & CellFlag.WET;
    l.flags[cellIdx(b.i0 + li, b.j0 + lj)] = (l.flags[cellIdx(b.i0 + li, b.j0 + lj)] & ~CellFlag.WET) | wet;
  }
  // fixtures: B's own (non-structural) fixtures replaced by A's, states copied (never dynamic)
  const src = l.fixtures.filter((f) => f.bakeGroup === 0 && inRect(a, f.px, f.pz));
  const keepF: Fixture[] = l.fixtures.filter((f) => !(f.bakeGroup === 0 && inRect(b, f.px, f.pz)));
  l.fixtures.length = 0;
  for (const f of keepF) l.fixtures.push(f);
  for (const f of src) {
    const { id: _id, seed: _seed, dynamic: _dyn, ...rest } = f;
    const nf = { ...rest, px: f.px + dx, pz: f.pz + dz, state: f.state === LightState.FLICKER ? LightState.DYING : f.state };
    g.addFixture(nf, latticeKeyOf(g, nf.px, nf.pz));
  }
  for (const f of l.fixtures) if (f.bakeGroup === 0 && inRect(b, f.px, f.pz)) f.dynamic = false;
  pairs.set(l, pair);
  return true;
}

/** Re-apply room A's ceiling tiles and WET flags to room B (after tile ageing / leaks, which run later). */
export function syncRepeatedRoom(l: ChunkLayout): void {
  const pr = pairs.get(l);
  if (!pr) return;
  const { a, b } = pr;
  for (let lj = 0; lj < a.j1 - a.j0; lj++) for (let li = 0; li < a.i1 - a.i0; li++) {
    const ca = cellIdx(a.i0 + li, a.j0 + lj), cb = cellIdx(b.i0 + li, b.j0 + lj);
    l.tiles[cb] = l.tiles[ca];
    l.flags[cb] = (l.flags[cb] & ~CellFlag.WET) | (l.flags[ca] & CellFlag.WET);
  }
}

// R2 (B6): a stamped pair of equal rooms in open LOBBY / MANILA floor.
export const STAMP_W = 5, STAMP_D = 6;
const STAMP_ZONES = new Set<number>([Zone.LOBBY, Zone.MANILA]);

/** Fixtures (indices) that intersect or touch (WALL_T) one of the rects without lying inside it; null if a structural
 * one does. */
function straddling(l: ChunkLayout, rects: readonly RoomRect[]): number[] | null {
  const out = new Set<number>();
  const e = 1e-6, T = WALL_T / 2 + 0.01;
  for (const r of rects) {
    const X0 = r.i0 * CELL, Z0 = r.j0 * CELL, X1 = r.i1 * CELL, Z1 = r.j1 * CELL;
    for (let n = 0; n < l.fixtures.length; n++) {
      const [a0, b0, a1, b1] = fixtureXZ(l.fixtures[n]);
      if (a1 <= X0 - T || a0 >= X1 + T || b1 <= Z0 - T || b0 >= Z1 + T) continue;
      if (a0 >= X0 + T - e && b0 >= Z0 + T - e && a1 <= X1 - T + e && b1 <= Z1 - T + e) continue;
      if (l.fixtures[n].bakeGroup !== 0) return null;
      out.add(n);
    }
  }
  return [...out].sort((p, q) => p - q);
}

/** Office leftovers in room A (desk + chair + monitor on one long wall, cabinets on the other, a bin, boxes, and a
 * stacking chair facing a corner), papers on the floor. `n` = the long walls' inward normals (door-free sides). */
function furnishRoom(ctx: ZoneGenContext, a: RoomRect, b: RoomRect, alongX: boolean, rng: Rng): void {
  const l = ctx.grid.layout;
  // A's keepClear plus B's (translated): every prop placed in A must also be allowed at its copy in B
  const keep = computeKeepClear(l);
  for (let lj = 0; lj < a.j1 - a.j0; lj++) for (let li = 0; li < a.i1 - a.i0; li++) {
    if (keep[cellIdx(b.i0 + li, b.j0 + lj)]) keep[cellIdx(a.i0 + li, a.j0 + lj)] = 1;
  }
  const pl = new PropPlacer(ctx, keep);
  const y = l.floorCm[cellIdx(a.i0, a.j0)] / 100;
  const X0 = a.i0 * CELL, Z0 = a.j0 * CELL, X1 = a.i1 * CELL, Z1 = a.j1 * CELL, T = WALL_T / 2;
  // long walls (no doors): for an x-aligned pair the doors are on x lines, so the long walls are the z lines
  const walls = alongX
    ? [{ x: (X0 + X1) / 2, z: Z0 + T, nx: 0, nz: 1, len: X1 - X0 }, { x: (X0 + X1) / 2, z: Z1 - T, nx: 0, nz: -1, len: X1 - X0 }]
    : [{ x: X0 + T, z: (Z0 + Z1) / 2, nx: 1, nz: 0, len: Z1 - Z0 }, { x: X1 - T, z: (Z0 + Z1) / 2, nx: -1, nz: 0, len: Z1 - Z0 }];
  if (rng.chance(0.5)) walls.reverse();
  const at = (w: typeof walls[0], t: number, out: number): [number, number] => [w.x + w.nx * out + Math.abs(w.nz) * t, w.z + w.nz * out + Math.abs(w.nx) * t];
  const span = (w: typeof walls[0], half: number): number => rng.range(-(w.len / 2 - half - 0.1), w.len / 2 - half - 0.1);
  // desk, chair pushed back at an angle, monitor on the desk
  const w0 = walls[0];
  for (let k = 0; k < 4; k++) {
    const t = span(w0, 0.8);
    const [x, z] = at(w0, t, 0.395);
    const desk = pl.tryPlace(PropKind.DESK, rng.int(0, 3), x, y, z, yawOf(w0.nx, w0.nz), rng.next());
    if (!desk) continue;
    if (rng.chance(0.7)) pl.place({ kind: PropKind.CRT_MONITOR, variant: rng.int(0, 3), x: x + Math.abs(w0.nz) * rng.range(-0.3, 0.3) - w0.nx * 0.08, y: y + 0.75, z: z + Math.abs(w0.nx) * rng.range(-0.3, 0.3) - w0.nz * 0.08, yaw: desk.yaw + rng.range(-0.3, 0.3), scale: 1, flags: 0, seed: rng.next() });
    const [cx, cz] = at(w0, t + rng.range(-0.3, 0.3), rng.range(1.05, 1.5));
    pl.tryPlace(PropKind.OFFICE_CHAIR, rng.int(0, 3), cx, y, cz, yawOf(-w0.nx, -w0.nz) + rng.range(-1.2, 1.2), rng.next());
    const [bx, bz] = at(w0, t + (rng.chance(0.5) ? 1 : -1) * 1.0, 0.24);
    pl.tryPlace(PropKind.TRASH_CAN, rng.int(0, 3), bx, y, bz, yawOf(w0.nx, w0.nz), rng.next());
    break;
  }
  // filing cabinets, a water cooler and boxes on the other long wall (a few tries each: the door strips are keepClear)
  const w1 = walls[1];
  const along = (k: PropKindId, out: number, half: number, tries: number, yawAdd = 0): PropPlacement | null => {
    for (let t = 0; t < tries; t++) {
      const [x, z] = at(w1, span(w1, half), out);
      const p = pl.tryPlace(k, rng.int(0, 3), x, y, z, yawOf(w1.nx, w1.nz) + yawAdd, rng.next());
      if (p) return p;
    }
    return null;
  };
  for (let k = 0, n = rng.int(1, 2); k < n; k++) along(PropKind.FILING_CABINET, 0.325, 0.25, 6);
  if (rng.chance(0.5)) along(PropKind.WATER_COOLER, 0.18, 0.18, 4);
  for (let k = 0, n = rng.int(1, 3); k < n; k++) {
    const b = along(PropKind.CARDBOARD_BOX, 0.22, 0.26, 4);
    // (a stacked box keeps the axis yaw: repeatRoom re-checks every copy in B)
    if (b && rng.chance(0.4)) pl.place({ ...b, variant: rng.int(0, 3), y: y + 0.4, seed: rng.next() });
  }
  // the stacking chair facing a corner-ish spot of the long wall
  if (rng.chance(0.7)) {
    for (let t = 0; t < 4; t++) {
      const [x, z] = at(w1, (rng.chance(0.5) ? 1 : -1) * (w1.len / 2 - rng.range(0.45, 0.9)), 0.8);
      if (pl.tryPlace(PropKind.CHAIR_STACKING, rng.int(0, 3), x, y, z, yawOf(-w1.nx, -w1.nz), rng.next())) break;
    }
  }
  for (let k = 0, n = rng.int(1, 3); k < n; k++) {
    ctx.grid.addDecal({ kind: DecalKind.PAPER, sign: false, px: rng.range(X0 + 0.5, X1 - 0.5), py: y, pz: rng.range(Z0 + 0.5, Z1 - 0.5), nx: 0, ny: 1, nz: 0, rot: rng.range(0, 6.28), w: 0.21, h: 0.297, alpha: 0.9, color: PAPER_TINT });
  }
}

/** Stamp a pair of equal STAMP_W x STAMP_D rooms (joined along x or z) into open LOBBY / MANILA floor, furnish A and
 * repeat it into B. Returns the pair or null (nothing changed). */
export function stampRoomPair(ctx: ZoneGenContext, rng: Rng): RoomPair | null {
  const g = ctx.grid, l = g.layout;
  const none = new Uint8Array(N * N);
  interface Cand { i0: number; j0: number; alongX: boolean; cost: number; h: number }
  const cands: Cand[] = [];
  for (const alongX of [true, false]) {
    const W = alongX ? 2 * STAMP_W : STAMP_D, D = alongX ? STAMP_D : 2 * STAMP_W;
    for (let j0 = 1; j0 + D <= N - 1; j0++) for (let i0 = 1; i0 + W <= N - 1; i0++) {
      const c0 = cellIdx(i0, j0);
      if (!STAMP_ZONES.has(l.cellZone[c0]) || l.ceilCm[c0] - l.floorCm[c0] < 240) continue;
      // neither room may cross a render-tile line (B's copied troffers would straddle it)
      const T = TILE_CELLS;
      if (alongX ? (i0 < T && i0 + STAMP_W > T) || (i0 + STAMP_W < T && i0 + W > T) : (i0 < T && i0 + W > T)) continue;
      if (alongX ? (j0 < T && j0 + D > T) : (j0 < T && j0 + STAMP_W > T) || (j0 + STAMP_W < T && j0 + D > T)) continue;
      if (!rectFree(l, none, i0, j0, i0 + W, j0 + D, true)) continue;
      let inner = 0;
      for (let j = j0; j < j0 + D; j++) for (let i = i0 + 1; i < i0 + W; i++) if (l.ex.kind[exIdx(i, j)] !== EdgeKind.OPEN) inner++;
      for (let j = j0 + 1; j < j0 + D; j++) for (let i = i0; i < i0 + W; i++) if (l.ez.kind[ezIdx(i, j)] !== EdgeKind.OPEN) inner++;
      cands.push({ i0, j0, alongX, cost: inner * 0.25, h: rng.next() });
    }
  }
  if (cands.length === 0) return null;
  const rects = (c: Cand): [RoomRect, RoomRect] => c.alongX
    ? [{ id: 0, i0: c.i0, j0: c.j0, i1: c.i0 + STAMP_W, j1: c.j0 + STAMP_D }, { id: 0, i0: c.i0 + STAMP_W, j0: c.j0, i1: c.i0 + 2 * STAMP_W, j1: c.j0 + STAMP_D }]
    : [{ id: 0, i0: c.i0, j0: c.j0, i1: c.i0 + STAMP_D, j1: c.j0 + STAMP_W }, { id: 0, i0: c.i0, j0: c.j0 + STAMP_W, i1: c.i0 + STAMP_D, j1: c.j0 + 2 * STAMP_W }];
  for (const c of cands) {
    const s = straddling(l, rects(c));
    c.cost += s === null ? 1e9 : s.length;
  }
  cands.sort((p, q) => p.cost - q.cost || p.h - q.h);
  let before: Uint8Array | null = null;
  for (const c of cands.slice(0, 16)) {
    if (c.cost >= 1e9) break;
    const [A, B] = rects(c);
    const X0 = A.i0 * CELL, Z0 = A.j0 * CELL, X1 = B.i1 * CELL, Z1 = B.j1 * CELL;
    // props must lie inside one room; no vignette may live in the region (its props would be replaced)
    let ok = true;
    for (const p of propsInRect(l, X0 - 0.05, Z0 - 0.05, X1 + 0.05, Z1 + 0.05)) {
      const b = propAABB(p.kind, p.x, p.z, p.yaw, 0.05);
      const inside = (r: RoomRect): boolean => b.x0 >= r.i0 * CELL && b.z0 >= r.j0 * CELL && b.x1 <= r.i1 * CELL && b.z1 <= r.j1 * CELL;
      if (!inside(A) && !inside(B)) { ok = false; break; }
    }
    for (const v of l.vignettes) if (v.x >= X0 - 1 && v.x < X1 + 1 && v.z >= Z0 - 1 && v.z < Z1 + 1) ok = false;
    // door leaves hung on the region's old openings would end up in (or against) the new walls
    for (const p of propsInRect(l, X0 - 1.0, Z0 - 1.0, X1 + 1.0, Z1 + 1.0)) if (p.kind === PropKind.DOOR_LEAF) ok = false;
    if (!ok) continue;
    // three doors in one line: A's outer wall, the shared wall, B's outer wall
    const f0 = l.floorCm[cellIdx(A.i0, A.j0)];
    const outOk = (a: number, b: number): boolean => inChunk(a, b) && isOpenFloor(l, cellIdx(a, b)) && l.floorCm[cellIdx(a, b)] === f0;
    const rows: number[] = [];
    for (let r = 1; r < STAMP_D - 1; r++) {
      if (c.alongX ? outOk(A.i0 - 1, A.j0 + r) && outOk(B.i1, A.j0 + r) : outOk(A.i0 + r, A.j0 - 1) && outOk(A.i0 + r, B.j1)) {
        // nothing may stand in front of the outer doors (props were placed before the doors existed)
        const free = c.alongX
          ? doorApproachFree(l, 'x', A.i0, A.j0 + r) && doorApproachFree(l, 'x', B.i1, A.j0 + r)
          : doorApproachFree(l, 'z', A.i0 + r, A.j0) && doorApproachFree(l, 'z', A.i0 + r, B.j1);
        if (free) rows.push(r);
      }
    }
    if (rows.length === 0) continue;
    // middle rows first: the door strips (keepClear) then stay off the long walls, which carry the furniture
    const mid = rows.filter((r) => r >= 2 && r <= STAMP_D - 3);
    const pickFrom = mid.length > 0 ? mid : rows;
    const r = pickFrom[rng.int(0, pickFrom.length - 1)];
    const doorsA = c.alongX
      ? [{ axis: 'x' as const, i: A.i0, j: A.j0 + r }, { axis: 'x' as const, i: A.i1, j: A.j0 + r }]
      : [{ axis: 'z' as const, i: A.i0 + r, j: A.j0 }, { axis: 'z' as const, i: A.i0 + r, j: A.j1 }];
    const doorsB = c.alongX
      ? [{ axis: 'x' as const, i: B.i0, j: B.j0 + r }, { axis: 'x' as const, i: B.i1, j: B.j0 + r }]
      : [{ axis: 'z' as const, i: B.i0 + r, j: B.j0 }, { axis: 'z' as const, i: B.i0 + r, j: B.j1 }];
    before ??= portReach(l);
    const trim = l.ex.trim[exIdx(A.i0, A.j0)] & ~EdgeTrim.CASING;
    const ed = wallRect(g, A.i0, A.j0, A.i1, A.j1, doorsA, trim, true);
    wallRect(g, B.i0, B.j0, B.i1, B.j1, doorsB, trim, true, ed);
    if (!reachKept(before, portReach(l))) { ed.revert(); continue; }
    // wall-mounted props outside a new door opening would float in the hole
    const doorGone = new Set<PropPlacement>();
    for (const d of [...doorsA, doorsB[1]]) {
      const ex = d.axis === 'x' ? d.i * CELL : (d.i + 0.5) * CELL, ez = d.axis === 'x' ? (d.j + 0.5) * CELL : d.j * CELL;
      for (const p of l.props) if (PROP_DEFS[p.kind]?.wallMounted && Math.abs(p.x - ex) < 0.7 && Math.abs(p.z - ez) < 0.7) doorGone.add(p);
    }
    removeFixtures(l, straddling(l, [A, B]) ?? []);
    // start from empty rooms: rule props / traces inside go, A is furnished, B repeats it
    const keepProps = l.props.filter((p) => !doorGone.has(p) && (!(p.x >= X0 && p.x < X1 && p.z >= Z0 && p.z < Z1) || (p.flags & PropFlag.CEILING) !== 0));
    l.props.length = 0;
    for (const p of keepProps) l.props.push(p);
    for (let j = A.j0; j < B.j1; j++) for (let i = A.i0; i < B.i1; i++) l.flags[cellIdx(i, j)] &= ~CellFlag.WET;
    labelRooms(l);
    A.id = l.room[cellIdx(A.i0, A.j0)]; B.id = l.room[cellIdx(B.i0, B.j0)];
    furnishRoom(ctx, A, B, c.alongX, rng.fork(1));
    return { a: A, b: B };
  }
  return null;
}

// ------------------------------------------------------------------------------------------ CEILING_FURNITURE

const FURNITURE = new Set<number>([PropKind.CHAIR_STACKING, PropKind.OFFICE_CHAIR, PropKind.DESK, PropKind.CONFERENCE_TABLE]);

/** Is there any pair of floor furniture props in one room within 6 m of each other (under a >= 2.3 m ceiling)? */
function hasGroup(l: ChunkLayout, cand: readonly PropPlacement[]): boolean {
  const roomOf = (p: PropPlacement): number => {
    const li = Math.floor(p.x / CELL), lj = Math.floor(p.z / CELL);
    return inChunk(li, lj) ? l.room[cellIdx(li, lj)] : -1;
  };
  for (let a = 0; a < cand.length; a++) for (let b = a + 1; b < cand.length; b++) {
    const p = cand[a], q = cand[b];
    if ((p.x - q.x) * (p.x - q.x) + (p.z - q.z) * (p.z - q.z) <= 36 && roomOf(p) === roomOf(q) && roomOf(p) > 0) return true;
  }
  return false;
}

/** R2 (B6): a loose ring of 4-6 stacking chairs facing each other in open L0 floor (a meeting nobody attended),
 * for rooms without a furniture group. Returns the chairs placed. */
export function chairRing(ctx: ZoneGenContext, rng: Rng): PropPlacement[] {
  const l = ctx.grid.layout;
  const pl = new PropPlacer(ctx, computeKeepClear(l));
  const D = pl.space.distance();
  const spots: number[] = [];
  for (let c = 0; c < N * N; c++) {
    if (l.cellZone[c] > Zone.OFFICE || !isOpenFloor(l, c) || pl.space.keep[c] || l.ceilCm[c] - l.floorCm[c] < 240) continue;
    if ((l.flags[c] & (CellFlag.LANDMARK | CellFlag.RESERVED | CellFlag.NO_CEIL)) !== 0) continue;
    const px = Math.min(OCC_N - 1, Math.floor((((c & 31) + 0.5) * CELL) / OCC_RES)), pz = Math.min(OCC_N - 1, Math.floor((((c >> 5) + 0.5) * CELL) / OCC_RES));
    if (D[pz * OCC_N + px] >= 7) spots.push(c);
  }
  rng.shuffle(spots);
  // spots with no fixture over the ring first: ceilingFurniture skips a copy within 1 m of a fixture, so a ring under
  // a troffer ends up with a single chair on the ceiling (verify pass: 1 of 3-5 mirrored in about half the rings)
  const RING_CLEAR = 1.2 + 1.0;
  const clear = (c: number): boolean => {
    const [x, z] = ctx.grid.cellCenter(c & 31, c >> 5);
    return !l.fixtures.some((f) => (f.px - x) * (f.px - x) + (f.pz - z) * (f.pz - z) < RING_CLEAR * RING_CLEAR);
  };
  const ordered = [...spots.filter(clear), ...spots.filter((c) => !clear(c))];
  for (const c of ordered.slice(0, 12)) {
    const [cx, cz] = ctx.grid.cellCenter(c & 31, c >> 5);
    const y = l.floorCm[c] / 100, n = rng.int(4, 6), a0 = rng.range(0, Math.PI * 2), v = rng.int(0, 3);
    const out: PropPlacement[] = [];
    for (let k = 0; k < n; k++) {
      const a = a0 + (k / n) * Math.PI * 2 + rng.range(-0.15, 0.15), r = rng.range(0.95, 1.2);
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const p = pl.tryPlace(PropKind.CHAIR_STACKING, v, x, y, z, yawOf(cx - x, cz - z) + rng.range(-0.25, 0.25), rng.next());
      if (p) out.push(p);
    }
    if (out.length >= 3) return out;
    // not enough room: take them back
    const drop = new Set(out);
    const keep = l.props.filter((p) => !drop.has(p));
    l.props.length = 0;
    for (const p of keep) l.props.push(p);
    pl.rebuild();
  }
  return [];
}

/** The members of a furniture group (around a random grouped member of `cand`: same room, within 6 m) that can be
 * mirrored: ceiling >= 2.3 m (head room under the copy) and no fixture within 1 m. */
function mirrorable(l: ChunkLayout, cand: readonly PropPlacement[], rng: Rng): PropPlacement[] {
  if (cand.length < 2) return [];
  const grouped = cand.filter((p) => cand.some((q) => q !== p && (p.x - q.x) * (p.x - q.x) + (p.z - q.z) * (p.z - q.z) <= 36));
  const pool = grouped.length > 0 ? grouped : cand;
  const seed = pool[rng.int(0, pool.length - 1)];
  const room = l.room[cellIdx(Math.floor(seed.x / CELL), Math.floor(seed.z / CELL))];
  // the room's furniture near the seed prop (LOBBY rooms are huge: stay within 6 m)
  const group = cand.filter((p) => {
    const li = Math.floor(p.x / CELL), lj = Math.floor(p.z / CELL);
    if (!inChunk(li, lj) || l.room[cellIdx(li, lj)] !== room) return false;
    const ex = p.x - seed.x, ez = p.z - seed.z;
    return ex * ex + ez * ez <= 36;
  });
  if (group.length < 2) return [];
  return group.filter((p) => {
    const c = cellIdx(Math.floor(p.x / CELL), Math.floor(p.z / CELL));
    if (l.ceilCm[c] - l.floorCm[c] < 230) return false;
    return !l.fixtures.some((f) => (f.px - p.x) * (f.px - p.x) + (f.pz - p.z) * (f.pz - p.z) < 1.0);
  });
}

export function ceilingFurniture(ctx: ZoneGenContext, rng: Rng): boolean {
  const g = ctx.grid, l = g.layout;
  const cand = l.props.filter((p) => FURNITURE.has(p.kind) && (p.flags & PropFlag.CEILING) === 0);
  let up = cand.length >= 2 && hasGroup(l, cand) ? mirrorable(l, cand, rng) : [];
  // R2 verify: a lone mirrored chair (the rest of a loose group under troffers / 6 m away) barely reads as the
  // anomaly: Level 0 chunks then set out the chair ring instead
  if (up.length < 2 && ctx.district.zone <= Zone.OFFICE) {
    const ring = mirrorable(l, chairRing(ctx, rng.fork(3)), rng);
    if (ring.length >= 2) up = ring;
  }
  if (up.length === 0) return false;
  let sx = 0, sz = 0, r = 1;
  for (const p of up) {
    const c = cellIdx(Math.floor(p.x / CELL), Math.floor(p.z / CELL));
    g.addProp({ ...p, y: l.ceilCm[c] / 100, flags: PropFlag.CEILING });
    sx += p.x; sz += p.z;
  }
  sx /= up.length; sz /= up.length;
  for (const p of up) r = Math.max(r, Math.sqrt((p.x - sx) * (p.x - sx) + (p.z - sz) * (p.z - sz)) + 1);
  g.addAnomaly(AnomalyKind.CEILING_FURNITURE, sx, sz, r);
  return true;
}

// ------------------------------------------------------------------------------------------ entry

export function placeAnomalies(ctx: ZoneGenContext): void {
  const g = ctx.grid, l = g.layout, { s, cx, cz } = ctx.key;
  const rng = rngFor(ctx.seed, SALT.ANOMALY, s, cx, cz, 3);
  const pEcho = rng.float(), pRoom = rng.float(), pCeil = rng.float();
  const pick = rng.next();

  if (pEcho < LATE_ECHO_P) {
    const runs = corridorRuns(l, corridorWidth);
    if (runs.length > 0) {
      const r = runs[pick % runs.length];
      const mid = Math.floor(r.len / 2);
      const li = r.axis === 0 ? r.li + mid : r.li, lj = r.axis === 0 ? r.lj : r.lj + mid;
      const [x, z] = g.cellCenter(li, lj);
      g.addAnomaly(AnomalyKind.LATE_ECHO, x, z, 6);
    }
  }
  if (pRoom < REPEATED_ROOM_P && ctx.district.zone <= Zone.OFFICE) {
    const site = (pr: RoomPair): void => {
      const { b } = pr;
      const x = ((b.i0 + b.i1) / 2) * CELL, z = ((b.j0 + b.j1) / 2) * CELL;
      const hw = ((b.i1 - b.i0) * CELL) / 2, hd = ((b.j1 - b.j0) * CELL) / 2;
      g.addAnomaly(AnomalyKind.REPEATED_ROOM, x, z, Math.sqrt(hw * hw + hd * hd));
    };
    const prs = roomPairs(l);
    let done = false;
    for (let k = 0; k < prs.length && !done; k++) {
      const pr = prs[(pick + k) % prs.length];
      if (repeatRoom(ctx, pr)) { site(pr); done = true; }
    }
    if (!done) {
      const pr = stampRoomPair(ctx, rng.fork(5));
      if (pr && repeatRoom(ctx, pr)) site(pr);
    }
  }
  if (pCeil < CEILING_FURNITURE_P) ceilingFurniture(ctx, rng.fork(9));
}
