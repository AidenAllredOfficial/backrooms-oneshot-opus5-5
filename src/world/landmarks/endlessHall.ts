// src/world/landmarks/endlessHall.ts — ENDLESS_HALL (storeys 0, 1; 32x2): restyles the artery lane through the
// chunk into an identical, endless-looking hall (WP4).
//
// The flanking artery walls become continuous walls with fake DOOR_FRAME + DOOR_LEAF pairs every 4 cells (global
// phase, so the pattern continues seamlessly across chunks); the artery's real side doors are kept (DOORWAY) so the
// chunk halves stay connected; a light in every other global cell. The hall's ends are the artery's seam openings.
// Entrances = the lane cells at both ends plus the lane cell inside every real side door.

import { CELL, CHUNK_CELLS } from '../../core/constants.ts';
import { CeilKind, CellFlag, EdgeKind, EdgeTrim, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey, cellIdx, hash01, hash3, SALT } from '../../core/index.ts';
import type { ArterySpan, ChunkGrid, LandmarkSite, ZoneGenContext } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { edgeKindPassable } from '../content/util.ts';
import { Frame } from '../structures/frame.ts';
import { cells, DOWN, fixture, landmarkRng, prop, recessedRect, wall } from './common.ts';
import type { Lm } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const N = CHUNK_CELLS;

/** The artery lane crossing this chunk: frame (u across the 2 lanes, v along the hall) or null. */
function laneFrame(g: ChunkGrid, ctx: ZoneGenContext): { f: Frame; along0: number } | null {
  const spans: readonly ArterySpan[] = ctx.world.arteriesNear(ctx.key.s, ctx.key.cx, ctx.key.cz);
  for (const a of spans) {
    const lane = a.row - (a.axis === 'x' ? g.gj0 : g.gi0);
    if (lane < 1 || lane + 2 > N - 1) continue;
    const g0 = Math.max(a.g0, a.axis === 'x' ? g.gi0 : g.gj0), g1 = Math.min(a.g1, (a.axis === 'x' ? g.gi0 : g.gj0) + N);
    if (g1 - g0 < N) continue; // the hall needs the lane across the whole chunk
    // rot 3: u -> -z, v -> +x (hall along x); rot 0: u -> +x, v -> +z (hall along z)
    return a.axis === 'x' ? { f: new Frame(0, lane, 2, N, 3), along0: g.gi0 } : { f: new Frame(lane, 0, 2, N, 0), along0: g.gj0 };
  }
  return null;
}

export const endlessHall: LandmarkGenerator = {
  kind: LandmarkKind.ENDLESS_HALL, storeys: [Storey.LOBBY, Storey.SUBLEVEL], weight: 1, footprint: [32, 2],
  stamp(g: ChunkGrid, ctx: ZoneGenContext, site: LandmarkSite) {
    const rng = landmarkRng(ctx, site);
    let lf = laneFrame(g, ctx);
    let synthetic = false;
    if (!lf) {
      // forced outside an artery chunk: a synthetic hall along x on a free row (ends at the seams)
      for (let k = 0; k < 24 && !lf; k++) {
        const lane = 3 + ((rng.int(0, 22) + k) % 23);
        let free = true;
        for (let li = 0; li < N && free; li++) for (let d = -1; d <= 2; d++) if (g.isReserved(li, lane + d)) free = false;
        if (free) lf = { f: new Frame(0, lane, 2, N, 3), along0: g.gi0 };
      }
      if (!lf) return { entrances: [] };
      synthetic = true;
    }
    const { f, along0 } = lf;
    const lm: Lm = { g, ctx, site, f, rng, W: 2, L: N, entrances: [] };
    const l = g.layout;
    const s = ctx.key.s;
    const deep = s === Storey.SUBLEVEL;
    const wallMat = deep ? Mat.CMU_PAINTED : Mat.WALLPAPER_L0;
    const ceil = 2.6;
    cells(lm, 0, 0, 2, N, {
      floorCm: 0, ceilCm: ceil * 100, floorMat: deep ? Mat.CONCRETE_FLOOR : Mat.CARPET_L0, ceilMat: deep ? Mat.CONCRETE_CEIL : Mat.CEILING_TILE,
      ceilKind: deep ? CeilKind.CONCRETE : CeilKind.TILES, blockCm: 0, flagsSet: CellFlag.LANDMARK | CellFlag.RESERVED,
      flagsClear: CellFlag.SOLID | CellFlag.VOID | CellFlag.NOWALK | CellFlag.WET | CellFlag.NO_CEIL | CellFlag.SEALED,
    });
    const [ri0, rj0, ri1, rj1] = f.rect();
    for (let lj = rj0; lj < rj1; lj++) for (let li = ri0; li < ri1; li++) {
      const c = cellIdx(li, lj);
      l.wallMat[c] = wallMat; l.trimMat[c] = Mat.TRIM_PAINT; l.tiles[c] = 0;
    }
    // the hall's own lights replace the artery's
    for (let i = l.fixtures.length - 1; i >= 0; i--) {
      const fx = l.fixtures[i];
      if (fx.bakeGroup !== 0) continue;
      const li = Math.floor(fx.px / CELL), lj = Math.floor(fx.pz / CELL);
      if (li >= ri0 && li < ri1 && lj >= rj0 && lj < rj1) l.fixtures.splice(i, 1);
    }
    f.setEdge(g, 0, 0, 1, 0, EdgeKind.OPEN, wallMat, wallMat, { trim: 0 });
    const trim = deep ? 0 : EdgeTrim.BASEBOARD;
    const color = kelvinToLinearRGB(deep ? 4000 : 4000, 0.03);
    for (let v = 0; v < N; v++) {
      if (v > 0) f.setEdge(g, 0, v - 1, 0, v, EdgeKind.OPEN, wallMat, wallMat, { trim: 0 });
      if (v > 0) f.setEdge(g, 1, v - 1, 1, v, EdgeKind.OPEN, wallMat, wallMat, { trim: 0 });
      const gv = along0 + v; // global cell along the hall
      for (const side of [0, 1] as const) {
        const u = side, un = side === 0 ? -1 : 2;
        const e = f.edge(u, v, un, v);
        const cur = g.getEdge(e.axis, e.i, e.j);
        const hA = e.axis === 'x' ? l.ex.hA[e.j * 33 + e.i] : l.ez.hA[e.j * 32 + e.i];
        const realDoor = !synthetic ? edgeKindPassable(cur, hA) : (((gv >> 3) + side) & 1) === 0 && (gv & 7) === 3;
        if (realDoor) {
          wall(lm, u, v, un, v, EdgeKind.DOORWAY, wallMat, EdgeTrim.CASING, 210);
          lm.entrances.push(f.cell(u, v));
          continue;
        }
        wall(lm, u, v, un, v, EdgeKind.WALL, wallMat, trim);
        // fake door: DOOR_FRAME + DOOR_LEAF against the wall every 4 global cells (sides offset by 2)
        if (((gv + side * 2) & 3) === 1) {
          const um = side === 0 ? 0.075 + 0.075 : 2 * CELL - 0.075 - 0.075;
          const du = side === 0 ? 1 : -1;
          prop(lm, PropKind.DOOR_FRAME, um, (v + 0.5) * CELL, 0, du, 0);
          const uLeaf = side === 0 ? 0.075 + 0.03 : 2 * CELL - 0.075 - 0.03;
          prop(lm, PropKind.DOOR_LEAF, uLeaf, (v + 0.5) * CELL, 0, du, 0, (gv >> 2) & 3);
        }
      }
      // a light in every other global cell, across the hall, centred on the lane line
      if ((gv & 1) === 0) {
        const h = hash01(hash3(site.seed ^ s, SALT.LANDMARK, gv));
        const state = h < 0.06 ? LightState.OFF : h < 0.14 ? LightState.DYING : LightState.ON;
        if (deep) {
          fixture(lm, FixtureKind.TUBE_STRIP, CELL, (v + 0.5) * CELL, ceil - 0.05, DOWN, [1, 0], color, 8600, state);
        } else {
          const a = f.point(0.6, v * CELL + 0.3), b = f.point(1.8, v * CELL + 0.9);
          recessedRect(lm, FixtureKind.TROFFER_2x4, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), ceil, color, 3300, state);
        }
      }
    }
    // the ends: the lane cells on the seam lines (walkable seam edges)
    for (const v of [0, N - 1]) for (const u of [0, 1]) {
      const e = f.edge(u, v, u, v === 0 ? -1 : N);
      const k = g.getEdge(e.axis, e.i, e.j);
      if (edgeKindPassable(k, 220)) lm.entrances.push(f.cell(u, v));
    }
    g.addLandmark(LandmarkKind.ENDLESS_HALL, ri0, rj0, ri1, rj1);
    return { entrances: lm.entrances };
  },
};
