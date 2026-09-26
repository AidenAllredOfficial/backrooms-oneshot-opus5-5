// src/world/heroRooms/valveGallery.ts — VALVE_GALLERY hero (PIPEWORKS, CONCRETE; 12x5, R2 B4): a long service gallery
// whose walls disappear behind pipework. Five horizontal runs of different bores on each side, a drop to a hand-wheel
// valve every 1.2 m with a painted tag, a grated trench down the middle of the floor, caged bulbs on the ceiling (one
// dying), a hissing joint, puddles under the drips.
//
// Frame: u along (12 cells), v across (5 cells). Openings at both u ends (2 cells) and one side door.

import { CELL, WALL_T } from '../../core/constants.ts';
import { CeilKind, CellFlag, DecalKind, EdgeKind, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey, Zone } from '../../core/index.ts';
import type { LightStateId, MatId, Vec3, ZoneId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, box, cells, claim, DOWN, emitter, fixture, floorDecal, glowPanel, opening, OVERHEAD, pipeF, prop, SOLID_F, THIN_F, WALK_F } from '../landmarks/common.ts';
import type { LandmarkGenerator } from '../landmarks/index.ts';

const W = 12, L = 5;
const CEIL = 3.6;
/** Horizontal runs per wall: [height, radius, material]. */
const RUNS: readonly [number, number, MatId][] = [
  [0.45, 0.07, Mat.METAL_RUST], [0.85, 0.05, Mat.METAL_PAINTED], [2.05, 0.11, Mat.METAL_PAINTED], [2.62, 0.16, Mat.METAL_RUST], [3.2, 0.06, Mat.METAL_PAINTED],
];
/** Tag colours (painted bands on the valve drops): water green, steam red, gas yellow, air blue. */
const TAGS: readonly Vec3[] = [[0.1, 0.5, 0.15], [0.6, 0.06, 0.04], [0.8, 0.6, 0.05], [0.08, 0.2, 0.6]];
export const VALVE_GALLERY = { runs: RUNS.length, valvePitch: 1.2 } as const;

export const valveGallery: LandmarkGenerator = {
  kind: LandmarkKind.VALVE_GALLERY, storeys: [Storey.SUBLEVEL, Storey.POOLROOMS], weight: 1, footprint: [W, L], heroOnly: true,
  hero: [Zone.PIPEWORKS, Zone.CONCRETE] as readonly ZoneId[],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const wallMat = Mat.CONCRETE_WALL;
    claim(lm, { floorMat: Mat.CONCRETE_FLOOR, wallMat, ceilMat: Mat.CONCRETE_CEIL, ceilKind: CeilKind.CONCRETE, ceilCm: CEIL * 100, trimMat: Mat.METAL_PAINTED, zone: Zone.PIPEWORKS });
    for (const v of [1, 2, 3]) {
      opening(lm, 0, v, -1, 0, EdgeKind.OPEN, wallMat);
      opening(lm, W - 1, v, 1, 0, EdgeKind.OPEN, wallMat);
    }
    opening(lm, lm.rng.int(4, 7), L - 1, 0, 1, EdgeKind.DOORWAY, wallMat, 0, 210);

    const x0 = WALL_T / 2, x1 = W * CELL - WALL_T / 2;
    const side = [WALL_T / 2, L * CELL - WALL_T / 2];
    for (let s = 0; s < 2; s++) {
      const wv = side[s], dv = s === 0 ? 1 : -1;
      // horizontal runs, standing off the wall on brackets
      for (const [y, r, mat] of RUNS) {
        const vm = wv + dv * (r + 0.05);
        pipeF(lm, x0, vm, y, x1, vm, y, r, mat, y < 2.0 ? SOLID_F : OVERHEAD);
      }
      for (let um = 0.6; um < x1; um += 2.4) box(lm, um - 0.03, wv, um + 0.03, wv + dv * 0.42, 0.3, 3.3, Mat.METAL_PAINTED, THIN_F);
      // valve drops: from the 2.05 m run down to a wheel at hand height, a tag band, a gauge dial on the wall
      for (let k = 0; k < 9; k++) {
        const um = 1.2 + k * VALVE_GALLERY.valvePitch + (s ? 0.6 : 0);
        if (um > x1 - 0.8) continue;
        const vm = wv + dv * 0.33;
        pipeF(lm, um, vm, 2.05, um, vm, 1.0, 0.035, Mat.METAL_PAINTED, SOLID_F);
        prop(lm, PropKind.PIPE_VALVE, um, vm + dv * 0.02, 1.25, 0, dv, lm.rng.int(0, 3));
        const tag = TAGS[lm.rng.int(0, TAGS.length - 1)];
        box(lm, um - 0.042, vm - 0.042, um + 0.042, vm + 0.042, 1.62, 1.72, Mat.PLASTIC, THIN_F);
        glowPanel(lm, um, vm + dv * 0.043, 1.67, 0, dv, 0.07, 0.09, 0, tag); // painted tag (colour only)
        if (lm.rng.chance(0.4)) {
          const [x, z] = lm.f.point(um + 0.35, wv + dv * 0.005);
          const [nx, nz] = lm.f.dir(0, dv);
          g.addDecal({ kind: 15, sign: true, px: x, py: 1.45, pz: z, nx, ny: 0, nz, rot: 0, w: 0.14, h: 0.14, alpha: 0.9 }); // gauge dial
        }
      }
    }
    // the grated trench down the middle
    const tv0 = (L * CELL) / 2 - 0.3, tv1 = (L * CELL) / 2 + 0.3;
    box(lm, x0, tv0, x1, tv1, 0, 0.012, Mat.METAL_GRATE, WALK_F);
    box(lm, x0, tv0 - 0.04, x1, tv0, 0, 0.02, Mat.METAL_PAINTED, THIN_F);
    box(lm, x0, tv1, x1, tv1 + 0.04, 0, 0.02, Mat.METAL_PAINTED, THIN_F);
    // caged bulbs on the ceiling, one dying; a leak with puddles
    const warm = kelvinToLinearRGB(2800, 0.01);
    const dying = lm.rng.int(0, 4);
    for (let k = 0; k < 5; k++) {
      const st: LightStateId = k === dying ? LightState.DYING : LightState.ON;
      fixture(lm, FixtureKind.CAGE_BULB, 1.8 + k * 2.64, (L * CELL) / 2 + 0.5, CEIL - 0.25, DOWN, [1, 0], warm, 150, st, { shape: 1, w: 0.1, h: 0.1, hum: 0.5 });
    }
    const lu = lm.rng.int(3, 8);
    cells(lm, lu, 1, lu + 2, 4, { flagsSet: CellFlag.WET });
    floorDecal(lm, (lu + 1) * CELL, (L * CELL) / 2 - 0.9, 0.002, { kind: DecalKind.WATER_STAIN, sign: false, rot: lm.rng.range(0, 6.28), w: 1.6, h: 1.0, alpha: 0.6 });
    floorDecal(lm, (lu + 1) * CELL + 0.8, 0.9, 0.002, { kind: DecalKind.RUST_STREAK, sign: false, rot: lm.rng.range(0, 6.28), w: 0.8, h: 0.8, alpha: 0.5 });
    emitter(lm, EmitterKind.STEAM, (lu + 1) * CELL, side[0] + 0.3, 2.62, 0.45);
    emitter(lm, EmitterKind.DRIP, (lu + 1) * CELL, (L * CELL) / 2 - 0.9, 0.02, 0.35);
    emitter(lm, EmitterKind.PIPE, (W * CELL) / 2, side[1] - 0.3, 2.0, 0.5);
    return { entrances: lm.entrances };
  },
};
