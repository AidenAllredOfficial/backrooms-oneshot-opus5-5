// src/world/landmarks/lazyRiver.ts — LAZY_RIVER (storey 2 + POOLROOMS hero; 16x14, R2 B4): a waist-deep channel
// loops around a tiled island with loungers. Inflatable rings drift in the channel, a footbridge crosses it, stepped
// entries lead down from the deck and up onto the island, and the channel walls glow with underwater lights.
//
// Frame: u across (16 cells), v along (14 cells). Deck: the 1-cell ring along the walls. Channel: cells in
// [1,15) x [1,13) minus the island [3,13) x [3,11); floor -70, water -10 (wadeable). Steps: from the deck at u = 1
// and u = 14 (v 6..8), onto the island at v = 2 and v = 11 (u 7..9). Footbridge over v 11..13 at u 4..6.

import { CELL } from '../../core/constants.ts';
import { CeilKind, CellFlag, EdgeKind, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey, Zone } from '../../core/index.ts';
import type { ZoneId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, box, cells, claim, emitter, fixture, handrail, opening, prop, ramp, recessedCells, THIN_F, WALK_F, waterRect } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const W = 16, L = 14;
const CEIL = 4.5;
export const LAZY_RIVER = { outer: [1, 1, 15, 13] as const, island: [3, 3, 13, 11] as const, floorCm: -70, waterCm: -10 } as const;

export const lazyRiver: LandmarkGenerator = {
  kind: LandmarkKind.LAZY_RIVER, storeys: [Storey.POOLROOMS], weight: 1, footprint: [W, L],
  hero: [Zone.POOLROOMS, Zone.PILLAR_HALL, Zone.LOW_EXPANSE] as readonly ZoneId[],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const tile = Mat.POOL_TILE;
    claim(lm, { floorMat: tile, wallMat: tile, ceilMat: tile, ceilKind: CeilKind.TILE_GLAZED, ceilCm: CEIL * 100, trimMat: tile, zone: Zone.POOLROOMS });
    for (const v of [6, 7]) {
      opening(lm, 0, v, -1, 0, EdgeKind.ARCH, tile, 0, 280);
      opening(lm, W - 1, v, 1, 0, EdgeKind.ARCH, tile, 0, 280);
    }
    opening(lm, lm.rng.int(10, 13), 0, 0, -1, EdgeKind.ARCH, tile, 0, 260);

    const R = LAZY_RIVER;
    const [ou0, ov0, ou1, ov1] = R.outer, [iu0, iv0, iu1, iv1] = R.island;
    const fy = R.floorCm / 100, wy = R.waterCm / 100;
    // the channel: four strips around the island
    const strips: [number, number, number, number][] = [[ou0, ov0, ou1, iv0], [ou0, iv1, ou1, ov1], [ou0, iv0, iu0, iv1], [iu1, iv0, ou1, iv1]];
    for (const [a, b, c, d] of strips) {
      cells(lm, a, b, c, d, { floorCm: R.floorCm, waterCm: R.waterCm, floorMat: Mat.POOL_MOSAIC });
      waterRect(lm, a, b, c, d, wy, fy, 0);
    }
    cells(lm, iu0, iv0, iu1, iv1, { floorMat: Mat.TERRAZZO });
    // steps: down from the deck on both ends, up onto the island top and bottom
    ramp(lm, ou0 * CELL, 6 * CELL, (ou0 + 1) * CELL, 8 * CELL, -1, 0, fy, 0, 4, tile, true);
    ramp(lm, (ou1 - 1) * CELL, 6 * CELL, ou1 * CELL, 8 * CELL, 1, 0, fy, 0, 4, tile, true);
    ramp(lm, 7 * CELL, (iv0 - 1) * CELL, 9 * CELL, iv0 * CELL, 0, 1, fy, 0, 4, tile, true);
    ramp(lm, 7 * CELL, iv1 * CELL, 9 * CELL, (iv1 + 1) * CELL, 0, -1, fy, 0, 4, tile, true);
    // wet deck
    cells(lm, 0, 0, W, 1, { flagsSet: CellFlag.WET });
    cells(lm, 0, L - 1, W, L, { flagsSet: CellFlag.WET });

    // the footbridge: a low deck just over the water with railings
    const bu0 = 4 * CELL + 0.2, bu1 = 6 * CELL - 0.2, bv0 = iv1 * CELL - 0.3, bv1 = ov1 * CELL + 0.3;
    box(lm, bu0, bv0, bu1, bv1, 0.05, 0.22, Mat.WOOD, WALK_F);
    for (const um of [bu0 + 0.05, bu1 - 0.05]) handrail(lm, um, bv0 + 0.1, 0.22, um, bv1 - 0.1, 0.22, Mat.METAL_PAINTED, 0.95, 2);
    for (const um of [bu0 + 0.3, bu1 - 0.3]) for (const vm of [bv0 + 0.9, bv1 - 0.9]) box(lm, um - 0.06, vm - 0.06, um + 0.06, vm + 0.06, fy, 0.05, Mat.METAL_PAINTED, THIN_F);

    // underwater lights along the channel's outer walls, rings drifting in it
    const uw = kelvinToLinearRGB(7800, 0.02);
    const ly = (fy + wy) / 2;
    for (let u = 2; u < W - 2; u += 3) {
      fixture(lm, FixtureKind.UNDERWATER, (u + 0.5) * CELL, ov0 * CELL + 0.02, ly, [0, 0, 1], [1, 0], uw, 1300, LightState.ON, { w: 0.24, h: 0.24, hum: 0.05 });
      if (u < 4 || u > 6) fixture(lm, FixtureKind.UNDERWATER, (u + 0.5) * CELL, ov1 * CELL - 0.02, ly, [0, 0, -1], [1, 0], uw, 1300, LightState.ON, { w: 0.24, h: 0.24, hum: 0.05 });
    }
    for (let v = 3; v < L - 3; v += 4) {
      fixture(lm, FixtureKind.UNDERWATER, ou0 * CELL + 0.02, (v + 0.5) * CELL, ly, [1, 0, 0], [0, 1], uw, 1300, LightState.ON, { w: 0.24, h: 0.24, hum: 0.05 });
      fixture(lm, FixtureKind.UNDERWATER, ou1 * CELL - 0.02, (v + 0.5) * CELL, ly, [-1, 0, 0], [0, 1], uw, 1300, LightState.ON, { w: 0.24, h: 0.24, hum: 0.05 });
    }
    const n = lm.rng.int(4, 6);
    for (let k = 0; k < n; k++) {
      const [a, b, c, d] = strips[k % 4];
      const [x, z] = lm.f.point(lm.rng.range(a * CELL + 0.6, c * CELL - 0.6), lm.rng.range(b * CELL + 0.6, d * CELL - 0.6));
      g.addProp({ kind: PropKind.POOL_FLOAT, variant: lm.rng.int(0, 2), x, y: wy, z, yaw: lm.rng.range(0, 6.28), scale: 1, flags: 0, seed: lm.rng.next() });
    }
    // the island: loungers back to back, a tiled planter in the middle, towels
    const cu = ((iu0 + iu1) / 2) * CELL, cv = ((iv0 + iv1) / 2) * CELL;
    box(lm, cu - 1.2, cv - 0.6, cu + 1.2, cv + 0.6, 0, 0.55, tile);
    box(lm, cu - 1.1, cv - 0.5, cu + 1.1, cv + 0.5, 0.55, 0.57, Mat.CONCRETE_FLOOR, THIN_F);
    for (const side of [-1, 1]) {
      for (let k = 0; k < 4; k++) {
        if (lm.rng.chance(0.2)) continue;
        const p = prop(lm, PropKind.LOUNGE_CHAIR, 5.0 + k * 2.4, cv + side * 2.1, 0, 0, -side, lm.rng.int(0, 2), undefined, lm.rng.range(-0.05, 0.05));
        if (lm.rng.chance(0.3)) g.addProp({ kind: PropKind.TOWEL, variant: lm.rng.int(0, 3), x: p.x, y: 0.37, z: p.z, yaw: p.yaw, scale: 1, flags: 0, seed: lm.rng.next() });
      }
    }
    // light: skylights
    const sky = kelvinToLinearRGB(6300, 0.01);
    for (let v = 1; v < L - 1; v += 3) for (let u = 1; u < W - 1; u += 3) recessedCells(lm, FixtureKind.SKY_PANEL, u, v, u + 1, v + 1, CEIL, sky, 2700, LightState.ON);
    emitter(lm, EmitterKind.WATER, 2 * CELL, 7 * CELL, wy, 0.4);
    emitter(lm, EmitterKind.WATER, (W - 2) * CELL, 7 * CELL, wy, 0.4);
    emitter(lm, EmitterKind.PIPE, (W / 2) * CELL, 1.5 * CELL, fy + 0.2, 0.2);
    return { entrances: lm.entrances };
  },
};
