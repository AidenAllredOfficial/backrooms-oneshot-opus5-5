// src/world/landmarks/loadingDock.ts — LOADING_DOCK (storey 1, 14x10): a tall concrete hall with two roll-up
// openings (HEADER + ROLLUP trim) in one wall, a truck well 1.2 m below the platform behind a HALF parapet with a
// ramp down at one end, PALLET / CRATE clusters and orange SODIUM lights (WP4).
//
// Frame: u along the dock (14 cells), v across (10 cells).
//   v 0-3  the well, floor -120 (wheel stops against the v = 0 wall); u = 13, v 1-3 the ramp lane (-1.2 -> 0 m)
//   v 4-9  the platform, floor 0; the roll-up openings are on the v = 10 wall at u 2-4 and 9-11
//   line v = 4: OPEN lip with a pipe-and-post guard rail (105 cm, see-through: R2) for u 0-12; line u = 13 (v 1-3): HALF wall beside the ramp lane
// R2 (B4): the well reads from the entrances: a see-through guard rail with yellow bollards instead of the parapet,
// dock levelers and rubber bumpers at two berths, two big closed roll-up doors in the well's back wall with daylight
// leaking under them and a red / green signal lamp each, and the entrance roll-ups hang half lowered.

import { CELL, WALL_T } from '../../core/constants.ts';
import {
  CeilKind, DECAL_PAINT_STRIPE, DecalKind, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey, Zone,
} from '../../core/index.ts';
import type { LightStateId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, box, cells, claim, DOWN, emitter, fixture, floorDecal, glowPanel, handrail, opening, OVERHEAD, pipeF, prop, ramp, SOLID_F, THIN_F, WALK_F } from './common.ts';
import type { Lm } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const W = 14, L = 10;
const CEIL = 6.0;
export const LOADING_DOCK = { wellV: 4, wellCm: -120, rampU: 13, rollups: [[2, 5], [9, 12]] as const, headerCm: 300, parapetCm: 105 } as const;

/** Two truck berths in the well: dock levelers on the platform lip, rubber bumpers on the well wall, yellow bollards
 * along the rail, and a big closed roll-up door opposite each berth with daylight leaking under it and a signal lamp. */
function dockBerths(lm: Lm): void {
  const D = LOADING_DOCK;
  const wy = D.wellCm / 100;
  const lip = D.wellV * CELL;
  const day = kelvinToLinearRGB(6500, 0);
  for (const uc of [3.5 * CELL, 9.5 * CELL]) {
    // leveler plate and bumpers
    box(lm, uc - 1.0, lip, uc + 1.0, lip + 1.8, -0.01, 0.012, Mat.METAL_DECK, WALK_F);
    for (const du of [-1.25, 1.25]) box(lm, uc + du - 0.13, lip - 0.12, uc + du + 0.13, lip, wy + 0.55, wy + 1.05, Mat.RUBBER, SOLID_F);
    // the roll-up door in the well's back wall (v = 0): a ribbed curtain in a steel frame, closed
    const face = WALL_T / 2;
    const w = 3.2, h = 3.3;
    box(lm, uc - w / 2 - 0.12, face, uc + w / 2 + 0.12, face + 0.12, wy, wy + h + 0.25, Mat.METAL_PAINTED, THIN_F);
    box(lm, uc - w / 2, face, uc + w / 2, face + 0.06, wy + 0.04, wy + h, Mat.METAL_PAINTED, THIN_F);
    for (let y = wy + 0.2; y < wy + h; y += 0.18) box(lm, uc - w / 2, face + 0.06, uc + w / 2, face + 0.075, y, y + 0.025, Mat.METAL_RUST, THIN_F);
    box(lm, uc - w / 2 - 0.1, face, uc + w / 2 + 0.1, face + 0.45, wy + h, wy + h + 0.45, Mat.METAL_PAINTED, THIN_F); // coil box
    glowPanel(lm, uc, face + 0.08, wy + 0.025, 0, 1, w - 0.1, 0.04, 2500, day); // daylight under the door
    // signal lamp beside the door: red (a truck is expected) or green
    const red = lm.rng.chance(0.6);
    glowPanel(lm, uc + w / 2 + 0.35, face + 0.01, wy + 2.2, 0, 1, 0.09, 0.09, 260, red ? [1, 0.06, 0.03] : [0.1, 1, 0.2]);
    box(lm, uc + w / 2 + 0.26, face, uc + w / 2 + 0.44, face + 0.008, wy + 2.1, wy + 2.4, Mat.RUBBER, THIN_F);
    // yellow bollards along the lip either side of the berth
    for (const du of [-1.6, 1.6]) {
      pipeF(lm, uc + du, lip + 0.35, 0, uc + du, lip + 0.35, 1.05, 0.08, Mat.FLOOR_PAINT, SOLID_F);
    }
  }
}

/** A pallet, optionally with a crate or a stack of boxes on it. */
function palletStack(lm: Lm, um: number, vm: number, y: number, load: number): void {
  const du = lm.rng.chance(0.5) ? 1 : 0;
  const p = prop(lm, PropKind.PALLET, um, vm, y, du, 1 - du, lm.rng.int(0, 3), undefined, lm.rng.range(-0.06, 0.06));
  if (load === 1) prop(lm, PropKind.CRATE, um + lm.rng.range(-0.05, 0.05), vm + lm.rng.range(-0.05, 0.05), y + 0.15, du, 1 - du, lm.rng.int(0, 3), undefined, lm.rng.range(-0.1, 0.1));
  else if (load === 2) {
    for (let k = 0; k < 4; k++) {
      const [ox, oz] = [(k & 1) ? 0.26 : -0.26, (k & 2) ? 0.21 : -0.21];
      lm.g.addProp({ kind: PropKind.CARDBOARD_BOX, variant: lm.rng.int(0, 3), x: p.x + ox, y: y + 0.15, z: p.z + oz, yaw: p.yaw, scale: 1, flags: 0, seed: lm.rng.next() });
    }
  }
}

export const loadingDock: LandmarkGenerator = {
  kind: LandmarkKind.LOADING_DOCK, storeys: [Storey.SUBLEVEL], weight: 1, footprint: [W, L],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const wallMat = Mat.CONCRETE_WALL;
    claim(lm, { floorMat: Mat.CONCRETE_FLOOR, wallMat, ceilMat: Mat.CONCRETE_CEIL, ceilKind: CeilKind.CONCRETE, ceilCm: CEIL * 100, trimMat: Mat.METAL_PAINTED, zone: Zone.WAREHOUSE });
    const D = LOADING_DOCK;
    // the well and the ramp lane
    cells(lm, 0, 0, W, D.wellV, { floorCm: D.wellCm });
    ramp(lm, D.rampU * CELL, 1 * CELL, W * CELL, D.wellV * CELL, 0, 1, D.wellCm / 100, 0, 0, Mat.CONCRETE_FLOOR, true);
    for (let u = 0; u < D.rampU; u++) {
      lm.f.setEdge(g, u, D.wellV - 1, u, D.wellV, EdgeKind.OPEN, wallMat, wallMat, { trim: 0 });
    }
    // a see-through guard rail along the lip (gaps at the two berths for the levelers)
    const lipV = D.wellV * CELL + 0.06;
    for (const [a, b] of [[0.1, 3.5 * CELL - 1.05], [3.5 * CELL + 1.05, 9.5 * CELL - 1.05], [9.5 * CELL + 1.05, D.rampU * CELL - 0.05]] as [number, number][]) {
      handrail(lm, a, lipV, 0, b, lipV, 0, Mat.METAL_PAINTED, D.parapetCm / 100, Math.max(1, Math.round((b - a) / 1.5)));
    }
    for (const uc of [3.5 * CELL, 9.5 * CELL]) {
      // a chain across each berth opening
      box(lm, uc - 1.05, lipV - 0.01, uc + 1.05, lipV + 0.01, 0.78, 0.8, Mat.METAL_RUST, THIN_F);
    }
    dockBerths(lm);
    for (let v = 1; v < D.wellV; v++) {
      lm.f.setEdge(g, D.rampU - 1, v, D.rampU, v, EdgeKind.HALF, wallMat, wallMat, { hA: D.parapetCm, trim: 0 });
    }
    // two roll-up openings on the v = L wall
    for (const [u0, u1] of D.rollups) {
      for (let u = u0; u < u1; u++) opening(lm, u, L - 1, 0, 1, EdgeKind.HEADER, wallMat, EdgeTrim.ROLLUP, D.headerCm);
      // the curtain, stuck half way (above head height; no collision)
      const back = L * CELL - WALL_T / 2;
      box(lm, u0 * CELL, back - 0.04, u1 * CELL, back + 0.04, 2.35, D.headerCm / 100, Mat.METAL_PAINTED, OVERHEAD);
      for (let y = 2.45; y < D.headerCm / 100; y += 0.16) box(lm, u0 * CELL, back - 0.055, u1 * CELL, back - 0.04, y, y + 0.02, Mat.METAL_RUST, OVERHEAD);
    }
    // yellow safety stripe along the platform lip; wheel stops and oil in the well
    floorDecal(lm, (D.rampU / 2) * CELL, D.wellV * CELL + 0.2, 0, { kind: DECAL_PAINT_STRIPE, sign: false, rot: lm.f.yaw(1, 0), w: 0.12, h: D.rampU * CELL - 0.3, alpha: 0.85 });
    for (const um of [3.5 * CELL, 9.5 * CELL]) {
      prop(lm, PropKind.WHEEL_STOP, um, 0.075 + 0.9, D.wellCm / 100, 0, 1, lm.rng.int(0, 3));
      floorDecal(lm, um + lm.rng.range(-0.4, 0.4), 2.2 * CELL, D.wellCm / 100, { kind: DecalKind.OIL, sign: false, rot: lm.rng.range(0, 6.28), w: 1.1, h: 0.8, alpha: 0.7 });
    }
    // pallet / crate clusters: on the platform (clear of the roll-up approaches) and one in the well
    const spots: [number, number][] = [[1.3 * CELL, 6.2 * CELL], [2.5 * CELL, 6.2 * CELL], [6.5 * CELL, 7.9 * CELL], [7.6 * CELL, 7.9 * CELL], [12.4 * CELL, 5.6 * CELL]];
    for (const [um, vm] of spots) if (lm.rng.chance(0.8)) palletStack(lm, um, vm, 0, lm.rng.int(0, 2));
    palletStack(lm, 6.5 * CELL, 1.6 * CELL, D.wellCm / 100, 2);
    prop(lm, PropKind.CONE, 11.2 * CELL, 3.2 * CELL, D.wellCm / 100, 0, 1, 0, undefined, lm.rng.range(0, 1));
    // sodium lights hanging 1.6 m under the deck, three over the well and three over the platform
    const na = kelvinToLinearRGB(2000, 0);
    const dying = lm.rng.int(0, 5);
    let k = 0;
    for (const vm of [2 * CELL, 7 * CELL]) {
      for (const um of [2.5 * CELL, 7 * CELL, 11.5 * CELL]) {
        const st: LightStateId = k === dying ? LightState.DYING : LightState.ON;
        fixture(lm, FixtureKind.SODIUM, um, vm, CEIL - 1.6, DOWN, [1, 0], na, 16000, st, { w: 0.45, h: 0.25, hum: 0.7 });
        k++;
      }
    }
    emitter(lm, EmitterKind.MACHINE, 1.0, 8 * CELL, 3.0, 0.2);
    emitter(lm, EmitterKind.DRIP, 5 * CELL, 1.5 * CELL, D.wellCm / 100 + 0.02, 0.25);
    return { entrances: lm.entrances };
  },
};
