// src/world/landmarks/chapel.ts — CHAPEL (storey 0; 10x16, R2 B4): a windowless office chapel. Two blocks of wooden
// pews face a raised dais at the far end, where a tall narrow window glows amber over a plain table; the aisle carpet
// is worn to the backing. The only other light is a row of dim pendants down the nave, one of them dead.
//
// Frame: u across (10 cells), v along (16 cells). Entrance: a double doorway at the aisle on the v = 0 wall and a
// side door; dais over v 13..16 (a WALKABLE_TOP box, 30 cm); the window on the v = L wall.

import { CELL, WALL_T } from '../../core/constants.ts';
import { CeilKind, DecalKind, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, box, cells, claim, DOWN, emitter, fixture, floorDecal, glowPanel, opening, prop, ramp, SOLID_F, THIN_F, WALK_F } from './common.ts';
import type { Lm } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const W = 10, L = 16;
const CEIL = 6.0;
export const CHAPEL = { aisle: [4, 6] as const, pewRows: 9, pewV0: 2.2, pewPitch: 1.05, daisV: 13, daisH: 0.3 } as const;

/** A pew: seat, backrest and two end panels, from um0 to um1 at row line vm (facing +v). */
function pew(lm: Lm, um0: number, um1: number, vm: number): void {
  const wood = Mat.WOOD;
  box(lm, um0, vm - 0.22, um1, vm + 0.2, 0.42, 0.47, wood, SOLID_F); // seat
  box(lm, um0, vm - 0.28, um1, vm - 0.22, 0.47, 0.95, wood, THIN_F); // back
  box(lm, um0, vm - 0.3, um0 + 0.05, vm + 0.22, 0, 0.98, wood, THIN_F); // ends
  box(lm, um1 - 0.05, vm - 0.3, um1, vm + 0.22, 0, 0.98, wood, THIN_F);
  box(lm, um0, vm - 0.26, um1, vm - 0.22, 0.12, 0.2, wood, THIN_F); // kneeler rail of the row behind
}

export const chapel: LandmarkGenerator = {
  kind: LandmarkKind.CHAPEL, storeys: [Storey.LOBBY], weight: 0.9, footprint: [W, L],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const wallMat = Mat.WALLPAPER_MANILA;
    claim(lm, { floorMat: Mat.CARPET_OFFICE, wallMat, ceilMat: Mat.CEILING_TILE, ceilKind: CeilKind.TILES, ceilCm: CEIL * 100, baseboard: true });
    const C = CHAPEL;
    const [a0, a1] = C.aisle;
    cells(lm, a0, 0, a1, C.daisV, { floorMat: Mat.CARPET_L0 }); // the aisle runner
    opening(lm, a0, 0, 0, -1, EdgeKind.DOORWAY, wallMat, EdgeTrim.CASING, 230);
    opening(lm, a0 + 1, 0, 0, -1, EdgeKind.DOORWAY, wallMat, EdgeTrim.CASING, 230);
    const west = lm.rng.chance(0.5);
    opening(lm, west ? 0 : W - 1, lm.rng.int(2, 5), west ? -1 : 1, 0, EdgeKind.DOORWAY, wallMat, EdgeTrim.CASING, 210);

    // pews: two blocks either side of the aisle
    const iu0 = WALL_T / 2 + 0.9, iu1 = a0 * CELL - 0.35, ju0 = a1 * CELL + 0.35, ju1 = W * CELL - WALL_T / 2 - 0.9;
    for (let r = 0; r < C.pewRows; r++) {
      const vm = C.pewV0 + r * C.pewPitch + 0.9;
      if (!(r === 6 && lm.rng.chance(0.5))) pew(lm, iu0, iu1, vm);
      if (!(r === 3 && lm.rng.chance(0.5))) pew(lm, ju0, ju1, vm);
    }
    // the dais: a 30 cm platform across the far end with a two-step ramp at the aisle
    const dv = C.daisV * CELL, back = L * CELL - WALL_T / 2;
    box(lm, WALL_T / 2, dv, W * CELL - WALL_T / 2, back, 0, C.daisH, Mat.WOOD, WALK_F);
    ramp(lm, a0 * CELL, dv - 0.6, a1 * CELL, dv, 0, 1, 0, C.daisH, 2, Mat.CARPET_L0, true);
    const mid = (W / 2) * CELL;
    box(lm, mid - 0.9, back - 1.6, mid + 0.9, back - 0.95, C.daisH, C.daisH + 0.95, Mat.WOOD, SOLID_F); // the table
    box(lm, mid - 0.95, back - 1.62, mid + 0.95, back - 0.93, C.daisH + 0.95, C.daisH + 0.99, Mat.FABRIC_PARTITION, THIN_F); // cloth
    for (const du of [-0.55, 0.55]) {
      box(lm, mid + du - 0.03, back - 1.3, mid + du + 0.03, back - 1.24, C.daisH + 0.99, C.daisH + 1.3, Mat.METAL_PAINTED, THIN_F); // candlesticks
      // electric candles: small warm bulbs standing on the sticks (socket down into the stick)
      fixture(lm, FixtureKind.CAGE_BULB, mid + du, back - 1.27, C.daisH + 1.36, [0, 1, 0], [1, 0], kelvinToLinearRGB(2000, 0), 45, LightState.ON, { shape: 1, w: 0.05, h: 0.05, hum: 0 });
    }
    // the window: a tall narrow amber panel on the back wall, mullions across it
    const wy = C.daisH + 2.9;
    glowPanel(lm, mid, back - 0.005, wy, 0, -1, 1.1, 3.2, 700, kelvinToLinearRGB(2300, 0));
    for (const y of [wy - 0.8, wy, wy + 0.8]) box(lm, mid - 0.55, back - 0.05, mid + 0.55, back - 0.01, y - 0.03, y + 0.03, Mat.METAL_PAINTED, THIN_F);
    box(lm, mid - 0.03, back - 0.05, mid + 0.03, back - 0.01, wy - 1.6, wy + 1.6, Mat.METAL_PAINTED, THIN_F);
    box(lm, mid - 0.62, back - 0.08, mid + 0.62, back - 0.01, wy - 1.72, wy - 1.6, Mat.WOOD, THIN_F); // sill
    box(lm, mid - 0.62, back - 0.08, mid + 0.62, back - 0.01, wy + 1.6, wy + 1.72, Mat.WOOD, THIN_F);
    // pendants down the nave (dim, warm), one dead; two small lamps on the side walls of the dais
    const warm = kelvinToLinearRGB(2700, 0.005);
    const dead = lm.rng.int(0, 3);
    for (let k = 0; k < 4; k++) {
      fixture(lm, FixtureKind.PENDANT_LINEAR, mid, 3.2 + k * 3.4, 3.4, DOWN, [0, 1], warm, 6000, k === dead ? LightState.OFF : LightState.ON, { hum: 0.2 });
    }
    // wall sconces down both sides of the nave, warm and low
    for (const [um, du] of [[WALL_T / 2 + 0.14, 1], [W * CELL - WALL_T / 2 - 0.14, -1]] as [number, number][]) {
      for (let vm = 2.4; vm < dv + 1.5; vm += 3.3) {
        fixture(lm, FixtureKind.CAGE_BULB, um, vm, 2.4, [du, 0, 0], [0, 1], warm, 120, LightState.ON, { shape: 1, w: 0.12, h: 0.12, hum: 0.1 });
      }
    }
    // worn aisle, a hymn book (paper) dropped, a lone chair turned toward the wall
    for (let k = 0; k < 3; k++) {
      floorDecal(lm, mid + lm.rng.range(-0.3, 0.3), 2.0 + k * 3.0, 0, { kind: DecalKind.SCUFF, sign: false, rot: lm.f.yaw(0, 1), w: 0.8, h: 2.0, alpha: 0.45 });
    }
    floorDecal(lm, mid + 0.4, 6.0 * CELL, 0, { kind: DecalKind.PAPER, sign: false, rot: lm.rng.range(0, 6.28), w: 0.3, h: 0.22, alpha: 0.9 });
    prop(lm, PropKind.CHAIR_STACKING, west ? W * CELL - 0.5 : 0.5, 1.0, 0, west ? 1 : -1, 0, 0, undefined, lm.rng.range(-0.2, 0.2));
    emitter(lm, EmitterKind.BUZZ, mid, back - 0.4, wy, 0.12);
    return { entrances: lm.entrances };
  },
};
