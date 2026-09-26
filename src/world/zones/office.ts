// src/world/zones/office.ts — OFFICE generator (WP2). GLOBAL seams (all OPEN: seams fall between aisle lanes);
// 16-cell block lattice of CUBICLES / ROOMS / BREAK blocks.
//
// Global aisle lanes (gi or gj = 15 or 0 mod 16, VINYL_VCT) frame 14x14-cell blocks. Chunk seams (gi = 0 mod 32)
// always fall between two aisle cells, so the seam is all OPEN and blocks never cross a chunk. Block type by hash:
//   CUBICLES 60%: three double rows of 2x2 PARTITION pods (desk, chair, CRT, maybe a filing cabinet) with 1-cell
//                 aisles and a 2-cell cross aisle; partitions fall over (RAIL) with p = decay * 0.2.
//   ROOMS    30%: a central corridor with DRYWALL rooms on both sides (BSP along the corridor, optional depth split),
//                 DOORWAY doors with CASING, interior windows onto the aisle; conference rooms or private offices;
//                 10% are a raised VINYL_VCT floor (+30 cm): the corridor ends become the block's two doors, each
//                 with a 2-step ramp just inside; outer rooms get no aisle doors (the doors are the only way up).
//   BREAK    10%: a walled cafeteria with wide HEADER openings, long tables with stacking chairs, a counter
//                 (blocker cells), vending machines with their own VENDING light panels and a water cooler.
// R2 (docs/contract-changes/R2-architecture.md):
//   ATRIUM   (7% of blocks, taken from CUBICLES): the whole 14 x 14 block drops 3.0 / 4.5 m; the aisles become the
//            gallery (parapet + handrail), a carpeted stair descends along one side and a sunken open-plan office
//            (rows of desks) sits down there under pendants (structures/splitLevel.ts);
//   ROOMS blocks: some rooms become restrooms / kitchenettes (structures/programs.ts), 35% of the doors get leaves;
//   decayed blocks lose ceiling tiles or whole ceiling patches (structures/plenum.ts); windows to nowhere near
//   district boundaries; zone-transition connectors (structures/transitions.ts).

import { CELL, CHUNK_CELLS } from '../../core/constants.ts';
import { cellIdx, mod } from '../../core/grid.ts';
import { CeilKind, EdgeKind, EdgeTrim, FixtureKind, Mat, PropKind, SeamMode, SolidFlag, Zone, type PropKindId } from '../../core/ids.ts';
import { hangDoors } from '../structures/doors.ts';
import { missingTiles, openCeiling } from '../structures/plenum.ts';
import { applyProgram, Program } from '../structures/programs.ts';
import { buildSplitHall } from '../structures/splitLevel.ts';
import { transitionStamps } from '../structures/transitions.ts';
import { windowWall } from '../structures/windows.ts';
import { hash01, hash2, hash6, Rng, SALT } from '../../core/rng.ts';
import type { ChunkGrid, EdgeOpts, LightingProfile, PropRuleSet, SeamEdges, ZoneGenContext, ZoneGenerator, ZonePalette } from '../../core/world.ts';
import { addCustomFixture, num, propSeed, putProp, storeyStyle, styleLighting, stylePalette, yawFacing } from './l0common.ts';

const N = CHUNK_CELLS;
export const OFFICE_PERIOD = 16;
const INNER = 14; // block interior cells per axis
const OFFICE_TAG = 0x0ff1;

export const OfficeBlock = { CUBICLES: 0, ROOMS: 1, BREAK: 2, ATRIUM: 3 } as const;
export const ATRIUM_P = 0.1;
/** Block type of global block (bx, bz) = (floorDiv(gi, 16), floorDiv(gj, 16)). */
export function officeBlockType(seed: number, s: number, bx: number, bz: number): number {
  const u = hash01(hash6(seed, SALT.ZONE_LAYOUT, s, OFFICE_TAG, bx, bz));
  return u < ATRIUM_P ? OfficeBlock.ATRIUM : u < 0.6 ? OfficeBlock.CUBICLES : u < 0.9 ? OfficeBlock.ROOMS : OfficeBlock.BREAK;
}
export const OFFICE_DOOR_P = 0.42;
/** Per-chunk debug counters of the last OFFICE generate() (tests). */
export interface OfficeDebug { atriums: number; programs: number; doors: number; doorways: number; openCeilings: number; windows: number; connectors: number }
const DEBUG = new Map<string, OfficeDebug>();
export const officeDebug = (ctx: ZoneGenContext): OfficeDebug | null => DEBUG.get(`${ctx.seed}:${ctx.key.s}:${ctx.key.cx}:${ctx.key.cz}`) ?? null;
/** Aisle lane test on a global index. */
export const isAisle = (g: number): boolean => { const m = mod(g, OFFICE_PERIOD); return m === 15 || m === 0; };

const PARTITION: EdgeOpts = { hA: 150, matNeg: Mat.FABRIC_PARTITION, matPos: Mat.FABRIC_PARTITION, trim: 0 };
const FALLEN: EdgeOpts = { hA: 45, matNeg: Mat.FABRIC_PARTITION, matPos: Mat.FABRIC_PARTITION, trim: 0 };
const DOOR: EdgeOpts = { hA: 210, trim: EdgeTrim.BASEBOARD | EdgeTrim.CASING };
const WINDOW: EdgeOpts = { hA: 95, hB: 200, trim: EdgeTrim.BASEBOARD };
/** Raised ROOMS blocks (+30 cm floor): edge heights are storey-relative absolutes, so heads and sills move up too. */
const RAISE_CM = 30;
const DOOR_RAISED: EdgeOpts = { hA: 210 + RAISE_CM, trim: EdgeTrim.BASEBOARD | EdgeTrim.CASING };
const WINDOW_RAISED: EdgeOpts = { hA: 95 + RAISE_CM, hB: 200 + RAISE_CM, trim: EdgeTrim.BASEBOARD };

export const officeGenerator: ZoneGenerator = {
  id: Zone.OFFICE,
  seamMode: 'global',
  districtParams(rng, _s) {
    return { phaseX: rng.int(0, 3), phaseZ: rng.int(0, 3) };
  },
  globalSeam(_q): SeamEdges {
    // seams (gi = 0 mod 32) lie between the aisle lanes 15 and 0 (mod 16): always OPEN
    return { kind: new Uint8Array(N), hA: new Int16Array(N), hB: new Int16Array(N) };
  },
  generate(ctx) {
    generateOffice(ctx);
  },
  palette(s, d) {
    const base: ZonePalette = {
      floorMat: Mat.CARPET_OFFICE, wallMat: Mat.DRYWALL, ceilMat: Mat.CEILING_TILE, trimMat: Mat.TRIM_PAINT,
      ceilKind: CeilKind.TILES, ceilCm: 260, baseboard: true,
    };
    return stylePalette(storeyStyle(d.zone, s), base);
  },
  lighting(s, d) {
    const base: LightingProfile = {
      kind: FixtureKind.TROFFER_2x2, placement: 'lattice', lattice: [4, 4],
      phase: [num(d.params, 'phaseX', 0) % 4, num(d.params, 'phaseZ', 0) % 4], axis: 1,
      cctRange: [3500, 4100], luminance: 3000, zoneMul: 1, mountCm: 0,
    };
    return styleLighting(storeyStyle(d.zone, s), base, d.params);
  },
  props: {
    rules: [
      { kind: PropKind.OUTLET, where: 'wallMounted', per100m2: 2.0, variants: 2, minSpacing: 2.4, yCm: 30 },
      { kind: PropKind.THERMOSTAT, where: 'wallMounted', per100m2: 0.25, variants: 1, minSpacing: 8, yCm: 150 },
      { kind: PropKind.EXTINGUISHER, where: 'wallMounted', per100m2: 0.12, variants: 1, minSpacing: 15, yCm: 60 },
      { kind: PropKind.TRASH_CAN, where: 'corner', per100m2: 0.3, variants: 2, minSpacing: 5, yCm: 0 },
      { kind: PropKind.WATER_COOLER, where: 'wall', per100m2: 0.05, variants: 1, minSpacing: 20, yCm: 0 },
      { kind: PropKind.FILING_CABINET, where: 'wall', per100m2: 0.15, variants: 2, minSpacing: 6, yCm: 0 },
    ],
  } satisfies PropRuleSet,
};

// ------------------------------------------------------------------------------------------------ block frame

/** A block interior in its own frame: a (along the rows / corridor) and b (across), 14 x 14 cells. */
class Blk {
  readonly g: ChunkGrid;
  readonly ox: number; readonly oz: number; // local cell of frame (0, 0)
  readonly o: 0 | 1; // 0: a = +x, b = +z;  1: a = +z, b = +x
  constructor(g: ChunkGrid, ox: number, oz: number, o: 0 | 1) { this.g = g; this.ox = ox; this.oz = oz; this.o = o; }
  li(a: number, b: number): number { return this.o === 0 ? this.ox + a : this.ox + b; }
  lj(a: number, b: number): number { return this.o === 0 ? this.oz + b : this.oz + a; }
  /** edge on the a-line a = k, cell b */
  aEdge(k: number, b: number, kind: number, o?: EdgeOpts): void {
    if (this.o === 0) this.g.setEdge('x', this.ox + k, this.oz + b, kind, o);
    else this.g.setEdge('z', this.ox + b, this.oz + k, kind, o);
  }
  /** edge on the b-line b = k, cell a */
  bEdge(k: number, a: number, kind: number, o?: EdgeOpts): void {
    if (this.o === 0) this.g.setEdge('z', this.ox + a, this.oz + k, kind, o);
    else this.g.setEdge('x', this.ox + k, this.oz + a, kind, o);
  }
  /** frame point (cells, fractional) -> chunk-local metres */
  x(fa: number, fb: number): number { return (this.o === 0 ? this.ox + fa : this.ox + fb) * CELL; }
  z(fa: number, fb: number): number { return (this.o === 0 ? this.oz + fb : this.oz + fa) * CELL; }
  /** frame direction -> world dx / dz */
  dx(da: number, db: number): number { return this.o === 0 ? da : db; }
  dz(da: number, db: number): number { return this.o === 0 ? db : da; }
  reservedIn(a0: number, b0: number, a1: number, b1: number): boolean {
    for (let b = b0; b < b1; b++) for (let a = a0; a < a1; a++) if (this.g.isReserved(this.li(a, b), this.lj(a, b))) return true;
    return false;
  }
}

interface Ox { ctx: ZoneGenContext; rng: Rng; seq: number; dbg: OfficeDebug; busy: Uint8Array }
const nextSeed = (ox: Ox): number => propSeed(ox.ctx, OFFICE_TAG, ox.seq++);

/** Props in the block frame: position (fa, fb) in cells, facing frame direction (da, db). */
function prop(ox: Ox, b: Blk, kind: PropKindId, variant: number, fa: number, fb: number, y: number, da: number, db: number, jitter: number): void {
  const yaw = yawFacing(b.dx(da, db), b.dz(da, db)) + (jitter > 0 ? (ox.rng.float() * 2 - 1) * jitter : 0);
  putProp(b.g, kind, variant, b.x(fa, fb), y, b.z(fa, fb), yaw, nextSeed(ox));
}

// ------------------------------------------------------------------------------------------------ generate

function generateOffice(ctx: ZoneGenContext): void {
  const g = ctx.grid;
  // aisle lanes: VINYL_VCT
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      if (isAisle(g.gi0 + li) || isAisle(g.gj0 + lj)) g.setCells(li, lj, li + 1, lj + 1, { floorMat: Mat.VINYL_VCT });
    }
  }
  const dbg: OfficeDebug = { atriums: 0, programs: 0, doors: 0, doorways: 0, openCeilings: 0, windows: 0, connectors: 0 };
  const ox: Ox = { ctx, rng: ctx.rng, seq: 0, dbg, busy: new Uint8Array(N * N) };
  const style = storeyStyle(ctx.district.zone, ctx.key.s);
  for (let kz = 0; kz < 2; kz++) {
    for (let kx = 0; kx < 2; kx++) {
      const bx = (g.gi0 >> 4) + kx, bz = (g.gj0 >> 4) + kz; // gi0 is a multiple of 32
      const h = hash6(ctx.seed, SALT.ZONE_LAYOUT, ctx.key.s, OFFICE_TAG, bx, bz);
      const rng = new Rng(hash2(h, 0xb10c));
      ox.rng = rng;
      const blk = new Blk(g, kx * OFFICE_PERIOD + 1, kz * OFFICE_PERIOD + 1, (h >>> 3) & 1 ? 1 : 0);
      let type = officeBlockType(ctx.seed, ctx.key.s, bx, bz);
      if (type !== OfficeBlock.CUBICLES && blk.reservedIn(-1, -1, INNER + 1, INNER + 1)) type = OfficeBlock.CUBICLES;
      if (type === OfficeBlock.ATRIUM && !atrium(ctx, ox, blk, h)) type = OfficeBlock.CUBICLES;
      if (type === OfficeBlock.CUBICLES) cubicles(ctx, ox, blk);
      else if (type === OfficeBlock.ROOMS) rooms(ctx, ox, blk);
      else if (type === OfficeBlock.BREAK) breakRoom(ctx, ox, blk);
      if (type !== OfficeBlock.ATRIUM && style === 0) blockDecay(ctx, ox, blk, h);
    }
  }
  // R2: door leaves, windows to nowhere, zone transitions
  const dc = hangDoors(ctx, { p: OFFICE_DOOR_P, variant: (hh) => ((hh >>> 9) & 3) === 0 ? 0 : 1, tag: 0x0ff1 });
  dbg.doors = dc.leaves; dbg.doorways = dc.doorways;
  if (style === 0) {
    const bnd = (['W', 'N', 'E', 'S'] as const).some((sd) => ctx.seams[sd].mode === SeamMode.BOUNDARY);
    const wr = ctx.rng.fork(0x3d0f);
    if (wr.chance(bnd ? 0.4 : 0.06)) {
      // the backing strip never takes an aisle cell (aisles stay open lanes)
      const wb = ox.busy.slice();
      for (let lj = 0; lj < N; lj++) for (let li = 0; li < N; li++) if (isAisle(g.gi0 + li) || isAisle(g.gj0 + lj)) wb[cellIdx(li, lj)] = 1;
      const run = windowWall(ctx, wr, wb, Mat.DRYWALL);
      if (run) dbg.windows = run.windows;
    }
  }
  dbg.connectors = transitionStamps(ctx, ox.busy).connectors;
  const key = `${ctx.seed}:${ctx.key.s}:${ctx.key.cx}:${ctx.key.cz}`;
  if (DEBUG.size >= 512) DEBUG.delete(DEBUG.keys().next().value as string);
  DEBUG.set(key, dbg);
}

// ------------------------------------------------------------------------------------------------ ATRIUM (R2)

/** The 14 x 14 block drops 3.0 / 4.5 m under the aisle gallery: parapets, stair, pendants, desks down below. */
function atrium(ctx: ZoneGenContext, ox: Ox, b: Blk, h: number): boolean {
  const g = b.g, l = g.layout;
  if (storeyStyle(ctx.district.zone, ctx.key.s) === 2) return false;
  const rng = new Rng(hash2(h, 0xa7e1));
  // the hall = the block interior (local rect), the gallery = the surrounding aisles (floor 0, open)
  const i0 = Math.min(b.li(0, 0), b.li(INNER - 1, INNER - 1)), j0 = Math.min(b.lj(0, 0), b.lj(INNER - 1, INNER - 1));
  const i1 = i0 + INNER, j1 = j0 + INNER;
  for (let lj = j0 - 1; lj <= j1; lj++) for (let li = i0 - 1; li <= i1; li++) {
    if (g.isReserved(li, lj)) return false;
    if (li >= 0 && lj >= 0 && li < N && lj < N && l.floorCm[cellIdx(li, lj)] !== 0) return false;
  }
  const depth = rng.chance(0.7) ? 300 : 450;
  const lp = ctx.lighting;
  const along = rng.chance(0.5);
  const info = buildSplitHall(ctx, {
    i0, j0, i1, j1, depthCm: depth, stairAxis: along ? 'x' : 'z', stairSide: rng.chance(0.5) ? -1 : 1, stairHead: rng.chance(0.5) ? -1 : 1,
    stairW: 2, stairL: depth > 300 ? 7 : 5, wallMat: Mat.DRYWALL, stairMat: Mat.CARPET_OFFICE, parapetMat: Mat.DRYWALL,
    columns: rng.chance(0.7),
    pendant: { kind: FixtureKind.PENDANT_LINEAR, luminance: 8000, cct: [lp.cctRange[0], lp.cctRange[1]], w: 1.2, h: 0.2 },
  });
  // a sunken open-plan office: rows of desks with chairs (and a monitor on some), clear of the stair and columns
  const low = -depth / 100;
  const [si0, sj0, si1, sj1] = info.stair;
  const nearStair = (li: number, lj: number): boolean => li >= si0 - 2 && li < si1 + 2 && lj >= sj0 - 2 && lj < sj1 + 2;
  for (let lj = j0 + 2; lj < j1 - 2; lj += 3) {
    for (let li = i0 + 2; li < i1 - 2; li += 2) {
      if (nearStair(li, lj) || g.hasFlag(li, lj, 1) || g.hasFlag(li, lj + 1, 1) || !rng.chance(0.75)) continue;
      const x = (li + 0.5) * CELL, z = (lj + 0.5) * CELL;
      putProp(g, PropKind.DESK, rng.int(0, 2), x, low, z, YAW_FACING_Z, nextSeed(ox));
      if (rng.chance(0.6)) putProp(g, PropKind.CRT_MONITOR, rng.int(0, 1), x + rng.range(-0.3, 0.3), low + 0.75, z - 0.1, YAW_FACING_Z + rng.range(-0.2, 0.2), nextSeed(ox));
      if (rng.chance(0.8)) putProp(g, PropKind.OFFICE_CHAIR, rng.int(0, 2), x + rng.range(-0.2, 0.2), low, z + 0.75, rng.range(-0.8, 0.8), nextSeed(ox));
    }
  }
  for (let lj = j0 - 1; lj <= j1; lj++) for (let li = i0 - 1; li <= i1; li++) if (li >= 0 && lj >= 0 && li < N && lj < N) ox.busy[cellIdx(li, lj)] = 1;
  ox.dbg.atriums++;
  return true;
}
const YAW_FACING_Z = Math.PI; // desk front toward +z (the chair side)

/** Decayed blocks: scattered missing tiles, and with p 0.02-0.08 an open plenum patch. */
function blockDecay(ctx: ZoneGenContext, ox: Ox, b: Blk, h: number): void {
  const g = b.g, l = g.layout;
  const i0 = Math.min(b.li(0, 0), b.li(INNER - 1, INNER - 1)), j0 = Math.min(b.lj(0, 0), b.lj(INNER - 1, INNER - 1));
  const decay = ctx.fields.decay((g.gi0 + i0 + INNER / 2) * CELL, (g.gj0 + j0 + INNER / 2) * CELL);
  const rng = new Rng(hash2(h, 0xdeca));
  if (decay > 0.6 && rng.chance(0.08 + 0.4 * (decay - 0.6))) {
    const pw = rng.int(2, 4), ph = rng.int(2, 5);
    const a = i0 - 1 + rng.int(0, INNER + 2 - pw), c = j0 - 1 + rng.int(0, INNER + 2 - ph);
    let ok = a >= 0 && c >= 0 && a + pw <= N && c + ph <= N;
    const c0 = ok ? l.ceilCm[cellIdx(a, c)] : 0;
    for (let lj = c; lj < c + ph && ok; lj++) for (let li = a; li < a + pw && ok; li++) {
      const cc = cellIdx(li, lj);
      if (g.isReserved(li, lj) || l.ceilCm[cc] !== c0 || l.ceilKind[cc] !== CeilKind.TILES || (l.flags[cc] & 1) !== 0 || ox.busy[cc]) ok = false;
    }
    if (ok) { openCeiling(ctx, a, c, a + pw, c + ph, rng); missingTiles(ctx, a - 1, c - 1, a + pw + 1, c + ph + 1, 0.3, rng); ox.dbg.openCeilings++; return; }
  }
  if (decay > 0.45 && rng.chance(0.35)) {
    const pw = rng.int(3, 6), ph = rng.int(3, 6);
    const a = i0 + rng.int(0, INNER - pw), c = j0 + rng.int(0, INNER - ph);
    missingTiles(ctx, a, c, a + pw, c + ph, rng.range(0.1, 0.35), rng);
  }
}

// ------------------------------------------------------------------------------------------------ CUBICLES

function cubicles(ctx: ZoneGenContext, ox: Ox, b: Blk): void {
  const A0 = [0, 2, 4, 8, 10, 12];
  for (const r0 of [0, 5, 10]) {
    for (const a0 of A0) {
      // pod A faces -b (cells b r0..r0+1), pod B faces +b (cells b r0+2..r0+3); back to back on line r0+2
      const okA = !b.reservedIn(a0, r0, a0 + 2, r0 + 2) && !b.reservedIn(a0, r0 - 1, a0 + 2, r0);
      const okB = !b.reservedIn(a0, r0 + 2, a0 + 2, r0 + 4) && !b.reservedIn(a0, r0 + 4, a0 + 2, r0 + 5);
      if (okA || okB) {
        for (let a = a0; a < a0 + 2; a++) partition(ctx, b, 'b', r0 + 2, a);
      }
      if (okA) for (let bb = r0; bb < r0 + 2; bb++) { partition(ctx, b, 'a', a0, bb); partition(ctx, b, 'a', a0 + 2, bb); }
      if (okB) for (let bb = r0 + 2; bb < r0 + 4; bb++) { partition(ctx, b, 'a', a0, bb); partition(ctx, b, 'a', a0 + 2, bb); }
      if (okA) pod(ox, b, a0, r0, -1);
      if (okB) pod(ox, b, a0, r0 + 2, 1);
    }
  }
}

/** A PARTITION edge (or a fallen one, RAIL at 45 cm, with p = decay * 0.2). */
function partition(ctx: ZoneGenContext, b: Blk, line: 'a' | 'b', k: number, c: number): void {
  const fa = line === 'a' ? k : c + 0.5, fb = line === 'a' ? c + 0.5 : k;
  const x = b.x(fa, fb), z = b.z(fa, fb);
  const decay = ctx.fields.decay(ctx.grid.gi0 * CELL + x, ctx.grid.gj0 * CELL + z);
  const fallen = ctx.rng.chance(Math.max(0, Math.min(1, decay)) * 0.2);
  const kind = fallen ? EdgeKind.RAIL : EdgeKind.PARTITION;
  if (line === 'a') b.aEdge(k, c, kind, fallen ? FALLEN : PARTITION);
  else b.bEdge(k, c, kind, fallen ? FALLEN : PARTITION);
}

/** Furniture of one 2x2 pod whose cells start at (a0, b0); `open` = the b direction of its open side. */
function pod(ox: Ox, b: Blk, a0: number, b0: number, open: number): void {
  const rng = ox.rng;
  // §5.WP2: every pod gets DESK + OFFICE_CHAIR + CRT_MONITOR (+ FILING_CABINET p 0.3)
  const ca = a0 + 1, cb = b0 + 1; // pod centre (frame cells)
  const u = 1 / CELL; // metres -> cells
  const deskB = cb - open * 0.775 * u;
  prop(ox, b, PropKind.DESK, rng.int(0, 2), ca + (rng.float() - 0.5) * 0.08 * u, deskB, 0, 0, open, 0.02);
  prop(ox, b, PropKind.CRT_MONITOR, rng.int(0, 1), ca + (rng.float() - 0.5) * 0.4 * u, deskB - open * 0.1 * u, 0.75, 0, open, 0.2);
  prop(ox, b, PropKind.OFFICE_CHAIR, rng.int(0, 2), ca + (rng.float() - 0.5) * 0.3 * u, cb + open * (rng.float() * 0.25) * u, 0, 0, -open, 0.6);
  const side = rng.chance(0.5) ? 1 : -1;
  if (rng.chance(0.3)) {
    prop(ox, b, PropKind.FILING_CABINET, rng.int(0, 1), ca + side * 0.86 * u, cb + open * 0.55 * u, 0, -side, 0, 0);
  } else if (rng.chance(0.25)) {
    prop(ox, b, PropKind.TRASH_CAN, rng.int(0, 1), ca + side * 0.97 * u, deskB, 0, 0, open, 0.5);
  }
}

// ------------------------------------------------------------------------------------------------ ROOMS

interface Room { a0: number; a1: number; b0: number; b1: number; doorB: number; outer: boolean }

function rooms(ctx: ZoneGenContext, ox: Ox, b: Blk): void {
  const rng = ox.rng;
  const raised = rng.chance(0.1);
  const door = raised ? DOOR_RAISED : DOOR, window = raised ? WINDOW_RAISED : WINDOW;
  const list: Room[] = [];
  // strip 1: b in [0,6), corridor on its +b side (line 6); strip 2: b in [8,14), corridor on its -b side (line 8)
  for (const strip of [0, 1]) {
    const sb0 = strip === 0 ? 0 : 8, sb1 = strip === 0 ? 6 : 14;
    const corrLine = strip === 0 ? 6 : 8;
    const segs: number[] = [];
    split1d(rng, 0, INNER, segs);
    for (let k = 0; k < segs.length; k += 2) {
      const a0 = segs[k], a1 = segs[k + 1];
      if (a1 - a0 >= 4 && rng.chance(0.3)) {
        const mid = strip === 0 ? 3 : 11;
        const outer: Room = strip === 0
          ? { a0, a1, b0: sb0, b1: mid, doorB: mid, outer: true }
          : { a0, a1, b0: mid, b1: sb1, doorB: mid, outer: true };
        const inner: Room = strip === 0
          ? { a0, a1, b0: mid, b1: sb1, doorB: corrLine, outer: false }
          : { a0, a1, b0: sb0, b1: mid, doorB: corrLine, outer: false };
        list.push(outer, inner);
        for (let a = a0; a < a1; a++) b.bEdge(mid, a, EdgeKind.WALL);
      } else {
        list.push({ a0, a1, b0: sb0, b1: sb1, doorB: corrLine, outer: true });
      }
      if (a0 > 0) for (let bb = sb0; bb < sb1; bb++) b.aEdge(a0, bb, EdgeKind.WALL);
    }
    for (let a = 0; a < INNER; a++) b.bEdge(corrLine, a, EdgeKind.WALL);
    for (let bb = sb0; bb < sb1; bb++) { b.aEdge(0, bb, EdgeKind.WALL); b.aEdge(INNER, bb, EdgeKind.WALL); }
  }
  // perimeter lines b = 0 and b = 14 (facing the aisles); outer rooms get interior windows, some a second door
  for (const r of list) {
    if (!r.outer) continue;
    const perim = r.b0 === 0 ? 0 : r.b1 === INNER ? INNER : -1;
    if (perim < 0) continue;
    // a second door straight onto the aisle (not in raised blocks: their only entrances are the ramped doors)
    const aisleDoor = !raised && rng.chance(0.2) ? rng.int(r.a0 + 1, r.a1 - 2) : -1;
    for (let a = r.a0; a < r.a1; a++) {
      if (a === aisleDoor) b.bEdge(perim, a, EdgeKind.DOORWAY, door);
      else if (a > r.a0 && a < r.a1 - 1 && rng.chance(0.3)) b.bEdge(perim, a, EdgeKind.WINDOW, window);
      else b.bEdge(perim, a, EdgeKind.WALL);
    }
  }
  // doors (after the walls, so they win)
  for (const r of list) {
    const a = rng.int(r.a0 + 1, Math.max(r.a0 + 1, r.a1 - 2));
    b.bEdge(r.doorB, a, EdgeKind.DOORWAY, door);
  }
  // raised floor entered through a door with a 2-step ramp at each corridor end
  if (raised) raiseBlock(b);
  const pr = new Rng(hash2(ox.rng.next(), 0x9a0e));
  const pc = { ctx, rng: pr, busy: ox.busy, seq: { n: 0 } };
  for (const r of list) {
    // R2 room programs: some rooms are restrooms or kitchenettes (not in raised blocks: their sills move up)
    if (!raised && storeyStyle(ctx.district.zone, ctx.key.s) === 0 && pr.chance(0.18)) {
      const a0 = Math.min(b.li(r.a0, r.b0), b.li(r.a1 - 1, r.b1 - 1)), c0 = Math.min(b.lj(r.a0, r.b0), b.lj(r.a1 - 1, r.b1 - 1));
      const a1 = Math.max(b.li(r.a0, r.b0), b.li(r.a1 - 1, r.b1 - 1)) + 1, c1 = Math.max(b.lj(r.a0, r.b0), b.lj(r.a1 - 1, r.b1 - 1)) + 1;
      const rect = { li0: a0, lj0: c0, li1: a1, lj1: c1 };
      const area = (a1 - a0) * (c1 - c0);
      const prog = area <= 30 && pr.chance(0.6) ? Program.RESTROOM : Program.KITCHENETTE;
      if (applyProgram(pc, rect, prog)) { ox.dbg.programs++; continue; }
    }
    furnishRoom(ox, b, r, raised ? RAISE_CM / 100 : 0);
  }
}

/** 1-D BSP of [a0, a1) into rooms of width >= 3 (pairs pushed into out). */
function split1d(rng: Rng, a0: number, a1: number, out: number[]): void {
  const len = a1 - a0;
  if (len >= 7 && (len > 8 || rng.chance(0.6))) {
    const k = rng.int(a0 + 3, a1 - 3);
    split1d(rng, a0, k, out);
    split1d(rng, k, a1, out);
  } else {
    out.push(a0, a1);
  }
}

/** Corridor cell (b) of the entrance door at each end of a raised block's corridor (the other cell is walled). */
const RAMP_B = 6;

function raiseBlock(b: Blk): void {
  const g = b.g, L = g.layout;
  for (let bb = 0; bb < INNER; bb++) {
    for (let a = 0; a < INNER; a++) {
      const li = b.li(a, bb), lj = b.lj(a, bb);
      const ramp = bb === RAMP_B && (a === 0 || a === INNER - 1);
      if (ramp) { g.setCells(li, lj, li + 1, lj + 1, { floorMat: Mat.VINYL_VCT }); continue; }
      g.setCells(li, lj, li + 1, lj + 1, { floorCm: L.floorCm[cellIdx(li, lj)] + RAISE_CM, floorMat: Mat.VINYL_VCT });
    }
  }
  for (const end of [0, INNER - 1]) {
    // the corridor end (2 cells wide, b = 6..7) becomes a door on the aisle-level ramp cell and a wall beside it
    const line = end === 0 ? 0 : INNER;
    b.aEdge(line, RAMP_B, EdgeKind.DOORWAY, DOOR);
    b.aEdge(line, RAMP_B + 1, EdgeKind.WALL);
    const xa = b.x(end, RAMP_B), za = b.z(end, RAMP_B), xb = b.x(end + 1, RAMP_B + 1), zb = b.z(end + 1, RAMP_B + 1);
    // ascent toward the block interior: +a at the a = 0 end, -a at the far end
    const da = end === 0 ? 1 : -1;
    const wdx = b.dx(da, 0), wdz = b.dz(da, 0);
    const dir: 0 | 1 | 2 | 3 = wdx > 0 ? 0 : wdx < 0 ? 1 : wdz > 0 ? 2 : 3;
    const base = L.floorCm[cellIdx(b.li(end, RAMP_B), b.lj(end, RAMP_B))];
    g.addSolid({
      kind: 'ramp', x0: Math.min(xa, xb), z0: Math.min(za, zb), x1: Math.max(xa, xb), z1: Math.max(za, zb),
      y0: base / 100, y1: (base + RAISE_CM) / 100, dir, steps: 2, mat: Mat.VINYL_VCT,
      flags: SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.WALKABLE_TOP | SolidFlag.RENDER, bakeGroup: 0,
    });
  }
}

function furnishRoom(ox: Ox, b: Blk, r: Room, y: number): void {
  const rng = ox.rng, u = 1 / CELL;
  const w = r.a1 - r.a0, d = r.b1 - r.b0;
  const ca = (r.a0 + r.a1) / 2, cb = (r.b0 + r.b1) / 2;
  // far wall = the b side away from the door line
  const farB = r.doorB === r.b1 ? r.b0 : r.b1;
  const inward = farB === r.b0 ? 1 : -1; // b direction from the far wall into the room
  if (w * d >= 18 && Math.max(w, d) >= 4 && Math.min(w, d) >= 3 && rng.chance(0.55)) {
    // conference room: a 3.0 x 1.2 m table along the long axis, 6-10 chairs around it
    const alongA = w >= d;
    prop(ox, b, PropKind.CONFERENCE_TABLE, rng.int(0, 1), ca, cb, y, alongA ? 0 : 1, alongA ? 1 : 0, 0);
    // the table's long axis = its local x; facing +b / +a puts local x along a / b respectively
    const n = rng.int(6, 10);
    const ends = n >= 8 ? 2 : n & 1;
    const sides = n - ends;
    const perSide = [Math.ceil(sides / 2), Math.floor(sides / 2)];
    for (let s = 0; s < 2; s++) {
      const sgn = s === 0 ? 1 : -1;
      const k = perSide[s];
      for (let i = 0; i < k; i++) {
        const t = k === 1 ? 0 : -1.05 + (2.1 * i) / (k - 1);
        const pa = alongA ? ca + t * u : ca + sgn * 0.95 * u, pb = alongA ? cb + sgn * 0.95 * u : cb + t * u;
        prop(ox, b, PropKind.OFFICE_CHAIR, rng.int(0, 2), pa, pb, y, alongA ? 0 : -sgn, alongA ? -sgn : 0, 0.35);
      }
    }
    for (let e = 0; e < ends; e++) {
      const sgn = e === 0 ? 1 : -1;
      const pa = alongA ? ca + sgn * 1.9 * u : ca, pb = alongA ? cb : cb + sgn * 1.9 * u;
      prop(ox, b, PropKind.OFFICE_CHAIR, rng.int(0, 2), pa, pb, y, alongA ? -sgn : 0, alongA ? 0 : -sgn, 0.35);
    }
    return;
  }
  // private office: desk against the far wall facing the door, chair, CRT, cabinet, maybe a visitor chair
  const deskB = farB + inward * (0.08 + 0.375) * u;
  const deskA = ca + (rng.float() - 0.5) * Math.max(0, w - 2) * 0.5;
  prop(ox, b, PropKind.DESK, rng.int(0, 2), deskA, deskB, y, 0, inward, 0.03);
  prop(ox, b, PropKind.CRT_MONITOR, rng.int(0, 1), deskA + (rng.float() - 0.5) * 0.4 * u, deskB - inward * 0.1 * u, y + 0.75, 0, inward, 0.2);
  prop(ox, b, PropKind.OFFICE_CHAIR, rng.int(0, 2), deskA, deskB + inward * 0.8 * u, y, 0, -inward, 0.5);
  if (rng.chance(0.7)) {
    const side = deskA > ca ? -1 : 1; // cabinet in the far corner on the side the desk leaves free
    const pa = side > 0 ? r.a1 - (0.03 + 0.31) * u : r.a0 + (0.03 + 0.31) * u;
    prop(ox, b, PropKind.FILING_CABINET, rng.int(0, 1), pa, farB + inward * (0.08 + 0.24) * u, y, -side, 0, 0);
  }
  if (d >= 3 && rng.chance(0.5)) {
    prop(ox, b, PropKind.CHAIR_STACKING, rng.int(0, 2), deskA + (rng.float() - 0.5) * 0.6 * u, deskB + inward * 1.9 * u, y, 0, -inward, 0.3);
  }
}

// ------------------------------------------------------------------------------------------------ BREAK

function breakRoom(ctx: ZoneGenContext, ox: Ox, b: Blk): void {
  const rng = ox.rng, g = b.g, u = 1 / CELL;
  // floor
  for (let bb = 0; bb < INNER; bb++) for (let a = 0; a < INNER; a++) {
    g.setCells(b.li(a, bb), b.lj(a, bb), b.li(a, bb) + 1, b.lj(a, bb) + 1, { floorMat: Mat.VINYL_VCT });
  }
  // walls on the 4 sides (0: b = 0, 1: b = 14, 2: a = 0, 3: a = 14); wide HEADER openings on 2-3 of them
  const sides = rng.shuffle([0, 1, 2, 3]);
  const nOpen = rng.int(2, 3);
  const opened = new Uint8Array(4);
  const openFrom = new Int8Array(4).fill(-1), openTo = new Int8Array(4).fill(-1);
  for (let k = 0; k < nOpen; k++) {
    const s = sides[k];
    const w = rng.int(2, 3);
    const p = rng.int(3, INNER - 3 - w);
    opened[s] = 1; openFrom[s] = p; openTo[s] = p + w;
  }
  for (let s = 0; s < 4; s++) {
    for (let c = 0; c < INNER; c++) {
      const isOpen = opened[s] && c >= openFrom[s] && c < openTo[s];
      const kind = isOpen ? EdgeKind.HEADER : EdgeKind.WALL;
      const o = isOpen ? { hA: 220 } : undefined;
      if (s === 0) b.bEdge(0, c, kind, o);
      else if (s === 1) b.bEdge(INNER, c, kind, o);
      else if (s === 2) b.aEdge(0, c, kind, o);
      else b.aEdge(INNER, c, kind, o);
    }
  }
  // closed sides host the counter and the vending bank
  const closed: number[] = [];
  for (let s = 0; s < 4; s++) if (!opened[s]) closed.push(s);
  const along = (s: number, c: number, depth: number): [number, number] =>
    s === 0 ? [c, depth] : s === 1 ? [c, INNER - depth] : s === 2 ? [depth, c] : [INNER - depth, c];
  const inwardOf = (s: number): [number, number] => (s === 0 ? [0, 1] : s === 1 ? [0, -1] : s === 2 ? [1, 0] : [-1, 0]);

  // counter (blocker cells, WOOD top) along the first closed side
  const cs = closed[0];
  const c0 = rng.int(2, INNER - 6);
  for (let c = c0; c < c0 + 4; c++) {
    const [a, bb] = along(cs, c + 0.5, 0.5);
    const li = b.li(Math.floor(a), Math.floor(bb)), lj = b.lj(Math.floor(a), Math.floor(bb));
    g.setCells(li, lj, li + 1, lj + 1, { blockCm: 90, floorMat: Mat.WOOD });
  }
  // vending machines (with VENDING light panels) along the second closed side, or the far end of the first
  const vs = closed.length > 1 ? closed[1] : cs;
  const nv = rng.int(2, 3);
  const v0 = vs === cs ? (c0 >= 7 ? 1 : INNER - 1 - nv) : rng.int(2, INNER - 2 - nv);
  const [ia, ib] = inwardOf(vs);
  for (let k = 0; k < nv; k++) {
    const [fa, fb] = along(vs, v0 + k + 0.5, (0.03 + 0.4) * u);
    prop(ox, b, PropKind.VENDING_MACHINE, rng.int(0, 2), fa, fb, 0, ia, ib, 0);
    const [pa, pb] = along(vs, v0 + k + 0.5, (0.03 + 0.8 + 0.01) * u);
    const tdx = b.dx(ib !== 0 ? 1 : 0, ia !== 0 ? 1 : 0), tdz = b.dz(ib !== 0 ? 1 : 0, ia !== 0 ? 1 : 0);
    addCustomFixture(ctx, {
      kind: FixtureKind.VENDING, x: b.x(pa, pb), y: 1.05, z: b.z(pa, pb),
      nx: b.dx(ia, ib), ny: 0, nz: b.dz(ia, ib), tx: tdx, ty: 0, tz: tdz, w: 0.7, h: 1.4,
      cct0: 5200, cct1: 6200, luminance: 600, hum: 0.8,
    });
  }
  // a trash can beside the vending bank, on the side away from the counter (skipped if it would touch it)
  const tc = vs === cs ? (v0 < 7 ? v0 + nv : v0 - 1) : v0 + nv;
  if (tc >= 0 && tc < INNER && !(vs === cs && tc >= c0 - 1 && tc < c0 + 5)) {
    const [ta, tb] = along(vs, tc + 0.5, (0.03 + 0.2) * u);
    prop(ox, b, PropKind.TRASH_CAN, rng.int(0, 1), ta, tb, 0, ia, ib, 0.4);
  }
  // water cooler against a wall section of another side, away from its opening
  const ws = closed.length > 2 ? closed[2] : sides[0];
  const wc = opened[ws] ? (openFrom[ws] > 7 ? 2 : INNER - 3) : rng.int(2, INNER - 3);
  const [wa, wb] = along(ws, wc + 0.5, (0.03 + 0.16) * u);
  const [wia, wib] = inwardOf(ws);
  prop(ox, b, PropKind.WATER_COOLER, 0, wa, wb, 0, wia, wib, 0);

  // long cafeteria tables along a with stacking chairs, rows at b = 4.5 / 7 / 9.5 (inside the 1.5-cell margins)
  const rows = rng.chance(0.5) ? [4.5, 9.5] : [4, 7, 10];
  for (const rb of rows) {
    for (const ra of [4, 10]) {
      if (rng.chance(0.12)) continue;
      prop(ox, b, PropKind.CONFERENCE_TABLE, 1, ra, rb, 0, 0, 1, 0.03);
      for (let s = -1; s <= 1; s += 2) {
        for (let i = 0; i < 3; i++) {
          if (rng.chance(0.2)) continue;
          const t = -1.0 + i;
          prop(ox, b, PropKind.CHAIR_STACKING, rng.int(0, 2), ra + t * u + (rng.float() - 0.5) * 0.1 * u, rb + s * 0.85 * u, 0, 0, -s, 0.3);
        }
      }
    }
  }
}
