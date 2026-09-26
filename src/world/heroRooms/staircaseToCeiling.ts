// src/world/heroRooms/staircaseToCeiling.ts — STAIRCASE_TO_CEILING hero (Level 0 family; 8x10, R2 B4): an
// ordinary low room with a carpeted staircase in the middle that climbs straight up into the drop ceiling. The tiles
// are cut away around its upper half; above them is only black. The flight is real: at the top a small landing ends
// against a bare wall in the dark, a metre above the ceiling you came from.
//
// Frame: u across (8 cells), v along (10 cells). Flight: u 3..5, v 2.4..8.4 m (0 -> 3.0 m, ascending +v); the landing
// to the back wall. Cells over the upper flight and landing: NO_CEIL, ceiling 520 cm (the void).

import { CELL, WALL_T } from '../../core/constants.ts';
import { CellFlag, DecalKind, EdgeKind, EdgeTrim, EmitterKind, LandmarkKind, LightState, Mat, Storey, Zone } from '../../core/index.ts';
import type { ZoneId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { ageCeiling, begin, box, cells, claim, emitter, floorDecal, handrail, opening, ramp, storeyStyle, troffer, WALK_F } from '../landmarks/common.ts';
import type { LandmarkGenerator } from '../landmarks/index.ts';

const W = 8, L = 10;
export const STAIRCASE_TO_CEILING = { ceilCm: 270, voidCm: 520, rise: 3.0, v0: 2.4, v1: 8.4, u: [3, 5] as const, holeV: 5 } as const;

export const staircaseToCeiling: LandmarkGenerator = {
  kind: LandmarkKind.STAIRCASE_TO_CEILING, storeys: [Storey.LOBBY, Storey.SUBLEVEL], weight: 1, footprint: [W, L], heroOnly: true,
  hero: [Zone.LOBBY, Zone.MANILA, Zone.DARK, Zone.MAZE] as readonly ZoneId[],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const s = ctx.key.s;
    const deep = s === Storey.SUBLEVEL;
    const P = STAIRCASE_TO_CEILING;
    const st = storeyStyle(s, P.ceilCm, ctx.district.zone === Zone.MANILA && !deep ? { wallMat: Mat.WALLPAPER_MANILA } : {});
    claim(lm, st);
    const wallMat = st.wallMat;
    const trim = deep ? 0 : EdgeTrim.BASEBOARD;
    opening(lm, 3, 0, 0, -1, EdgeKind.HEADER, wallMat, trim, 225);
    opening(lm, 4, 0, 0, -1, EdgeKind.HEADER, wallMat, trim, 225);
    opening(lm, 0, lm.rng.int(2, 7), -1, 0, EdgeKind.DOORWAY, wallMat, deep ? 0 : EdgeTrim.CASING, 210);
    opening(lm, W - 1, lm.rng.int(2, 7), 1, 0, EdgeKind.DOORWAY, wallMat, deep ? 0 : EdgeTrim.CASING, 210);

    const [a, b] = P.u;
    // the hole in the ceiling over the upper flight and the landing: no ceiling, a tall black void
    cells(lm, a, P.holeV, b, L, { ceilCm: P.voidCm, flagsSet: CellFlag.NO_CEIL });
    // the flight and the landing
    const stairMat = deep ? Mat.CONCRETE_FLOOR : Mat.CARPET_L0;
    ramp(lm, a * CELL, P.v0, b * CELL, P.v1, 0, 1, 0, P.rise, 20, stairMat);
    const back = L * CELL - WALL_T / 2;
    box(lm, a * CELL, P.v1, b * CELL, back, 0, P.rise, stairMat, WALK_F);
    const rail = deep ? Mat.METAL_PAINTED : Mat.WOOD;
    handrail(lm, a * CELL + 0.05, P.v0 + 0.2, 0.15, a * CELL + 0.05, P.v1, P.rise, rail);
    handrail(lm, b * CELL - 0.05, P.v0 + 0.2, 0.15, b * CELL - 0.05, P.v1, P.rise, rail);
    // worn nosing at the foot, a trail of damp footprints going up
    floorDecal(lm, (a + 1) * CELL, P.v0 - 0.4, 0, { kind: DecalKind.FOOTPRINTS_WET, sign: false, rot: lm.f.yaw(0, 1), w: 0.6, h: 1.2, alpha: 0.4 });
    floorDecal(lm, (a + 1) * CELL + lm.rng.range(-0.3, 0.3), P.v0 - 1.4, 0, { kind: DecalKind.WATER_STAIN, sign: false, rot: lm.rng.range(0, 6.28), w: 1.4, h: 1.0, alpha: 0.4 });

    // lights: ordinary troffers in the room; nothing above the ceiling
    const col = kelvinToLinearRGB(deep ? 4000 : 4100, 0.035);
    const ceil = P.ceilCm / 100;
    troffer(lm, 1 * CELL + 0.3, 1 * CELL, ceil, col, 3300, LightState.ON);
    troffer(lm, 6 * CELL + 0.3, 1 * CELL, ceil, col, 3300, LightState.ON);
    troffer(lm, 1 * CELL + 0.3, 6 * CELL, ceil, col, 3300, lm.rng.chance(0.5) ? LightState.DYING : LightState.ON);
    troffer(lm, 6 * CELL + 0.3, 6 * CELL, ceil, col, 3300, LightState.ON);
    troffer(lm, 3 * CELL + 0.3, 2 * CELL + 0.3, ceil, col, 3300, LightState.ON, true);
    if (!deep) ageCeiling(lm, 0.2, 0.05, 0.02);
    emitter(lm, EmitterKind.VENT, (a + 1) * CELL, back - 1.0, P.rise + 1.5, 0.35); // air moving somewhere up there
    return { entrances: lm.entrances };
  },
};
