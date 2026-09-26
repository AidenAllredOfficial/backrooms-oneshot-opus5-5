// src/world/landmarks/stairsToNowhere.ts — STAIRS_TO_NOWHERE (storeys 0, 1; 8x10, R2 B4): a tall bare stairwell
// whose one broad flight climbs 3 m to a landing that ends in a closed door against the back wall. The door is
// framed, numbered and locked; nothing is behind it. One bulb over the landing, the flight lit from below.
//
// Frame: u across (8 cells), v along (10 cells). Entrance(s) in the v = 0 wall (and one side door); the flight runs
// along +v over u 2.6..6.9 m from v 2.4 m to v 8.4 m, then a WALKABLE_TOP landing box up to the back wall.

import { CELL, WALL_T } from '../../core/constants.ts';
import { DecalKind, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import {
  ageCeiling, begin, box, claim, DOWN, emitter, fixture, floorDecal, handrail, opening, prop, ramp, storeyStyle, troffer, wallDecal, WALK_F,
} from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const W = 8, L = 10;
const CEIL = 5.4;
export const STAIRS_TO_NOWHERE = { rise: 3.0, v0: 2.4, v1: 8.4, u0: 2.6, u1: 7.0 } as const;

export const stairsToNowhere: LandmarkGenerator = {
  kind: LandmarkKind.STAIRS_TO_NOWHERE, storeys: [Storey.LOBBY, Storey.SUBLEVEL], weight: 1, footprint: [W, L],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const s = ctx.key.s;
    const deep = s === Storey.SUBLEVEL;
    const st = storeyStyle(s, CEIL * 100);
    claim(lm, st);
    const wallMat = st.wallMat;
    const S = STAIRS_TO_NOWHERE;
    // entrances: a wide header at the foot of the flight, a door in one side wall near the front
    opening(lm, 3, 0, 0, -1, EdgeKind.HEADER, wallMat, deep ? 0 : EdgeTrim.BASEBOARD, 230);
    opening(lm, 4, 0, 0, -1, EdgeKind.HEADER, wallMat, deep ? 0 : EdgeTrim.BASEBOARD, 230);
    const west = lm.rng.chance(0.5);
    opening(lm, west ? 0 : W - 1, 1, west ? -1 : 1, 0, EdgeKind.DOORWAY, wallMat, deep ? 0 : EdgeTrim.CASING, 210);

    // the flight: 20 risers of 15 cm over 6 m, carpeted on Level 0, bare concrete below
    const stairMat = deep ? Mat.CONCRETE_FLOOR : Mat.CARPET_L0;
    ramp(lm, S.u0, S.v0, S.u1, S.v1, 0, 1, 0, S.rise, 20, stairMat);
    // the landing, up to the back wall face
    const back = L * CELL - WALL_T / 2;
    box(lm, S.u0, S.v1, S.u1, back, 0, S.rise, stairMat, WALK_F);
    // handrails on both sides of the flight and along the open landing edges
    const rail = deep ? Mat.METAL_RUST : Mat.WOOD;
    handrail(lm, S.u0 + 0.05, S.v0 + 0.15, 0.15, S.u0 + 0.05, S.v1, S.rise, rail);
    handrail(lm, S.u1 - 0.05, S.v0 + 0.15, 0.15, S.u1 - 0.05, S.v1, S.rise, rail);
    handrail(lm, S.u0 + 0.05, S.v1, S.rise, S.u0 + 0.05, back - 0.05, S.rise, rail);
    handrail(lm, S.u1 - 0.05, S.v1, S.rise, S.u1 - 0.05, back - 0.05, S.rise, rail);

    // the door at the top: frame + leaf against the back wall, a room number above, scuffs on the landing
    const mid = (S.u0 + S.u1) / 2;
    prop(lm, PropKind.DOOR_FRAME, mid, back - 0.075, S.rise, 0, -1);
    prop(lm, PropKind.DOOR_LEAF, mid, back - 0.03, S.rise, 0, -1, lm.rng.int(0, 3));
    wallDecal(lm, 3, L - 1, 3, L, 0.5, S.rise + 2.45, { kind: DecalKind.PARKING_NUMBER, sign: false, rot: 0, w: 0.3, h: 0.3, alpha: 0.8 });
    floorDecal(lm, mid + lm.rng.range(-0.4, 0.4), back - 0.8, S.rise + 0.005, { kind: DecalKind.SCUFF, sign: false, rot: lm.rng.range(0, 6.28), w: 1.0, h: 0.6, alpha: 0.5 });
    floorDecal(lm, mid, S.v0 - 0.6, 0, { kind: DecalKind.FOOTPRINTS_WET, sign: false, rot: lm.f.yaw(0, 1), w: 0.6, h: 1.4, alpha: 0.35 });

    // light: a bare bulb over the landing (the only thing that makes the door read), a dim fitting at the foot
    const warm = kelvinToLinearRGB(2900, 0.01);
    fixture(lm, FixtureKind.CAGE_BULB, mid, back - 1.1, CEIL - 0.6, DOWN, [1, 0], warm, 220, LightState.ON, { shape: 1, w: 0.1, h: 0.1, hum: 0.5 });
    const cold = kelvinToLinearRGB(4100, 0.03);
    if (deep) {
      fixture(lm, FixtureKind.TUBE_STRIP, 1.4 * CELL, 1.5 * CELL, CEIL - 0.05, DOWN, [0, 1], cold, 8600, LightState.ON);
      fixture(lm, FixtureKind.TUBE_STRIP, (W - 1.4) * CELL, 1.5 * CELL, CEIL - 0.05, DOWN, [0, 1], cold, 8600, lm.rng.chance(0.4) ? LightState.DYING : LightState.ON);
    } else {
      troffer(lm, 1.2, 1.2, CEIL, cold, 3300, LightState.ON);
      troffer(lm, W * CELL - 1.8, 1.2, CEIL, cold, 3300, lm.rng.chance(0.4) ? LightState.DYING : LightState.ON);
      troffer(lm, 1.2, 6.0, CEIL, cold, 3300, LightState.OFF);
      ageCeiling(lm, 0.18, 0.04, 0.02);
    }
    emitter(lm, EmitterKind.BUZZ, mid, back - 1.1, CEIL - 0.7, 0.25);
    return { entrances: lm.entrances };
  },
};
