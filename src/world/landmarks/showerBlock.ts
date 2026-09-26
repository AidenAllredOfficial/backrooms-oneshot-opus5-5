// src/world/landmarks/showerBlock.ts — SHOWER_BLOCK (storey 2 + hero on the storey's tiled districts; 10x8, R2 B4):
// two facing rows of open shower bays behind tiled half-walls, chrome heads and mixer valves on every back wall, a
// long slatted bench down the middle, a thin skin of water over the whole mosaic floor, drains, steam, and one shower
// that is still running.
//
// Frame: u along (10 cells), v across (8 cells). Bays: cells u 1..9 of rows v = 0 and v = 7, divided by 180 cm
// PARTITION edges; the aisle v 1..6 between them. Entrances: both u ends of the aisle.

import { CELL, WALL_T } from '../../core/constants.ts';
import { CeilKind, CellFlag, DecalKind, EdgeKind, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey, Zone } from '../../core/index.ts';
import type { LightStateId, ZoneId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, box, cells, claim, DOWN, emitter, fixture, floorDecal, opening, pipeF, prop, THIN_F, waterRect } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const W = 10, L = 8;
const CEIL = 3.0;
export const SHOWER_BLOCK = { bays: [1, 9] as const, partitionCm: 180, filmCm: 1 } as const;

export const showerBlock: LandmarkGenerator = {
  kind: LandmarkKind.SHOWER_BLOCK, storeys: [Storey.POOLROOMS], weight: 1, footprint: [W, L],
  hero: [Zone.LOW_EXPANSE, Zone.MANILA, Zone.CONCRETE] as readonly ZoneId[],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const tile = Mat.POOL_TILE;
    claim(lm, { floorMat: Mat.POOL_MOSAIC, wallMat: tile, ceilMat: tile, ceilKind: CeilKind.TILE_GLAZED, ceilCm: CEIL * 100, trimMat: tile, zone: Zone.POOLROOMS });
    for (const v of [3, 4]) {
      opening(lm, 0, v, -1, 0, EdgeKind.ARCH, tile, 0, 240);
      opening(lm, W - 1, v, 1, 0, EdgeKind.ARCH, tile, 0, 240);
    }
    const [b0, b1] = SHOWER_BLOCK.bays;
    // bay dividers: tiled half-walls across the bay rows
    for (const v of [0, L - 1]) {
      for (let u = b0; u <= b1; u++) lm.f.setEdge(g, u - 1, v, u, v, EdgeKind.PARTITION, tile, tile, { hA: SHOWER_BLOCK.partitionCm, trim: 0 });
    }
    // the water film over the whole floor
    cells(lm, 0, 0, W, L, { waterCm: SHOWER_BLOCK.filmCm, flagsSet: CellFlag.WET });
    waterRect(lm, 0, 0, W, L, SHOWER_BLOCK.filmCm / 100, 0, 2);

    // heads and valves on every bay's back wall; one shower still running
    const running = lm.rng.int(b0, b1 - 1);
    const chrome = Mat.METAL_PAINTED;
    for (const [v, dv] of [[0, 1], [L - 1, -1]] as [number, number][]) {
      const wallV = v === 0 ? WALL_T / 2 : L * CELL - WALL_T / 2;
      for (let u = b0; u < b1; u++) {
        const um = (u + 0.5) * CELL;
        pipeF(lm, um, wallV, 1.0, um, wallV, 2.05, 0.014, chrome, THIN_F); // riser
        pipeF(lm, um, wallV, 2.05, um, wallV + dv * 0.3, 2.0, 0.014, chrome, THIN_F); // arm
        pipeF(lm, um, wallV + dv * 0.28, 2.0, um, wallV + dv * 0.3, 1.94, 0.06, chrome, THIN_F); // head
        prop(lm, PropKind.PIPE_VALVE, um, wallV + dv * 0.1, 1.05, 0, dv, 0);
        floorDecal(lm, um, wallV + dv * 0.7, SHOWER_BLOCK.filmCm / 100 + 0.002, { kind: DecalKind.DRAIN, sign: false, rot: 0, w: 0.22, h: 0.22, alpha: 0.95 });
        if (u === running && v === 0) {
          emitter(lm, EmitterKind.WATER, um, wallV + dv * 0.5, 1.2, 0.55);
          emitter(lm, EmitterKind.STEAM, um, wallV + dv * 0.5, 2.2, 0.25);
          floorDecal(lm, um, wallV + dv * 0.55, SHOWER_BLOCK.filmCm / 100 + 0.003, { kind: DecalKind.WATER_STAIN, sign: false, rot: lm.rng.range(0, 6.28), w: 1.0, h: 1.0, alpha: 0.5 });
        }
        if (lm.rng.chance(0.2)) floorDecal(lm, um + lm.rng.range(-0.3, 0.3), wallV + dv * 0.8, SHOWER_BLOCK.filmCm / 100 + 0.003, { kind: DecalKind.MOLD, sign: false, rot: lm.rng.range(0, 6.28), w: 0.8, h: 0.5, alpha: 0.5 });
      }
    }
    // the bench: slats on steel legs down the middle of the aisle, towels left on it
    const bv = (L / 2) * CELL;
    const bu0 = 2 * CELL, bu1 = (W - 2) * CELL;
    for (let k = 0; k < 4; k++) box(lm, bu0, bv - 0.24 + k * 0.125, bu1, bv - 0.16 + k * 0.125, 0.42, 0.46, Mat.WOOD, THIN_F);
    for (let um = bu0 + 0.2; um < bu1; um += 1.6) box(lm, um, bv - 0.22, um + 0.05, bv + 0.22, 0, 0.42, chrome, THIN_F);
    for (let k = 0; k < 3; k++) {
      if (!lm.rng.chance(0.55)) continue;
      const [x, z] = lm.f.point(lm.rng.range(bu0 + 0.5, bu1 - 0.5), bv);
      g.addProp({ kind: PropKind.TOWEL, variant: lm.rng.int(0, 3), x, y: 0.46, z, yaw: lm.f.yaw(0, 1) + Math.PI / 2 + lm.rng.range(-0.3, 0.3), scale: 1, flags: 0, seed: lm.rng.next() });
    }
    prop(lm, PropKind.BUCKET, 0.5, 1.4, 0, 1, 0, 0, undefined, lm.rng.range(0, 3));
    // light: two battens along the aisle (one dying), a caged bulb at each end
    const col = kelvinToLinearRGB(4800, 0.04);
    const r = lm.rng.float();
    const st: LightStateId = r < 0.4 ? LightState.DYING : r < 0.6 ? LightState.FLICKER : LightState.ON;
    fixture(lm, FixtureKind.TUBE_STRIP, 3 * CELL, bv, CEIL - 0.05, DOWN, [1, 0], col, 8600, LightState.ON);
    fixture(lm, FixtureKind.TUBE_STRIP, 7 * CELL, bv, CEIL - 0.05, DOWN, [1, 0], col, 8600, st);
    for (const um of [0.6, W * CELL - 0.6]) fixture(lm, FixtureKind.CAGE_BULB, um, bv + 1.5, CEIL - 0.3, DOWN, [1, 0], kelvinToLinearRGB(3200, 0), 120, LightState.ON, { shape: 1, w: 0.1, h: 0.1, hum: 0.2 });
    emitter(lm, EmitterKind.DRIP, 5 * CELL, (L - 0.5) * CELL, 0.05, 0.35);
    return { entrances: lm.entrances };
  },
};
