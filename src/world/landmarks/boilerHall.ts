// src/world/landmarks/boilerHall.ts — BOILER_HALL (storey 1, 12x12): a 6 m concrete hall with three BOILERs facing two
// TANKs across a central floor, a pipe manifold (pipe solids) tying them together overhead, bare CAGE_BULBs and the
// STEAM / MACHINE / PIPE soundscape (WP4).
//
// Frame: u across (12 cells), v along (12 cells). Boilers at v = 2.5 m facing +v, tanks at v = 10 m. Two headers at
// y = 3.6 m run along u over each row; cross pipes along v near both side walls join them; a riser goes up to the deck.

import { CELL, WALL_T } from '../../core/constants.ts';
import { CeilKind, DecalKind, EdgeKind, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, SolidFlag, Storey, Zone } from '../../core/index.ts';
import type { LightStateId, MatId } from '../../core/index.ts';
import { PROP_DEFS } from '../../core/props.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, claim, DOWN, emitter, fixture, floorDecal, opening, prop } from './common.ts';
import type { Lm } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const S = 12;
const CEIL = 6.0;
export const BOILER_HALL = { boilerV: 2.5, tankV: 10.0, headerY: 3.6, boilers: [2.2, 7.2, 12.2], tanks: [4.2, 10.2] } as const;

const OVERHEAD = SolidFlag.OCCLUDE | SolidFlag.RENDER;
const LOW = SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.RENDER;

function pipe(lm: Lm, um0: number, vm0: number, y0: number, um1: number, vm1: number, y1: number, r: number, mat: MatId, flags = OVERHEAD): void {
  const [ax, az] = lm.f.point(um0, vm0), [bx, bz] = lm.f.point(um1, vm1);
  lm.g.addSolid({ kind: 'pipe', a: [ax, y0, az], b: [bx, y1, bz], r, mat, flags });
}

export const boilerHall: LandmarkGenerator = {
  kind: LandmarkKind.BOILER_HALL, storeys: [Storey.SUBLEVEL], weight: 1, footprint: [S, S],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, S, S);
    if (!lm) return { entrances: [] };
    const wallMat = Mat.CONCRETE_WALL;
    claim(lm, { floorMat: Mat.CONCRETE_FLOOR, wallMat, ceilMat: Mat.CONCRETE_CEIL, ceilKind: CeilKind.CONCRETE, ceilCm: CEIL * 100, trimMat: Mat.METAL_PAINTED, zone: Zone.PIPEWORKS });
    const west = lm.rng.chance(0.5);
    opening(lm, west ? 0 : S - 1, lm.rng.int(5, 7), west ? -1 : 1, 0, EdgeKind.DOORWAY, wallMat, 0, 210);
    opening(lm, lm.rng.int(4, 7), S - 1, 0, 1, EdgeKind.DOORWAY, wallMat, 0, 210);

    const B = BOILER_HALL;
    const H = B.headerY;
    const bH = PROP_DEFS[PropKind.BOILER].size[1], tH = PROP_DEFS[PropKind.TANK].size[1];
    // three boilers facing the hall, two tanks across from them
    for (const um of B.boilers) prop(lm, PropKind.BOILER, um, B.boilerV, 0, 0, 1, lm.rng.int(0, 3));
    for (const um of B.tanks) prop(lm, PropKind.TANK, um, B.tankV, 0, 0, -1, lm.rng.int(0, 3), undefined, lm.rng.range(0, 1.5));

    // manifold: headers over each row, drops into every vessel, cross pipes along both side walls, a riser
    const paint = Mat.METAL_PAINTED, rust = Mat.METAL_RUST;
    const x0 = 0.6, x1 = S * CELL - 0.6;
    pipe(lm, x0, B.boilerV, H, x1, B.boilerV, H, 0.14, paint);
    pipe(lm, x0, B.tankV, H, x1, B.tankV, H, 0.12, paint);
    for (const um of B.boilers) pipe(lm, um, B.boilerV, bH, um, B.boilerV, H, 0.09, rust);
    for (const um of B.tanks) pipe(lm, um, B.tankV, tH, um, B.tankV, H, 0.08, rust);
    pipe(lm, x0, B.boilerV, H, x0, B.tankV, H, 0.12, paint);
    pipe(lm, x1, B.boilerV, H, x1, B.tankV, H, 0.12, paint);
    pipe(lm, x1, B.tankV, H, x1, B.tankV, CEIL, 0.16, rust);
    // a service line down the side wall to a valve at hand height (the only pipe low enough to bump into)
    const sx = west ? S * CELL - WALL_T / 2 - 0.12 : WALL_T / 2 + 0.12;
    const sv = 7.4;
    pipe(lm, sx, sv, 0, sx, sv, H, 0.07, rust, LOW);
    pipe(lm, sx, sv, H, west ? x1 : x0, sv, H, 0.07, rust);
    prop(lm, PropKind.PIPE_VALVE, sx + (west ? -0.12 : 0.12), sv, 1.1, west ? -1 : 1, 0, lm.rng.int(0, 3));

    // bare cage bulbs hanging under the headers' level, one dying, maybe one flickering
    const warm = kelvinToLinearRGB(2800, 0.01);
    const bulbs: [number, number, number][] = [
      [2.4, 6.2, 3.2], [7.2, 6.2, 3.2], [12.0, 6.2, 3.2], [4.7, 0.9, 3.0], [9.7, 0.9, 3.0], [7.2, 11.8, 3.2], [1.6, 11.8, 3.2], [12.8, 11.8, 3.2],
    ];
    const dying = lm.rng.int(0, bulbs.length - 1);
    const flick = lm.rng.chance(0.35) ? lm.rng.int(0, bulbs.length - 1) : -1;
    bulbs.forEach(([um, vm, y], i) => {
      const st: LightStateId = i === dying ? LightState.DYING : i === flick ? LightState.FLICKER : LightState.ON;
      fixture(lm, FixtureKind.CAGE_BULB, um, vm, y, DOWN, [1, 0], warm, 160, st, { shape: 1, w: 0.1, h: 0.1, hum: 0.6 });
    });

    // sound: steam from a leaking joint, the machines, pipes ticking along the header
    emitter(lm, EmitterKind.STEAM, B.boilers[1] + 0.9, B.boilerV, H, 0.5);
    emitter(lm, EmitterKind.MACHINE, B.boilers[1], B.boilerV + 1.0, 1.0, 0.7);
    emitter(lm, EmitterKind.PIPE, S * CELL / 2, B.tankV, H, 0.45);
    // oil under the boilers, a floor drain, water under the steam leak
    for (const um of B.boilers) {
      if (lm.rng.chance(0.7)) floorDecal(lm, um + lm.rng.range(-0.3, 0.3), B.boilerV + 1.0 + lm.rng.range(0, 0.3), 0, { kind: DecalKind.OIL, sign: false, rot: lm.rng.range(0, 6.28), w: 1.0, h: 0.7, alpha: 0.6 });
    }
    floorDecal(lm, S * CELL / 2, 6.2, 0, { kind: DecalKind.DRAIN, sign: false, rot: 0, w: 0.45, h: 0.45, alpha: 0.95 });
    floorDecal(lm, B.boilers[1] + 0.9, B.boilerV + 1.3, 0, { kind: DecalKind.WATER_STAIN, sign: false, rot: lm.rng.range(0, 6.28), w: 1.2, h: 1.2, alpha: 0.6 });
    return { entrances: lm.entrances };
  },
};
