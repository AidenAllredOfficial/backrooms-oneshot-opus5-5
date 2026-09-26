// src/world/heroRooms/executiveSuite.ts — EXECUTIVE_SUITE hero (OFFICE; 10x8, R2 B4): the corner office. Wood panelled
// walls, deep carpet, a wide desk with a leather chair and two visitors' chairs, a conference table with six chairs,
// a row of filing cabinets and a water cooler. Behind the desk a window wall of daylight seen through half-closed
// blinds: the only daylight on Level 0, and it is not real.
//
// Frame: u across (10 cells), v along (8 cells). Door in the v = 0 wall; the window on the v = L wall behind the desk.

import { CELL, WALL_T } from '../../core/constants.ts';
import { CeilKind, DecalKind, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey, Zone } from '../../core/index.ts';
import type { ZoneId } from '../../core/index.ts';
import { PROP_DEFS } from '../../core/props.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, box, cells, claim, DOWN, emitter, fixture, glowPanel, opening, prop, THIN_F, troffer, wallDecal } from '../landmarks/common.ts';
import type { LandmarkGenerator } from '../landmarks/index.ts';

const W = 10, L = 8;
const CEIL = 3.0;
export const EXECUTIVE_SUITE = { window: { w: 4.4, y0: 0.9, y1: 2.5 }, slatPitch: 0.09 } as const;

export const executiveSuite: LandmarkGenerator = {
  kind: LandmarkKind.EXECUTIVE_SUITE, storeys: [Storey.LOBBY], weight: 1, footprint: [W, L], heroOnly: true,
  hero: [Zone.OFFICE] as readonly ZoneId[],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const wallMat = Mat.WOOD;
    claim(lm, { floorMat: Mat.CARPET_OFFICE, wallMat, ceilMat: Mat.CEILING_TILE, ceilKind: CeilKind.TILES, ceilCm: CEIL * 100, baseboard: true, trimMat: Mat.WOOD });
    const door = lm.rng.int(1, 2);
    opening(lm, door, 0, 0, -1, EdgeKind.DOORWAY, wallMat, EdgeTrim.CASING, 215);
    opening(lm, 0, lm.rng.int(2, 5), -1, 0, EdgeKind.DOORWAY, wallMat, EdgeTrim.CASING, 215);
    const back = L * CELL - WALL_T / 2;
    // a rug under the desk area
    cells(lm, 5, 4, 9, 7, { floorMat: Mat.CARPET_L0 });

    // the window wall: daylight glow + blinds (slats) + frame
    const X = EXECUTIVE_SUITE.window;
    const wc = 8.0; // window centre along u, behind the desk
    const wy = (X.y0 + X.y1) / 2;
    glowPanel(lm, wc, back - 0.004, wy, 0, -1, X.w, X.y1 - X.y0, 1800, kelvinToLinearRGB(7000, 0));
    for (let y = X.y0 + 0.05; y < X.y1; y += EXECUTIVE_SUITE.slatPitch) {
      box(lm, wc - X.w / 2, back - 0.07, wc + X.w / 2, back - 0.02, y, y + 0.012, Mat.PLASTIC, THIN_F);
    }
    for (const du of [-X.w / 2, -X.w / 6, X.w / 6, X.w / 2]) box(lm, wc + du - 0.04, back - 0.09, wc + du + 0.04, back, X.y0 - 0.05, X.y1 + 0.05, Mat.METAL_PAINTED, THIN_F);
    box(lm, wc - X.w / 2 - 0.04, back - 0.12, wc + X.w / 2 + 0.04, back, X.y0 - 0.08, X.y0 - 0.02, Mat.WOOD, THIN_F); // sill
    box(lm, wc - X.w / 2 - 0.04, back - 0.12, wc + X.w / 2 + 0.04, back, X.y1 + 0.02, X.y1 + 0.14, Mat.WOOD, THIN_F); // head box
    // the daylight actually entering: a row of cool panels over the window strip (a light shelf)
    for (let k = 0; k < 3; k++) {
      fixture(lm, FixtureKind.TUBE_STRIP, wc - 1.4 + k * 1.4, back - 0.25, X.y1 + 0.2, DOWN, [1, 0], kelvinToLinearRGB(6800, 0), 5200, LightState.ON, { hum: 0.05 });
    }

    // the desk (wide), the chair behind it, two visitors' chairs, a phone and a monitor
    const desk = PROP_DEFS[PropKind.DESK].size;
    const dv = back - 1.4;
    const dp = prop(lm, PropKind.DESK, wc, dv, 0, 0, -1, 0);
    dp.scale = 1.25;
    prop(lm, PropKind.OFFICE_CHAIR, wc + lm.rng.range(-0.2, 0.2), dv + desk[2] * 0.62 + 0.25, 0, 0, -1, lm.rng.int(0, 3), undefined, lm.rng.range(-0.4, 0.4));
    for (const du of [-0.55, 0.55]) prop(lm, PropKind.CHAIR_STACKING, wc + du, dv - desk[2] * 0.62 - 0.55, 0, 0, 1, 0, undefined, lm.rng.range(-0.2, 0.2));
    prop(lm, PropKind.PHONE, wc - 0.55, dv, 0.75 * 1.25, 0, -1, 0);
    prop(lm, PropKind.CRT_MONITOR, wc + 0.45, dv + 0.1, 0.75 * 1.25, 0, -1, 0, undefined, lm.rng.range(-0.3, 0.1));
    // the conference table and six chairs toward the door side
    const tv = 2.6 * CELL, tu = 3.2 * CELL;
    prop(lm, PropKind.CONFERENCE_TABLE, tu, tv, 0, 1, 0, 0);
    for (const side of [-1, 1]) for (let k = -1; k <= 1; k++) {
      prop(lm, PropKind.OFFICE_CHAIR, tu + side * 0.95, tv + k * 0.95, 0, -side, 0, lm.rng.int(0, 3), undefined, lm.rng.range(-0.35, 0.35));
    }
    // filing cabinets along the u = W wall, a water cooler, a framed poster, a pendant over the table
    const fu = W * CELL - WALL_T / 2 - 0.32;
    for (let k = 0; k < 4; k++) prop(lm, PropKind.FILING_CABINET, fu, 1.2 + k * 0.5, 0, -1, 0, lm.rng.int(0, 3));
    prop(lm, PropKind.WATER_COOLER, WALL_T / 2 + 0.2, back - 0.35, 0, 1, 0, 0);
    wallDecal(lm, 0, 5, -1, 5, 0.5, 1.6, { kind: DecalKind.POSTER, sign: false, rot: 0, w: 0.9, h: 0.65, alpha: 0.95 });
    fixture(lm, FixtureKind.PENDANT_LINEAR, tu, tv, 2.2, DOWN, [0, 1], kelvinToLinearRGB(3000, 0), 3200, LightState.ON, { hum: 0.2 });
    const col = kelvinToLinearRGB(3500, 0.02);
    troffer(lm, 6 * CELL + 0.3, 3 * CELL, CEIL, col, 2600, LightState.ON);
    troffer(lm, 1 * CELL + 0.3, 5 * CELL, CEIL, col, 2600, LightState.OFF);
    emitter(lm, EmitterKind.VENT, wc, back - 0.5, CEIL - 0.2, 0.2);
    return { entrances: lm.entrances };
  },
};
