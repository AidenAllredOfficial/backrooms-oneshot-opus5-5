// src/world/landmarks/atrium.ts — ATRIUM (storey 2, 18x18): 12 m tiled volume, a shallow reflecting pool, four tiled
// columns, a SKY_PANEL grid at 12 m and one lonely RED_BULB (WP4).

import { CELL } from '../../core/constants.ts';
import { CeilKind, EdgeKind, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey, Zone } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { RED_LIGHT } from '../content/util.ts';
import { begin, box, cells, claim, DOWN, emitter, fixture, opening, prop, recessedCells } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const S = 18;
const CEIL = 12;

export const atrium: LandmarkGenerator = {
  kind: LandmarkKind.ATRIUM, storeys: [Storey.POOLROOMS], weight: 1, footprint: [S, S],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, S, S);
    if (!lm) return { entrances: [] };
    const tile = Mat.POOL_TILE;
    claim(lm, { floorMat: tile, wallMat: tile, ceilMat: tile, ceilKind: CeilKind.TILE_GLAZED, ceilCm: CEIL * 100, trimMat: tile, zone: Zone.POOLROOMS });
    // grand arches in the middle of every side
    const m = S / 2 - 1;
    for (const u of [m, m + 1]) {
      opening(lm, u, 0, 0, -1, EdgeKind.ARCH, tile, 0, 320);
      opening(lm, u, S - 1, 0, 1, EdgeKind.ARCH, tile, 0, 320);
      opening(lm, 0, u, -1, 0, EdgeKind.ARCH, tile, 0, 320);
      opening(lm, S - 1, u, 1, 0, EdgeKind.ARCH, tile, 0, 320);
    }
    // central reflecting pool: 6x6 cells, floor -30 (a 30 cm step, walkable), water at -5
    const p0 = 6, p1 = 12;
    cells(lm, p0, p0, p1, p1, { floorCm: -30, waterCm: -5, floorMat: Mat.POOL_MOSAIC });
    const a = lm.f.point(p0 * CELL, p0 * CELL), b = lm.f.point(p1 * CELL, p1 * CELL);
    g.addWater({ x0: Math.min(a[0], b[0]), z0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), z1: Math.max(a[1], b[1]), y: -0.05, floorY: -0.3, kind: 0 });
    emitter(lm, EmitterKind.WATER, S * CELL / 2, S * CELL / 2, 0.1, 0.25);
    // four tiled columns, floor to ceiling
    const cols = [4, 13];
    for (const cu of cols) for (const cv of cols) {
      box(lm, (cu + 0.05) * CELL, (cv + 0.05) * CELL, (cu + 0.95) * CELL, (cv + 0.95) * CELL, 0, CEIL, tile);
    }
    // SKY_PANEL grid every 3 cells (skipping the columns)
    const sky = kelvinToLinearRGB(6500, 0.01);
    for (let v = 1; v < S; v += 3) for (let u = 1; u < S; u += 3) {
      if (cols.includes(u) && cols.includes(v)) continue;
      recessedCells(lm, FixtureKind.SKY_PANEL, u, v, u + 1, v + 1, CEIL, sky, 3200, LightState.ON);
    }
    // one red bulb on a long cord in a far corner
    fixture(lm, FixtureKind.RED_BULB, 1.3 * CELL, (S - 1.3) * CELL, 2.7, DOWN, [1, 0], RED_LIGHT, 150, LightState.ON, { shape: 1, w: 0.08, h: 0.08, hum: 0.5 });
    // lounge chairs facing the pool on two sides
    for (let k = 0; k < 3; k++) {
      const um = (p0 + 0.9 + 2 * k) * CELL;
      prop(lm, PropKind.LOUNGE_CHAIR, um, (p0 - 1.2) * CELL, 0, 0, 1, lm.rng.int(0, 2));
      if (lm.rng.chance(0.6)) prop(lm, PropKind.LOUNGE_CHAIR, um, (p1 + 1.2) * CELL, 0, 0, -1, lm.rng.int(0, 2));
    }
    return { entrances: lm.entrances };
  },
};
