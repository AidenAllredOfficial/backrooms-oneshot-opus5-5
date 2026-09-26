// src/world/landmarks/vendingAlcove.ts — VENDING_ALCOVE (storeys 0, 1, 2 (R2: tiled on the Poolrooms storey); 4x3): a shallow alcove off the storey whose
// only real light is 2-3 humming vending machines, each with a VENDING fixture (RECT 0.7 x 1.4, 600 nits, cold
// white) on its lit front panel (WP4).
//
// Frame: u across the alcove (4 cells), v into it (3 cells). The v = 3 side is open to the storey through a wide
// HEADER (underside 230 cm); the machines stand with their backs on the v = 0 wall, facing +v.

import { CELL, WALL_T } from '../../core/constants.ts';
import { CeilKind, DecalKind, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey } from '../../core/index.ts';
import type { LightStateId, MatId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, claim, DOWN, emitter, fixture, floorDecal, opening, prop, recessedRect } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const W = 4, L = 3;
/** Vending machine: 0.9 wide, 0.8 deep (PROP_DEFS); the lit panel sits on its front face. */
const VM_DEPTH = 0.8;
export const VENDING_PANEL = { w: 0.7, h: 1.4, y: 1.05, luminance: 600, cct: 6500 } as const;

export const vendingAlcove: LandmarkGenerator = {
  kind: LandmarkKind.VENDING_ALCOVE, storeys: [Storey.LOBBY, Storey.SUBLEVEL, Storey.POOLROOMS], weight: 1.4, footprint: [W, L],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const deep = ctx.key.s === Storey.SUBLEVEL;
    const pool = ctx.key.s === Storey.POOLROOMS;
    const wallMat: MatId = deep ? Mat.CMU_PAINTED : pool ? Mat.POOL_TILE : Mat.WALLPAPER_L0;
    const ceil = 2.5;
    claim(lm, deep
      ? { floorMat: Mat.VINYL_VCT, wallMat, ceilMat: Mat.CONCRETE_CEIL, ceilKind: CeilKind.CONCRETE, ceilCm: ceil * 100 }
      : pool
        ? { floorMat: Mat.POOL_MOSAIC, wallMat, ceilMat: Mat.POOL_TILE, ceilKind: CeilKind.TILE_GLAZED, ceilCm: ceil * 100, trimMat: Mat.POOL_TILE }
        : { floorMat: Mat.VINYL_VCT, wallMat, ceilMat: Mat.CEILING_TILE, ceilKind: CeilKind.TILES, ceilCm: ceil * 100, baseboard: true });
    // the open front: a wide header across the whole alcove
    for (let u = 0; u < W; u++) opening(lm, u, L - 1, 0, 1, EdgeKind.HEADER, wallMat, deep || pool ? 0 : EdgeTrim.BASEBOARD, 230);

    // 2-3 machines against the back wall, facing out (+v)
    const n = lm.rng.int(2, 3);
    const slots = n === 3 ? [0.95, 2.4, 3.85] : lm.rng.chance(0.5) ? [1.35, 2.55] : [2.25, 3.45];
    const cold = kelvinToLinearRGB(VENDING_PANEL.cct, 0.01);
    const dead = lm.rng.chance(0.25) ? lm.rng.int(0, n - 1) : -1; // sometimes one machine is dark
    const buzz = lm.rng.int(0, n - 1);
    const vmBack = WALL_T / 2 + 0.01;
    for (let k = 0; k < n; k++) {
      const um = slots[k] + lm.rng.range(-0.05, 0.05);
      prop(lm, PropKind.VENDING_MACHINE, um, vmBack + VM_DEPTH / 2, 0, 0, 1, lm.rng.int(0, 3), undefined, lm.rng.range(-0.02, 0.02));
      const state: LightStateId = k === dead ? LightState.OFF : k === buzz ? LightState.BUZZ : LightState.ON;
      fixture(lm, FixtureKind.VENDING, um, vmBack + VM_DEPTH + 0.005, VENDING_PANEL.y, [0, 0, 1], [1, 0], cold, VENDING_PANEL.luminance, state,
        { shape: 0, w: VENDING_PANEL.w, h: VENDING_PANEL.h, hum: 0.5 });
    }
    // compressor hum
    emitter(lm, EmitterKind.MACHINE, (W * CELL) / 2, 0.6, 0.5, 0.3);
    // a trash can in a free front corner, scuffs and a dead ceiling light (the machines are the light)
    if (n === 2) {
      const left = slots[0] > 2; // the free back corner
      prop(lm, PropKind.TRASH_CAN, left ? 0.45 : W * CELL - 0.45, vmBack + 0.3, 0, 0, 1, lm.rng.int(0, 3));
    }
    floorDecal(lm, (W * CELL) / 2 + lm.rng.range(-0.6, 0.6), 1.5, 0, { kind: DecalKind.SCUFF, sign: false, rot: lm.rng.range(0, 6.28), w: 1.2, h: 0.6, alpha: 0.5 });
    if (pool) {
      // a wet tiled nook: towels dumped by the machines, the floor damp
      const [x, z] = lm.f.point(lm.rng.range(1.0, W * CELL - 1.0), 2.4);
      g.addProp({ kind: PropKind.TOWEL, variant: lm.rng.int(0, 3), x, y: 0, z, yaw: lm.rng.range(0, 6.28), scale: 1, flags: 0, seed: lm.rng.next() });
      fixture(lm, FixtureKind.TUBE_STRIP, (W * CELL) / 2, 2.0 * CELL, ceil - 0.05, DOWN, [1, 0], kelvinToLinearRGB(5000, 0.02), 8600, LightState.OFF);
    } else if (deep) {
      fixture(lm, FixtureKind.TUBE_STRIP, (W * CELL) / 2, 2.0 * CELL, ceil - 0.05, DOWN, [1, 0], kelvinToLinearRGB(4000, 0.03), 8600, LightState.OFF);
    } else {
      const a = lm.f.point(2 * CELL - 0.3, 1.5 * CELL - 0.3), b = lm.f.point(2 * CELL + 0.3, 1.5 * CELL + 0.3);
      recessedRect(lm, FixtureKind.TROFFER_2x2, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), ceil,
        kelvinToLinearRGB(4100, 0.03), 3000, LightState.OFF);
    }
    return { entrances: lm.entrances };
  },
};
