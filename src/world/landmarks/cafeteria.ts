// src/world/landmarks/cafeteria.ts — CAFETERIA (storeys 0, 1; 14x12, R2 B4): a staff canteen left mid-shift. Long
// tables in two columns with stacking chairs pushed in, pulled out or knocked over; a steel serving counter with a
// tray rail and a sneeze guard along one wall under a lower bulkhead; a vending machine and bins by the door; a grid of
// troffers with a dead patch over the far tables. Vinyl floor, scuffed in the aisles.
//
// Frame: u across (14 cells), v along (12 cells). Doors in the v = 0 wall; the counter along the v = L wall.

import { CELL, WALL_T } from '../../core/constants.ts';
import { DecalKind, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey } from '../../core/index.ts';
import type { LightStateId } from '../../core/index.ts';
import { PROP_DEFS } from '../../core/props.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { defaultPropFlags } from '../content/props.ts';
import { VENDING_PANEL } from './vendingAlcove.ts';
import { ageCeiling, begin, box, claim, DOWN, emitter, fixture, floorDecal, opening, prop, SOLID_F, storeyStyle, THIN_F, troffer } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const W = 14, L = 12;
const CEIL = 3.0;
export const CAFETERIA = { tableCols: [4.4, 11.8] as const, tableRows: [3.2, 5.6, 8.0] as const, counterD: 0.85 } as const;

export const cafeteria: LandmarkGenerator = {
  kind: LandmarkKind.CAFETERIA, storeys: [Storey.LOBBY, Storey.SUBLEVEL], weight: 1, footprint: [W, L],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const deep = ctx.key.s === Storey.SUBLEVEL;
    const st = storeyStyle(ctx.key.s, CEIL * 100, { floorMat: Mat.VINYL_VCT, ...(deep ? {} : { wallMat: Mat.DRYWALL }) });
    claim(lm, st);
    const wallMat = st.wallMat;
    const trim = deep ? 0 : EdgeTrim.BASEBOARD;
    // doors: a double header near one end of the front wall, a single door in each side wall
    const d0 = lm.rng.chance(0.5) ? 2 : W - 4;
    opening(lm, d0, 0, 0, -1, EdgeKind.HEADER, wallMat, trim, 225);
    opening(lm, d0 + 1, 0, 0, -1, EdgeKind.HEADER, wallMat, trim, 225);
    opening(lm, 0, lm.rng.int(3, 6), -1, 0, EdgeKind.DOORWAY, wallMat, deep ? 0 : EdgeTrim.CASING, 210);
    opening(lm, W - 1, lm.rng.int(3, 6), 1, 0, EdgeKind.DOORWAY, wallMat, deep ? 0 : EdgeTrim.CASING, 210);

    // the serving line: steel counter + tray rail + sneeze guard, a back counter against the wall
    const back = L * CELL - WALL_T / 2;
    const cu0 = 2.4, cu1 = W * CELL - 2.4;
    const cv1 = back - 1.5, cv0 = cv1 - CAFETERIA.counterD;
    const steel = Mat.METAL_PAINTED;
    box(lm, cu0, cv0, cu1, cv1, 0, 0.9, steel, SOLID_F);
    box(lm, cu0, cv0 - 0.28, cu1, cv0, 0.82, 0.86, steel, THIN_F); // tray rail
    for (let um = cu0 + 0.2; um < cu1; um += 1.6) box(lm, um, cv0 - 0.26, um + 0.03, cv0 - 0.02, 0, 0.82, steel, THIN_F);
    box(lm, cu0, cv0 + 0.28, cu1, cv0 + 0.3, 1.18, 1.22, steel, THIN_F); // sneeze-guard top rail
    for (let um = cu0 + 0.1; um < cu1; um += 1.2) box(lm, um, cv0 + 0.28, um + 0.02, cv0 + 0.3, 0.9, 1.18, steel, THIN_F);
    box(lm, 1.0, back - 0.7, W * CELL - 1.0, back, 0, 0.92, steel, SOLID_F); // back counter
    box(lm, 1.0, back - 0.35, W * CELL - 1.0, back, 1.4, 2.0, steel, SOLID_F); // shelf / hood run
    // pans in the wells (dark rectangles), trays stacked at the start of the line
    for (let um = cu0 + 0.5; um + 0.6 < cu1 - 0.3; um += 0.8) box(lm, um, cv0 + 0.18, um + 0.6, cv1 - 0.18, 0.9, 0.905, Mat.RUBBER, THIN_F);
    box(lm, cu0 + 0.1, cv0 - 0.25, cu0 + 0.55, cv0 - 0.02, 0.86, 1.02, Mat.PLASTIC, THIN_F);
    // warm heat-lamp strip under the shelf over the back counter
    const lamp = kelvinToLinearRGB(2400, 0);
    for (let k = 0; k < 3; k++) {
      fixture(lm, FixtureKind.TUBE_STRIP, cu0 + 1.2 + k * ((cu1 - cu0 - 2.4) / 2), back - 0.2, 1.38, DOWN, [1, 0], lamp, 2600, k === 1 ? LightState.DYING : LightState.ON, { hum: 0.3 });
    }

    // tables: 3 rows x 2 columns of long tables; chairs on both sides
    const chair = PROP_DEFS[PropKind.CHAIR_STACKING].size;
    for (const vm of CAFETERIA.tableRows) {
      for (const um of CAFETERIA.tableCols) {
        prop(lm, PropKind.CONFERENCE_TABLE, um, vm, 0, 0, 1, lm.rng.int(0, 3), undefined, lm.rng.range(-0.03, 0.03));
        for (const side of [-1, 1]) {
          for (let k = 0; k < 4; k++) {
            const r = lm.rng.float();
            if (r < 0.12) continue; // missing chair
            const cu = um - 1.1 + k * 0.73 + lm.rng.range(-0.06, 0.06);
            const out = r < 0.7 ? 0.35 : 0.75; // pushed in / pulled out
            const cv = vm + side * (0.6 + out - chair[2] / 2 + 0.1);
            prop(lm, PropKind.CHAIR_STACKING, cu, cv, 0, 0, -side, 0, undefined, lm.rng.range(-0.25, 0.25) + (r > 0.93 ? 1.3 : 0));
          }
        }
        if (lm.rng.chance(0.3)) prop(lm, PropKind.TRASH_CAN, um + 1.3, vm, 0.75, 0, 1, lm.rng.int(0, 3)); // a bin left on the table
      }
    }
    // by the door: a vending machine (its lit panel), bins, a stack of chairs
    const vu = d0 < W / 2 ? W * CELL - 1.6 : 1.6;
    const vmBack = WALT;
    prop(lm, PropKind.VENDING_MACHINE, vu, vmBack + 0.4, 0, 0, 1, lm.rng.int(0, 3));
    fixture(lm, FixtureKind.VENDING, vu, vmBack + 0.805, VENDING_PANEL.y, [0, 0, 1], [1, 0], kelvinToLinearRGB(6500, 0.01), VENDING_PANEL.luminance,
      lm.rng.chance(0.2) ? LightState.OFF : LightState.BUZZ, { shape: 0, w: VENDING_PANEL.w, h: VENDING_PANEL.h, hum: 0.5 });
    prop(lm, PropKind.TRASH_CAN, vu + (d0 < W / 2 ? -0.9 : 0.9), 0.4, 0, 0, 1, lm.rng.int(0, 3));
    const [sx, sz] = lm.f.point(d0 < W / 2 ? W * CELL - 0.5 : 0.5, 6.5 * CELL);
    const yaw = lm.f.yaw(d0 < W / 2 ? -1 : 1, 0);
    for (let k = 0; k < 7; k++) {
      lm.g.addProp({ kind: PropKind.CHAIR_STACKING, variant: 0, x: sx, y: k * 0.085, z: sz, yaw, scale: 1, flags: k === 0 ? defaultPropFlags(PropKind.CHAIR_STACKING) : 0, seed: lm.rng.next() });
    }

    // ceiling: troffer grid, a dead patch over the far tables
    const col = kelvinToLinearRGB(4100, 0.03);
    const deadCol = lm.rng.int(0, 1);
    for (let v = 1; v < L - 2; v += 2) for (let u = 1; u < W - 1; u += 3) {
      const far = v >= 5 && (u < W / 2) === (deadCol === 0);
      const r = lm.rng.float();
      const stt: LightStateId = far ? (r < 0.6 ? LightState.OFF : LightState.DYING) : r < 0.08 ? LightState.OFF : LightState.ON;
      if (deep) fixture(lm, FixtureKind.TUBE_STRIP, (u + 0.5) * CELL, (v + 0.5) * CELL, CEIL - 0.05, DOWN, [1, 0], col, 8600, stt);
      else troffer(lm, u * CELL + 0.3, v * CELL, CEIL, col, 3300, stt, true);
    }
    if (!deep) ageCeiling(lm, 0.14, 0.03, 0.015);
    // scuffed aisles, a spill by the counter
    for (let k = 0; k < 5; k++) {
      floorDecal(lm, lm.rng.range(1.5, W * CELL - 1.5), lm.rng.range(1.5, cv0 - 0.8), 0, { kind: DecalKind.SCUFF, sign: false, rot: lm.rng.range(0, 6.28), w: 1.4, h: 0.7, alpha: 0.4 });
    }
    floorDecal(lm, lm.rng.range(cu0 + 1, cu1 - 1), cv0 - 0.7, 0, { kind: DecalKind.WATER_STAIN, sign: false, rot: lm.rng.range(0, 6.28), w: 1.0, h: 0.7, alpha: 0.5 });
    emitter(lm, EmitterKind.MACHINE, vu, 0.8, 1.0, 0.25);
    emitter(lm, EmitterKind.BUZZ, (W / 2) * CELL, back - 0.3, 1.4, 0.2);
    return { entrances: lm.entrances };
  },
};

const WALT = WALL_T / 2 + 0.01;
