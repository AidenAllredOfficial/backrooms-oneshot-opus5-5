// src/world/landmarks/lockerRoom.ts — LOCKER_ROOM (storey 2, 10x8): three banks of lockers (METAL_PAINTED PARTITION
// rows, 2 m high) with BENCH_TILED benches down the aisles between them, a wet shower end, towels left behind and
// dripping taps (WP4).
//
// Frame: u along the banks (10 cells), v across (8 cells). Banks on the lines v = 2, 4, 6 for u in [2, 8); the strips
// u in [0, 2) (entrance side) and u in [8, 10) (showers, POOL_MOSAIC, WET) connect the four aisles.

import { CELL } from '../../core/constants.ts';
import { CeilKind, CellFlag, DecalKind, EdgeKind, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey, Zone } from '../../core/index.ts';
import type { LightStateId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, cells, claim, DOWN, emitter, fixture, floorDecal, opening, prop } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const W = 10, L = 8;
const CEIL = 2.8;
export const LOCKER_BANKS = { lines: [2, 4, 6], u0: 2, u1: 8, heightCm: 200 } as const;

export const lockerRoom: LandmarkGenerator = {
  kind: LandmarkKind.LOCKER_ROOM, storeys: [Storey.POOLROOMS], weight: 1, footprint: [W, L],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const tile = Mat.POOL_TILE, metal = Mat.METAL_PAINTED;
    claim(lm, { floorMat: tile, wallMat: tile, ceilMat: Mat.CEILING_TILE, ceilKind: CeilKind.TILES, ceilCm: CEIL * 100, trimMat: tile, zone: Zone.POOLROOMS });
    opening(lm, 0, lm.rng.int(1, L - 2), -1, 0, EdgeKind.DOORWAY, tile, 0, 210);
    const back = lm.rng.chance(0.5);
    opening(lm, W - 1 - lm.rng.int(0, 1), back ? 0 : L - 1, 0, back ? -1 : 1, EdgeKind.DOORWAY, tile, 0, 210);
    // locker banks: PARTITION edges with METAL_PAINTED faces
    for (const v of LOCKER_BANKS.lines) {
      for (let u = LOCKER_BANKS.u0; u < LOCKER_BANKS.u1; u++) {
        lm.f.setEdge(g, u, v - 1, u, v, EdgeKind.PARTITION, metal, metal, { hA: LOCKER_BANKS.heightCm, trim: 0 });
      }
    }
    // shower end: mosaic floor, wet, drips; puddles creeping into the aisles
    cells(lm, LOCKER_BANKS.u1, 0, W, L, { floorMat: Mat.POOL_MOSAIC, flagsSet: CellFlag.WET });
    for (let v = 0; v < L; v++) {
      if (lm.rng.chance(0.5)) cells(lm, LOCKER_BANKS.u1 - 1, v, LOCKER_BANKS.u1, v + 1, { flagsSet: CellFlag.WET });
    }
    for (let k = 0; k < 3; k++) {
      emitter(lm, EmitterKind.DRIP, (LOCKER_BANKS.u1 + 0.5 + lm.rng.range(0, 1)) * CELL, (1 + 2.7 * k) * CELL, 0.02, 0.35);
    }
    floorDecal(lm, (LOCKER_BANKS.u1 + 1) * CELL, (L / 2) * CELL, 0, { kind: DecalKind.DRAIN, sign: false, rot: 0, w: 0.4, h: 0.4, alpha: 0.95 });
    // benches down the middle of every aisle (two in each inner aisle), towels on some, some on the floor
    const aisles = [1, 3, 5, 7]; // aisle centre lines in cells (v)
    for (const av of aisles) {
      const inner = av === 3 || av === 5;
      const ums = inner ? [3.5 * CELL, 6.5 * CELL] : [5 * CELL];
      for (const um of ums) {
        const p = prop(lm, PropKind.BENCH_TILED, um, av * CELL, 0, 0, 1, lm.rng.int(0, 3));
        if (lm.rng.chance(0.45)) {
          g.addProp({ kind: PropKind.TOWEL, variant: lm.rng.int(0, 3), x: p.x + lm.rng.range(-0.6, 0.6), y: 0.45, z: p.z, yaw: p.yaw + lm.rng.range(-0.3, 0.3), scale: 1, flags: 0, seed: lm.rng.next() });
        }
      }
      if (lm.rng.chance(0.35)) {
        const [x, z] = lm.f.point(lm.rng.range(2.5, 8) * CELL, (av + lm.rng.range(-0.6, 0.6)) * CELL);
        g.addProp({ kind: PropKind.TOWEL, variant: lm.rng.int(0, 3), x, y: 0, z, yaw: lm.rng.range(0, 6.28), scale: 1, flags: 0, seed: lm.rng.next() });
      }
    }
    // tube lights over the aisles; the shower end has one dying tube
    const col = kelvinToLinearRGB(4300, 0.04);
    for (const av of aisles) {
      for (const um of [3 * CELL, 7 * CELL]) {
        const r = lm.rng.float();
        const st: LightStateId = r < 0.1 ? LightState.OFF : r < 0.18 ? LightState.DYING : LightState.ON;
        fixture(lm, FixtureKind.TUBE_STRIP, um, av * CELL, CEIL - 0.05, DOWN, [1, 0], col, 8600, st);
      }
    }
    fixture(lm, FixtureKind.TUBE_STRIP, 9 * CELL, 2 * CELL, CEIL - 0.05, DOWN, [0, 1], col, 8600, LightState.DYING);
    fixture(lm, FixtureKind.TUBE_STRIP, 9 * CELL, 6 * CELL, CEIL - 0.05, DOWN, [0, 1], col, 8600, lm.rng.chance(0.3) ? LightState.FLICKER : LightState.ON);
    emitter(lm, EmitterKind.WATER, 9 * CELL, 4 * CELL, 0.05, 0.15);
    return { entrances: lm.entrances };
  },
};
