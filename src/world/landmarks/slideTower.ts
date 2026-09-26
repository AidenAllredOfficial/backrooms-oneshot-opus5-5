// src/world/landmarks/slideTower.ts — SLIDE_TOWER (storey 2 + POOLROOMS hero; 16x16, R2 B4): an 11 m tiled hall
// dominated by a water slide. A 40-riser stair climbs 6 m along one wall to a railed platform; from it a white tube
// spirals down one and a bit turns and shoots out over a deep pool. Visible through the arches from far away, lit by a
// skylight grid; underwater lights in the pool walls.
//
// Frame: u across (16 cells), v along (16 cells). Stair: u 0.2..1.6 m, v 1.2..13.2 m (0 -> 6 m, ascending +v).
// Platform: u 0.2..4.8 m, v 13.2 m..back wall at 6 m. Pool: cells u 7..15, v 2..10 (floor -140, water -10, NOWALK).

import { CELL, CHUNK_CELLS, WALL_T } from '../../core/constants.ts';
import { CeilKind, CellFlag, cellIdx, EdgeKind, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey, Zone } from '../../core/index.ts';
import type { ZoneId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, box, cells, claim, emitter, fixture, handrail, opening, OVERHEAD, pipeF, prop, ramp, recessedCells, SOLID_F, WALK_F, waterRect } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const S = 16;
/** Decay byte cap under the slide tube (props/pipes.ts RUST_DECAY is 150: keep the tube painted, never rusty). */
const SLIDE_DECAY_MAX = 120;
const CEIL = 11.0;
export const SLIDE_TOWER = {
  top: 6.0, stair: [0.2, 1.6, 1.2, 13.2] as const, pool: [7, 2, 15, 10] as const, poolCm: -140, waterCm: -10,
  helix: { cu: 7.0, cv: 14.4, r: 2.2, turns: 1.125, yEnd: 1.3 }, tube: 0.422, // 0.422: props/pipes.ts paints this bore blue-grey
} as const;

export const slideTower: LandmarkGenerator = {
  kind: LandmarkKind.SLIDE_TOWER, storeys: [Storey.POOLROOMS], weight: 1, footprint: [S, S],
  hero: [Zone.POOLROOMS, Zone.PILLAR_HALL] as readonly ZoneId[],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, S, S);
    if (!lm) return { entrances: [] };
    const tile = Mat.POOL_TILE;
    claim(lm, { floorMat: tile, wallMat: tile, ceilMat: tile, ceilKind: CeilKind.TILE_GLAZED, ceilCm: CEIL * 100, trimMat: tile, zone: Zone.POOLROOMS });
    for (const u of [3, 4]) opening(lm, u, 0, 0, -1, EdgeKind.ARCH, tile, 0, 320);
    for (const v of [12, 13]) opening(lm, S - 1, v, 1, 0, EdgeKind.ARCH, tile, 0, 320);
    opening(lm, lm.rng.int(9, 12), S - 1, 0, 1, EdgeKind.DOORWAY, tile, 0, 210);

    const T = SLIDE_TOWER;
    // ---- the pool
    const [pu0, pv0, pu1, pv1] = T.pool;
    cells(lm, pu0, pv0, pu1, pv1, { floorCm: T.poolCm, waterCm: T.waterCm, floorMat: Mat.POOL_MOSAIC, flagsSet: CellFlag.NOWALK });
    cells(lm, pu0 - 1, pv0 - 1, pu1 + 1 > S ? S : pu1 + 1, pv0, { flagsSet: CellFlag.WET });
    cells(lm, pu0 - 1, pv1, pu1, pv1 + 1, { flagsSet: CellFlag.WET });
    waterRect(lm, pu0, pv0, pu1, pv1, T.waterCm / 100, T.poolCm / 100, 0);
    const uw = kelvinToLinearRGB(7600, 0.02);
    for (let u = pu0 + 1; u < pu1; u += 3) {
      fixture(lm, FixtureKind.UNDERWATER, (u + 0.5) * CELL, pv0 * CELL + 0.02, -0.75, [0, 0, 1], [1, 0], uw, 1400, LightState.ON, { w: 0.26, h: 0.26, hum: 0.05 });
      fixture(lm, FixtureKind.UNDERWATER, (u + 0.5) * CELL, pv1 * CELL - 0.02, -0.75, [0, 0, -1], [1, 0], uw, 1400, LightState.ON, { w: 0.26, h: 0.26, hum: 0.05 });
    }
    prop(lm, PropKind.POOL_LADDER, (pu1 - 1.5) * CELL, pv0 * CELL + 0.27, -1.0, 0, 1, 0, 0);
    prop(lm, PropKind.POOL_LADDER, pu0 * CELL + 0.27, (pv1 - 1.5) * CELL, -1.0, 1, 0, 0, 0);
    for (let k = 0; k < 3; k++) {
      const [x, z] = lm.f.point(lm.rng.range((pu0 + 1) * CELL, (pu1 - 1) * CELL), lm.rng.range((pv0 + 1) * CELL, (pv1 - 1) * CELL));
      g.addProp({ kind: PropKind.POOL_FLOAT, variant: lm.rng.int(0, 2), x, y: T.waterCm / 100, z, yaw: lm.rng.range(0, 6.28), scale: 1, flags: 0, seed: lm.rng.next() });
    }

    // ---- the stair along the u = 0 wall, 40 risers, and its rail
    const [su0, su1, sv0, sv1] = T.stair;
    ramp(lm, su0, sv0, su1, sv1, 0, 1, 0, T.top, 40, tile);
    handrail(lm, su1 - 0.05, sv0 + 0.1, 0.15, su1 - 0.05, sv1, T.top, Mat.METAL_PAINTED, 0.95, 10);
    // ---- the platform: a tiled slab on four columns, railings on its open sides
    const back = S * CELL - WALL_T / 2;
    const pa = su0, pb = 4.8, pc = sv1;
    box(lm, pa, pc, pb, back, T.top - 0.35, T.top, tile, WALK_F);
    for (const [a, b] of [[pb - 0.35, pc], [pb - 0.35, back - 0.35]]) box(lm, a, b, a + 0.35, b + 0.35, 0, T.top - 0.35, tile, SOLID_F);
    handrail(lm, su1, pc + 0.05, T.top, pb - 0.05, pc + 0.05, T.top, Mat.METAL_PAINTED, 1.05, 3);
    handrail(lm, pb - 0.05, back - 0.1, T.top, pb - 0.05, T.helix.cv + T.tube + 0.15, T.top, Mat.METAL_PAINTED, 1.05, 2);
    handrail(lm, pb - 0.05, pc + 0.05, T.top, pb - 0.05, T.helix.cv - T.tube - 0.15, T.top, Mat.METAL_PAINTED, 1.05, 1);

    // ---- the slide: a helix of tube segments from the platform edge, then a straight run-out over the pool
    const H = T.helix;
    const n = Math.round(H.turns * 36);
    const th0 = Math.PI, th1 = Math.PI + H.turns * Math.PI * 2;
    const at = (t: number): [number, number, number] => {
      const th = th0 + (th1 - th0) * t;
      return [H.cu + H.r * Math.cos(th), H.cv + H.r * Math.sin(th), T.top + 0.2 - (T.top + 0.2 - H.yEnd) * t];
    };
    const mouth = at(0);
    pipeF(lm, mouth[0] - 0.6, mouth[1], mouth[2], mouth[0], mouth[1], mouth[2], T.tube, Mat.PLASTIC, OVERHEAD);
    for (let k = 0; k < n; k++) {
      const a = at(k / n), b = at((k + 1) / n);
      const low = Math.min(a[2], b[2]) < 2.2;
      pipeF(lm, a[0], a[1], a[2], b[0], b[1], b[2], T.tube, Mat.PLASTIC, low ? SOLID_F : OVERHEAD);
    }
    const end = at(1);
    const th = th1;
    const tx = -Math.sin(th), tz = Math.cos(th); // tangent of increasing theta
    const runout = 5.2;
    const out: [number, number, number] = [end[0] + tx * runout, end[1] + tz * runout, 0.35];
    pipeF(lm, end[0], end[1], end[2], out[0], out[1], out[2], T.tube, Mat.PLASTIC, SOLID_F);
    // props/pipes.ts draws a pipe rusty when the decay byte of its midpoint cell is >= 150: the slide is a painted
    // tube, so cap the decay of those cells (decay was written from the fields before the landmark stamp)
    const l = g.layout;
    for (const s of l.solids) {
      if (s.kind !== 'pipe' || s.r !== T.tube) continue;
      const li = Math.floor((s.a[0] + s.b[0]) / 2 / CELL), lj = Math.floor((s.a[2] + s.b[2]) / 2 / CELL);
      if (li < 0 || lj < 0 || li >= CHUNK_CELLS || lj >= CHUNK_CELLS) continue;
      const c = cellIdx(li, lj);
      l.decay[c] = Math.min(l.decay[c], SLIDE_DECAY_MAX);
    }
    // steel legs under the helix (every quarter turn) and under the run-out
    for (let k = 1; k < 5; k++) {
      const p = at(k / 5);
      pipeF(lm, p[0], p[1], 0, p[0], p[1], p[2] - T.tube, 0.05, Mat.METAL_PAINTED, SOLID_F);
    }
    pipeF(lm, (end[0] + out[0]) / 2, (end[1] + out[1]) / 2, 0, (end[0] + out[0]) / 2, (end[1] + out[1]) / 2, (end[2] + out[2]) / 2 - T.tube, 0.05, Mat.METAL_PAINTED, SOLID_F);

    // ---- light: skylight grid high up (the hall is a bright box), a warm lamp on the platform
    const sky = kelvinToLinearRGB(6300, 0.01);
    for (let v = 1; v < S - 1; v += 3) for (let u = 1; u < S - 1; u += 3) recessedCells(lm, FixtureKind.SKY_PANEL, u, v, u + 1, v + 1, CEIL, sky, 4200, LightState.ON);
    // loungers along the pool's open side, towels
    for (let k = 0; k < 4; k++) {
      if (lm.rng.chance(0.25)) continue;
      const p = prop(lm, PropKind.LOUNGE_CHAIR, (pu0 + 1 + k * 2) * CELL, (pv1 + 2.2) * CELL, 0, 0, -1, lm.rng.int(0, 2), undefined, lm.rng.range(-0.06, 0.06));
      if (lm.rng.chance(0.35)) g.addProp({ kind: PropKind.TOWEL, variant: lm.rng.int(0, 3), x: p.x, y: 0.37, z: p.z, yaw: p.yaw, scale: 1, flags: 0, seed: lm.rng.next() });
    }
    prop(lm, PropKind.LIFEBUOY, S * CELL - 0.075 - 0.07, 6 * CELL, 1.3, -1, 0, 0);
    emitter(lm, EmitterKind.WATER, (pu0 + pu1) / 2 * CELL, (pv0 + pv1) / 2 * CELL, 0, 0.5);
    emitter(lm, EmitterKind.DRIP, out[0], out[1], T.waterCm / 100 + 0.02, 0.35);
    emitter(lm, EmitterKind.VENT, (S / 2) * CELL, (S / 2) * CELL, CEIL - 0.6, 0.3);
    return { entrances: lm.entrances };
  },
};
