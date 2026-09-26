// src/world/heroRooms/tollBooth.ts — TOLL_BOOTH hero (PARKING; 12x10, R2 B4): the pay station on the way out of the
// car park. A kerbed island carries a little glazed booth with its light on, a chair, a monitor and nobody inside;
// barrier arms are down across both lanes; a ticket machine glows; a canopy with strip lights hangs over it all.
// Lane lines, stop bars, cones.
//
// Frame: u across (12 cells), v along (10 cells, the driving direction). Lanes: u 1.5..6 m and 8.4..12.9 m; the
// island u 6.0..8.4 m, v 3.6..8.4 m. Entrances: both ends of both lanes (the v = 0 and v = L walls).

import { CELL, WALL_T } from '../../core/constants.ts';
import { CeilKind, DECAL_PAINT_STRIPE, EdgeKind, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, SignKind, Storey, Zone } from '../../core/index.ts';
import type { ZoneId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, box, claim, DOWN, emitter, fixture, floorDecal, glowPanel, opening, OVERHEAD, prop, SOLID_F, THIN_F, WALK_F } from '../landmarks/common.ts';
import type { LandmarkGenerator } from '../landmarks/index.ts';

const W = 12, L = 10;
const CEIL = 4.2;
export const TOLL_BOOTH = { island: [6.0, 3.6, 8.4, 8.4] as const, booth: [6.3, 5.0, 8.1, 7.0] as const, kerb: 0.15 } as const;

export const tollBooth: LandmarkGenerator = {
  kind: LandmarkKind.TOLL_BOOTH, storeys: [Storey.SUBLEVEL], weight: 1, footprint: [W, L], heroOnly: true,
  hero: [Zone.PARKING] as readonly ZoneId[],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const wallMat = Mat.CONCRETE_WALL;
    claim(lm, { floorMat: Mat.CONCRETE_FLOOR, wallMat, ceilMat: Mat.CONCRETE_CEIL, ceilKind: CeilKind.CONCRETE, ceilCm: CEIL * 100, trimMat: Mat.CONCRETE_WALL });
    for (const u of [2, 3, 4, 8, 9, 10]) {
      opening(lm, u, 0, 0, -1, EdgeKind.OPEN, wallMat);
      opening(lm, u, L - 1, 0, 1, EdgeKind.OPEN, wallMat);
    }
    const T = TOLL_BOOTH;
    const [iu0, iv0, iu1, iv1] = T.island;
    // the island: a kerb with yellow-painted ends
    box(lm, iu0, iv0, iu1, iv1, 0, T.kerb, Mat.CONCRETE_WALL, WALK_F);
    for (const vm of [iv0 + 0.3, iv1 - 0.3]) floorDecal(lm, (iu0 + iu1) / 2, vm, T.kerb + 0.002, { kind: DECAL_PAINT_STRIPE, sign: false, rot: lm.f.yaw(1, 0), w: 0.5, h: iu1 - iu0 - 0.1, alpha: 0.85 });
    // the booth: a low wall all round, corner posts, glazing gaps, a roof
    const [bu0, bv0, bu1, bv1] = T.booth;
    const k0 = T.kerb, sill = k0 + 1.0, head = k0 + 2.2, t = 0.06;
    const shell = Mat.METAL_PAINTED;
    box(lm, bu0, bv0, bu1, bv0 + t, k0, sill, shell, SOLID_F);
    box(lm, bu0, bv1 - t, bu1, bv1, k0, sill, shell, SOLID_F);
    box(lm, bu0, bv0, bu0 + t, bv1, k0, sill, shell, SOLID_F);
    box(lm, bu1 - t, bv0, bu1, bv1 - 0.9, k0, head, shell, SOLID_F); // the door side: a solid panel, then the doorway
    for (const [a, b] of [[bu0, bv0], [bu1 - t, bv0], [bu0, bv1 - t], [bu1 - t, bv1 - t]]) box(lm, a, b, a + t, b + t, sill, head, shell, THIN_F);
    box(lm, bu0 - 0.1, bv0 - 0.1, bu1 + 0.1, bv1 + 0.1, head, head + 0.18, shell, SOLID_F); // roof
    // inside: a counter, a chair, a monitor, a lamp left on
    box(lm, bu0 + t, bv0 + t, bu0 + 0.55, bv1 - t, k0, k0 + 0.95, Mat.WOOD, SOLID_F);
    prop(lm, PropKind.OFFICE_CHAIR, bu0 + 1.0, (bv0 + bv1) / 2, k0, -1, 0, lm.rng.int(0, 3), undefined, lm.rng.range(-0.5, 0.5));
    prop(lm, PropKind.CRT_MONITOR, bu0 + 0.3, (bv0 + bv1) / 2 + 0.3, k0 + 0.95, 1, 0, 0);
    glowPanel(lm, bu0 + 0.3 + 0.215, (bv0 + bv1) / 2 + 0.3, k0 + 0.95 + 0.2, 1, 0, 0.28, 0.2, 60, [0.6, 0.75, 1.0]);
    fixture(lm, FixtureKind.TUBE_STRIP, (bu0 + bu1) / 2, (bv0 + bv1) / 2, head - 0.06, DOWN, [0, 1], kelvinToLinearRGB(3800, 0.03), 5000, LightState.ON, { hum: 0.4 });
    lm.g.addDecal({ kind: SignKind.EXIT, sign: true, ...face(lm, (bu0 + bu1) / 2, bv0 - 0.004, 0, -1, head - 0.3), rot: 0, w: 0.5, h: 0.2, alpha: 1 });
    // barrier arms down across both lanes (striped), their posts on the island
    for (const [vm, dir] of [[iv0 + 0.4, -1], [iv1 - 0.4, 1]] as [number, number][]) {
      const pu = dir < 0 ? iu0 + 0.25 : iu1 - 0.25;
      box(lm, pu - 0.15, vm - 0.15, pu + 0.15, vm + 0.15, k0, k0 + 1.0, shell, SOLID_F);
      const [a, b] = dir < 0 ? [WALL_T / 2 + 1.4, pu] : [pu, W * CELL - WALL_T / 2 - 1.4];
      box(lm, a, vm - 0.04, b, vm + 0.04, k0 + 0.92, k0 + 1.0, Mat.PLASTIC, OVERHEAD);
      for (let x = a + 0.2; x < b - 0.3; x += 0.8) box(lm, x, vm - 0.042, x + 0.4, vm + 0.042, k0 + 0.918, k0 + 1.002, Mat.RUBBER, THIN_F);
      floorDecal(lm, dir < 0 ? (iu0 + WALL_T) / 2 + 0.5 : (iu1 + W * CELL) / 2 - 0.5, vm - dir * 1.2, 0.002, { kind: DECAL_PAINT_STRIPE, sign: false, rot: lm.f.yaw(1, 0), w: 0.3, h: 4.0, alpha: 0.85 });
    }
    // the ticket machine at the island's approach end, its screen glowing
    box(lm, iu0 + 0.2, iv0 + 0.7, iu0 + 0.6, iv0 + 1.05, k0, k0 + 1.35, Mat.PLASTIC, SOLID_F);
    glowPanel(lm, iu0 + 0.198, iv0 + 0.88, k0 + 1.1, -1, 0, 0.18, 0.14, 120, [0.5, 0.9, 0.6]);
    // the canopy with strip lights under it, lane lines and cones
    const cy = CEIL - 0.9;
    box(lm, 1.0, iv0 - 0.4, W * CELL - 1.0, iv1 + 0.4, cy, cy + 0.25, Mat.METAL_PAINTED, OVERHEAD);
    const cool = kelvinToLinearRGB(4300, 0.02);
    for (const um of [3.6, 11.2]) for (const vm of [iv0 + 0.8, iv1 - 0.8]) fixture(lm, FixtureKind.TUBE_STRIP, um, vm, cy - 0.04, DOWN, [0, 1], cool, 8600, LightState.ON);
    for (const um of [1.5, W * CELL - 1.5]) floorDecal(lm, um, L * CELL / 2, 0.002, { kind: DECAL_PAINT_STRIPE, sign: false, rot: lm.f.yaw(0, 1), w: 0.12, h: L * CELL - 1.0, alpha: 0.75 });
    for (let k = 0; k < 3; k++) prop(lm, PropKind.CONE, iu1 + 0.5 + k * 0.1, iv1 + 0.9 + k * 0.7, 0, 0, 1, 0, undefined, lm.rng.range(0, 1));
    const na = kelvinToLinearRGB(2000, 0);
    fixture(lm, FixtureKind.SODIUM, 3.6, 1.2, CEIL - 0.4, DOWN, [1, 0], na, 12000, LightState.ON, { w: 0.45, h: 0.25, hum: 0.6 });
    fixture(lm, FixtureKind.SODIUM, 10.8, L * CELL - 1.2, CEIL - 0.4, DOWN, [1, 0], na, 12000, lm.rng.chance(0.4) ? LightState.DYING : LightState.ON, { w: 0.45, h: 0.25, hum: 0.6 });
    emitter(lm, EmitterKind.BUZZ, (bu0 + bu1) / 2, (bv0 + bv1) / 2, head - 0.2, 0.3);
    emitter(lm, EmitterKind.MACHINE, iu0 + 0.4, iv0 + 0.9, 0.8, 0.2);
    return { entrances: lm.entrances };
  },
};

function face(lm: Parameters<typeof box>[0], um: number, vm: number, du: number, dv: number, y: number): { px: number; py: number; pz: number; nx: number; ny: number; nz: number } {
  const [x, z] = lm.f.point(um, vm);
  const [nx, nz] = lm.f.dir(du, dv);
  return { px: x, py: y, pz: z, nx, ny: 0, nz };
}
