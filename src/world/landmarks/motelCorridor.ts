// src/world/landmarks/motelCorridor.ts — MOTEL_CORRIDOR (storeys 0, 1; 8x22, R2 B4): a 26 m hotel corridor with
// numbered doors on both sides, warm wall sconces between them, patterned carpet and a different wallpaper from the
// rest of Level 0. One door stands open on a small lit room (bed, television, a lamp left on, curtains glowing);
// an ice machine hums in an alcove; the far end is a fire door under an EXIT sign.
//
// Frame: u across (8 cells), v along (22 cells). Corridor: u 3..4. Rooms behind the walls are SOLID, except the open
// room (u 0..2, v ROOM_V..+3) and the ice alcove (u 5..6, v ICE_V..+2).

import { CELL, WALL_T } from '../../core/constants.ts';
import { CeilKind, CellFlag, DecalKind, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey } from '../../core/index.ts';
import type { LightStateId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { EXIT_RED } from '../content/util.ts';
import { VENDING_PANEL } from './vendingAlcove.ts';
import { begin, box, cells, claim, DOWN, emitter, fixture, floorDecal, glowPanel, opening, prop, SOLID_F, storeyStyle, THIN_F, wall, wallDecal } from './common.ts';
import type { Lm } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const W = 8, L = 22;
const CEIL = 2.45;
export const MOTEL = { corridor: [3, 5] as const, roomV: 8, iceV: 14 } as const;

/** Fake door (frame + leaf) on corridor wall side (-1: u = 3 face looking +u; +1: u = 4 face looking -u) at cell v. */
function door(lm: Lm, side: -1 | 1, v: number, number: boolean): void {
  const du = side < 0 ? 1 : -1;
  const face = side < 0 ? MOTEL.corridor[0] * CELL + WALL_T / 2 : MOTEL.corridor[1] * CELL - WALL_T / 2;
  prop(lm, PropKind.DOOR_FRAME, face + du * 0.075, (v + 0.5) * CELL, 0, du, 0);
  prop(lm, PropKind.DOOR_LEAF, face + du * 0.03, (v + 0.5) * CELL, 0, du, 0, lm.rng.int(0, 3));
  if (number) {
    const u = side < 0 ? MOTEL.corridor[0] : MOTEL.corridor[1] - 1;
    wallDecal(lm, u, v, u + side, v, 0.5, 1.62, { kind: DecalKind.PARKING_NUMBER, sign: false, rot: 0, w: 0.16, h: 0.16, alpha: 0.9 });
  }
}

export const motelCorridor: LandmarkGenerator = {
  kind: LandmarkKind.MOTEL_CORRIDOR, storeys: [Storey.LOBBY, Storey.SUBLEVEL], weight: 1, footprint: [W, L],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const deep = ctx.key.s === Storey.SUBLEVEL;
    const wallMat = deep ? Mat.CMU_PAINTED : Mat.WALLPAPER_MANILA;
    const st = storeyStyle(ctx.key.s, CEIL * 100, { floorMat: Mat.CARPET_OFFICE, wallMat, ceilMat: Mat.CEILING_TILE, ceilKind: CeilKind.TILES, baseboard: true });
    claim(lm, st);
    const [c0, c1] = MOTEL.corridor;
    const rv = MOTEL.roomV, iv = MOTEL.iceV;
    // everything behind the corridor walls is solid, except the open room and the ice alcove
    cells(lm, 0, 0, c0, L, { flagsSet: CellFlag.SOLID });
    cells(lm, c1, 0, W, L, { flagsSet: CellFlag.SOLID });
    cells(lm, 0, rv, c0, rv + 3, { flagsClear: CellFlag.SOLID, floorMat: Mat.CARPET_L0, ceilCm: 250 });
    cells(lm, c1, iv, c1 + 2, iv + 2, { flagsClear: CellFlag.SOLID, floorMat: Mat.VINYL_VCT });
    for (let v = 0; v < L; v++) {
      const inRoom = v >= rv && v < rv + 3, inIce = v >= iv && v < iv + 2;
      if (!inRoom) wall(lm, c0, v, c0 - 1, v, EdgeKind.WALL, wallMat, EdgeTrim.BASEBOARD);
      else wall(lm, c0, v, c0 - 1, v, v === rv + 1 ? EdgeKind.DOORWAY : EdgeKind.WALL, wallMat, v === rv + 1 ? EdgeTrim.CASING : EdgeTrim.BASEBOARD, v === rv + 1 ? 210 : undefined);
      if (!inIce) wall(lm, c1 - 1, v, c1, v, EdgeKind.WALL, wallMat, EdgeTrim.BASEBOARD);
      else wall(lm, c1 - 1, v, c1, v, EdgeKind.HEADER, wallMat, 0, 215);
    }
    // the room's own walls (painted), the alcove's (block)
    for (let v = rv; v < rv + 3; v++) wall(lm, 0, v, -1, v, EdgeKind.WALL, Mat.DRYWALL, EdgeTrim.BASEBOARD);
    for (let u = 0; u < c0; u++) {
      wall(lm, u, rv, u, rv - 1, EdgeKind.WALL, Mat.DRYWALL, EdgeTrim.BASEBOARD);
      wall(lm, u, rv + 2, u, rv + 3, EdgeKind.WALL, Mat.DRYWALL, EdgeTrim.BASEBOARD);
      for (let v = rv; v < rv + 3; v++) if (u > 0) lm.f.setEdge(g, u - 1, v, u, v, EdgeKind.OPEN, Mat.DRYWALL, Mat.DRYWALL, { trim: 0 });
    }
    // ends: the entrance end is open, the far end a fire door under an EXIT sign
    opening(lm, c0, 0, 0, -1, EdgeKind.OPEN, wallMat);
    opening(lm, c0 + 1, 0, 0, -1, EdgeKind.OPEN, wallMat);
    const fire = lm.rng.int(c0, c1 - 1);
    opening(lm, fire, L - 1, 0, 1, EdgeKind.DOORWAY, wallMat, EdgeTrim.CASING, 210);
    fixture(lm, FixtureKind.EXIT_SIGN, (fire + 0.5) * CELL, L * CELL - WALL_T / 2 - 0.05, 2.3, [0, 0, -1], [1, 0], EXIT_RED, 150, LightState.ON);

    // doors: every third cell, sides offset; numbers beside them
    for (let v = 1; v < L - 1; v += 3) {
      if (!(v >= rv - 1 && v <= rv + 3)) door(lm, -1, v, true);
      const vr = v + 1;
      if (vr < L - 1 && !(vr >= iv - 1 && vr <= iv + 2)) door(lm, 1, vr, true);
    }
    // sconces between the doors: warm bulbs 1.85 m up on both walls, a few dead, one buzzing
    const warm = kelvinToLinearRGB(2700, 0);
    let buzz = lm.rng.int(0, 6);
    for (let v = 0; v < L; v += 3) {
      for (const side of [-1, 1] as const) {
        const vv = side < 0 ? v : v + 1.5;
        if (vv >= L - 0.5) continue;
        if (side < 0 && vv >= rv && vv < rv + 3) continue;
        if (side > 0 && vv >= iv && vv < iv + 2) continue;
        const um = side < 0 ? c0 * CELL + WALL_T / 2 + 0.14 : c1 * CELL - WALL_T / 2 - 0.14;
        const r = lm.rng.float();
        const stt: LightStateId = buzz-- === 0 ? LightState.BUZZ : r < 0.15 ? LightState.OFF : LightState.ON;
        fixture(lm, FixtureKind.CAGE_BULB, um, (vv + 0.5) * CELL, 1.85, [-side, 0, 0], [0, 1], warm, 110, stt, { shape: 1, w: 0.12, h: 0.12, hum: 0.2 });
      }
    }
    // a runner of stains down the carpet
    for (let k = 0; k < 4; k++) {
      floorDecal(lm, (c0 + 1) * CELL + lm.rng.range(-0.5, 0.5), lm.rng.range(1, L * CELL - 1), 0,
        { kind: k & 1 ? DecalKind.WATER_STAIN : DecalKind.SCUFF, sign: false, rot: lm.rng.range(0, 6.28), w: 1.2, h: 0.8, alpha: 0.4 });
    }

    // the open room: bed (mattress on a base), television on a dresser, a lamp left on, curtains glowing
    const rvm = rv * CELL;
    box(lm, WALL_T / 2, rvm + 0.48, WALL_T / 2 + 2.0, rvm + 1.52, 0, 0.32, Mat.WOOD, SOLID_F);
    prop(lm, PropKind.MATTRESS, WALL_T / 2 + 1.0, rvm + 1.0, 0.32, 1, 0, lm.rng.int(0, 2), undefined, lm.rng.range(-0.05, 0.05));
    box(lm, WALL_T / 2, rvm + 1.85, WALL_T / 2 + 0.45, rvm + 2.3, 0, 0.55, Mat.WOOD, SOLID_F); // nightstand
    fixture(lm, FixtureKind.CAGE_BULB, WALL_T / 2 + 0.22, rvm + 2.07, 0.95, DOWN, [1, 0], kelvinToLinearRGB(2400, 0), 90, LightState.ON, { shape: 1, w: 0.14, h: 0.14, hum: 0.1 });
    box(lm, WALL_T / 2 + 0.2, rvm + 2.05, WALL_T / 2 + 0.24, rvm + 2.09, 0.55, 0.9, Mat.METAL_PAINTED, THIN_F);
    box(lm, 1.3, (rv + 3) * CELL - WALL_T / 2 - 0.5, 2.9, (rv + 3) * CELL - WALL_T / 2, 0, 0.75, Mat.WOOD, SOLID_F); // dresser
    prop(lm, PropKind.CRT_MONITOR, 2.1, (rv + 3) * CELL - WALL_T / 2 - 0.25, 0.75, 0, -1, 0);
    // curtains on the back wall: a warm window glow behind vertical folds
    glowPanel(lm, WALL_T / 2 + 0.005, rvm + 2.9, 1.45, 1, 0, 0.95, 1.3, 220, kelvinToLinearRGB(2900, 0));
    for (let k = 0; k < 7; k++) box(lm, WALL_T / 2 + 0.04 + (k & 1) * 0.03, rvm + 2.4 + k * 0.15, WALL_T / 2 + 0.07 + (k & 1) * 0.03, rvm + 2.47 + k * 0.15, 0.7, 2.25, Mat.FABRIC_PARTITION, THIN_F);
    prop(lm, PropKind.BACKPACK, 2.4, rvm + 0.5, 0, 0, 1, 0, undefined, lm.rng.range(0, 6.28));

    // the ice machine alcove
    const im = (iv + 1) * CELL;
    prop(lm, PropKind.VENDING_MACHINE, c1 * CELL + 1.9, im, 0, -1, 0, lm.rng.int(0, 3));
    fixture(lm, FixtureKind.VENDING, c1 * CELL + 1.9 - 0.405, im, VENDING_PANEL.y, [-1, 0, 0], [0, 1], kelvinToLinearRGB(6500, 0.01), VENDING_PANEL.luminance * 0.7,
      LightState.BUZZ, { shape: 0, w: VENDING_PANEL.w, h: VENDING_PANEL.h, hum: 0.6 });
    emitter(lm, EmitterKind.MACHINE, c1 * CELL + 1.8, im, 0.6, 0.35);
    emitter(lm, EmitterKind.RADIO, 1.5, rvm + 1.8, 1.0, 0.15); // a television murmur from the open room
    return { entrances: lm.entrances };
  },
};
