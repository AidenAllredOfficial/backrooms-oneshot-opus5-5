// src/world/landmarks/redRoom.ts — RED_ROOM (storeys 0, 1 (R2); 6x6): bare CMU room, three red bulbs, one doorway, a hum (WP4).

import { CeilKind, EdgeKind, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, Storey } from '../../core/index.ts';
import { RED_LIGHT } from '../content/util.ts';
import { begin, claim, DOWN, emitter, fixture, opening, prop } from './common.ts';
import type { LandmarkGenerator } from './index.ts';
import { PropKind } from '../../core/index.ts';

export const redRoom: LandmarkGenerator = {
  kind: LandmarkKind.RED_ROOM, storeys: [Storey.LOBBY, Storey.SUBLEVEL], weight: 1, footprint: [6, 6],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, 6, 6);
    if (!lm) return { entrances: [] };
    const ceil = 2.6;
    claim(lm, { floorMat: Mat.CONCRETE_FLOOR, wallMat: Mat.CMU_PAINTED, ceilMat: Mat.CONCRETE_CEIL, ceilKind: CeilKind.CONCRETE, ceilCm: ceil * 100, trimMat: Mat.CMU_PAINTED });
    opening(lm, lm.rng.int(1, 4), 0, 0, -1, EdgeKind.DOORWAY, Mat.CMU_PAINTED);
    // three bare red bulbs hanging on cords (one buzzing)
    const spots: [number, number][] = [[1.5, 2.1], [4.5, 3.3], [2.7, 5.4]];
    const buzz = lm.rng.int(0, 2);
    spots.forEach(([um, vm], i) => {
      fixture(lm, FixtureKind.RED_BULB, um + lm.rng.range(-0.2, 0.2), vm + lm.rng.range(-0.2, 0.2), ceil - 0.45 - lm.rng.range(0, 0.25), DOWN, [1, 0],
        RED_LIGHT, 200, i === buzz ? LightState.BUZZ : LightState.ON, { shape: 1, w: 0.08, h: 0.08, hum: 0.8 });
    });
    emitter(lm, EmitterKind.BUZZ, 3.6, 3.6, 2.2, 0.45);
    // a single chair pushed into the far corner, facing the wall
    if (lm.rng.chance(0.5)) prop(lm, PropKind.CHAIR_STACKING, 6.6, 6.55, 0, 0, 1, 0, undefined, lm.rng.range(-0.3, 0.3));
    return { entrances: lm.entrances };
  },
};
