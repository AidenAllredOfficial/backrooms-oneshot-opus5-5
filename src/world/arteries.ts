// src/world/arteries.ts — artery stamping (WP1).
//
// Arteries are endless 2-cell hallways on a world lattice (sites.ts). In a chunk they cross:
//  - lane cells get ARTERY|RESERVED and the storey's artery palette (cellZone set accordingly);
//  - flanking walls go on the lines before and after the lanes, with an OPEN or DOORWAY side door every
//    U(4, 10) cells (a renewal process seeded from the artery seed, in GLOBAL cells, so it is continuous across
//    chunks); where two arteries cross, their walls are skipped;
//  - the artery lights: storey 0 troffers every other cell, storey 1 TUBE_STRIP every 2 cells, storey 2
//    SKY_PANEL every 3 cells.

import { ARTERY, CEIL_TILE, CHUNK_CELLS, DOOR_CM, TILE_CELLS } from '../core/constants.ts';
import { cellIdx, ezIdx, exIdx } from '../core/grid.ts';
import { CellFlag, EdgeKind, EdgeTrim, FixtureKind, type FixtureKindId, LightState, type MatId, type StoreyId, TileState, Zone, type ZoneId } from '../core/ids.ts';
import { NO_WATER, setTile, type ChunkLayout } from '../core/layout.ts';
import { hash2, Rng } from '../core/rng.ts';
import type { ArterySpan, ZonePalette } from '../core/world.ts';
import type { BuildGrid } from './chunkGrid.ts';
import { kelvinToLinearRGB } from './content/kelvin.ts';

const N = CHUNK_CELLS;
const W = ARTERY.WIDTH_CELLS; // 2

export interface ArteryStyle {
  zone: ZoneId; // palette zone of the lane cells
  ceilLo: number; ceilHi: number; // lane ceilCm = clamp(palette.ceilCm, lo, hi)
  fixture: FixtureKindId;
  every: number; // one light every N cells along the lane
  luminance: number;
  cct: number;
  wainscot: boolean;
}

export const ARTERY_STYLE: Readonly<Record<StoreyId, ArteryStyle>> = {
  0: { zone: Zone.LOBBY, ceilLo: 250, ceilHi: 260, fixture: FixtureKind.TROFFER_2x4, every: 2, luminance: 3300, cct: 4100, wainscot: false },
  1: { zone: Zone.CONCRETE, ceilLo: 280, ceilHi: 300, fixture: FixtureKind.TUBE_STRIP, every: 2, luminance: 8600, cct: 4000, wainscot: true },
  2: { zone: Zone.POOLROOMS, ceilLo: 330, ceilHi: 360, fixture: FixtureKind.SKY_PANEL, every: 3, luminance: 2500, cct: 6500, wainscot: false },
};

/** Local lane index (first of the 2 lanes) of a span in chunk with global origin (gi0, gj0). */
const laneOf = (a: ArterySpan, gi0: number, gj0: number): number => a.row - (a.axis === 'x' ? gj0 : gi0);

/** Global positions (cells along the artery) of side doors on one flank, with their kinds, inside [gA, gB). */
function sideDoors(a: ArterySpan, side: number, gA: number, gB: number, out: Map<number, number>): void {
  const rng = new Rng(hash2(a.seed, 101 + side));
  let g = a.g0 + rng.int(1, 9);
  while (g < gB && g < a.g1) {
    const kind = rng.chance(0.5) ? EdgeKind.DOORWAY : EdgeKind.OPEN;
    if (g >= gA) out.set(g, kind);
    g += rng.int(4, 10);
  }
}

/** Stamps every artery span crossing this chunk (spans from sites.arteriesInChunk). */
export function stampArteries(g: BuildGrid, spans: readonly ArterySpan[], pal: ZonePalette, s: StoreyId): void {
  if (spans.length === 0) return;
  const l = g.layout;
  const style = ARTERY_STYLE[s];
  const ceilCm = Math.max(style.ceilLo, Math.min(style.ceilHi, pal.ceilCm));
  const gi0 = g.gi0, gj0 = g.gj0;
  const isLane = (li: number, lj: number, axis: 'x' | 'z' | null): boolean => {
    for (const a of spans) {
      if (axis !== null && a.axis !== axis) continue;
      const L = laneOf(a, gi0, gj0);
      const c = a.axis === 'x' ? lj : li;
      if (c >= L && c < L + W) return true;
    }
    return false;
  };

  // ---- 1. lane cells
  for (const a of spans) {
    const L = laneOf(a, gi0, gj0);
    const [li0, lj0, li1, lj1] = a.axis === 'x' ? [0, L, N, L + W] : [L, 0, L + W, N];
    g.setCells(li0, lj0, li1, lj1, {
      floorCm: 0, ceilCm, waterCm: NO_WATER, blockCm: 0, floorMat: pal.floorMat, ceilMat: pal.ceilMat, ceilKind: pal.ceilKind,
      cellZone: style.zone, flagsSet: CellFlag.ARTERY | CellFlag.RESERVED,
      flagsClear: CellFlag.SOLID | CellFlag.VOID | CellFlag.NOWALK | CellFlag.NO_CEIL,
    }, true);
    for (let lj = lj0; lj < lj1; lj++) {
      for (let li = li0; li < li1; li++) {
        const c = cellIdx(li, lj);
        l.wallMat[c] = pal.wallMat;
        l.trimMat[c] = pal.trimMat;
      }
    }
  }
  // interior edges between lane cells: OPEN, lane-palette materials
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      if (!isLane(li, lj, null)) continue;
      if (li > 0 && isLane(li - 1, lj, null)) {
        const k = exIdx(li, lj);
        l.ex.kind[k] = EdgeKind.OPEN; l.ex.matNeg[k] = pal.wallMat; l.ex.matPos[k] = pal.wallMat;
      }
      if (lj > 0 && isLane(li, lj - 1, null)) {
        const k = ezIdx(li, lj);
        l.ez.kind[k] = EdgeKind.OPEN; l.ez.matNeg[k] = pal.wallMat; l.ez.matPos[k] = pal.wallMat;
      }
    }
  }

  // ---- 2. flanking walls with side doors
  const trim = (pal.baseboard ? EdgeTrim.BASEBOARD : 0) | (style.wainscot ? EdgeTrim.WAINSCOT : 0);
  const doors = new Map<number, number>();
  for (const a of spans) {
    const L = laneOf(a, gi0, gj0);
    const other: 'x' | 'z' = a.axis === 'x' ? 'z' : 'x';
    const gAlong0 = a.axis === 'x' ? gi0 : gj0;
    for (let side = 0; side < 2; side++) {
      const line = side === 0 ? L : L + W; // flank line (perpendicular index)
      doors.clear();
      sideDoors(a, side, gAlong0, gAlong0 + N, doors);
      for (let c = 0; c < N; c++) {
        // cell along the artery = c; skip where a crossing artery's lanes are
        if (a.axis === 'x' ? isLane(c, 0, other) : isLane(0, c, other)) continue;
        const gAlong = gAlong0 + c;
        const dk = doors.get(gAlong);
        const kind = dk ?? EdgeKind.WALL;
        // neg side cell / pos side cell of the flank edge
        const outside = a.axis === 'x' ? cellIdx(c, side === 0 ? line - 1 : line) : cellIdx(side === 0 ? line - 1 : line, c);
        const outMat = l.wallMat[outside] as MatId;
        const matNeg = side === 0 ? outMat : pal.wallMat;
        const matPos = side === 0 ? pal.wallMat : outMat;
        const t = kind === EdgeKind.DOORWAY ? trim | EdgeTrim.CASING : trim;
        // door head below the lower of the two ceilings (LOW_EXPANSE ceilings go down to 210 cm)
        const hA = kind === EdgeKind.DOORWAY ? Math.min(DOOR_CM, Math.min(ceilCm, l.ceilCm[outside]) - 10) : 0;
        if (a.axis === 'x') g.setEdge('z', c, line, kind, { hA, matNeg, matPos, trim: t }, true);
        else g.setEdge('x', line, c, kind, { hA, matNeg, matPos, trim: t }, true);
      }
    }
  }

  // ---- 3. lights
  const color = kelvinToLinearRGB(style.cct, 0.02);
  const recessed = style.fixture !== FixtureKind.TUBE_STRIP;
  for (let ai = 0; ai < spans.length; ai++) {
    const a = spans[ai];
    const L = laneOf(a, gi0, gj0);
    const G = a.row; // global first lane
    for (let c = 0; c < N; c++) {
      const gAlong = (a.axis === 'x' ? gi0 : gj0) + c;
      if (((gAlong % style.every) + style.every) % style.every !== 0) continue;
      // at a crossing only the first span lights the shared cells
      let shared = false;
      for (let bi = 0; bi < ai; bi++) {
        const b = spans[bi];
        if (b.axis === a.axis) continue;
        const Lb = laneOf(b, gi0, gj0);
        if (c >= Lb - 1 && c < Lb + W + 1) shared = true;
      }
      if (shared) continue;
      // positions in 0.3 m units (global): along centre and across centre
      let along03: number, across03: number, wAlong: number, wAcross: number;
      let acrossLocal = 4 * (L + 1); // centre line between the two lanes
      const straddles = L + 1 === TILE_CELLS; // a recessed rect across the lanes would cross the render-tile line
      switch (style.fixture) {
        case FixtureKind.TROFFER_2x4: // 0.6 along x 1.2 across, one tile row of the cell
          along03 = 4 * gAlong + 1; wAlong = 0.6; wAcross = 1.2;
          break;
        case FixtureKind.SKY_PANEL: // 1.2 x 1.2, the whole cell along
          along03 = 4 * gAlong + 2; wAlong = 1.2; wAcross = 1.2;
          break;
        default: // TUBE_STRIP along the lane on the centre line
          along03 = 4 * gAlong + 2; wAlong = 1.2; wAcross = 0.1;
          break;
      }
      let alongLong = false; // troffer long axis turned along the lane
      if (recessed && straddles) {
        // fully inside the first lane: its inner 0.6 m ceiling-tile column (next to the lane centre line), so the
        // recessed rect neither crosses the render-tile line nor overlaps the flanking wall's half-thickness (a 1.2 m
        // rect centred in the lane filled it wall to wall)
        acrossLocal = 4 * L + 3;
        wAcross = 0.6;
        if (style.fixture === FixtureKind.TROFFER_2x4) { along03 = 4 * gAlong + 2; wAlong = 1.2; alongLong = true; }
      }
      across03 = 4 * (G - L) + acrossLocal;
      const alongLocalM = (along03 - 4 * (a.axis === 'x' ? gi0 : gj0)) * 0.3;
      const acrossLocalM = acrossLocal * 0.3;
      const px = a.axis === 'x' ? alongLocalM : acrossLocalM;
      const pz = a.axis === 'x' ? acrossLocalM : alongLocalM;
      const gx03 = a.axis === 'x' ? along03 : across03, gz03 = a.axis === 'x' ? across03 : along03;
      const mountCm = recessed ? 0 : 8;
      // long axis t: troffer / tube along its w; troffer w = across (1.2), tube w = along (1.2), panel square
      const tAcross = style.fixture === FixtureKind.TROFFER_2x4 && !alongLong;
      const tx = (a.axis === 'x') !== tAcross ? 1 : 0;
      const tz = 1 - tx;
      const w = tAcross ? wAcross : wAlong, h = tAcross ? wAlong : wAcross;
      g.addFixture({
        kind: style.fixture, state: LightState.ON, shape: 0,
        px, py: (ceilCm - mountCm) / 100, pz, nx: 0, ny: -1, nz: 0, tx, ty: 0, tz,
        w, h, color: [color[0], color[1], color[2]], luminance: style.luminance,
        hum: style.fixture === FixtureKind.TUBE_STRIP ? 0.6 : 0.5, bakeGroup: 0,
      }, { latticeI: Math.floor(gx03 / 2), latticeJ: Math.floor(gz03 / 2) });
      if (recessed) {
        const hx = (a.axis === 'x' ? wAlong : wAcross) / 2, hz = (a.axis === 'x' ? wAcross : wAlong) / 2;
        markFixtureTiles(l, px, pz, hx, hz);
      }
    }
  }
}

/** Sets TileState.FIXTURE on every 0.6 m ceiling tile whose centre lies inside the rect (chunk-local metres). */
export function markFixtureTiles(l: ChunkLayout, px: number, pz: number, hx: number, hz: number): void {
  const t0 = Math.max(0, Math.floor((px - hx) / CEIL_TILE)), t1 = Math.min(2 * N - 1, Math.floor((px + hx) / CEIL_TILE));
  const u0 = Math.max(0, Math.floor((pz - hz) / CEIL_TILE)), u1 = Math.min(2 * N - 1, Math.floor((pz + hz) / CEIL_TILE));
  for (let u = u0; u <= u1; u++) {
    for (let t = t0; t <= t1; t++) {
      const cx = (t + 0.5) * CEIL_TILE, cz = (u + 0.5) * CEIL_TILE;
      if (cx < px - hx || cx > px + hx || cz < pz - hz || cz > pz + hz) continue;
      setTile(l.tiles, cellIdx(t >> 1, u >> 1), (u & 1) * 2 + (t & 1), TileState.FIXTURE);
    }
  }
}

/** Artery lanes of a chunk (local first-lane row for 'x' spans, column for 'z' spans). */
export function laneCells(spans: readonly ArterySpan[], gi0: number, gj0: number): { axis: 'x' | 'z'; lane: number }[] {
  return spans.map((a) => ({ axis: a.axis, lane: laneOf(a, gi0, gj0) }));
}
