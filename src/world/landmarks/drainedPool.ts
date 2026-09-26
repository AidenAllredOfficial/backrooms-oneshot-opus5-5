// src/world/landmarks/drainedPool.ts — DRAINED_POOL (storey 2 + POOLROOMS hero; 14x12, R2 B4): a competition pool
// emptied years ago. The tiled basin is walkable: a stair down into the shallow end (-120), a sloped floor to the
// deep end (-250), steel ladders on the deep walls. Some of the underwater lights are still on, glowing on dry tile.
// Leaf-brown stains, fallen tiles, a lounger that ended up at the bottom, a puddle in the deepest corner; half the
// skylights overhead are dead.
//
// Frame: u along the pool (14 cells), v across (12 cells). Basin: u 2..12, v 3..10. Shallow u 2..6 (-120), slope u 6..8,
// deep u 8..12 (-250). Stairs in cells u 2..4 at v 5..7 (down toward +u). Arches in the v = 0 and u = W walls.

import { CELL } from '../../core/constants.ts';
import { CeilKind, CellFlag, DecalKind, EdgeKind, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey, Zone } from '../../core/index.ts';
import type { LightStateId, ZoneId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, box, cells, claim, emitter, fixture, floorDecal, handrail, opening, pipeF, prop, ramp, recessedCells, THIN_F, waterRect } from './common.ts';
import type { Lm } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const W = 14, L = 12;
const CEIL = 5.0;
export const DRAINED_POOL = { basin: [2, 3, 12, 10] as const, shallowCm: -120, deepCm: -250, slope: [6, 8] as const, stairs: [2, 4, 5, 7] as const } as const;

/** A steel ladder on a basin wall: two rails and rungs from the basin floor to 90 cm above the deck. */
export function poolLadder(lm: Lm, um: number, vm: number, du: number, dv: number, floorY: number): void {
  // (du, dv): direction from the wall into the basin; rails 0.45 apart along the wall. Straight parts are boxes (no
  // plumbing fittings), the goose-neck over the coping a sloped pipe.
  const tu = -dv, tv = du;
  const off = 0.12, t = 0.02;
  const at = (s: number, d: number): [number, number] => [um + tu * s + du * d, vm + tv * s + dv * d];
  for (const s of [-0.225, 0.225]) {
    const [a, b] = at(s, off);
    box(lm, a - t, b - t, a + t, b + t, floorY, 0.05, Mat.METAL_PAINTED, THIN_F);
    const [c, d] = at(s, -0.25);
    pipeF(lm, a, b, 0.05, c, d, 0.9, 0.02, Mat.METAL_PAINTED, THIN_F);
  }
  for (let y = floorY + 0.3; y < -0.05; y += 0.3) {
    const [a, b] = at(-0.225, off), [c, d] = at(0.225, off);
    box(lm, Math.min(a, c) - 0.015, Math.min(b, d) - 0.015, Math.max(a, c) + 0.015, Math.max(b, d) + 0.015, y - 0.015, y + 0.015, Mat.METAL_PAINTED, THIN_F);
  }
}

export const drainedPool: LandmarkGenerator = {
  kind: LandmarkKind.DRAINED_POOL, storeys: [Storey.POOLROOMS], weight: 1, footprint: [W, L],
  hero: [Zone.POOLROOMS] as readonly ZoneId[],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const tile = Mat.POOL_TILE;
    claim(lm, { floorMat: tile, wallMat: tile, ceilMat: tile, ceilKind: CeilKind.TILE_GLAZED, ceilCm: CEIL * 100, trimMat: tile, zone: Zone.POOLROOMS });
    for (const u of [5, 6]) opening(lm, u, 0, 0, -1, EdgeKind.ARCH, tile, 0, 280);
    for (const v of [5, 6]) opening(lm, W - 1, v, 1, 0, EdgeKind.ARCH, tile, 0, 280);

    const D = DRAINED_POOL;
    const [bu0, bv0, bu1, bv1] = D.basin;
    const [s0, s1] = D.slope;
    const sh = D.shallowCm / 100, dp = D.deepCm / 100;
    cells(lm, bu0, bv0, s0, bv1, { floorCm: D.shallowCm, floorMat: Mat.POOL_MOSAIC });
    cells(lm, s0, bv0, bu1, bv1, { floorCm: D.deepCm, floorMat: Mat.POOL_MOSAIC });
    // the slope from the shallow floor down to the deep floor (smooth, walkable)
    ramp(lm, s0 * CELL, bv0 * CELL, s1 * CELL, bv1 * CELL, -1, 0, dp, sh, 0, Mat.POOL_MOSAIC);
    // stairs from the deck down into the shallow end (8 risers of 15 cm, 30 cm treads)
    const [tu0, tu1, tv0, tv1] = D.stairs;
    ramp(lm, tu0 * CELL, tv0 * CELL, tu1 * CELL, tv1 * CELL, -1, 0, sh, 0, 8, tile);
    handrail(lm, tu0 * CELL + 0.1, tv0 * CELL + 0.08, 0, tu1 * CELL, tv0 * CELL + 0.08, sh, Mat.METAL_PAINTED);
    handrail(lm, tu0 * CELL + 0.1, tv1 * CELL - 0.08, 0, tu1 * CELL, tv1 * CELL - 0.08, sh, Mat.METAL_PAINTED);
    // ladders on both deep side walls and the deep end wall
    poolLadder(lm, 10.5 * CELL, bv0 * CELL, 0, 1, dp);
    poolLadder(lm, 9.5 * CELL, bv1 * CELL, 0, -1, dp);
    poolLadder(lm, bu1 * CELL, 6.5 * CELL, -1, 0, dp);

    // underwater lights in the deep walls: most dead, some still burning on dry tile
    const uw = kelvinToLinearRGB(7600, 0.02);
    const ly = dp + 0.9;
    for (const um of [8.5, 10.5]) for (const [vm, dv] of [[bv0, 1], [bv1, -1]] as [number, number][]) {
      const st: LightStateId = lm.rng.chance(0.45) ? LightState.ON : LightState.OFF;
      fixture(lm, FixtureKind.UNDERWATER, um * CELL, vm * CELL + dv * 0.02, ly, [0, 0, dv], [1, 0], uw, 1100, st, { w: 0.26, h: 0.26, hum: 0.05 });
    }
    fixture(lm, FixtureKind.UNDERWATER, bu1 * CELL - 0.02, 5.2 * CELL, ly, [-1, 0, 0], [0, 1], uw, 1100, LightState.ON, { w: 0.26, h: 0.26, hum: 0.05 });

    // the puddle in the deepest corner (a film of water), stains, fallen tiles, the lounger at the bottom
    cells(lm, bu1 - 2, bv1 - 2, bu1, bv1, { waterCm: D.deepCm + 2, flagsSet: CellFlag.WET });
    waterRect(lm, bu1 - 2, bv1 - 2, bu1, bv1, dp + 0.02, dp, 2);
    for (let i = 0; i < 9; i++) {
      const deep = i < 5;
      const um = deep ? lm.rng.range(s1 * CELL + 0.4, bu1 * CELL - 0.4) : lm.rng.range(bu0 * CELL + 0.4, s0 * CELL - 0.2);
      const vm = lm.rng.range(bv0 * CELL + 0.4, bv1 * CELL - 0.4);
      floorDecal(lm, um, vm, (deep ? dp : sh) + 0.003, { kind: i % 3 === 0 ? DecalKind.MOLD : DecalKind.WATER_STAIN, sign: false, rot: lm.rng.range(0, 6.28), w: lm.rng.range(1.2, 2.4), h: lm.rng.range(0.9, 1.8), alpha: 0.6 });
    }
    for (let i = 0; i < 7; i++) {
      const um = lm.rng.range(bu0 * CELL + 0.5, bu1 * CELL - 0.5), vm = lm.rng.range(bv0 * CELL + 0.5, bv1 * CELL - 0.5);
      const y = um < s0 * CELL ? sh : um > s1 * CELL ? dp : null;
      if (y === null) continue;
      g.addProp({ kind: i < 5 ? PropKind.TILE_FRAGMENT : PropKind.CEILING_DEBRIS, variant: lm.rng.int(0, 3), x: lm.f.point(um, vm)[0], y, z: lm.f.point(um, vm)[1], yaw: lm.rng.range(0, 6.28), scale: 1, flags: 0, seed: lm.rng.next() });
    }
    prop(lm, PropKind.LOUNGE_CHAIR, 10.2 * CELL, 5.3 * CELL, dp, 1, 0.4, lm.rng.int(0, 2), undefined, lm.rng.range(-0.3, 0.3));
    prop(lm, PropKind.POOL_FLOAT, 9.1 * CELL, 8.2 * CELL, dp, 0, 1, lm.rng.int(0, 2), undefined, lm.rng.range(0, 6.28));
    // lane lines on the basin floor (faded paint)
    for (const vm of [4.75 * CELL, 6.5 * CELL, 8.25 * CELL]) {
      floorDecal(lm, (bu0 + 1) * CELL + 0.6 + 1.5, vm, sh + 0.004, { kind: 255, sign: false, rot: lm.f.yaw(1, 0), w: 0.2, h: 3.0, alpha: 0.55, color: [0.04, 0.08, 0.22] });
      floorDecal(lm, (s1 + bu1) / 2 * CELL, vm, dp + 0.004, { kind: 255, sign: false, rot: lm.f.yaw(1, 0), w: 0.2, h: 4.0, alpha: 0.55, color: [0.04, 0.08, 0.22] });
    }
    // deck loungers along the back wall, a lifebuoy
    for (let i = 0; i < 4; i++) {
      if (lm.rng.chance(0.3)) continue;
      prop(lm, PropKind.LOUNGE_CHAIR, (3 + i * 2.4) * CELL, (L - 0.9) * CELL, 0, 0, -1, lm.rng.int(0, 2), undefined, lm.rng.range(-0.1, 0.1));
    }
    prop(lm, PropKind.LIFEBUOY, 0.075 + 0.07, 7.5 * CELL, 1.3, 1, 0, 0);

    // ceiling: skylight panels, half of them dead
    const sky = kelvinToLinearRGB(6500, 0.01);
    for (let v = 1; v < L - 1; v += 3) for (let u = 1; u < W - 1; u += 3) {
      recessedCells(lm, FixtureKind.SKY_PANEL, u, v, u + 1, v + 1, CEIL, sky, 2800, lm.rng.chance(0.45) ? LightState.OFF : LightState.ON);
    }
    emitter(lm, EmitterKind.DRIP, (bu1 - 1) * CELL, (bv1 - 1) * CELL, dp + 0.03, 0.4);
    emitter(lm, EmitterKind.VENT, (W / 2) * CELL, (L / 2) * CELL, CEIL - 0.4, 0.2);
    return { entrances: lm.entrances };
  },
};
