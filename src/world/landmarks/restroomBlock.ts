// src/world/landmarks/restroomBlock.ts — RESTROOM_BLOCK (storeys 0, 1; 8x6, R2 B4): a public restroom with a row of
// five toilet stalls (steel partitions lifted off the floor, doors shut, ajar or missing), a vanity counter with a
// steel mirror strip under a buzzing batten, three urinals, a floor drain and puddles. Tiled walls on Level 0, painted
// block below.
//
// Frame: u across (8 cells = 9.6 m), v along (6 cells = 7.2 m). Door in the v = 0 wall; stalls against the v = L wall;
// the counter on the u = 0 wall, urinals on the u = W wall.

import { CELL, WALL_T } from '../../core/constants.ts';
import { CellFlag, DecalKind, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, box, cells, claim, DOWN, emitter, fixture, floorDecal, opening, prop, SOLID_F, storeyStyle, THIN_F } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const W = 8, L = 6;
const CEIL = 2.6;
export const RESTROOM = { stalls: 5, stallW: 1.05, stallD: 1.55, partTop: 1.95, partBottom: 0.28 } as const;

export const restroomBlock: LandmarkGenerator = {
  kind: LandmarkKind.RESTROOM_BLOCK, storeys: [Storey.LOBBY, Storey.SUBLEVEL], weight: 1, footprint: [W, L],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const deep = ctx.key.s === Storey.SUBLEVEL;
    const st = storeyStyle(ctx.key.s, CEIL * 100, deep
      ? { floorMat: Mat.CONCRETE_FLOOR, wallMat: Mat.CMU_PAINTED }
      : { floorMat: Mat.TERRAZZO, wallMat: Mat.POOL_TILE, baseboard: false, trimMat: Mat.POOL_TILE });
    claim(lm, st);
    const wallMat = st.wallMat;
    const door = lm.rng.int(2, 4);
    opening(lm, door, 0, 0, -1, EdgeKind.DOORWAY, wallMat, deep ? 0 : EdgeTrim.CASING, 210);
    if (lm.rng.chance(0.5)) opening(lm, W - 1, 0, 0, -1, EdgeKind.DOORWAY, wallMat, deep ? 0 : EdgeTrim.CASING, 210);

    const R = RESTROOM;
    const back = L * CELL - WALL_T / 2;
    const front = back - R.stallD;
    const x0 = W * CELL - WALL_T / 2 - 1.3 - R.stalls * R.stallW; // stalls end 1.3 m short of the urinal wall
    const steel = Mat.METAL_PAINTED, porcelain = Mat.PLASTIC;
    const t = 0.03;
    // partitions (lifted off the floor on little legs) and the front rail
    for (let k = 0; k <= R.stalls; k++) {
      const um = x0 + k * R.stallW;
      box(lm, um - t / 2, front, um + t / 2, back, R.partBottom, R.partTop, steel, THIN_F);
      pipeF2(lm, um, front + 0.05, R.partBottom);
    }
    box(lm, x0, front - 0.02, x0 + R.stalls * R.stallW, front + 0.02, R.partTop - 0.04, R.partTop + 0.02, steel, THIN_F);
    for (let k = 0; k < R.stalls; k++) {
      const um0 = x0 + k * R.stallW, cu = um0 + R.stallW / 2;
      // door: shut (a panel in the front line), ajar inward (a panel along v at the hinge), or missing
      const r = lm.rng.float();
      if (r < 0.45) box(lm, um0 + 0.04, front - t / 2, um0 + R.stallW - 0.04, front + t / 2, R.partBottom + 0.02, R.partTop - 0.06, steel, THIN_F);
      else if (r < 0.85) box(lm, um0 + 0.05, front, um0 + 0.05 + t, front + R.stallW - 0.12, R.partBottom + 0.02, R.partTop - 0.06, steel, THIN_F);
      // the toilet: a bowl and a cistern against the back wall
      box(lm, cu - 0.19, back - 0.62, cu + 0.19, back - 0.12, 0, 0.4, porcelain, SOLID_F);
      box(lm, cu - 0.24, back - 0.2, cu + 0.24, back - 0.01, 0.4, 0.8, porcelain, SOLID_F);
      if (lm.rng.chance(0.3)) floorDecal(lm, cu, front + 0.6, 0, { kind: DecalKind.PAPER, sign: false, rot: lm.rng.range(0, 6.28), w: 0.35, h: 0.3, alpha: 0.8 });
    }
    // vanity counter with three basins on the u = 0 wall, a steel mirror strip, a batten over it
    const cu0 = WALL_T / 2, cu1 = cu0 + 0.58;
    const cv0 = 1.1, cv1 = Math.min(front - 0.4, 5.0);
    box(lm, cu0, cv0, cu1, cv1, 0, 0.86, deep ? Mat.CONCRETE_WALL : Mat.TERRAZZO, SOLID_F);
    for (let k = 0; k < 3; k++) {
      const vm = cv0 + ((k + 0.5) * (cv1 - cv0)) / 3;
      box(lm, cu0 + 0.14, vm - 0.22, cu0 + 0.46, vm + 0.22, 0.86, 0.875, steel, THIN_F);
      box(lm, cu0 + 0.03, vm - 0.02, cu0 + 0.16, vm + 0.02, 0.86, 1.08, steel, THIN_F); // tap
    }
    box(lm, cu0, cv0 + 0.1, cu0 + 0.012, cv1 - 0.1, 1.12, 1.95, steel, THIN_F);
    fixture(lm, FixtureKind.TUBE_STRIP, cu0 + 0.08, (cv0 + cv1) / 2, 2.12, [1, 0, 0], [0, 1], kelvinToLinearRGB(4300, 0.05), 7000,
      lm.rng.chance(0.5) ? LightState.BUZZ : LightState.DYING, { hum: 0.7 });
    // three urinals on the far side wall, dividers between them
    const wu = W * CELL - WALL_T / 2;
    for (let k = 0; k < 3; k++) {
      const vm = 1.3 + k * 0.85;
      box(lm, wu - 0.34, vm - 0.2, wu, vm + 0.2, 0.45, 1.15, porcelain, SOLID_F);
      if (k > 0) box(lm, wu - 0.5, vm - 0.44, wu, vm - 0.41, 0.35, 1.55, steel, THIN_F);
    }
    // wet floor: puddles by the stalls, a drain, a mop and bucket in the corner, a wet-floor sign
    cells(lm, 2, L - 2, W - 1, L - 1, { flagsSet: CellFlag.WET });
    floorDecal(lm, (W / 2) * CELL, 2.2 * CELL, 0, { kind: DecalKind.DRAIN, sign: false, rot: 0, w: 0.35, h: 0.35, alpha: 0.95 });
    floorDecal(lm, (W / 2 + 0.5) * CELL, 2.9 * CELL, 0, { kind: DecalKind.WATER_STAIN, sign: false, rot: lm.rng.range(0, 6.28), w: 1.8, h: 1.2, alpha: 0.5 });
    prop(lm, PropKind.BUCKET, 0.45, front + 0.1 + 0.9, 0, 1, 0, 0, undefined, lm.rng.range(0, 3));
    prop(lm, PropKind.MOP, 0.35, front + 0.6 + 0.9, 0, 1, 0, 0, undefined, lm.rng.range(0, 3));
    if (lm.rng.chance(0.6)) prop(lm, PropKind.WET_FLOOR_SIGN, (door + 0.5) * CELL + 0.6, 1.3, 0, 0, -1, 0, undefined, lm.rng.range(-0.4, 0.4));
    prop(lm, PropKind.TRASH_CAN, cu1 + 0.25, cv0 - 0.35, 0, 0, 1, lm.rng.int(0, 3));
    // light: two ceiling battens, one of them flickering now and then; drips and a cistern hiss
    const col = kelvinToLinearRGB(4300, 0.05);
    fixture(lm, FixtureKind.TUBE_STRIP, (W / 2) * CELL, 1.6 * CELL, CEIL - 0.05, DOWN, [1, 0], col, 8600, LightState.ON);
    fixture(lm, FixtureKind.TUBE_STRIP, (x0 + R.stalls * R.stallW / 2), front - 0.5, CEIL - 0.05, DOWN, [1, 0], col, 8600, lm.rng.chance(0.35) ? LightState.FLICKER : LightState.ON);
    emitter(lm, EmitterKind.DRIP, x0 + R.stallW * 1.5, back - 0.4, 0.3, 0.3);
    emitter(lm, EmitterKind.WATER, x0 + R.stallW * 3.5, back - 0.3, 0.6, 0.12);
    return { entrances: lm.entrances };
  },
};

/** A partition leg (a short steel post under the partition's front end). */
function pipeF2(lm: Parameters<typeof box>[0], um: number, vm: number, top: number): void {
  box(lm, um - 0.02, vm - 0.02, um + 0.02, vm + 0.02, 0, top, Mat.METAL_PAINTED, THIN_F);
}
