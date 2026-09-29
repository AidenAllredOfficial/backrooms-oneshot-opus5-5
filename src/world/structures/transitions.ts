// src/world/structures/transitions.ts — R2 zone transitions, stamped by the zone generators on their side of a
// district BOUNDARY seam (the seam line itself stays the pure, shared world/seams.ts contract).
//
// Hard boundaries (a wall with 2-4 styled openings): behind every narrow opening (DOORWAY or a HEADER <= 220 cm,
// 1-3 cells) the HOST side builds a 2-3-cell connector: side walls, a bulkhead ceiling at 230 cm, the neighbour's
// floor / wall materials up to the connector midline and the host's beyond it, and at its inner end a fire-door
// frame (DOORWAY + CASING | THRESHOLD | EXIT_SIGN trim) with a metal DOOR_LEAF propped open and an EXIT sign over
// it. Host = the side with the LOWER zone rank (see ZONE_RANK) among the zones whose generators call this; ties by
// district id. On storey 1 (and whenever a deep zone hosts) the connector is a raw CMU service corridor, 20 cm below
// the floor, ramped back up at its inner end, lit by a TUBE_STRIP.
// Soft boundaries: both sides dither the neighbour's palette into their first 3 cells (floor material per hashed
// global cell, falling off with distance; alternate wall pieces take the neighbour's wall material).
// Every connector is tried and reverted if it would leave any walkable cell unreachable from the ports.

import { CELL, CHUNK_CELLS, WALL_T } from '../../core/constants.ts';
import { cellIdx, exIdx, ezIdx } from '../../core/grid.ts';
import { CeilKind, DECAL_PAINT_STRIPE, EdgeKind, EdgeTrim, FixtureKind, Mat, SeamMode, SolidFlag, Zone, type MatId, type ZoneId } from '../../core/ids.ts';
import { hash01, hash5, SALT } from '../../core/rng.ts';
import type { DistrictInfo, SeamSpec, ZoneGenContext, ZonePalette } from '../../core/world.ts';
import { EXIT_RED, fixtureAt, addLatticeFixture } from '../content/util.ts';
import { softPair } from '../seams.ts';
import { generatorFor } from '../zones/registry.ts';
import { addCustomFixtureUnique } from '../zones/l0common.ts';
import { leafClear, placeLeaf, swingFree } from './doors.ts';
import { plainCell, propsInRect, putEdge, restore, snapshot, solidsInRect, unreachedWalkable, WALK_SOLID } from './util.ts';

const N = CHUNK_CELLS;
/** Zone rank for choosing the connector host: lower rank hosts. Zones whose generators do not call
 * transitionStamps get Infinity (never host). */
export const ZONE_RANK: Readonly<Record<number, number>> = {
  [Zone.PIPEWORKS]: 0, [Zone.CONCRETE]: 1, [Zone.PILLAR_HALL]: 3, [Zone.DARK]: 4, [Zone.LOW_EXPANSE]: 8,
  [Zone.MANILA]: 5, [Zone.LOBBY]: 6, [Zone.OFFICE]: 7,
};
const rankOf = (z: ZoneId): number => ZONE_RANK[z] ?? Infinity;
export const CONNECTOR_CEIL_CM = 230;
const DEEP = (z: ZoneId): boolean => z >= Zone.POOLROOMS;

export interface TransitionCounts { connectors: number; dithered: number }

type Side = 'W' | 'N' | 'E' | 'S';
const SIDES: readonly Side[] = ['W', 'N', 'E', 'S'];

function neighbourDistrict(ctx: ZoneGenContext, side: Side): DistrictInfo {
  const { s, cx, cz } = ctx.key;
  const dx = side === 'W' ? -1 : side === 'E' ? 1 : 0, dz = side === 'N' ? -1 : side === 'S' ? 1 : 0;
  return ctx.world.districtAt(s, cx + dx, cz + dz);
}

/** Does this chunk host the connectors of the boundary on `side`? (pure in both chunks' inputs) */
export function hostsConnector(self: DistrictInfo, other: DistrictInfo): boolean {
  const ra = rankOf(self.zone), rb = rankOf(other.zone);
  if (ra !== rb) return ra < rb;
  if (ra === Infinity) return false;
  return (self.id >>> 0) < (other.id >>> 0);
}

export function transitionStamps(ctx: ZoneGenContext, busy: Uint8Array | null = null): TransitionCounts {
  const out: TransitionCounts = { connectors: 0, dithered: 0 };
  for (const side of SIDES) {
    const spec = ctx.seams[side];
    if (spec.mode !== SeamMode.BOUNDARY) continue;
    const other = neighbourDistrict(ctx, side);
    if (other.id === ctx.district.id) continue;
    const soft = softPair(ctx.seed, ctx.key.s, ctx.district.id, other.id);
    const otherPal = generatorFor(other.zone).palette(ctx.key.s, other);
    if (soft) out.dithered += dither(ctx, side, otherPal, busy);
    else if (hostsConnector(ctx.district, other)) out.connectors += connectors(ctx, side, spec, other, otherPal, busy);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ geometry helpers

/** Local cell at depth d (0 = next to the line) and position c along the seam line of `side`. */
function cellAt(side: Side, c: number, d: number): [number, number] {
  switch (side) {
    case 'W': return [d, c];
    case 'E': return [N - 1 - d, c];
    case 'N': return [c, d];
    default: return [c, N - 1 - d];
  }
}
/** Edge between depth d-1 and d (d >= 1) at position c: the "across" edges of the connector. */
function acrossEdge(side: Side, c: number, d: number): { axis: 'x' | 'z'; i: number; j: number } {
  switch (side) {
    case 'W': return { axis: 'x', i: d, j: c };
    case 'E': return { axis: 'x', i: N - d, j: c };
    case 'N': return { axis: 'z', i: c, j: d };
    default: return { axis: 'z', i: c, j: N - d };
  }
}
/** Edge between positions c-1 and c at depth d: the "along" edges (connector side walls). */
function alongEdge(side: Side, c: number, d: number): { axis: 'x' | 'z'; i: number; j: number } {
  switch (side) {
    case 'W': return { axis: 'z', i: d, j: c };
    case 'E': return { axis: 'z', i: N - 1 - d, j: c };
    case 'N': return { axis: 'x', i: c, j: d };
    default: return { axis: 'x', i: c, j: N - 1 - d };
  }
}
/** matNeg / matPos so that the face looking into the connector interior gets `inside`, the other `outside`
 * (`negIsInside`: the connector cell is on the edge's negative side). */
function faceMats(negIsInside: boolean, inside: MatId, outside: MatId): { matNeg: MatId; matPos: MatId } {
  return negIsInside ? { matNeg: inside, matPos: outside } : { matNeg: outside, matPos: inside };
}

// ------------------------------------------------------------------------------------------------ hard connectors

function connectors(ctx: ZoneGenContext, side: Side, spec: SeamSpec, other: DistrictInfo, otherPal: ZonePalette, busy: Uint8Array | null): number {
  const g = ctx.grid, l = g.layout;
  // runs of walkable seam edges
  const runs: [number, number][] = [];
  let a = -1;
  for (let c = 0; c <= N; c++) {
    const k = c < N ? spec.kind[c] : EdgeKind.WALL;
    const rollup = k === EdgeKind.HEADER && (spec.trim[c] & EdgeTrim.ROLLUP) !== 0;
    const walk = c < N && (k === EdgeKind.DOORWAY || (k === EdgeKind.HEADER && spec.hA[c] >= 190 && (spec.hA[c] <= 220 || rollup)) || k === EdgeKind.OPEN);
    if (walk && a < 0) a = c;
    if (!walk && a >= 0) { runs.push([a, c]); a = -1; }
  }
  const deepHost = DEEP(ctx.district.zone) || ctx.key.s === 1;
  const hostPal = ctx.palette;
  let built = 0;
  const seen = new Uint8Array(N * N);
  let base0 = -1;
  for (const [r0, r1] of runs) {
    const w = r1 - r0;
    // only styled openings (doorway / header / roll-up), not artery lanes or wide arcades
    const k0 = spec.kind[r0];
    if (k0 !== EdgeKind.DOORWAY && k0 !== EdgeKind.HEADER) continue;
    // roll-up openings (PARKING / WAREHOUSE boundaries) get a 2-cell concrete loading bay instead of fire doors
    const bay = k0 === EdgeKind.HEADER && (spec.trim[r0] & EdgeTrim.ROLLUP) !== 0;
    if (w > (bay ? 4 : 3) || r0 < 2 || r1 > N - 2) continue;
    const D = bay ? 2 : w >= 2 ? 3 : 2 + (hash01(hash5(ctx.seed, SALT.CONNECT, ctx.key.s, g.gi0 + r0, g.gj0)) < 0.5 ? 1 : 0);
    const connCeil = bay ? spec.hA[r0] + 20 : CONNECTOR_CEIL_CM;
    // footprint: positions [r0, r1) x depths [0, D); plain cells, one floor height, room above for the bulkhead
    let ok = true;
    const f0 = l.floorCm[cellIdx(...cellAt(side, r0, 0))];
    for (let d = 0; d < D && ok; d++) {
      for (let c = r0; c < r1 && ok; c++) {
        const [li, lj] = cellAt(side, c, d);
        const cc = cellIdx(li, lj);
        if (!plainCell(g, li, lj) || l.floorCm[cc] !== f0 || (busy && busy[cc])) ok = false;
        else if (l.ceilCm[cc] - f0 < connCeil + 10) ok = false;
        else if (solidsInRect(l, li, lj, li + 1, lj + 1) || propsInRect(l, li, lj, li + 1, lj + 1)) ok = false;
      }
    }
    // the cells beyond the inner end must be walkable too (the door leads somewhere)
    for (let c = r0; c < r1 && ok; c++) { const [li, lj] = cellAt(side, c, D); if (!plainCell(g, li, lj) || l.floorCm[cellIdx(li, lj)] !== f0) ok = false; }
    if (!ok) continue;
    if (base0 < 0) base0 = unreachedWalkable(l, seen);
    const snap = snapshot(l);
    const mid = D >> 1; // depths < mid take the neighbour's palette
    const cmu = deepHost || bay;
    // service corridors and loading bays are raw (unpainted) block
    const outerWall = cmu ? Mat.CMU_RAW : otherPal.wallMat, innerWall = cmu ? Mat.CMU_RAW : hostPal.wallMat;
    const floorDrop = ctx.key.s === 1 && !bay ? 20 : 0;
    for (let d = 0; d < D; d++) {
      for (let c = r0; c < r1; c++) {
        const [li, lj] = cellAt(side, c, d);
        g.setCells(li, lj, li + 1, lj + 1, {
          ceilCm: f0 + connCeil, floorCm: f0 - floorDrop,
          floorMat: cmu ? Mat.CONCRETE_FLOOR : d < mid ? otherPal.floorMat : hostPal.floorMat,
          ...(bay ? { ceilKind: CeilKind.CONCRETE, ceilMat: Mat.CONCRETE_CEIL } : {}),
        });
        l.wallMat[cellIdx(li, lj)] = d < mid ? outerWall : innerWall;
        if (d > 0) { const e = acrossEdge(side, c, d); putEdge(g, e.axis, e.i, e.j, EdgeKind.OPEN, { trim: 0 }); }
        if (c > r0) { const e = alongEdge(side, c, d); putEdge(g, e.axis, e.i, e.j, EdgeKind.OPEN, { trim: 0 }); }
      }
      // side walls: the connector interior face gets the depth's material, the room side keeps the host's
      for (const [c, insideNeg] of [[r0, false], [r1, true]] as const) {
        const e = alongEdge(side, c, d);
        const m = faceMats(insideNeg, d < mid ? outerWall : innerWall, hostPal.wallMat);
        putEdge(g, e.axis, e.i, e.j, EdgeKind.WALL, { ...m, trim: hostPal.baseboard && !cmu ? EdgeTrim.BASEBOARD : 0 });
      }
    }
    // the inner end: fire doors (one leaf per cell, the middle of three is a wall)
    const doorCells: number[] = [];
    if (bay) for (let c = r0; c < r1; c++) { const e = acrossEdge(side, c, D); putEdge(g, e.axis, e.i, e.j, EdgeKind.OPEN, { trim: 0 }); }
    for (let c = r0; c < r1 && !bay; c++) {
      const e = acrossEdge(side, c, D);
      const door = !(w === 3 && c === r0 + 1);
      const insideNeg = side === 'W' || side === 'N'; // the connector is on the negative side of its inner end line
      const m = faceMats(insideNeg, innerWall, hostPal.wallMat);
      if (door) {
        putEdge(g, e.axis, e.i, e.j, EdgeKind.DOORWAY, { hA: f0 + 210, ...m, trim: EdgeTrim.CASING | EdgeTrim.THRESHOLD | (c === r0 ? EdgeTrim.EXIT_SIGN : 0) });
        doorCells.push(c);
      } else putEdge(g, e.axis, e.i, e.j, EdgeKind.WALL, { ...m, trim: 0 });
    }
    if (floorDrop > 0) {
      // the inner cell row ramps back up to the host floor
      const [ai, aj] = cellAt(side, r0, D - 1), [bi, bj] = cellAt(side, r1 - 1, D - 1);
      const x0 = Math.min(ai, bi) * CELL, x1 = (Math.max(ai, bi) + 1) * CELL, z0 = Math.min(aj, bj) * CELL, z1 = (Math.max(aj, bj) + 1) * CELL;
      const dir: 0 | 1 | 2 | 3 = side === 'W' ? 0 : side === 'E' ? 1 : side === 'N' ? 2 : 3;
      g.addSolid({ kind: 'ramp', x0, z0, x1, z1, y0: (f0 - floorDrop) / 100, y1: f0 / 100, dir, steps: 0, mat: Mat.CONCRETE_FLOOR, flags: WALK_SOLID | SolidFlag.FILLED, bakeGroup: 0 });
    }
    if (unreachedWalkable(l, seen) > base0) { restore(l, snap); continue; }
    // leaves propped open into the host side (hinges at the connector walls), the exit sign over the doors
    const inward: -1 | 1 = side === 'W' || side === 'N' ? 1 : -1; // +axis direction points into the host
    for (let k = 0; k < doorCells.length; k++) {
      const c = doorCells[k];
      const e = acrossEdge(side, c, D);
      const hinge: -1 | 1 = doorCells.length === 1 ? (c === r0 ? -1 : 1) : k === 0 ? -1 : 1;
      const deg = 88 + 10 * hash01(hash5(ctx.seed, SALT.PROP, ctx.key.s, g.gi0 + c, g.gj0 + D));
      if (floorDrop !== 0) continue;
      // into the host unless the leaf would block the space there (e.g. a 1-cell corridor along the doors); then back
      // into the connector, flat against its side wall; else no leaf
      const into = leafClear(l, e.axis, e.i, e.j, inward, hinge) && swingFree(l, e.axis, e.i, e.j, inward, hinge) ? inward
        : leafClear(l, e.axis, e.i, e.j, (-inward) as -1 | 1, hinge) && swingFree(l, e.axis, e.i, e.j, (-inward) as -1 | 1, hinge) ? (-inward) as -1 | 1 : 0;
      if (into !== 0) placeLeaf(g, e.axis, e.i, e.j, into, hinge, deg, 2, hash5(ctx.seed, SALT.PROP, 77, g.gi0 + c, g.gj0 + D));
    }
    if (bay) {
      // yellow safety stripes across the bay mouth on the host side of the roll-up
      const e0 = acrossEdge(side, r0, D);
      const lineM = (e0.axis === 'x' ? e0.i : e0.j) * CELL + (inward > 0 ? -0.15 : 0.15);
      const mid0 = (r0 + r1) / 2 * CELL, len = w * CELL - 0.3;
      g.addDecal({
        kind: DECAL_PAINT_STRIPE, sign: false, px: e0.axis === 'x' ? lineM : mid0, py: f0 / 100 + 0.002, pz: e0.axis === 'x' ? mid0 : lineM,
        nx: 0, ny: 1, nz: 0, rot: e0.axis === 'x' ? 0 : Math.PI / 2, w: 0.1, h: len, alpha: 0.85, color: [1.0, 0.72, 0.06],
      });
    }
    if (doorCells.length > 0) {
      const c = doorCells[0];
      const e = acrossEdge(side, c, D);
      const lineM = (e.axis === 'x' ? e.i : e.j) * CELL, midM = ((e.axis === 'x' ? e.j : e.i) + 0.5) * CELL;
      // on the connector side, 5 cm below the door head, facing into the connector (the way back out)
      const n = -inward; // normal pointing back into the connector
      const off = lineM + n * (WALL_T / 2 + 0.03);
      const px = e.axis === 'x' ? off : midM, pz = e.axis === 'x' ? midM : off;
      const t: [number, number, number] = e.axis === 'x' ? [0, 0, 1] : [1, 0, 0];
      addLatticeFixture(g, fixtureAt(FixtureKind.EXIT_SIGN, px, (f0 + 210) / 100 + 0.12, pz, [e.axis === 'x' ? n : 0, 0, e.axis === 'x' ? 0 : n], t, EXIT_RED, 150));
    }
    if (cmu) {
      // a tube strip down the connector's middle
      const cc = (r0 + r1) / 2;
      const [li, lj] = cellAt(side, Math.floor(cc), Math.max(0, mid));
      const alongLine = side === 'W' || side === 'E'; // connector runs along x for W/E seams
      const x = alongLine ? (li + 0.5) * CELL : cc * CELL, z = alongLine ? cc * CELL : (lj + 0.5) * CELL;
      addCustomFixtureUnique(ctx, {
        kind: FixtureKind.TUBE_STRIP, x, y: (f0 + connCeil) / 100 - 0.06, z, nx: 0, ny: -1, nz: 0,
        tx: alongLine ? 1 : 0, ty: 0, tz: alongLine ? 0 : 1, w: 1.2, h: 0.1, cct0: 3900, cct1: 4300, luminance: 8600, hum: 0.6,
      });
    }
    if (busy) for (let d = 0; d <= D; d++) for (let c = r0; c < r1; c++) { const [li, lj] = cellAt(side, c, d); busy[cellIdx(li, lj)] = 1; }
    built++;
  }
  return built;
}

// ------------------------------------------------------------------------------------------------ soft dither

const DITHER_P: readonly number[] = [0.55, 0.3, 0.12];

function dither(ctx: ZoneGenContext, side: Side, otherPal: ZonePalette, busy: Uint8Array | null): number {
  const g = ctx.grid, l = g.layout;
  const hostPal = ctx.palette;
  if (otherPal.floorMat === hostPal.floorMat && otherPal.wallMat === hostPal.wallMat) return 0;
  let n = 0;
  for (let d = 0; d < DITHER_P.length; d++) {
    for (let c = 0; c < N; c++) {
      const [li, lj] = cellAt(side, c, d);
      const cc = cellIdx(li, lj);
      if (!plainCell(g, li, lj) || (busy && busy[cc])) continue;
      if (l.floorMat[cc] !== hostPal.floorMat) continue;
      const gi = g.gi0 + li, gj = g.gj0 + lj;
      if (hash01(hash5(ctx.seed, SALT.CONNECT, ctx.key.s, gi, gj)) < DITHER_P[d]) {
        g.setCells(li, lj, li + 1, lj + 1, { floorMat: otherPal.floorMat });
        n++;
      }
      // alternate wall pieces take the neighbour's wall material (edges around the cell, global parity)
      if (otherPal.wallMat === hostPal.wallMat || ((gi + gj) & 1) !== 0 || d > 1) continue;
      for (const [axis, i, j] of [['x', li, lj], ['x', li + 1, lj], ['z', li, lj], ['z', li, lj + 1]] as const) {
        if (i < 1 || j < 1 || (axis === 'x' ? i >= N : j >= N) || g.isFrozenEdge(axis, i, j)) continue;
        const k = axis === 'x' ? l.ex.kind[exIdx(i, j)] : l.ez.kind[ezIdx(i, j)];
        if (k !== EdgeKind.WALL) continue;
        const e = axis === 'x' ? l.ex : l.ez, ki = axis === 'x' ? exIdx(i, j) : ezIdx(i, j);
        e.matNeg[ki] = otherPal.wallMat; e.matPos[ki] = otherPal.wallMat;
      }
    }
  }
  return n;
}
