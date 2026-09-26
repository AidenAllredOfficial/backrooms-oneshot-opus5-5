// src/world/heroRooms/sumpPit.ts — SUMP_PIT hero (PIPEWORKS, CONCRETE; 12x12, R2 B4): a 7 m square pit in the floor,
// five metres deep, with black water standing three metres down. A grated catwalk crosses it; railings run round the
// rim; two pumps squat on the deck with their suction pipes plunging into the water; big mains come down out of the
// ceiling; a steel ladder goes down the wall into the dark. Caged bulbs and one sodium lamp.
//
// Frame: u across, v along (12 x 12 cells). Pit: cells [3, 9)^2, floor -500, water -300 (NOWALK). Catwalk across the
// pit along v at u 5.4..6.6 m, y 0. Deck: the 3-cell ring around the pit. Openings on two opposite sides.

import { CELL, WALL_T } from '../../core/constants.ts';
import { CeilKind, CellFlag, DecalKind, EdgeKind, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, SignKind, Storey, Zone } from '../../core/index.ts';
import type { ZoneId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { poolLadder } from '../landmarks/drainedPool.ts';
import { begin, cells, claim, DOWN, emitter, fixture, floorDecal, handrail, opening, OVERHEAD, pipeF, prop, box, WALK_F, waterRect } from '../landmarks/common.ts';
import type { LandmarkGenerator } from '../landmarks/index.ts';

const S = 12;
const CEIL = 6.0;
export const SUMP_PIT = { pit: [3, 9] as const, floorCm: -500, waterCm: -300, railCm: 105 } as const;

export const sumpPit: LandmarkGenerator = {
  kind: LandmarkKind.SUMP_PIT, storeys: [Storey.SUBLEVEL, Storey.POOLROOMS], weight: 1, footprint: [S, S], heroOnly: true,
  hero: [Zone.PIPEWORKS, Zone.CONCRETE] as readonly ZoneId[],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, S, S);
    if (!lm) return { entrances: [] };
    const wallMat = Mat.CONCRETE_WALL;
    claim(lm, { floorMat: Mat.CONCRETE_FLOOR, wallMat, ceilMat: Mat.CONCRETE_CEIL, ceilKind: CeilKind.CONCRETE, ceilCm: CEIL * 100, trimMat: Mat.METAL_PAINTED, zone: Zone.PIPEWORKS });
    for (const u of [5, 6]) {
      opening(lm, u, 0, 0, -1, EdgeKind.OPEN, wallMat);
      opening(lm, u, S - 1, 0, 1, EdgeKind.DOORWAY, wallMat, 0, 210);
    }
    opening(lm, 0, lm.rng.int(1, 2), -1, 0, EdgeKind.DOORWAY, wallMat, 0, 210);
    const P = SUMP_PIT;
    const [a, b] = P.pit;
    const fy = P.floorCm / 100, wy = P.waterCm / 100;
    cells(lm, a, a, b, b, { floorCm: P.floorCm, waterCm: P.waterCm, floorMat: Mat.CONCRETE_FLOOR, flagsSet: CellFlag.NOWALK });
    waterRect(lm, a, a, b, b, wy, fy, 1);
    // railings round the rim (post-and-rail on the open lip), a gap at both ends of the catwalk
    const cu: number = 5; // catwalk cells u 5
    const A = a * CELL - 0.06, B = b * CELL + 0.06;
    handrail(lm, A, A, 0, cu * CELL - 0.02, A, 0, Mat.METAL_PAINTED, 1.05, 2);
    handrail(lm, (cu + 1) * CELL + 0.02, A, 0, B, A, 0, Mat.METAL_PAINTED, 1.05, 3);
    handrail(lm, A, B, 0, cu * CELL - 0.02, B, 0, Mat.METAL_PAINTED, 1.05, 2);
    handrail(lm, (cu + 1) * CELL + 0.02, B, 0, B, B, 0, Mat.METAL_PAINTED, 1.05, 3);
    handrail(lm, A, A, 0, A, B, 0, Mat.METAL_PAINTED, 1.05, 5);
    handrail(lm, B, A, 0, B, B, 0, Mat.METAL_PAINTED, 1.05, 5);
    // the catwalk: grating on two stringers, handrails both sides
    const c0 = cu * CELL + 0.1, c1 = (cu + 1) * CELL - 0.1;
    box(lm, c0, a * CELL - 0.05, c1, b * CELL + 0.05, -0.04, 0, Mat.METAL_GRATE, WALK_F);
    for (const um of [c0, c1 - 0.08]) box(lm, um, a * CELL - 0.05, um + 0.08, b * CELL + 0.05, -0.28, -0.04, Mat.METAL_PAINTED, OVERHEAD);
    for (const um of [c0 + 0.03, c1 - 0.03]) handrail(lm, um, a * CELL, 0, um, b * CELL, 0, Mat.METAL_PAINTED, 1.05, 5);
    // pumps on the deck, suction pipes down into the water; mains coming out of the ceiling
    const pumps: [number, number][] = [[1.5 * CELL, 2.0 * CELL], [(S - 1.5) * CELL, (S - 2.2) * CELL]];
    for (const [pu, pv] of pumps) {
      prop(lm, PropKind.TANK, pu, pv, 0, 0, 1, lm.rng.int(0, 3), undefined, lm.rng.range(0, 1));
      const tu = pu < S * CELL / 2 ? a * CELL + 0.6 : b * CELL - 0.6;
      const tv = pv < S * CELL / 2 ? a * CELL + 0.8 : b * CELL - 0.8;
      pipeF(lm, pu, pv, 1.4, tu, pv, 1.4, 0.13, Mat.METAL_RUST, OVERHEAD);
      pipeF(lm, tu, pv, 1.4, tu, tv, 1.4, 0.13, Mat.METAL_RUST, OVERHEAD);
      pipeF(lm, tu, tv, 1.4, tu, tv, wy - 0.8, 0.13, Mat.METAL_RUST, OVERHEAD);
    }
    for (const [mu, mv] of [[(a + 1.5) * CELL, (b - 1.5) * CELL], [(b - 1.2) * CELL, (a + 2.2) * CELL]]) {
      pipeF(lm, mu, mv, CEIL, mu, mv, wy - 1.0, 0.3, Mat.METAL_PAINTED, OVERHEAD);
    }
    // the ladder down the far wall
    poolLadder(lm, (a + 1.5) * CELL, a * CELL, 0, 1, fy);
    // wet deck edge, stains, a warning sign on the wall
    cells(lm, a - 1, a - 1, b + 1, a, { flagsSet: CellFlag.WET });
    for (let k = 0; k < 4; k++) {
      floorDecal(lm, lm.rng.range(1, S * CELL - 1), lm.rng.range(0.8, a * CELL - 0.6), 0.002, { kind: k & 1 ? DecalKind.OIL : DecalKind.WATER_STAIN, sign: false, rot: lm.rng.range(0, 6.28), w: 1.3, h: 1.0, alpha: 0.55 });
    }
    const [sx, sz] = lm.f.point(3 * CELL, WALL_T / 2 + 0.004);
    const [nx, nz] = lm.f.dir(0, 1);
    g.addDecal({ kind: SignKind.AUTHORIZED, sign: true, px: sx, py: 1.6, pz: sz, nx, ny: 0, nz, rot: 0, w: 0.5, h: 0.35, alpha: 1 });
    // light: caged bulbs over the rim, one sodium over the pit
    const warm = kelvinToLinearRGB(2800, 0.01);
    for (const [u, v] of [[1.5, 1.5], [10.5, 1.5], [1.5, 10.5], [10.5, 10.5], [6, 1.4], [6, 10.6]] as [number, number][]) {
      fixture(lm, FixtureKind.CAGE_BULB, u * CELL, v * CELL, CEIL - 1.2, DOWN, [1, 0], warm, 180, lm.rng.chance(0.15) ? LightState.DYING : LightState.ON, { shape: 1, w: 0.1, h: 0.1, hum: 0.5 });
    }
    fixture(lm, FixtureKind.SODIUM, (a + b) / 2 * CELL + 0.9, (a + b) / 2 * CELL, CEIL - 0.6, DOWN, [1, 0], kelvinToLinearRGB(2000, 0), 12000, LightState.ON, { w: 0.45, h: 0.25, hum: 0.7 });
    emitter(lm, EmitterKind.WATER, (a + b) / 2 * CELL, (a + b) / 2 * CELL, wy, 0.4);
    emitter(lm, EmitterKind.MACHINE, pumps[0][0], pumps[0][1], 1.0, 0.6);
    emitter(lm, EmitterKind.DRIP, (a + 2) * CELL, (b - 2) * CELL, wy + 0.02, 0.45);
    return { entrances: lm.entrances };
  },
};
