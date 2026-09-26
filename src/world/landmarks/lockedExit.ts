// src/world/landmarks/lockedExit.ts — LOCKED_EXIT (storeys 0, 1, 2 (R2: block / tile restyles); 8x3): a narrow lit corridor ending in a door leaf inside
// a frame under a glowing EXIT sign. Interacting with the DOOR_LEAF makes WP13 play a locked-door rattle (WP4).

import { CELL, WALL_T } from '../../core/constants.ts';
import { CeilKind, CellFlag, EdgeKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { EXIT_RED } from '../content/util.ts';
import { begin, cells, claim, DOWN, fixture, opening, prop, wall } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const W = 8, L = 3;

export const lockedExit: LandmarkGenerator = {
  kind: LandmarkKind.LOCKED_EXIT, storeys: [Storey.LOBBY, Storey.SUBLEVEL, Storey.POOLROOMS], weight: 1.2, footprint: [W, L],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const s = ctx.key.s;
    const wallMat = s === Storey.SUBLEVEL ? Mat.CMU_PAINTED : s === Storey.POOLROOMS ? Mat.POOL_TILE : Mat.DRYWALL;
    const ceil = 2.5;
    claim(lm, s === Storey.SUBLEVEL
      ? { floorMat: Mat.CONCRETE_FLOOR, wallMat, ceilMat: Mat.CONCRETE_CEIL, ceilKind: CeilKind.CONCRETE, ceilCm: ceil * 100, trimMat: Mat.METAL_PAINTED }
      : s === Storey.POOLROOMS
        ? { floorMat: Mat.POOL_MOSAIC, wallMat, ceilMat: Mat.POOL_TILE, ceilKind: CeilKind.TILE_GLAZED, ceilCm: ceil * 100, trimMat: Mat.POOL_TILE }
        : { floorMat: Mat.VINYL_VCT, wallMat, ceilMat: Mat.CEILING_TILE, ceilKind: CeilKind.TILES, ceilCm: ceil * 100, baseboard: true });
    // the corridor is the middle row; the side rows are solid mass behind walls
    cells(lm, 0, 0, W, 1, { flagsSet: CellFlag.SOLID });
    cells(lm, 0, 2, W, 3, { flagsSet: CellFlag.SOLID });
    for (let u = 0; u < W; u++) {
      wall(lm, u, 1, u, 0, EdgeKind.WALL, wallMat, s === 0 ? 1 : 0);
      wall(lm, u, 1, u, 2, EdgeKind.WALL, wallMat, s === 0 ? 1 : 0);
    }
    opening(lm, 0, 1, -1, 0, EdgeKind.OPEN, wallMat);
    // tube lights along the corridor (the one nearest the door buzzes)
    const col = kelvinToLinearRGB(s === Storey.POOLROOMS ? 5600 : 4000, 0.03);
    for (let u = 0; u < W; u += 2) {
      fixture(lm, FixtureKind.TUBE_STRIP, (u + 1) * CELL, 1.5 * CELL, ceil - 0.05, DOWN, [1, 0], col, 8600, u === W - 2 ? LightState.BUZZ : LightState.ON);
    }
    // the door at the far end: frame + leaf against the end wall, EXIT sign above
    const face = W * CELL - WALL_T / 2;
    prop(lm, PropKind.DOOR_FRAME, face - 0.075, 1.5 * CELL, 0, -1, 0);
    prop(lm, PropKind.DOOR_LEAF, face - 0.03, 1.5 * CELL, 0, -1, 0);
    fixture(lm, FixtureKind.EXIT_SIGN, face - 0.05, 1.5 * CELL, 2.3, [-1, 0, 0], [0, 1], EXIT_RED, 150, LightState.ON);
    return { entrances: lm.entrances };
  },
};
