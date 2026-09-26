// src/world/landmarks/splitLevelHall.ts — SPLIT_LEVEL_HALL (storeys 0, 1; 12x14, R2 B4): one long hall whose far
// half has sunk 1.5 m. A broad flight in the middle joins the two floors; the drop is guarded by a railing and the
// same wallpaper runs down the retaining wall. The lower floor is lit by a row of fixtures hung at the upper
// ceiling, 5.7 m above it, so it reads as a pit of carpet from the upper level.
//
// Frame: u across (12 cells), v along (14 cells). Upper floor v 0..6 (floor 0), lower floor v 7..13 (floor -150).
// Flight: u 5..7 over v 7..9 (ramp -1.5 -> 0 toward -v), a balustrade on line v = 7 elsewhere. Entrances are all on
// the upper level (v = 0 wall and both side walls near the front): the lower level is a dead end, on purpose.

import { CELL, WALL_T } from '../../core/constants.ts';
import { DecalKind, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey } from '../../core/index.ts';
import type { LightStateId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { ageCeiling, begin, cells, claim, DOWN, emitter, fixture, floorDecal, handrail, opening, prop, ramp, storeyStyle, troffer } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const W = 12, L = 14;
export const SPLIT_LEVEL = { dropV: 7, lowCm: -150, stair: [5, 7] as const, stairLen: 2, ceilCm: 420 } as const;

export const splitLevelHall: LandmarkGenerator = {
  kind: LandmarkKind.SPLIT_LEVEL_HALL, storeys: [Storey.LOBBY, Storey.SUBLEVEL], weight: 1, footprint: [W, L],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const s = ctx.key.s;
    const deep = s === Storey.SUBLEVEL;
    const P = SPLIT_LEVEL;
    const st = storeyStyle(s, P.ceilCm);
    claim(lm, st);
    const wallMat = st.wallMat;
    const trim = deep ? 0 : EdgeTrim.BASEBOARD;
    // the sunken half (the flight cells keep the lower floor: the ramp solid carries the walk)
    cells(lm, 0, P.dropV, W, L, { floorCm: P.lowCm });
    const [su0, su1] = P.stair;
    ramp(lm, su0 * CELL, P.dropV * CELL, su1 * CELL, (P.dropV + P.stairLen) * CELL, 0, -1, P.lowCm / 100, 0, 10, st.floorMat);
    // the drop: an open edge (the retaining wall face shows below), guarded by a post-and-rail balustrade
    const rail = deep ? Mat.METAL_PAINTED : Mat.WOOD;
    const lip = P.dropV * CELL + 0.05;
    handrail(lm, WALL_T / 2 + 0.05, lip, 0, su0 * CELL - 0.02, lip, 0, rail, 1.0, su0 * 2);
    handrail(lm, su1 * CELL + 0.02, lip, 0, W * CELL - WALL_T / 2 - 0.05, lip, 0, rail, 1.0, (W - su1) * 2);
    handrail(lm, su0 * CELL + 0.06, (P.dropV + P.stairLen) * CELL, P.lowCm / 100, su0 * CELL + 0.06, P.dropV * CELL, 0, rail);
    handrail(lm, su1 * CELL - 0.06, (P.dropV + P.stairLen) * CELL, P.lowCm / 100, su1 * CELL - 0.06, P.dropV * CELL, 0, rail);

    // entrances on the upper level
    const m = lm.rng.int(3, W - 5);
    opening(lm, m, 0, 0, -1, EdgeKind.HEADER, wallMat, trim, 230);
    opening(lm, m + 1, 0, 0, -1, EdgeKind.HEADER, wallMat, trim, 230);
    opening(lm, 0, lm.rng.int(1, 4), -1, 0, EdgeKind.DOORWAY, wallMat, deep ? 0 : EdgeTrim.CASING, 210);
    opening(lm, W - 1, lm.rng.int(1, 4), 1, 0, EdgeKind.DOORWAY, wallMat, deep ? 0 : EdgeTrim.CASING, 210);

    // lights: a grid at 4.2 m over both levels, some dead; the lower level darker
    const col = kelvinToLinearRGB(deep ? 4000 : 4100, 0.03);
    for (let v = 1; v < L - 1; v += 3) for (let u = 1; u < W - 1; u += 3) {
      const lower = v >= P.dropV;
      const r = lm.rng.float();
      const stt: LightStateId = r < (lower ? 0.4 : 0.12) ? LightState.OFF : r < (lower ? 0.55 : 0.2) ? LightState.DYING : LightState.ON;
      if (deep) fixture(lm, FixtureKind.TUBE_STRIP, (u + 0.5) * CELL, (v + 0.5) * CELL, P.ceilCm / 100 - 0.05, DOWN, [1, 0], col, 8600, stt);
      else troffer(lm, u * CELL + 0.3, v * CELL, P.ceilCm / 100, col, 3300, stt);
    }
    if (!deep) ageCeiling(lm, 0.2, 0.04, 0.03);

    // the lower floor: a few abandoned chairs in rows facing the far wall, a rolled-up mattress, damp
    const low = P.lowCm / 100;
    const rows = lm.rng.int(2, 3);
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < 5; k++) {
        if (lm.rng.chance(0.25)) continue;
        prop(lm, PropKind.CHAIR_STACKING, 4.2 + k * 1.5 + (r & 1) * 0.4, (P.dropV + 3 + r * 1.3) * CELL, low, 0, 1, 0, undefined, lm.rng.range(-0.15, 0.15));
      }
    }
    if (lm.rng.chance(0.5)) prop(lm, PropKind.MATTRESS, (W - 1.6) * CELL, (L - 2) * CELL, low, 1, 0, lm.rng.int(0, 2), undefined, lm.rng.range(-0.2, 0.2));
    for (let k = 0; k < 3; k++) {
      floorDecal(lm, lm.rng.range(1.5, W * CELL - 1.5), lm.rng.range((P.dropV + 2.5) * CELL, (L - 1) * CELL), low + 0.005,
        { kind: DecalKind.WATER_STAIN, sign: false, rot: lm.rng.range(0, 6.28), w: 1.6, h: 1.2, alpha: 0.45 });
    }
    emitter(lm, EmitterKind.DRIP, (W / 2) * CELL, (L - 2) * CELL, low + 0.02, 0.25);
    return { entrances: lm.entrances };
  },
};
