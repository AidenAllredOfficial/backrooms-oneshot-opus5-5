// src/world/landmarks/deepEnd.ts — DEEP_END (storey 2, 12x12): a 4 m plunge pool (floor -400 cm, water -10) behind a
// shallow wading strip, a tiled diving platform 1.5 m high (WALKABLE_TOP box solids reached by ramp stairs) with a
// board over the deep water, UNDERWATER lights in all four deep walls, a FLOAT_ROPE along the deep edge and a
// NO_DIVING sign (WP4).
//
// Frame (u across, v along), 12 x 12 cells:
//   v 0-1   entry deck (ARCH entrance on the v = 0 wall)          u 0-2 / 9-11  side decks (DOORWAY on u = 0)
//   v 2     shallow entry steps (ramp 0 -> -0.9 m) over u 3-8     v 3   shallow strip, floor -90 (wadeable)
//   v 4-9   deep pool u 3-8, floor -400 (NOWALK)                  v 10-11 back deck with the diving platform

import { CELL } from '../../core/constants.ts';
import {
  CeilKind, CellFlag, DecalKind, EdgeKind, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, SignKind, SolidFlag, Storey, Zone,
} from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, box, cells, claim, emitter, fixture, floorDecal, opening, prop, ramp, recessedCells, wallDecal } from './common.ts';
import type { Lm } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const S = 12;
const CEIL = 5.0;
export const DEEP_END = {
  pool: [3, 4, 9, 10] as const, // deep part [u0, v0, u1, v1)
  shallowV: 3, stepsV: 2, deepCm: -400, shallowCm: -90, waterCm: -10, platformY: 1.5,
} as const;

const WALK = SolidFlag.WALKABLE_TOP | SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.RENDER;
const SOLIDF = SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.RENDER;

function water(lm: Lm, u0: number, v0: number, u1: number, v1: number, y: number, floorY: number): void {
  const a = lm.f.point(u0 * CELL, v0 * CELL), b = lm.f.point(u1 * CELL, v1 * CELL);
  lm.g.addWater({ x0: Math.min(a[0], b[0]), z0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), z1: Math.max(a[1], b[1]), y, floorY, kind: 0 });
}

export const deepEnd: LandmarkGenerator = {
  kind: LandmarkKind.DEEP_END, storeys: [Storey.POOLROOMS], weight: 1, footprint: [S, S],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, S, S);
    if (!lm) return { entrances: [] };
    const tile = Mat.POOL_TILE;
    claim(lm, { floorMat: tile, wallMat: tile, ceilMat: tile, ceilKind: CeilKind.TILE_GLAZED, ceilCm: CEIL * 100, trimMat: tile, zone: Zone.POOLROOMS });
    // entrances: a wide arch on the entry deck, a doorway on a side deck
    opening(lm, 5, 0, 0, -1, EdgeKind.ARCH, tile, 0, 260);
    opening(lm, 6, 0, 0, -1, EdgeKind.ARCH, tile, 0, 260);
    const west = lm.rng.chance(0.5);
    opening(lm, west ? 0 : S - 1, lm.rng.int(5, 8), west ? -1 : 1, 0, EdgeKind.DOORWAY, tile, 0, 210);

    // ---- the pool: steps (v = 2), shallow strip (v = 3), deep part (v = 4..9)
    const [pu0, pv0, pu1, pv1] = DEEP_END.pool;
    const w = DEEP_END.waterCm;
    cells(lm, pu0, DEEP_END.stepsV, pu1, DEEP_END.stepsV + 1, { floorCm: DEEP_END.shallowCm, waterCm: w, floorMat: Mat.POOL_MOSAIC });
    cells(lm, pu0, DEEP_END.shallowV, pu1, DEEP_END.shallowV + 1, { floorCm: DEEP_END.shallowCm, waterCm: w, floorMat: Mat.POOL_MOSAIC });
    cells(lm, pu0, pv0, pu1, pv1, { floorCm: DEEP_END.deepCm, waterCm: w, floorMat: Mat.POOL_MOSAIC, flagsSet: CellFlag.NOWALK });
    ramp(lm, pu0 * CELL, DEEP_END.stepsV * CELL, pu1 * CELL, (DEEP_END.stepsV + 1) * CELL, 0, -1, DEEP_END.shallowCm / 100, 0, 3, tile, true);
    water(lm, pu0, DEEP_END.stepsV, pu1, pv0, w / 100, DEEP_END.shallowCm / 100);
    water(lm, pu0, pv0, pu1, pv1, w / 100, DEEP_END.deepCm / 100);
    // float rope along the deep edge (FLOAT_ROPE spans one cell edge, floats at the water line)
    for (let u = pu0; u < pu1; u++) {
      prop(lm, PropKind.FLOAT_ROPE, (u + 0.5) * CELL, pv0 * CELL, w / 100 - 0.06, 0, 1, 0, 0);
    }
    // wet deck around the pool
    cells(lm, pu0 - 1, DEEP_END.stepsV - 1, pu1 + 1, DEEP_END.stepsV, { flagsSet: CellFlag.WET });
    cells(lm, pu0 - 1, pv1, pu1 + 1, pv1 + 1, { flagsSet: CellFlag.WET });

    // ---- UNDERWATER lights: two in each of the four deep walls, facing into the pool, halfway down
    const uw = kelvinToLinearRGB(7600, 0.02);
    const ly = (DEEP_END.deepCm / 100 + w / 100) / 2;
    const lu = [pu0 + 1.5, pu1 - 1.5], lv = [pv0 + 1.5, pv1 - 1.5];
    for (const um of lu) {
      fixture(lm, FixtureKind.UNDERWATER, um * CELL, pv0 * CELL + 0.02, ly, [0, 0, 1], [1, 0], uw, 1400, LightState.ON, { w: 0.26, h: 0.26, hum: 0.05 });
      fixture(lm, FixtureKind.UNDERWATER, um * CELL, pv1 * CELL - 0.02, ly, [0, 0, -1], [1, 0], uw, 1400, LightState.ON, { w: 0.26, h: 0.26, hum: 0.05 });
    }
    for (const vm of lv) {
      fixture(lm, FixtureKind.UNDERWATER, pu0 * CELL + 0.02, vm * CELL, ly, [1, 0, 0], [0, 1], uw, 1400, LightState.ON, { w: 0.26, h: 0.26, hum: 0.05 });
      fixture(lm, FixtureKind.UNDERWATER, pu1 * CELL - 0.02, vm * CELL, ly, [-1, 0, 0], [0, 1], uw, 1400, LightState.ON, { w: 0.26, h: 0.26, hum: 0.05 });
    }

    // ---- diving platform on the back deck: a tiled tower 1.5 m high, stairs up its side, a board over the water
    const py = DEEP_END.platformY;
    const pa = 5.2 * CELL, pb = 6.8 * CELL; // platform across u
    const pvf = pv1 * CELL + 0.05, pvb = (pv1 + 1.3) * CELL; // platform along v (front edge at the pool lip)
    box(lm, pa, pvf, pb, pvb, 0, py, tile, WALK);
    // stairs: a ramp on the +u side of the platform, ascending toward -u (8 risers of 0.19 m)
    ramp(lm, pb, pvf + 0.15, pb + 2.2, pvb - 0.05, -1, 0, 0, py, 8, tile, true);
    // rails: thin boxes on the platform's back and -u sides (the front is the board, the +u side the stairs)
    box(lm, pa, pvb - 0.05, pb, pvb, py, py + 1.0, Mat.METAL_PAINTED, SOLIDF);
    box(lm, pa, pvf, pa + 0.05, pvb, py, py + 1.0, Mat.METAL_PAINTED, SOLIDF);
    // the board: 0.5 m wide, 1.8 m long, cantilevered over the deep water
    box(lm, 6 * CELL - 0.25, pvf - 1.8, 6 * CELL + 0.25, pvf, py - 0.06, py, Mat.METAL_PAINTED, WALK);

    // ---- a ladder out of the deep end, a lifebuoy, loungers on the side decks
    const lW = west ? S - 1 : 0; // ladder on the side without the doorway
    prop(lm, PropKind.POOL_LADDER, west ? pu1 * CELL - 0.27 : pu0 * CELL + 0.27, (pv0 + 2.5) * CELL, -1.0, west ? -1 : 1, 0, 0, 0); // deck y 0: POOL_LADDER wants p.y = deckY - 1.0
    wallDecal(lm, lW, 6, lW + (west ? 1 : -1), 6, 0.5, 1.5, { kind: SignKind.NO_DIVING, sign: true, rot: 0, w: 0.5, h: 0.35, alpha: 1 });
    prop(lm, PropKind.LIFEBUOY, west ? (S * CELL - 0.075 - 0.07) : 0.075 + 0.07, 4.5 * CELL, 1.3, west ? -1 : 1, 0, 0);
    floorDecal(lm, 6 * CELL, (DEEP_END.stepsV - 0.5) * CELL, 0, { kind: SignKind.NO_DIVING, sign: true, rot: lm.f.yaw(0, 1), w: 0.9, h: 0.45, alpha: 0.9 });
    const deckU = west ? S * CELL - 1.2 : 1.2; // the side deck without the doorway
    for (let k = 0; k < 3; k++) {
      if (!lm.rng.chance(0.7)) continue;
      prop(lm, PropKind.LOUNGE_CHAIR, deckU, (pv0 + 0.3 + 2 * k) * CELL, 0, 0, 1, lm.rng.int(0, 3), undefined, lm.rng.range(-0.05, 0.05));
    }

    // ---- ceiling: sky panels over the decks only (the pool is lit from below)
    const sky = kelvinToLinearRGB(6500, 0.01);
    for (const [u, v] of [[1, 1], [5, 1], [10, 1], [1, 5], [10, 5], [1, 9], [10, 9], [3, 10], [8, 10]] as [number, number][]) {
      recessedCells(lm, FixtureKind.SKY_PANEL, u, v, u + 1, v + 1, CEIL, sky, 2600, LightState.ON);
    }
    // sound: the big water body, a slow drip from the platform
    emitter(lm, EmitterKind.WATER, 6 * CELL, 7 * CELL, 0, 0.45);
    emitter(lm, EmitterKind.DRIP, 6 * CELL, (pv1 - 0.8) * CELL, w / 100 + 0.02, 0.25);
    floorDecal(lm, (pu0 - 0.5) * CELL, (pv0 + 0.5) * CELL, 0, { kind: DecalKind.WATER_STAIN, sign: false, rot: lm.rng.range(0, 6.28), w: 1.0, h: 1.4, alpha: 0.5 });
    return { entrances: lm.entrances };
  },
};
