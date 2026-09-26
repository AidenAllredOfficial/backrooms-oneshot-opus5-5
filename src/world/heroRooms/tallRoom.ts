// src/world/heroRooms/tallRoom.ts — TALL_ROOM hero (Level 0 family; 12x12, R2 B4): the famous 6 m carpeted room.
// The same wallpaper, the same carpet, the same 2x4 troffers, only everything is twice as tall as it should be:
// four boxed columns, a grid of troffers at 6 m (a patch of them dead), water stains up high, and one ordinary door
// set into the wall three metres above the floor, leading nowhere.
//
// Frame: u across, v along (12 x 12 cells). Openings at floor level on three sides.

import { CELL, WALL_T } from '../../core/constants.ts';
import { DecalKind, EdgeKind, EdgeTrim, EmitterKind, LandmarkKind, LightState, Mat, PropKind, Storey, Zone } from '../../core/index.ts';
import type { LightStateId, ZoneId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { ageCeiling, begin, box, claim, emitter, floorDecal, opening, prop, storeyStyle, troffer, wallDecal } from '../landmarks/common.ts';
import type { LandmarkGenerator } from '../landmarks/index.ts';

const S = 12;
export const TALL_ROOM = { ceil: 6.0, highDoorY: 3.1, columns: [3.4, 10.6] as const } as const;

export const tallRoom: LandmarkGenerator = {
  kind: LandmarkKind.TALL_ROOM, storeys: [Storey.LOBBY, Storey.SUBLEVEL], weight: 1, footprint: [S, S], heroOnly: true,
  hero: [Zone.LOBBY, Zone.MANILA, Zone.PILLAR_HALL] as readonly ZoneId[],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, S, S);
    if (!lm) return { entrances: [] };
    const s = ctx.key.s;
    const deep = s === Storey.SUBLEVEL;
    const manila = ctx.district.zone === Zone.MANILA;
    const T = TALL_ROOM;
    const st = storeyStyle(s, T.ceil * 100, manila && !deep ? { wallMat: Mat.WALLPAPER_MANILA } : {});
    claim(lm, st);
    const wallMat = st.wallMat;
    const trim = deep ? 0 : EdgeTrim.BASEBOARD;
    const m = lm.rng.int(3, 7);
    opening(lm, m, 0, 0, -1, EdgeKind.HEADER, wallMat, trim, 220);
    opening(lm, m + 1, 0, 0, -1, EdgeKind.HEADER, wallMat, trim, 220);
    opening(lm, 0, lm.rng.int(3, 8), -1, 0, EdgeKind.DOORWAY, wallMat, deep ? 0 : EdgeTrim.CASING, 210);
    opening(lm, S - 1, lm.rng.int(3, 8), 1, 0, EdgeKind.HEADER, wallMat, trim, 215);

    // four boxed columns, wallpapered like the walls
    for (const cu of T.columns) for (const cv of T.columns) box(lm, cu - 0.35, cv - 0.35, cu + 0.35, cv + 0.35, 0, T.ceil, wallMat);
    // the troffer grid at 6 m, a dead patch in one quadrant, one buzzing
    const col = kelvinToLinearRGB(deep ? 4000 : 4100, 0.035);
    const dq = lm.rng.int(0, 3);
    const buzz = lm.rng.int(0, 15);
    let k = 0;
    for (let v = 1; v < S - 1; v += 3) for (let u = 1; u < S - 1; u += 3) {
      const q = (u < S / 2 ? 0 : 1) + (v < S / 2 ? 0 : 2);
      const r = lm.rng.float();
      const stt: LightStateId = k++ === buzz ? LightState.BUZZ : q === dq ? (r < 0.7 ? LightState.OFF : LightState.DYING) : r < 0.08 ? LightState.OFF : LightState.ON;
      troffer(lm, u * CELL + 0.3, v * CELL, T.ceil, col, 3600, stt);
    }
    if (!deep) ageCeiling(lm, 0.22, 0.05, 0.03);
    // the door three metres up the back wall
    const back = S * CELL - WALL_T / 2;
    const du = lm.rng.range(4.5, 9.9);
    prop(lm, PropKind.DOOR_FRAME, du, back - 0.075, T.highDoorY, 0, -1);
    prop(lm, PropKind.DOOR_LEAF, du, back - 0.03, T.highDoorY, 0, -1, lm.rng.int(0, 3));
    box(lm, du - 0.55, back - 0.05, du + 0.55, back, T.highDoorY - 0.04, T.highDoorY, Mat.TRIM_PAINT); // a sill line under it
    wallDecal(lm, 5, S - 1, 5, S, 0.3, T.highDoorY - 0.5, { kind: DecalKind.DRIP, sign: false, rot: 0, w: 0.5, h: 1.2, alpha: 0.5 });
    // water stains high on the walls and one dark streak running down to the carpet
    for (let i = 0; i < 5; i++) {
      const side = lm.rng.int(0, 3);
      const t = lm.rng.int(1, S - 2);
      const [u, v, un, vn] = side === 0 ? [t, 0, t, -1] : side === 1 ? [t, S - 1, t, S] : side === 2 ? [0, t, -1, t] : [S - 1, t, S, t];
      wallDecal(lm, u, v, un, vn, lm.rng.range(0.2, 0.8), lm.rng.range(4.2, 5.6), { kind: DecalKind.WATER_STAIN, sign: false, rot: lm.rng.range(-0.3, 0.3), w: lm.rng.range(1.2, 2.2), h: lm.rng.range(0.8, 1.6), alpha: 0.55 });
    }
    // the carpet: a damp patch under the stains, a single chair very far from the entrance
    floorDecal(lm, lm.rng.range(3, S * CELL - 3), lm.rng.range(6, S * CELL - 2), 0, { kind: DecalKind.WATER_STAIN, sign: false, rot: lm.rng.range(0, 6.28), w: 2.4, h: 1.8, alpha: 0.5 });
    prop(lm, PropKind.CHAIR_STACKING, S * CELL - 1.4, S * CELL - 1.6, 0, lm.rng.chance(0.5) ? 1 : 0, 1, 0, undefined, lm.rng.range(-0.2, 0.2));
    emitter(lm, EmitterKind.BUZZ, (S / 2) * CELL, (S / 2) * CELL, T.ceil - 0.5, 0.35);
    return { entrances: lm.entrances };
  },
};
