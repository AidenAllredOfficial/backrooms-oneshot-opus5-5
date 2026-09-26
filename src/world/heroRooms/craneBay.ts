// src/world/heroRooms/craneBay.ts — CRANE_BAY hero (WAREHOUSE, PARKING; 16x12, R2 B4): a 9 m high bay with an
// overhead travelling crane. Runway beams on brackets along both long walls, a yellow bridge girder across the bay
// with its hoist trolley, and from it, on two cables, a hook block with a crate slung under it, hanging a metre over
// the floor, perfectly still. Hatched floor markings mark the bay; stacked crates line the walls.
//
// Frame: u across (16 cells), v along (12 cells). Runways along v at u 0.45 m and u W-0.45 m, top at 6.9 m.

import { CELL, WALL_T } from '../../core/constants.ts';
import { CeilKind, DECAL_PAINT_STRIPE, DecalKind, EdgeKind, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey, Zone } from '../../core/index.ts';
import type { LightStateId, ZoneId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, box, claim, DOWN, emitter, fixture, floorDecal, opening, OVERHEAD, pipeF, SOLID_F } from '../landmarks/common.ts';
import type { LandmarkGenerator } from '../landmarks/index.ts';

const W = 16, L = 12;
const CEIL = 9.0;
export const CRANE_BAY = { railY: 6.9, girder: 0.8, hookY: 2.9, loadY: 1.05 } as const;

export const craneBay: LandmarkGenerator = {
  kind: LandmarkKind.CRANE_BAY, storeys: [Storey.SUBLEVEL], weight: 1, footprint: [W, L], heroOnly: true,
  hero: [Zone.WAREHOUSE, Zone.PARKING] as readonly ZoneId[],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const wallMat = Mat.CONCRETE_WALL;
    claim(lm, { floorMat: Mat.CONCRETE_FLOOR, wallMat, ceilMat: Mat.METAL_DECK, ceilKind: CeilKind.TRUSS, ceilCm: CEIL * 100, trimMat: Mat.METAL_PAINTED, zone: Zone.WAREHOUSE });
    for (const u of [6, 7, 8, 9]) opening(lm, u, 0, 0, -1, EdgeKind.HEADER, wallMat, 0, 420);
    opening(lm, lm.rng.int(5, 10), L - 1, 0, 1, EdgeKind.DOORWAY, wallMat, 0, 210);
    const C = CRANE_BAY;
    const u0 = WALL_T / 2, u1 = W * CELL - WALL_T / 2;
    const back = L * CELL - WALL_T / 2;
    const steel = Mat.METAL_PAINTED;
    // runway beams on column brackets along both long walls
    for (const [a, b] of [[u0, u0 + 0.5], [u1 - 0.5, u1]] as [number, number][]) {
      box(lm, a, WALL_T / 2, b, back, C.railY - 0.6, C.railY, steel, OVERHEAD);
      for (let vm = 0.8; vm < back; vm += 3.6) box(lm, a, vm - 0.2, b, vm + 0.2, 0, C.railY - 0.6, steel, SOLID_F);
    }
    // the bridge: a deep girder across the bay with end trucks, a hoist trolley on top
    const gv = lm.rng.range(5.0, 9.4);
    box(lm, u0 + 0.1, gv - 0.35, u1 - 0.1, gv + 0.35, C.railY, C.railY + C.girder, steel, OVERHEAD);
    for (const [a, b] of [[u0, u0 + 0.7], [u1 - 0.7, u1]] as [number, number][]) box(lm, a, gv - 1.2, b, gv + 1.2, C.railY, C.railY + 0.55, steel, OVERHEAD);
    const tu = lm.rng.range(6.0, 13.0);
    box(lm, tu - 0.8, gv - 0.6, tu + 0.8, gv + 0.6, C.railY + C.girder, C.railY + C.girder + 0.7, Mat.METAL_RUST, OVERHEAD);
    box(lm, tu - 0.5, gv - 0.45, tu + 0.5, gv + 0.45, C.railY - 0.45, C.railY, Mat.METAL_RUST, OVERHEAD); // hoist drum under the girder
    // cables, the hook block, slings and the load
    for (const dv of [-0.12, 0.12]) pipeF(lm, tu, gv + dv, C.railY - 0.45, tu, gv + dv, C.hookY + 0.35, 0.012, Mat.METAL_RUST, OVERHEAD);
    box(lm, tu - 0.18, gv - 0.22, tu + 0.18, gv + 0.22, C.hookY, C.hookY + 0.4, Mat.METAL_PAINTED, OVERHEAD);
    pipeF(lm, tu, gv, C.hookY - 0.25, tu, gv, C.hookY, 0.04, Mat.METAL_RUST, OVERHEAD);
    for (const [du, dv] of [[-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]]) {
      pipeF(lm, tu, gv, C.hookY - 0.25, tu + du, gv + dv, C.loadY + 0.8, 0.012, Mat.RUBBER, OVERHEAD);
    }
    const [lx, lz] = lm.f.point(tu, gv);
    g.addProp({ kind: PropKind.CRATE, variant: lm.rng.int(0, 3), x: lx, y: C.loadY, z: lz, yaw: lm.f.yaw(1, 0) + lm.rng.range(-0.1, 0.1), scale: 1, flags: 1, seed: lm.rng.next() });
    // floor: hatched bay border, the drop zone under the hook
    for (const vm of [1.4, back - 1.4]) floorDecal(lm, W * CELL / 2, vm, 0.002, { kind: DECAL_PAINT_STRIPE, sign: false, rot: lm.f.yaw(1, 0), w: 0.15, h: W * CELL - 3.0, alpha: 0.85 });
    for (const um of [1.5, W * CELL - 1.5]) floorDecal(lm, um, L * CELL / 2, 0.002, { kind: DECAL_PAINT_STRIPE, sign: false, rot: lm.f.yaw(0, 1), w: 0.15, h: L * CELL - 3.0, alpha: 0.85 });
    for (let k = -2; k <= 2; k++) floorDecal(lm, tu + k * 0.35, gv, 0.003, { kind: DECAL_PAINT_STRIPE, sign: false, rot: lm.f.yaw(1, 1), w: 0.1, h: 1.6, alpha: 0.7 });
    floorDecal(lm, tu + lm.rng.range(-1, 1), gv + lm.rng.range(-1, 1), 0.004, { kind: DecalKind.OIL, sign: false, rot: lm.rng.range(0, 6.28), w: 1.2, h: 0.9, alpha: 0.6 });
    // crates stacked along the walls
    for (let k = 0; k < 6; k++) {
      const side = k & 1;
      const vm = 2.2 + (k >> 1) * 3.6 + lm.rng.range(-0.3, 0.3);
      const um = side ? u1 - 1.3 : u0 + 1.3;
      const h = lm.rng.int(1, 3);
      for (let i = 0; i < h; i++) {
        const [x, z] = lm.f.point(um + lm.rng.range(-0.05, 0.05), vm + lm.rng.range(-0.05, 0.05));
        g.addProp({ kind: PropKind.CRATE, variant: lm.rng.int(0, 3), x, y: i * 0.8, z, yaw: lm.rng.range(-0.08, 0.08), scale: 1, flags: i === 0 ? 3 : 0, seed: lm.rng.next() });
      }
    }
    // high-bay lamps over the bay, one dead
    const hb = kelvinToLinearRGB(4300, 0.02);
    const dead = lm.rng.int(0, 5);
    let k = 0;
    for (const vm of [3.6, 10.2]) for (const um of [4.2, 9.6, 15.0]) {
      const st: LightStateId = k++ === dead ? LightState.OFF : LightState.ON;
      fixture(lm, FixtureKind.HIGHBAY, um, vm, CEIL - 0.9, DOWN, [1, 0], hb, 3600, st, { shape: 1, w: 0.45, h: 0.45, hum: 0.5 });
    }
    // pendant control box hanging from the trolley
    pipeF(lm, tu + 0.7, gv + 0.5, C.railY - 0.1, tu + 0.7, gv + 0.5, 1.45, 0.008, Mat.RUBBER, OVERHEAD);
    box(lm, tu + 0.62, gv + 0.44, tu + 0.78, gv + 0.56, 1.1, 1.45, Mat.PLASTIC, OVERHEAD);
    emitter(lm, EmitterKind.MACHINE, tu, gv, C.railY, 0.3);
    emitter(lm, EmitterKind.PIPE, u0 + 0.3, L * CELL / 2, C.railY, 0.2);
    return { entrances: lm.entrances };
  },
};
