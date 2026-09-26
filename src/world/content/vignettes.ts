// src/world/content/vignettes.ts — global vignette candidates and chunk-local compositions (WP4, R2 B6).
//
// Candidates: one per cell of a global VIG_GRID (11 m) grid at a hashed position, kept with p VIG_KEEP_P (0.6), kind
// weighted by the zone at the candidate. A kept candidate is dropped if a kept candidate of a neighbouring grid cell
// with a lower hash lies within VIG_DROP. A candidate is placed only by the chunk that contains it, only if the local
// space fits (no retry elsewhere: determinism). R2 (B6): grid 18 -> 11 m, keep 0.45 -> 0.6, spacing 18 -> 10 m (about
// three times the small moments of WP4, see docs/contract-changes/R2-content.md).
//
// Realised spacing: a composition may shift its anchor up to VIG_SHIFT_MAX from the candidate point. To keep the
// realised vignettes >= VIG_MIN_SPACING apart, a candidate's anchor must lie >= VIG_MIN_SPACING + VIG_SHIFT_MAX from
// every surviving candidate with a lower hash (whose own anchor is within VIG_SHIFT_MAX of it); the lower-hash
// candidate keeps priority, exactly as in the drop rule. Anchors that violate it count as "the local space does not fit".
//
// After the vignettes, placeVignettes runs the trace layer and the district prop clusters (props.ts).

import { CELL, CHUNK_SIZE, DOOR_CM, WALL_T } from '../../core/constants.ts';
import {
  AnomalyKind, CeilKind, CellFlag, DecalKind, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, LightState, PropKind, SALT, STRATA_WEIGHTS, TileState, Zone,
  cellIdx, exIdx, ezIdx, getTile, hash01, hash2, hash5, isRecessedFixture, Rng, setTile, worldToCell,
} from '../../core/index.ts';
import type { ChunkGrid, ChunkLayout, EmitterKindId, Fixture, MatId, PropKindId, PropPlacement, StoreyId, VignetteKindId, ZoneGenContext, ZoneId } from '../../core/index.ts';
import { labelRooms } from '../rooms.ts';
import { yawOf } from '../structures/frame.ts';
import { placeLeaf } from '../structures/doors.ts';
import { kelvinToLinearRGB } from './kelvin.ts';
import { EdgeEdits, OCC_N, OCC_RES, PlacementSpace, portReach, propsInRect, reachKept } from './occupancy.ts';
import { defaultPropFlags, PAPER_TINT, placeDistrictClusters, placeTraces, PropPlacer } from './props.ts';
import { addLatticeFixture, fixtureAt, inChunk, isOpenFloor, isSeamSide, N, sideIsWall, wallFaceOf } from './util.ts';

export const VIG_GRID = 11;
export const VIG_KEEP_P = 0.6;
/** Compositions anchor within this many cells (Chebyshev) of the candidate's cell. */
export const VIG_REACH_CELLS = 2;
/** Max distance between a candidate point and its realised anchor. */
export const VIG_SHIFT_MAX = (VIG_REACH_CELLS + 0.5) * CELL * Math.SQRT2 + 0.8;
/** Drop radius between kept candidates (§5 had 18 m; R2: the grid pitch). */
export const VIG_DROP = VIG_GRID;
/** Minimum spacing of realised vignettes (R2: 10 m). */
export const VIG_MIN_SPACING = 10;
const RING = Math.ceil(VIG_DROP / VIG_GRID);

/** Relative weights per vignette kind (rows) and zone family column:
 * 0 L0 family (LOBBY..OFFICE), 1 POOLROOMS, 2 PARKING, 3 PIPEWORKS, 4 WAREHOUSE, 5 CONCRETE. */
export const VIGNETTE_WEIGHTS: readonly (readonly number[])[] = [
  [10, 3, 2, 2, 2, 4], // CHAIR_FACING_WALL
  [6, 8, 3, 2, 3, 3], // WET_FLOOR_SIGNS
  [8, 0, 0, 0, 0, 0], // FALLEN_TILES (requires ceilKind TILES)
  [5, 3, 3, 1, 2, 3], // LONE_DOORFRAME
  [4, 1, 1, 3, 2, 4], // MATTRESS_CLOSET
  [4, 2, 5, 5, 4, 5], // SPARKING_FIXTURE
  [3, 2, 3, 3, 3, 3], // RADIO
  [3, 1, 2, 1, 1, 2], // RINGING_PHONE
  [3, 2, 3, 4, 4, 4], // BACKPACK_CAMP
  [0, 10, 0, 0, 0, 0], // POOL_FLOAT
  [0, 0, 8, 0, 0, 0], // OPEN_CAR
  [0, 0, 0, 0, 8, 1], // COLLAPSED_RACK
  [0, 1, 1, 8, 2, 4], // STEAM_LEAK
];
export const zoneColumn = (z: ZoneId): number => (z <= Zone.OFFICE ? 0 : z - Zone.OFFICE);

function weightsFor(s: StoreyId, zone: ZoneId | null): number[] {
  const out = new Array<number>(VIGNETTE_WEIGHTS.length).fill(0);
  if (zone !== null) {
    const col = zoneColumn(zone);
    for (let k = 0; k < out.length; k++) out[k] = VIGNETTE_WEIGHTS[k][col];
    return out;
  }
  const sw = STRATA_WEIGHTS[s];
  for (let z = 0; z < sw.length; z++) {
    if (sw[z] === 0) continue;
    const col = zoneColumn(z as ZoneId);
    for (let k = 0; k < out.length; k++) out[k] += sw[z] * VIGNETTE_WEIGHTS[k][col];
  }
  return out;
}

function pickWeighted(w: readonly number[], u: number): number {
  let sum = 0;
  for (const v of w) sum += v;
  let r = u * sum;
  for (let i = 0; i < w.length; i++) { r -= w[i]; if (r < 0) return i; }
  return w.length - 1;
}

interface RawCand { x: number; z: number; h: number; kept: boolean; gx: number; gz: number }
function rawCandidate(seed: number, s: StoreyId, gx: number, gz: number): RawCand {
  const h = hash5(seed, SALT.VIGNETTE, s, gx, gz);
  return {
    x: (gx + hash01(hash2(h, 1))) * VIG_GRID, z: (gz + hash01(hash2(h, 2))) * VIG_GRID,
    h, kept: hash01(hash2(h, 3)) < VIG_KEEP_P, gx, gz,
  };
}
function survives(seed: number, s: StoreyId, c: RawCand): boolean {
  if (!c.kept) return false;
  for (let dz = -RING; dz <= RING; dz++) {
    for (let dx = -RING; dx <= RING; dx++) {
      if (dx === 0 && dz === 0) continue;
      const o = rawCandidate(seed, s, c.gx + dx, c.gz + dz);
      if (!o.kept) continue;
      if (!beats(o, c)) continue;
      const ex = o.x - c.x, ez = o.z - c.z;
      if (ex * ex + ez * ez < VIG_DROP * VIG_DROP) return false;
    }
  }
  return true;
}

/** Lower-hash priority order between two kept candidates (hash, then grid position). */
const beats = (o: RawCand, c: RawCand): boolean => o.h < c.h || (o.h === c.h && (o.gz < c.gz || (o.gz === c.gz && o.gx < c.gx)));

/** Surviving candidates that have priority over `c` and lie close enough to constrain its anchor (world metres). */
function priorNeighbours(seed: number, s: StoreyId, c: RawCand): [number, number][] {
  const reach = VIG_MIN_SPACING + 2 * VIG_SHIFT_MAX;
  const ring = Math.ceil(reach / VIG_GRID);
  const out: [number, number][] = [];
  for (let dz = -ring; dz <= ring; dz++) {
    for (let dx = -ring; dx <= ring; dx++) {
      if (dx === 0 && dz === 0) continue;
      const o = rawCandidate(seed, s, c.gx + dx, c.gz + dz);
      if (!o.kept || !beats(o, c)) continue;
      const ex = o.x - c.x, ez = o.z - c.z;
      if (ex * ex + ez * ez >= reach * reach) continue;
      if (survives(seed, s, o)) out.push([o.x, o.z]);
    }
  }
  return out;
}

/** World metres. `zoneAt` (optional, WP4 extension) gives the zone at a candidate for the kind weights; without it
 * the weights are the storey's STRATA_WEIGHTS mixture. */
export function vignetteCandidates(seed: number, s: StoreyId, x0: number, z0: number, x1: number, z1: number, zoneAt?: (x: number, z: number) => ZoneId): { x: number; z: number; kind: VignetteKindId; seed: number; alts: VignetteKindId[] }[] {
  return candidatesIn(seed, s, x0, z0, x1, z1, zoneAt).map((c) => ({ x: c.x, z: c.z, kind: c.kind, seed: c.seed, alts: c.alts }));
}

interface Cand { x: number; z: number; kind: VignetteKindId; seed: number; raw: RawCand; alts: VignetteKindId[] }

/** Fallback kinds tried (in order) when the candidate's own composition does not fit the local space (pacing: open
 * halls and pool halls have few walls, so wall-bound kinds failed there ~90% of the time and left long empty
 * stretches). Picked from the same zone weights without the kinds already tried. */
export const VIG_ALT_KINDS = 2;
function candidatesIn(seed: number, s: StoreyId, x0: number, z0: number, x1: number, z1: number, zoneAt?: (x: number, z: number) => ZoneId): Cand[] {
  const out: Cand[] = [];
  const g0x = Math.floor(x0 / VIG_GRID), g1x = Math.floor(x1 / VIG_GRID);
  const g0z = Math.floor(z0 / VIG_GRID), g1z = Math.floor(z1 / VIG_GRID);
  for (let gz = g0z; gz <= g1z; gz++) {
    for (let gx = g0x; gx <= g1x; gx++) {
      const c = rawCandidate(seed, s, gx, gz);
      if (c.x < x0 || c.x >= x1 || c.z < z0 || c.z >= z1) continue;
      if (!survives(seed, s, c)) continue;
      const w = weightsFor(s, zoneAt ? zoneAt(c.x, c.z) : null);
      const kind = pickWeighted(w, hash01(hash2(c.h, 4))) as VignetteKindId;
      const alts: VignetteKindId[] = [];
      const wa = w.slice();
      wa[kind] = 0;
      for (let a = 0; a < VIG_ALT_KINDS && wa.some((x) => x > 0); a++) {
        const k = pickWeighted(wa, hash01(hash2(c.h, 6 + a))) as VignetteKindId;
        alts.push(k);
        wa[k] = 0;
      }
      out.push({ x: c.x, z: c.z, kind, seed: hash2(c.h, 5), raw: c, alts });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------ compositions

interface Anchor { x: number; z: number; yaw: number }
interface VCtx {
  ctx: ZoneGenContext; pl: PropPlacer; rng: Rng; cells: number[]; lx: number; lz: number;
  /** May the vignette anchor sit at chunk-local (x, z)? (realised spacing, see the header) */
  ok: (x: number, z: number) => boolean;
}
type Composer = (v: VCtx) => Anchor | null;

const floorY = (v: VCtx, c: number): number => v.ctx.grid.layout.floorCm[c] / 100;
const at = (c: number): [number, number] => [((c & 31) + 0.5) * CELL, ((c >> 5) + 0.5) * CELL];

/** Rotate a prop-local offset (ox, oz) by an axis-aligned yaw (quarter turns; no trigonometry). */
function rotQ(yaw: number, ox: number, oz: number): [number, number] {
  const q = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4;
  // R_y(yaw): x' = c*x + s*z, z' = -s*x + c*z (core/writer.ts convention)
  switch (q) {
    case 0: return [ox, oz];
    case 1: return [oz, -ox];
    case 2: return [-ox, -oz];
    default: return [-oz, ox];
  }
}

/** Real WALL (or SOLID) sides of a cell that are not chunk seams. */
function wallSides(v: VCtx, c: number): number[] {
  const l = v.ctx.grid.layout, li = c & 31, lj = c >> 5;
  const out: number[] = [];
  for (let d = 0; d < 4; d++) if (!isSeamSide(li, lj, d) && sideIsWall(l, li, lj, d)) out.push(d);
  return out;
}

const chairFacingWall: Composer = (v) => {
  const def = 0.52;
  for (const c of v.cells) {
    const sides = wallSides(v, c);
    if (sides.length === 0) continue;
    const d = sides[v.rng.int(0, sides.length - 1)];
    const f = wallFaceOf(c & 31, c >> 5, d);
    const x = f.x + f.nx * (0.5 + def / 2), z = f.z + f.nz * (0.5 + def / 2);
    const yaw = yawOf(-f.nx, -f.nz);
    if (!v.ok(x, z)) continue;
    if (v.pl.tryPlace(PropKind.CHAIR_STACKING, v.rng.int(0, 2), x, floorY(v, c), z, yaw, v.rng.next())) return { x, z, yaw };
  }
  return null;
};

const wetFloorSigns: Composer = (v) => {
  const l = v.ctx.grid.layout;
  for (const c of v.cells) {
    const n = v.rng.int(3, 5);
    const alongX = v.rng.chance(0.5);
    const [cx, cz] = at(c);
    if (!v.ok(cx, cz)) continue;
    const yaw = alongX ? (v.rng.chance(0.5) ? 0 : Math.PI) : (v.rng.chance(0.5) ? Math.PI / 2 : -Math.PI / 2);
    const pts: [number, number][] = [];
    for (let k = 0; k < n; k++) {
      const o = (k - (n - 1) / 2) * 0.85;
      pts.push(alongX ? [cx + o, cz] : [cx, cz + o]);
    }
    const y = floorY(v, c);
    if (!pts.every(([x, z]) => v.pl.space.fits(PropKind.WET_FLOOR_SIGN, x, z, yaw, y))) continue;
    let placed = 0;
    for (const [x, z] of pts) if (v.pl.tryPlace(PropKind.WET_FLOOR_SIGN, 0, x, y, z, yaw + v.rng.range(-0.2, 0.2), v.rng.next())) placed++;
    if (placed === 0) continue;
    // wet strip under the row + wet footprints crossing it
    for (const [x, z] of pts) {
      const li = worldToCell(x), lj = worldToCell(z);
      if (inChunk(li, lj) && isOpenFloor(l, cellIdx(li, lj))) v.ctx.grid.setCells(li, lj, li + 1, lj + 1, { flagsSet: CellFlag.WET });
    }
    v.ctx.grid.addDecal({ kind: DecalKind.FOOTPRINTS_WET, sign: false, px: cx, py: y, pz: cz, nx: 0, ny: 1, nz: 0, rot: alongX ? 0 : Math.PI / 2, w: 0.5, h: 1.1, alpha: 0.75 });
    return { x: cx, z: cz, yaw };
  }
  return null;
};

const fallenTiles: Composer = (v) => {
  const l = v.ctx.grid.layout;
  for (const c of v.cells) {
    if (l.ceilKind[c] !== CeilKind.TILES) continue;
    if (!v.ok(...at(c))) continue;
    const li = c & 31, lj = c >> 5;
    const opts: [number, number][] = [];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = li + di, b = lj + dj;
      if (!inChunk(a, b)) continue;
      const cc = cellIdx(a, b);
      if (l.ceilKind[cc] !== CeilKind.TILES || !isOpenFloor(l, cc) || l.floorCm[cc] !== l.floorCm[c]) continue;
      for (let t = 0; t < 4; t++) if (getTile(l.tiles, cc, t) === TileState.NORMAL || getTile(l.tiles, cc, t) === TileState.STAINED) opts.push([cc, t]);
    }
    // prefer tiles close to the anchor cell
    opts.sort((p, q) => (p[0] === c ? 0 : 1) - (q[0] === c ? 0 : 1) || p[0] - q[0] || p[1] - q[1]);
    const n = v.rng.int(2, 4);
    if (opts.length < n) continue;
    const picked = opts.slice(0, Math.min(opts.length, n + 2));
    v.rng.shuffle(picked);
    let done = 0;
    for (const [cc, t] of picked.slice(0, n)) {
      setTile(l.tiles, cc, t, TileState.MISSING);
      const x = ((cc & 31) + 0.25 + 0.5 * (t & 1)) * CELL, z = ((cc >> 5) + 0.25 + 0.5 * (t >> 1)) * CELL;
      const y = l.floorCm[cc] / 100;
      v.pl.tryPlace(PropKind.TILE_FRAGMENT, v.rng.int(0, 3), x + v.rng.range(-0.15, 0.15), y, z + v.rng.range(-0.15, 0.15), v.rng.range(0, 6.28), v.rng.next(), { allowKeepClear: true });
      if (done === 0) v.pl.tryPlace(PropKind.CEILING_DEBRIS, v.rng.int(0, 3), x, y, z, v.rng.int(0, 3) * Math.PI / 2, v.rng.next(), { allowKeepClear: true });
      done++;
    }
    const [x, z] = at(c);
    return { x, z, yaw: 0 };
  }
  // R2 (B6): no tiled ceiling in reach (storey 1 Level 0 has concrete slabs): spalled ceiling instead, a crumbled
  // heap under a dripping spot of the slab
  if (l.ceilKind[v.cells[0] ?? 0] === CeilKind.TILES) return null;
  for (const c of v.cells) {
    if (l.ceilKind[c] === CeilKind.OPEN_DARK || (l.flags[c] & CellFlag.NO_CEIL) !== 0) continue;
    const [cx, cz] = at(c);
    const x = cx + v.rng.range(-0.1, 0.1), z = cz + v.rng.range(-0.1, 0.1);
    if (!v.ok(x, z)) continue;
    const y = floorY(v, c);
    const p = v.pl.tryPlace(PropKind.CEILING_DEBRIS, v.rng.chance(0.5) ? 3 : 0, x, y, z, v.rng.int(0, 3) * Math.PI / 2, v.rng.next(), { allowKeepClear: true });
    if (!p) continue;
    v.ctx.grid.addEmitter(EmitterKind.DRIP, x, y + 0.02, z, 0.3);
    v.ctx.grid.addDecal({ kind: DecalKind.WATER_STAIN, sign: false, px: x, py: y, pz: z, nx: 0, ny: 1, nz: 0, rot: v.rng.range(0, 6.28), w: 1.6, h: 1.4, alpha: 0.6 });
    return { x, z, yaw: 0 };
  }
  return null;
};

const loneDoorframe: Composer = (v) => {
  const D = v.pl.space.distance();
  for (const c of v.cells) {
    const [x, z] = at(c);
    const px = Math.min(OCC_N - 1, Math.floor(x / OCC_RES)), pz = Math.min(OCC_N - 1, Math.floor(z / OCC_RES));
    if (D[pz * OCC_N + px] < 4) continue; // >= ~1.2 m of free floor around the frame
    if (!v.ok(x, z)) continue;
    const yaw = v.rng.int(0, 3) * (Math.PI / 2);
    if (v.pl.tryPlace(PropKind.DOOR_FRAME, 0, x, floorY(v, c), z, yaw, v.rng.next())) return { x, z, yaw };
  }
  return null;
};

// ------------------------------------------------------------------ MATTRESS_CLOSET
// R2 (B6): Level 0 "rooms" are huge, so a 2-6 cell room almost never exists. The closet carves its own 2x2 / 2x3
// pocket into a room corner (>= 2 sides already WALL, the others OPEN): the open sides become WALL with one DOORWAY,
// a DOOR_LEAF hangs ajar into it, a mattress lies against its back wall and one bare CAGE_BULB hangs from the
// ceiling (the lattice fixtures inside are removed). Every cell reachable from the ports before stays reachable,
// else the edit is reverted. Falls back to an existing small room.

const CLOSET_SIZES: readonly (readonly [number, number])[] = [[2, 2], [2, 3], [3, 2]];
export interface ClosetRect { i0: number; j0: number; i1: number; j1: number; door: { axis: 'x' | 'z'; i: number; j: number; side: -1 | 1 } }

/** xz rect of a fixture (RECT: w along t, h across; SPHERE: w diameter). */
export function fixtureXZ(f: Fixture): [number, number, number, number] {
  const hw = f.w / 2, hh = f.shape === 0 ? f.h / 2 : f.w / 2;
  const alongX = Math.abs(f.tx) >= Math.abs(f.tz);
  return alongX ? [f.px - hw, f.pz - hh, f.px + hw, f.pz + hh] : [f.px - hh, f.pz - hw, f.px + hh, f.pz + hw];
}

/** Fixtures (bakeGroup 0) whose rect lies inside the cell rect; null if one straddles or touches its border walls
 * (WALL_T thick) or is structural. */
export function fixturesInside(l: ChunkLayout, i0: number, j0: number, i1: number, j1: number): number[] | null {
  const X0 = i0 * CELL, Z0 = j0 * CELL, X1 = i1 * CELL, Z1 = j1 * CELL, e = 1e-6, T = WALL_T / 2 + 0.01;
  const out: number[] = [];
  for (let n = 0; n < l.fixtures.length; n++) {
    const [a0, b0, a1, b1] = fixtureXZ(l.fixtures[n]);
    // touching the (thick) boundary walls counts as straddling
    if (a1 <= X0 - T || a0 >= X1 + T || b1 <= Z0 - T || b0 >= Z1 + T) continue;
    const f = l.fixtures[n];
    if (f.bakeGroup !== 0 || a0 < X0 - e || b0 < Z0 - e || a1 > X1 + e || b1 > Z1 + e) return null;
    out.push(n);
  }
  return out;
}

/** Remove fixtures by index; their recessed tiles go back to NORMAL. */
export function removeFixtures(l: ChunkLayout, idx: readonly number[]): void {
  if (idx.length === 0) return;
  const drop = new Set(idx);
  for (const n of idx) {
    const f = l.fixtures[n];
    if (!isRecessedFixture(f.kind)) continue;
    const [a0, b0, a1, b1] = fixtureXZ(f);
    for (let z = b0 + CELL / 4; z < b1; z += CELL / 2) for (let x = a0 + CELL / 4; x < a1; x += CELL / 2) {
      const li = worldToCell(x), lj = worldToCell(z);
      if (!inChunk(li, lj)) continue;
      const c = cellIdx(li, lj), t = (Math.floor((z - lj * CELL) / (CELL / 2)) << 1) | Math.floor((x - li * CELL) / (CELL / 2));
      if (getTile(l.tiles, c, t) === TileState.FIXTURE) setTile(l.tiles, c, t, TileState.NORMAL);
    }
  }
  const keep = l.fixtures.filter((_, n) => !drop.has(n));
  l.fixtures.length = 0;
  for (const f of keep) l.fixtures.push(f);
}

/** Classify the 4 boundary sides of a cell rect: 0 all OPEN, 1 all WALL, -1 mixed / other kinds. Order W, E, S, N
 * (x-line i0, x-line i1, z-line j0, z-line j1). */
export function rectSides(l: ChunkLayout, i0: number, j0: number, i1: number, j1: number): number[] {
  const cls = (kinds: number[]): number => kinds.every((k) => k === EdgeKind.OPEN) ? 0 : kinds.every((k) => k === EdgeKind.WALL) ? 1 : -1;
  const W: number[] = [], E: number[] = [], S: number[] = [], Nn: number[] = [];
  for (let j = j0; j < j1; j++) { W.push(l.ex.kind[exIdx(i0, j)]); E.push(l.ex.kind[exIdx(i1, j)]); }
  for (let i = i0; i < i1; i++) { S.push(l.ez.kind[ezIdx(i, j0)]); Nn.push(l.ez.kind[ezIdx(i, j1)]); }
  return [cls(W), cls(E), cls(S), cls(Nn)];
}

/** All interior edges of the rect OPEN and every cell dry open floor at one floor / ceiling height, free of
 * keepClear / LANDMARK / ARTERY / WET flags. */
export function rectFree(l: ChunkLayout, keep: Uint8Array, i0: number, j0: number, i1: number, j1: number, anyInterior = false): boolean {
  if (i0 < 1 || j0 < 1 || i1 > N - 1 || j1 > N - 1) return false;
  const c0 = cellIdx(i0, j0), f0 = l.floorCm[c0], h0 = l.ceilCm[c0], z0 = l.cellZone[c0];
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
    const c = cellIdx(i, j);
    if (!isOpenFloor(l, c) || keep[c] || l.floorCm[c] !== f0 || l.ceilCm[c] !== h0 || l.cellZone[c] !== z0) return false;
    if ((l.flags[c] & (CellFlag.LANDMARK | CellFlag.ARTERY | CellFlag.WET | CellFlag.NO_CEIL)) !== 0) return false;
    if (anyInterior) continue;
    if (i > i0 && l.ex.kind[exIdx(i, j)] !== EdgeKind.OPEN) return false;
    if (j > j0 && l.ez.kind[ezIdx(i, j)] !== EdgeKind.OPEN) return false;
  }
  // no furniture / machine solids (copiers, counters, pipes at head height) inside or against the rect
  return !solidsIn(l, i0 * CELL - 0.1, j0 * CELL - 0.1, i1 * CELL + 0.1, j1 * CELL + 0.1, f0 / 100 + 0.02, h0 / 100 - 0.05);
}

/** Any solid overlapping the xz rect within the height band [y0, y1]? */
export function solidsIn(l: ChunkLayout, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number): boolean {
  for (const s of l.solids) {
    let a0: number, a1: number, b0: number, b1: number, c0: number, c1: number;
    if (s.kind === 'box') { a0 = s.min[0]; a1 = s.max[0]; b0 = s.min[2]; b1 = s.max[2]; c0 = s.min[1]; c1 = s.max[1]; }
    else if (s.kind === 'ramp') { a0 = s.x0; a1 = s.x1; b0 = s.z0; b1 = s.z1; c0 = -1e9; c1 = 1e9; }
    else {
      a0 = Math.min(s.a[0], s.b[0]) - s.r; a1 = Math.max(s.a[0], s.b[0]) + s.r; b0 = Math.min(s.a[2], s.b[2]) - s.r; b1 = Math.max(s.a[2], s.b[2]) + s.r;
      c0 = Math.min(s.a[1], s.b[1]) - s.r; c1 = Math.max(s.a[1], s.b[1]) + s.r;
    }
    if (a0 < x1 && a1 > x0 && b0 < z1 && b1 > z0 && c0 < y1 && c1 > y0) return true;
  }
  return false;
}

/** Wall the OPEN sides of a rect (both faces take their cell's wallMat, baseboard trim copied from `trim`); returns
 * the recorded edits. `doors` edges become DOORWAYs (head featureDoorHa-like: min(210, ceiling - 10)). With `force`
 * every boundary edge is rewritten (and interior edges are cleared to OPEN), into the given `ed`. */
export function wallRect(g: ChunkGrid, i0: number, j0: number, i1: number, j1: number, doors: readonly { axis: 'x' | 'z'; i: number; j: number }[], trim: number,
  force = false, ed: EdgeEdits = new EdgeEdits(g)): EdgeEdits {
  const l = g.layout;
  const head = Math.min(DOOR_CM, l.ceilCm[cellIdx(i0, j0)] - l.floorCm[cellIdx(i0, j0)] - 10) + l.floorCm[cellIdx(i0, j0)];
  const put = (axis: 'x' | 'z', i: number, j: number): void => {
    const e = axis === 'x' ? l.ex : l.ez, k = axis === 'x' ? exIdx(i, j) : ezIdx(i, j);
    const isDoor = doors.some((d) => d.axis === axis && d.i === i && d.j === j);
    if (e.kind[k] !== EdgeKind.OPEN && !isDoor && !force) return;
    const na = axis === 'x' ? cellIdx(i - 1, j) : cellIdx(i, j - 1), nb = cellIdx(i, j);
    const o = { matNeg: l.wallMat[na] as MatId, matPos: l.wallMat[nb] as MatId, trim: isDoor ? trim | EdgeTrim.CASING : trim };
    ed.set(axis, i, j, isDoor ? EdgeKind.DOORWAY : EdgeKind.WALL, isDoor ? { ...o, hA: head } : o);
  };
  for (let j = j0; j < j1; j++) { put('x', i0, j); put('x', i1, j); }
  for (let i = i0; i < i1; i++) { put('z', i, j0); put('z', i, j1); }
  if (force) {
    for (let j = j0; j < j1; j++) for (let i = i0 + 1; i < i1; i++) if (l.ex.kind[exIdx(i, j)] !== EdgeKind.OPEN) ed.set('x', i, j, EdgeKind.OPEN);
    for (let j = j0 + 1; j < j1; j++) for (let i = i0; i < i1; i++) if (l.ez.kind[ezIdx(i, j)] !== EdgeKind.OPEN) ed.set('z', i, j, EdgeKind.OPEN);
  }
  return ed;
}

/** No floor prop or solid within the two cells on either side of an edge (both cells + 0.3 m beyond, along the
 * crossing). */
export function doorApproachFree(l: ChunkLayout, axis: 'x' | 'z', i: number, j: number): boolean {
  const m = 0.3;
  const r = axis === 'x'
    ? [(i - 1) * CELL - m, j * CELL, (i + 1) * CELL + m, (j + 1) * CELL]
    : [i * CELL, (j - 1) * CELL - m, (i + 1) * CELL, (j + 1) * CELL + m];
  const c = axis === 'x' ? cellIdx(Math.max(0, i - 1), j) : cellIdx(i, Math.max(0, j - 1));
  const f = l.floorCm[c] / 100;
  return propsInRect(l, r[0], r[1], r[2], r[3]).length === 0 && !solidsIn(l, r[0], r[1], r[2], r[3], f + 0.02, f + 2.0);
}

/** Mark keepClear Chebyshev-1 around both cells of an edge. */
export function keepAroundEdge(keep: Uint8Array, axis: 'x' | 'z', i: number, j: number): void {
  const cells: [number, number][] = axis === 'x' ? [[i - 1, j], [i, j]] : [[i, j - 1], [i, j]];
  for (const [a, b] of cells) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (inChunk(a + di, b + dj)) keep[cellIdx(a + di, b + dj)] = 1;
}

function carveCloset(v: VCtx): ClosetRect | null {
  const g = v.ctx.grid, l = g.layout, keep = v.pl.space.keep;
  let before: Uint8Array | null = null;
  const sizes = [...CLOSET_SIZES];
  v.rng.shuffle(sizes);
  for (const minWalls of [2, 1]) {
    for (const c of v.cells.slice(0, 13)) {
      const li = c & 31, lj = c >> 5;
      for (const [w, d] of sizes) {
        for (let j0 = lj - d + 1; j0 <= lj; j0++) for (let i0 = li - w + 1; i0 <= li; i0++) {
          const i1 = i0 + w, j1 = j0 + d;
          if (!rectFree(l, keep, i0, j0, i1, j1)) continue;
          const cc = cellIdx(i0, j0);
          if (l.ceilCm[cc] - l.floorCm[cc] < 235) continue;
          const sides = rectSides(l, i0, j0, i1, j1);
          if (sides.includes(-1)) continue;
          const walls = sides.filter((x) => x === 1).length;
          if (walls < minWalls || walls === 4) continue;
          const cx = ((i0 + i1) / 2) * CELL, cz = ((j0 + j1) / 2) * CELL;
          if (!v.ok(cx, cz)) continue;
          if (propsInRect(l, i0 * CELL - 0.1, j0 * CELL - 0.1, i1 * CELL + 0.1, j1 * CELL + 0.1).length > 0) continue;
          const inside = fixturesInside(l, i0, j0, i1, j1);
          if (inside === null) continue;
          // door candidates on the open sides: outside cell dry open floor at the same height
          const doors: { axis: 'x' | 'z'; i: number; j: number; side: -1 | 1 }[] = [];
          const f0 = l.floorCm[cc];
          const outOk = (a: number, b: number): boolean => inChunk(a, b) && isOpenFloor(l, cellIdx(a, b)) && l.floorCm[cellIdx(a, b)] === f0;
          if (sides[0] === 0) for (let j = j0; j < j1; j++) if (outOk(i0 - 1, j)) doors.push({ axis: 'x', i: i0, j, side: 1 });
          if (sides[1] === 0) for (let j = j0; j < j1; j++) if (outOk(i1, j)) doors.push({ axis: 'x', i: i1, j, side: -1 });
          if (sides[2] === 0) for (let i = i0; i < i1; i++) if (outOk(i, j0 - 1)) doors.push({ axis: 'z', i, j: j0, side: 1 });
          if (sides[3] === 0) for (let i = i0; i < i1; i++) if (outOk(i, j1)) doors.push({ axis: 'z', i, j: j1, side: -1 });
          // the approach to the new door must be free of props (placed before the door existed)
          const clearDoors = doors.filter((d) => doorApproachFree(l, d.axis, d.i, d.j));
          if (clearDoors.length === 0) continue;
          const door = clearDoors[v.rng.int(0, clearDoors.length - 1)];
          let trim = l.ex.trim[exIdx(i0, j0)];
          for (let j = j0; j < j1; j++) if (l.ex.kind[exIdx(i0, j)] === EdgeKind.WALL) trim = l.ex.trim[exIdx(i0, j)];
          before ??= portReach(l);
          const ed = wallRect(g, i0, j0, i1, j1, [door], trim & ~EdgeTrim.CASING);
          if (!reachKept(before, portReach(l))) { ed.revert(); continue; }
          removeFixtures(l, inside);
          labelRooms(l);
          keepAroundEdge(keep, door.axis, door.i, door.j);
          return { i0, j0, i1, j1, door: { axis: door.axis, i: door.i, j: door.j, side: door.side } };
        }
      }
    }
  }
  return null;
}

const mattressCloset: Composer = (v) => {
  const g = v.ctx.grid, l = g.layout;
  const cl = carveCloset(v);
  if (cl) {
    const { i0, j0, i1, j1, door } = cl;
    const y = l.floorCm[cellIdx(i0, j0)] / 100, ceil = l.ceilCm[cellIdx(i0, j0)] / 100;
    // the leaf swung 55-75 degrees into the closet (collision snaps to the open position along the jamb)
    placeLeaf(g, door.axis, door.i, door.j, door.side, v.rng.chance(0.5) ? 1 : -1, v.rng.range(55, 75), v.rng.int(0, 3), v.rng.next() >>> 0);
    v.pl.rebuild();
    // mattress against a closet wall (long walls first, never the door side), pushed to one end
    const X0 = i0 * CELL, Z0 = j0 * CELL, X1 = i1 * CELL, Z1 = j1 * CELL, T = 0.075;
    const walls: { x: number; z: number; nx: number; nz: number; len: number; doorSide: boolean }[] = [
      { x: X0 + T, z: (Z0 + Z1) / 2, nx: 1, nz: 0, len: Z1 - Z0, doorSide: door.axis === 'x' && door.i === i0 },
      { x: X1 - T, z: (Z0 + Z1) / 2, nx: -1, nz: 0, len: Z1 - Z0, doorSide: door.axis === 'x' && door.i === i1 },
      { x: (X0 + X1) / 2, z: Z0 + T, nx: 0, nz: 1, len: X1 - X0, doorSide: door.axis === 'z' && door.j === j0 },
      { x: (X0 + X1) / 2, z: Z1 - T, nx: 0, nz: -1, len: X1 - X0, doorSide: door.axis === 'z' && door.j === j1 },
    ];
    walls.sort((a, b) => Number(a.doorSide) - Number(b.doorSide) || b.len - a.len);
    let mat: PropPlacement | null = null;
    for (const w of walls) {
      if (w.doorSide || w.len < 2.0) continue;
      const tx = Math.abs(w.nz), tz = Math.abs(w.nx);
      for (const slide of [0, -(w.len - 1.95) / 2, (w.len - 1.95) / 2]) {
        const x = w.x + w.nx * 0.47 + tx * slide, z = w.z + w.nz * 0.47 + tz * slide;
        mat = v.pl.tryPlace(PropKind.MATTRESS, v.rng.int(0, 3), x, y, z, yawOf(tx, tz) + (v.rng.chance(0.5) ? Math.PI : 0), v.rng.next(), { allowKeepClear: true });
        if (mat) break;
      }
      if (mat) break;
    }
    // a couple of bottles and a sheet of paper on the floor
    for (let k = 0, n = v.rng.int(1, 3); k < n; k++) {
      v.pl.tryPlace(PropKind.BOTTLE, v.rng.int(0, 3), v.rng.range(X0 + 0.3, X1 - 0.3), y, v.rng.range(Z0 + 0.3, Z1 - 0.3), v.rng.range(0, 6.28), v.rng.next(), { allowKeepClear: true });
    }
    g.addDecal({ kind: DecalKind.PAPER, sign: false, px: v.rng.range(X0 + 0.4, X1 - 0.4), py: y, pz: v.rng.range(Z0 + 0.4, Z1 - 0.4), nx: 0, ny: 1, nz: 0, rot: v.rng.range(0, 6.28), w: 0.21, h: 0.3, alpha: 0.9, color: PAPER_TINT });
    // one bare bulb, warm, sometimes dying
    const col = kelvinToLinearRGB(v.rng.range(2500, 2900), 0.01);
    const bulb = fixtureAt(FixtureKind.CAGE_BULB, (X0 + X1) / 2, ceil - 0.28, (Z0 + Z1) / 2, [0, -1, 0], [1, 0, 0], [col[0], col[1], col[2]], v.rng.range(120, 160), { hum: 0.25 });
    if (v.ctx.opts.lights === 'dead') bulb.state = LightState.OFF;
    else if (v.ctx.opts.lights !== 'on' && v.rng.chance(0.25)) bulb.state = LightState.DYING;
    addLatticeFixture(g, bulb);
    const ax = mat ? mat.x : (X0 + X1) / 2, az = mat ? mat.z : (Z0 + Z1) / 2;
    return { x: ax, z: az, yaw: mat ? mat.yaw : 0 };
  }
  // fallback: an existing 2-6 cell room
  const size = new Map<number, number>();
  for (let c = 0; c < N * N; c++) { const r = l.room[c]; if (r) size.set(r, (size.get(r) ?? 0) + 1); }
  for (const c of v.cells) {
    const r = l.room[c], n = size.get(r) ?? 0;
    if (r === 0 || n > 6 || n < 2) continue;
    for (const d of wallSides(v, c)) {
      const f = wallFaceOf(c & 31, c >> 5, d);
      // mattress long axis (local Z) along the wall, pushed against it
      const yaw = yawOf(f.tx, f.tz) + (v.rng.chance(0.5) ? Math.PI : 0);
      const x = f.x + f.nx * 0.47, z = f.z + f.nz * 0.47;
      if (!v.ok(x, z)) continue;
      if (v.pl.tryPlace(PropKind.MATTRESS, v.rng.int(0, 2), x, floorY(v, c), z, yaw, v.rng.next())) return { x, z, yaw };
    }
  }
  return null;
};

const sparkingFixture: Composer = (v) => {
  const l = v.ctx.grid.layout;
  let best = -1, bd = 1e9;
  for (let i = 0; i < l.fixtures.length; i++) {
    const f = l.fixtures[i];
    if (f.bakeGroup !== 0 || f.state === LightState.OFF || f.kind === FixtureKind.EXIT_SIGN) continue;
    const c = cellIdx(Math.min(N - 1, Math.max(0, worldToCell(f.px))), Math.min(N - 1, Math.max(0, worldToCell(f.pz))));
    if ((l.flags[c] & (CellFlag.LANDMARK | CellFlag.RESERVED)) !== 0) continue;
    const dx = f.px - v.lx, dz = f.pz - v.lz, d2 = dx * dx + dz * dz;
    if (d2 < bd && d2 <= (VIG_SHIFT_MAX - 0.3) * (VIG_SHIFT_MAX - 0.3) && v.ok(f.px, f.pz)) { bd = d2; best = i; }
  }
  if (best < 0) return null;
  const f = l.fixtures[best];
  if (v.ctx.opts.lights !== 'on') { f.state = LightState.OFF; f.dynamic = false; } // QA 'on': every light stays ON
  v.ctx.grid.addAnomaly(AnomalyKind.SPARKING, f.px, f.pz, 3);
  return { x: f.px, z: f.pz, yaw: 0 };
};

/** A small floor prop against a wall + an audio emitter at it. */
function floorItemWithEmitter(kind: PropKindId, emitter: EmitterKindId, gain: number): Composer {
  return (v) => {
    for (const c of v.cells) {
      const sides = wallSides(v, c);
      if (sides.length === 0) continue;
      const d = sides[v.rng.int(0, sides.length - 1)];
      const f = wallFaceOf(c & 31, c >> 5, d);
      const off = v.rng.range(0.25, 0.55);
      const x = f.x + f.nx * off + f.tx * v.rng.range(-0.3, 0.3), z = f.z + f.nz * off + f.tz * v.rng.range(-0.3, 0.3);
      const yaw = yawOf(f.nx, f.nz) + v.rng.range(-0.5, 0.5);
      const y = floorY(v, c);
      if (!v.ok(x, z)) continue;
      if (v.pl.tryPlace(kind, v.rng.int(0, 2), x, y, z, yaw, v.rng.next())) {
        v.ctx.grid.addEmitter(emitter, x, y + 0.1, z, gain);
        return { x, z, yaw };
      }
    }
    return null;
  };
}

// R2 (B6): the bag's long axis is its local Z, so "along the wall" is yawOf(tangent) (WP4 used yawOf(tz, tx), which
// put the bag across the wall: it never fitted). Both flips and three slides along the wall are tried, then the bag
// perpendicular to the wall (head at the wall); bottles may land in keepClear cells (tiny, no collision).
const backpackCamp: Composer = (v) => {
  for (const c of v.cells) {
    const y = floorY(v, c);
    for (const d of wallSides(v, c)) {
      const f = wallFaceOf(c & 31, c >> 5, d);
      const opts: { x: number; z: number; yaw: number; ax: number; az: number }[] = [];
      for (const slide of [0, 0.45, -0.45]) {
        const x = f.x + f.nx * 0.44 + f.tx * slide, z = f.z + f.nz * 0.44 + f.tz * slide;
        const flip = v.rng.chance(0.5) ? 1 : -1;
        for (const s of [flip, -flip]) opts.push({ x, z, yaw: yawOf(f.tx * s, f.tz * s), ax: f.tx * s, az: f.tz * s });
      }
      for (const slide of [0, 0.3, -0.3]) {
        const x = f.x + f.nx * 1.03 + f.tx * slide, z = f.z + f.nz * 1.03 + f.tz * slide;
        opts.push({ x, z, yaw: yawOf(-f.nx, -f.nz), ax: -f.nx, az: -f.nz });
      }
      for (const o of opts) {
        if (!v.ok(o.x, o.z) || !v.pl.space.fits(PropKind.SLEEPING_BAG, o.x, o.z, o.yaw, y)) continue;
        v.pl.tryPlace(PropKind.SLEEPING_BAG, v.rng.int(0, 3), o.x, y, o.z, o.yaw, v.rng.next());
        // backpack at the bag's head (+forward end = local -Z? the head is toward (ax, az)), else beside it
        const side = (k: number): [number, number] => [f.nx * k, f.nz * k];
        const spots: [number, number][] = [
          [o.x + o.ax * 1.25, o.z + o.az * 1.25],
          [o.x + o.ax * 0.7 + side(0.65)[0], o.z + o.az * 0.7 + side(0.65)[1]],
          [o.x - o.ax * 0.7 + side(0.65)[0], o.z - o.az * 0.7 + side(0.65)[1]],
        ];
        for (const [x, z] of spots) {
          if (v.pl.tryPlace(PropKind.BACKPACK, v.rng.int(0, 3), x, y, z, yawOf(-f.nx, -f.nz) + v.rng.range(-0.5, 0.5), v.rng.next(), { allowKeepClear: true })) break;
        }
        // bottles, a box used as a table, a paper or two
        for (let k = 0, n = v.rng.int(2, 4); k < n; k++) {
          const ox = f.nx * v.rng.range(0.9, 1.5) + f.tx * v.rng.range(-1, 1), oz = f.nz * v.rng.range(0.9, 1.5) + f.tz * v.rng.range(-1, 1);
          v.pl.tryPlace(PropKind.BOTTLE, v.rng.int(0, 3), o.x + ox, y, o.z + oz, v.rng.range(0, 6.28), v.rng.next(), { allowKeepClear: true });
        }
        if (v.rng.chance(0.6)) {
          const bx = o.x + f.nx * 1.15 + o.ax * 0.5, bz = o.z + f.nz * 1.15 + o.az * 0.5;
          const box = v.pl.tryPlace(PropKind.CARDBOARD_BOX, v.rng.int(0, 3), bx, y, bz, v.rng.range(0, 6.28), v.rng.next());
          if (box) v.pl.place({ kind: PropKind.BOTTLE, variant: v.rng.int(0, 3), x: bx + v.rng.range(-0.08, 0.08), y: y + 0.4, z: bz + v.rng.range(-0.06, 0.06), yaw: v.rng.range(0, 6.28), scale: 1, flags: 0, seed: v.rng.next() });
        }
        for (let k = 0, n = v.rng.int(1, 3); k < n; k++) {
          v.ctx.grid.addDecal({ kind: DecalKind.PAPER, sign: false, px: o.x + f.nx * v.rng.range(0.7, 1.6) + f.tx * v.rng.range(-1, 1), py: y, pz: o.z + f.nz * v.rng.range(0.7, 1.6) + f.tz * v.rng.range(-1, 1), nx: 0, ny: 1, nz: 0, rot: v.rng.range(0, 6.28), w: 0.21, h: 0.3, alpha: 0.85, color: PAPER_TINT });
        }
        // tally marks scratched on the wall above the bag
        v.ctx.grid.addDecal({ kind: DecalKind.TALLY, sign: false, px: f.x + f.tx * v.rng.range(-0.25, 0.25), py: y + v.rng.range(0.8, 1.2), pz: f.z + f.tz * v.rng.range(-0.25, 0.25), nx: f.nx, ny: 0, nz: f.nz, rot: 0, w: 0.5, h: 0.35, alpha: 0.85 });
        return { x: o.x, z: o.z, yaw: o.yaw };
      }
    }
  }
  return null;
};

const poolFloat: Composer = (v) => {
  const l = v.ctx.grid.layout;
  let wi = -1, bd = 1e9;
  for (let i = 0; i < l.water.length; i++) {
    const w = l.water[i];
    if (w.kind !== 0 || w.y - w.floorY < 0.4) continue;
    const cx = Math.min(Math.max(v.lx, w.x0), w.x1), cz = Math.min(Math.max(v.lz, w.z0), w.z1);
    const d2 = (cx - v.lx) * (cx - v.lx) + (cz - v.lz) * (cz - v.lz);
    if (d2 < bd) { bd = d2; wi = i; }
  }
  if (wi < 0 || bd > (VIG_SHIFT_MAX - 1.0) * (VIG_SHIFT_MAX - 1.0)) return null;
  const w = l.water[wi];
  if (w.x1 - w.x0 < 1.6 || w.z1 - w.z0 < 1.6) return null;
  // drifting near the candidate, at least 0.7 m from the pool edge
  const x = Math.min(Math.max(v.lx, w.x0 + 0.7), w.x1 - 0.7), z = Math.min(Math.max(v.lz, w.z0 + 0.7), w.z1 - 0.7);
  if (!v.ok(x, z)) return null;
  const yaw = v.rng.range(0, 6.28);
  v.ctx.grid.addProp({ kind: PropKind.POOL_FLOAT, variant: v.rng.int(0, 2), x, y: w.y, z, yaw, scale: 1, flags: 0, seed: v.rng.next() });
  // towel draped on a nearby lounge chair (or a new chair at the pool side)
  let chair = null as null | { x: number; y: number; z: number; yaw: number };
  let cd = 64;
  for (const p of l.props) {
    if (p.kind !== PropKind.LOUNGE_CHAIR) continue;
    const d2 = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
    if (d2 < cd) { cd = d2; chair = p; }
  }
  if (!chair) {
    for (const c of v.cells) {
      if (!isOpenFloor(l, c)) continue;
      const [cx, cz] = at(c);
      const yaw2 = v.rng.int(0, 3) * (Math.PI / 2);
      const p = v.pl.tryPlace(PropKind.LOUNGE_CHAIR, v.rng.int(0, 2), cx, floorY(v, c), cz, yaw2, v.rng.next());
      if (p) { chair = p; break; }
    }
  }
  if (chair) {
    v.ctx.grid.addProp({ kind: PropKind.TOWEL, variant: v.rng.int(0, 3), x: chair.x, y: chair.y + 0.36, z: chair.z, yaw: chair.yaw, scale: 1, flags: 0, seed: v.rng.next() });
  }
  return { x, z, yaw };
};

/** Place the open car (variant 3, driver door open), its backpack and the dome light; false if it does not fit. */
function carAt(v: VCtx, x: number, y: number, z: number, yaw: number, ignore: readonly number[]): boolean {
  // leave room for the open driver door (left side, -X local) and the backpack beside it
  const [dxo, dzo] = rotQ(yaw, -1.35, -0.4);
  if (!v.pl.space.fits(PropKind.CAR_SEDAN, x, z, yaw, y, { ignoreKinds: ignore })) return false;
  if (!v.pl.space.fits(PropKind.BACKPACK, x + dxo, z + dzo, yaw, y)) return false;
  if (!v.pl.tryPlace(PropKind.CAR_SEDAN, 3, x, y, z, yaw, v.rng.next(), { ignoreKinds: ignore })) return false;
  v.pl.tryPlace(PropKind.BACKPACK, v.rng.int(0, 2), x + dxo, y, z + dzo, yaw + 0.6, v.rng.next());
  // dome light inside the cabin (warm, ON)
  const [fx, fz] = rotQ(yaw, 0, 0.2);
  const [tx, tz] = rotQ(yaw, 1, 0);
  const col = kelvinToLinearRGB(2700, 0);
  const dome = fixtureAt(FixtureKind.RED_BULB, x + fx, y + 1.28, z + fz, [0, -1, 0], [Math.abs(tx), 0, Math.abs(tz)], [col[0], col[1], col[2]], 80, { shape: 0, w: 0.3, h: 0.1 });
  if (v.ctx.opts.lights === 'dead') dome.state = LightState.OFF; // placed after assignFixtureStates
  addLatticeFixture(v.ctx.grid, dome);
  return true;
}

/** Stall geometry of WP3's PARKING: a WHEEL_STOP (yaw 0) 0.85 m inside the stall's back edge, stall 5 m deep. */
const STALL_STOP_TO_CENTRE = 1.65;
const openCar: Composer = (v) => {
  const l = v.ctx.grid.layout;
  // 1. an empty parking stall near the candidate: the car nose-in or nose-out over the stall's wheel stop
  const reach2 = (VIG_SHIFT_MAX - 0.3) * (VIG_SHIFT_MAX - 0.3);
  const stops = l.props
    .filter((p) => p.kind === PropKind.WHEEL_STOP && quarterTurn(p.yaw) >= 0)
    .map((p) => ({ p, d2: (p.x - v.lx) * (p.x - v.lx) + (p.z - v.lz) * (p.z - v.lz) }))
    .filter((e) => e.d2 <= reach2 * 1.6)
    .sort((a, b) => a.d2 - b.d2 || a.p.x - b.p.x || a.p.z - b.p.z);
  for (const { p } of stops) {
    const q = quarterTurn(p.yaw);
    const along = (q & 1) === 0; // stop long axis along x => stall runs along z
    for (const s of v.rng.chance(0.5) ? [1, -1] : [-1, 1]) {
      const x = along ? p.x : p.x + s * STALL_STOP_TO_CENTRE, z = along ? p.z + s * STALL_STOP_TO_CENTRE : p.z;
      if ((x - v.lx) * (x - v.lx) + (z - v.lz) * (z - v.lz) > reach2 || !v.ok(x, z)) continue;
      const li = worldToCell(x), lj = worldToCell(z);
      if (!inChunk(li, lj) || !isOpenFloor(l, cellIdx(li, lj))) continue;
      const base = along ? 0 : Math.PI / 2;
      const yaw = base + (v.rng.chance(0.5) ? 0 : Math.PI);
      if (carAt(v, x, floorY(v, cellIdx(li, lj)), z, yaw, [PropKind.WHEEL_STOP])) return { x, z, yaw };
    }
  }
  // 2. anywhere with room around it
  for (const c of v.cells) {
    const [x, z] = at(c);
    const yaw = v.rng.int(0, 3) * (Math.PI / 2);
    if (!v.ok(x, z)) continue;
    if (carAt(v, x, floorY(v, c), z, yaw, [])) return { x, z, yaw };
  }
  return null;
};

const quarterTurn = (yaw: number): number => {
  const q = yaw / (Math.PI / 2), r = Math.round(q);
  return Math.abs(q - r) < 1e-6 ? ((r % 4) + 4) % 4 : -1;
};

/** Boxes spilled by a collapsed rack: §5 asks for 6–10. */
export const RACK_SPILL_MIN = 6, RACK_SPILL_MAX = 10;
const BOX_H = 0.4; // PROP_DEFS[CARDBOARD_BOX].size[1]

const collapsedRack: Composer = (v) => {
  const l = v.ctx.grid.layout;
  let rack = -1, bd = (VIG_SHIFT_MAX - 0.5) * (VIG_SHIFT_MAX - 0.5);
  for (let i = 0; i < l.props.length; i++) {
    const p = l.props[i];
    if (p.kind !== PropKind.SHELF_RACK || p.variant === 2) continue;
    const d2 = (p.x - v.lx) * (p.x - v.lx) + (p.z - v.lz) * (p.z - v.lz);
    if (d2 < bd && v.ok(p.x, p.z)) { bd = d2; rack = i; }
  }
  if (rack < 0) return null;
  const p = l.props[rack];
  const n = v.rng.int(RACK_SPILL_MIN, RACK_SPILL_MAX);
  // spill spots on both faces of the rack (local +-Z) and past its ends, nearest the rack first (boxes fall close);
  // the rng jitters them. A tumbled box may also land on top of another one.
  const spots: { ox: number; oz: number; w: number }[] = [];
  for (const side of [1, -1]) {
    for (let a = 0; a < 6; a++) {
      for (let r = 0; r < 4; r++) {
        const ox = -1.3 + a * 0.52 + v.rng.range(-0.12, 0.12);
        const oz = side * (0.8 + r * 0.42 + v.rng.range(0, 0.12));
        spots.push({ ox, oz, w: r + v.rng.next() * 1.5 });
      }
    }
    for (let r = 0; r < 3; r++) spots.push({ ox: side * (1.5 + r * 0.45), oz: v.rng.range(-0.5, 0.5), w: r + 0.5 + v.rng.next() * 1.5 });
  }
  spots.sort((a, b) => a.w - b.w);
  // dry run on a scratch copy of the placement space: commit only if at least RACK_SPILL_MIN boxes fit (the aisle
  // must stay passable: `fits` rejects any box that would split walkable space)
  const scratch = new PlacementSpace(l, v.pl.space.keep);
  const plan: PropPlacement[] = [];
  const tryBox = (x: number, y: number, z: number, yaw: number): void => {
    const li = worldToCell(x), lj = worldToCell(z);
    if (!inChunk(li, lj)) return;
    if (!scratch.fits(PropKind.CARDBOARD_BOX, x, z, yaw, y)) return;
    const q: PropPlacement = { kind: PropKind.CARDBOARD_BOX, variant: v.rng.int(0, 3), x, y, z, yaw, scale: 1, flags: defaultPropFlags(PropKind.CARDBOARD_BOX), seed: v.rng.next() };
    scratch.commit(q);
    plan.push(q);
  };
  for (const sp of spots) {
    if (plan.length >= n) break;
    const [ox, oz] = rotQ(p.yaw, sp.ox, sp.oz);
    const x = p.x + ox, z = p.z + oz;
    const li = worldToCell(x), lj = worldToCell(z);
    if (!inChunk(li, lj)) continue;
    tryBox(x, l.floorCm[cellIdx(li, lj)] / 100, z, v.rng.range(0, 6.28));
  }
  // a few boxes on top of fallen ones
  for (let k = 0, m = plan.length; k < m && plan.length < n; k++) {
    const b = plan[k];
    if (b.y !== l.floorCm[cellIdx(worldToCell(b.x), worldToCell(b.z))] / 100 || !v.rng.chance(0.5)) continue;
    tryBox(b.x + v.rng.range(-0.06, 0.06), b.y + BOX_H, b.z + v.rng.range(-0.06, 0.06), b.yaw + v.rng.range(-0.5, 0.5));
  }
  if (plan.length < RACK_SPILL_MIN) return null;
  for (const q of plan) v.pl.tryPlace(q.kind, q.variant, q.x, q.y, q.z, q.yaw, q.seed);
  l.props[rack] = { ...p, variant: 2 };
  return { x: p.x, z: p.z, yaw: p.yaw };
};

const steamLeak: Composer = (v) => {
  const l = v.ctx.grid.layout, g = v.ctx.grid;
  // nearest pipe point within reach, else a ceiling point over the anchor cell
  let sx = 0, sy = 0, sz = 0, found = false, bd = (VIG_SHIFT_MAX - 0.5) * (VIG_SHIFT_MAX - 0.5);
  for (const s of l.solids) {
    if (s.kind !== 'pipe') continue;
    const ax = s.b[0] - s.a[0], ay = s.b[1] - s.a[1], az = s.b[2] - s.a[2];
    const len2 = ax * ax + ay * ay + az * az;
    if (len2 < 1e-6) continue;
    let t = ((v.lx - s.a[0]) * ax + (v.lz - s.a[2]) * az) / len2;
    t = Math.min(1, Math.max(0, t));
    const px = s.a[0] + ax * t, py = s.a[1] + ay * t, pz = s.a[2] + az * t;
    const d2 = (px - v.lx) * (px - v.lx) + (pz - v.lz) * (pz - v.lz);
    if (d2 < bd && px > 0.1 && pz > 0.1 && px < CHUNK_SIZE - 0.1 && pz < CHUNK_SIZE - 0.1 && v.ok(px, pz)) { bd = d2; sx = px; sy = py; sz = pz; found = true; }
  }
  let anchor = -1;
  if (found) {
    const li = worldToCell(sx), lj = worldToCell(sz);
    if (inChunk(li, lj) && isOpenFloor(l, cellIdx(li, lj))) anchor = cellIdx(li, lj);
    else found = false;
  }
  if (!found) {
    for (const c of v.cells) {
      if (l.ceilKind[c] === CeilKind.OPEN_DARK || (l.flags[c] & CellFlag.NO_CEIL) !== 0) continue;
      if (!v.ok(...at(c))) continue;
      anchor = c;
      [sx, sz] = at(c);
      sy = l.ceilCm[c] / 100 - 0.1;
      break;
    }
  }
  if (anchor < 0) return null;
  const fy = l.floorCm[anchor] / 100;
  g.addEmitter(EmitterKind.STEAM, sx, sy, sz, 0.5);
  g.addEmitter(EmitterKind.DRIP, sx, fy + 0.05, sz, 0.35);
  const li = anchor & 31, lj = anchor >> 5;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const a = li + di, b = lj + dj;
    if (!inChunk(a, b)) continue;
    const c = cellIdx(a, b);
    if (!isOpenFloor(l, c) || l.floorCm[c] !== l.floorCm[anchor]) continue;
    if (c === anchor || v.rng.chance(0.55)) g.setCells(a, b, a + 1, b + 1, { flagsSet: CellFlag.WET });
  }
  g.addDecal({ kind: DecalKind.WATER_STAIN, sign: false, px: sx, py: fy, pz: sz, nx: 0, ny: 1, nz: 0, rot: v.rng.range(0, 6.28), w: 1.0, h: 1.0, alpha: 0.7 });
  if (v.rng.chance(0.6)) {
    g.addDecal({ kind: DecalKind.WATER_STAIN, sign: false, px: sx + v.rng.range(-0.4, 0.4), py: fy, pz: sz + v.rng.range(-0.4, 0.4), nx: 0, ny: 1, nz: 0, rot: v.rng.range(0, 6.28), w: 0.7, h: 0.7, alpha: 0.55 });
  }
  return { x: sx, z: sz, yaw: 0 };
};

const COMPOSERS: readonly Composer[] = [
  chairFacingWall, wetFloorSigns, fallenTiles, loneDoorframe, mattressCloset, sparkingFixture,
  floorItemWithEmitter(PropKind.RADIO, EmitterKind.RADIO, 0.5),
  floorItemWithEmitter(PropKind.PHONE, EmitterKind.PHONE, 0.6),
  backpackCamp, poolFloat, openCar, collapsedRack, steamLeak,
];

/** Run one composition for a candidate at chunk-local (lx, lz); records the vignette and returns its anchor, or
 * null if the local space does not fit. `ok` filters anchors (placeVignettes: realised spacing). Exported for tests. */
export function composeVignette(ctx: ZoneGenContext, pl: PropPlacer, keepClear: Uint8Array, kind: VignetteKindId, lx: number, lz: number, seed: number,
  ok: (x: number, z: number) => boolean = () => true): Anchor | null {
  const l = ctx.grid.layout;
  const ci = Math.min(N - 1, Math.max(0, worldToCell(lx))), cj = Math.min(N - 1, Math.max(0, worldToCell(lz)));
  // anchor cells within reach, nearest first (deterministic)
  const cells: number[] = [];
  for (let dj = -VIG_REACH_CELLS; dj <= VIG_REACH_CELLS; dj++) for (let di = -VIG_REACH_CELLS; di <= VIG_REACH_CELLS; di++) {
    const a = ci + di, b = cj + dj;
    if (!inChunk(a, b)) continue;
    const c = cellIdx(a, b);
    if (!isOpenFloor(l, c) || keepClear[c]) continue;
    cells.push(c);
  }
  cells.sort((p, q) => {
    const [px, pz] = at(p), [qx, qz] = at(q);
    return (px - lx) * (px - lx) + (pz - lz) * (pz - lz) - ((qx - lx) * (qx - lx) + (qz - lz) * (qz - lz)) || p - q;
  });
  const rng = new Rng(seed);
  const a = COMPOSERS[kind]({ ctx, pl, rng, cells, lx, lz, ok });
  if (a) ctx.grid.addVignette(kind, a.x, a.z, a.yaw);
  return a;
}

export function placeVignettes(ctx: ZoneGenContext, keepClear: Uint8Array): void {
  const l = ctx.grid.layout, { s, cx, cz } = ctx.key;
  const X0 = cx * CHUNK_SIZE, Z0 = cz * CHUNK_SIZE;
  const zoneAt = (x: number, z: number): ZoneId => {
    const li = worldToCell(x - X0), lj = worldToCell(z - Z0);
    return (inChunk(li, lj) ? l.cellZone[cellIdx(li, lj)] : ctx.district.zone) as ZoneId;
  };
  const cands = candidatesIn(ctx.seed, s, X0, Z0, X0 + CHUNK_SIZE, Z0 + CHUNK_SIZE, zoneAt);
  const pl = new PropPlacer(ctx, keepClear);
  const minD = VIG_MIN_SPACING + VIG_SHIFT_MAX;
  for (const cand of cands) {
    const prior = priorNeighbours(ctx.seed, s, cand.raw);
    const ok = (x: number, z: number): boolean => {
      const wx = X0 + x, wz = Z0 + z;
      if ((wx - cand.x) * (wx - cand.x) + (wz - cand.z) * (wz - cand.z) > VIG_SHIFT_MAX * VIG_SHIFT_MAX) return false;
      for (const [px, pz] of prior) if ((wx - px) * (wx - px) + (wz - pz) * (wz - pz) < minD * minD) return false;
      return true;
    };
    if (composeVignette(ctx, pl, keepClear, cand.kind, cand.x - X0, cand.z - Z0, cand.seed, ok)) continue;
    for (const alt of cand.alts) if (composeVignette(ctx, pl, keepClear, alt, cand.x - X0, cand.z - Z0, cand.seed, ok)) break;
  }
  // R2 (B6): big storage clusters (sparse halls), then the small lived-in traces between the vignettes
  placeDistrictClusters(ctx, pl);
  placeTraces(ctx, pl);
}
