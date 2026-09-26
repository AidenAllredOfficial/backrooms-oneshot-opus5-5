// src/world/heroRooms/halfLevel.ts — HALF_LEVEL hero (PARKING; 16x14, R2 B4): a double-height bay of the car park
// where half the floor is a raised deck 1.6 m up, reached by a sloped car ramp with a painted arrow. Cars are parked
// on both levels, a concrete parapet with a steel rail guards the deck edge, columns carry both, and orange sodium
// lamps hang over each level; one is dying.
//
// Frame: u across (16 cells), v along (14 cells). Lower level v 0..7 (floor 0), deck v 7..14 (floor 160).
// Ramp: u 12..14 over v 2..7 (0 -> 1.6 m, ascending +v). Entrances: lower level only (v = 0 wall, u = 0 wall).

import { CELL, WALL_T } from '../../core/constants.ts';
import { CeilKind, DECAL_PAINT_STRIPE, DecalKind, EdgeKind, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, SignKind, Storey, Zone } from '../../core/index.ts';
import type { LightStateId, ZoneId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, box, cells, claim, DOWN, emitter, fixture, floorDecal, handrail, opening, prop, ramp, SOLID_F } from '../landmarks/common.ts';
import type { Lm } from '../landmarks/common.ts';
import type { LandmarkGenerator } from '../landmarks/index.ts';

const W = 16, L = 14;
const CEIL = 5.6;
export const HALF_LEVEL = { deckV: 7, deckCm: 160, ramp: [12, 14, 2] as const, parapetH: 0.95 } as const;

/** A car in a stall at frame metres (um, vm) on floor y, nose toward (du, dv), with a wheel stop and stall lines. */
function parked(lm: Lm, um: number, vm: number, y: number, du: number, dv: number): void {
  prop(lm, PropKind.CAR_SEDAN, um, vm, y, du, dv, lm.rng.int(0, 3), undefined, lm.rng.range(-0.04, 0.04));
}

export const halfLevel: LandmarkGenerator = {
  kind: LandmarkKind.HALF_LEVEL, storeys: [Storey.SUBLEVEL], weight: 1, footprint: [W, L], heroOnly: true,
  hero: [Zone.PARKING] as readonly ZoneId[],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const wallMat = Mat.CONCRETE_WALL;
    claim(lm, { floorMat: Mat.CONCRETE_FLOOR, wallMat, ceilMat: Mat.CONCRETE_CEIL, ceilKind: CeilKind.CONCRETE, ceilCm: CEIL * 100, trimMat: Mat.CONCRETE_WALL });
    const H = HALF_LEVEL;
    const dy = H.deckCm / 100;
    for (const u of [3, 4, 5]) opening(lm, u, 0, 0, -1, EdgeKind.OPEN, wallMat);
    for (const v of [2, 3]) opening(lm, 0, v, -1, 0, EdgeKind.OPEN, wallMat);
    // the deck and the ramp up to it
    cells(lm, 0, H.deckV, W, L, { floorCm: H.deckCm });
    const [ru0, ru1, rv0] = H.ramp;
    ramp(lm, ru0 * CELL, rv0 * CELL, ru1 * CELL, H.deckV * CELL, 0, 1, 0, dy, 0, Mat.CONCRETE_FLOOR);
    floorDecal(lm, (ru0 + 1) * CELL, (rv0 - 0.8) * CELL, 0, { kind: SignKind.ARROW_UP, sign: true, rot: lm.f.yaw(0, 1), w: 0.9, h: 1.4, alpha: 0.7 });
    // parapet along the deck edge (except over the ramp) with a steel rail; kerbs beside the ramp
    const dv = H.deckV * CELL;
    box(lm, WALL_T / 2, dv, ru0 * CELL, dv + 0.22, dy, dy + H.parapetH, Mat.CONCRETE_WALL, SOLID_F);
    handrail(lm, WALL_T / 2 + 0.1, dv + 0.11, dy + H.parapetH, ru0 * CELL - 0.1, dv + 0.11, dy + H.parapetH, Mat.METAL_PAINTED, 0.12, 8);
    box(lm, ru0 * CELL - 0.22, rv0 * CELL, ru0 * CELL, dv, 0, 0.3, Mat.CONCRETE_WALL, SOLID_F);
    box(lm, ru1 * CELL, dv, W * CELL - WALL_T / 2, dv + 0.22, dy, dy + H.parapetH, Mat.CONCRETE_WALL, SOLID_F);
    floorDecal(lm, ru0 * CELL / 2, dv - 0.25, 0.0 + 0.002, { kind: DECAL_PAINT_STRIPE, sign: false, rot: lm.f.yaw(1, 0), w: 0.15, h: ru0 * CELL - 0.4, alpha: 0.8 });
    // columns under the deck edge and in the lower bay (0.5 m square, floor to ceiling)
    for (const um of [3.6, 8.4, 13.2]) {
      if (um > ru0 * CELL - 0.4 && um < ru1 * CELL + 0.4) continue;
      box(lm, um - 0.25, dv - 0.5, um + 0.25, dv, 0, CEIL, Mat.CONCRETE_WALL, SOLID_F);
      lm.g.addDecal({ ...faceDecal(lm, um, dv - 0.5, 0, -1), kind: DecalKind.PARKING_NUMBER, sign: false, rot: 0, w: 0.35, h: 0.35, alpha: 0.85 });
    }
    // stalls: nose-in cars on the deck against the back wall, and on the lower level against the front wall
    const back = L * CELL - WALL_T / 2;
    for (let k = 0; k < 5; k++) {
      const um = 1.6 + k * 2.6;
      floorDecal(lm, um - 1.3, back - 2.6, dy + 0.002, { kind: DECAL_PAINT_STRIPE, sign: false, rot: lm.f.yaw(0, 1), w: 0.12, h: 5.0, alpha: 0.8 });
      if (lm.rng.chance(0.6)) parked(lm, um, back - 2.5, dy, 0, 1);
      prop(lm, PropKind.WHEEL_STOP, um, back - 0.6, dy, 0, 1, 0);
    }
    for (let k = 0; k < 2; k++) {
      const um = 8.8 + k * 2.6;
      floorDecal(lm, um - 1.3, 3.0, 0.002, { kind: DECAL_PAINT_STRIPE, sign: false, rot: lm.f.yaw(0, 1), w: 0.12, h: 5.0, alpha: 0.8 });
      if (lm.rng.chance(0.5)) parked(lm, um, 2.8, 0, 0, -1);
    }
    floorDecal(lm, 5.0, 5.4, 0.002, { kind: DecalKind.OIL, sign: false, rot: lm.rng.range(0, 6.28), w: 1.2, h: 0.9, alpha: 0.6 });
    // sodium lamps: three over each level, hung from the slab
    const na = kelvinToLinearRGB(2000, 0);
    const dying = lm.rng.int(0, 5);
    let k = 0;
    for (const [vm, y] of [[3.6, CEIL - 1.2], [back - 3.0, CEIL - 0.8]] as [number, number][]) {
      for (const um of [3.0, 9.6, 16.2]) {
        const st: LightStateId = k === dying ? LightState.DYING : LightState.ON;
        fixture(lm, FixtureKind.SODIUM, um, vm, y, DOWN, [1, 0], na, 15000, st, { w: 0.45, h: 0.25, hum: 0.7 });
        k++;
      }
    }
    prop(lm, PropKind.CONE, (ru0 + 1) * CELL, (rv0 - 1.8) * CELL, 0, 0, 1, 0, undefined, lm.rng.range(0, 1));
    emitter(lm, EmitterKind.VENT, W * CELL / 2, L * CELL / 2, CEIL - 0.4, 0.3);
    emitter(lm, EmitterKind.DRIP, 2.0, back - 1.0, dy + 0.02, 0.2);
    return { entrances: lm.entrances };
  },
};

/** Decal placement fields for a vertical face at frame metres (um, vm), 1.55 m up, facing (du, dv). */
function faceDecal(lm: Lm, um: number, vm: number, du: number, dv: number): { px: number; py: number; pz: number; nx: number; ny: number; nz: number } {
  const [x, z] = lm.f.point(um + du * 0.003, vm + dv * 0.003);
  const [nx, nz] = lm.f.dir(du, dv);
  return { px: x, py: 1.55, pz: z, nx, ny: 0, nz };
}
