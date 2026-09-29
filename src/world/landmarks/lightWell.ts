// src/world/landmarks/lightWell.ts — LIGHT_WELL (storeys 0, 1; 12x12, R2 B4): an ordinary low room ring around a
// 7.2 m square shaft that rises 12 m to a glazed roof of daylight panels. Three tiers of fake floors look into the
// shaft: slab edges with railings and dark or dimly lit window bands, as if the building went on for storeys above.
// The shaft floor holds four benches around a terrazzo square; the light falls straight down onto it.
//
// Frame: u across, v along (12 x 12 cells). Ring: cells outside [3, 9)^2, ceiling 270 cm (Level 0) / 300 (sublevel).
// Shaft: cells [3, 9)^2, ceiling 1200 cm. Openings: a header on every side, in the ring.

import { CELL } from '../../core/constants.ts';
import { CeilKind, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey } from '../../core/index.ts';
import type { LightStateId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import {
  ageCeiling, begin, box, cells, claim, DOWN, emitter, fixture, glowPanel, opening, prop, recessedCells, SOLID_F, storeyStyle, THIN_F, troffer,
} from './common.ts';
import type { Lm } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const S = 12;
export const LIGHT_WELL = { shaft: [3, 9] as const, shaftCm: 1200, tiers: [3.6, 6.4, 9.2] as const } as const;

/** One fake upper floor around the shaft at height y: slab edge, railing posts + top rail, a window band behind. */
function tier(lm: Lm, y: number, lit: boolean): void {
  const [a, b] = LIGHT_WELL.shaft;
  const A = a * CELL, B = b * CELL;
  const d = 0.55; // slab overhang into the shaft
  const slab = Mat.CONCRETE_CEIL;
  // slab edges (four sides, corners overlap)
  box(lm, A, A, B, A + d, y - 0.32, y, slab, SOLID_F);
  box(lm, A, B - d, B, B, y - 0.32, y, slab, SOLID_F);
  box(lm, A, A, A + d, B, y - 0.32, y, slab, SOLID_F);
  box(lm, B - d, A, B, B, y - 0.32, y, slab, SOLID_F);
  // railing: top rail + a post every 1.2 m on each side
  const r = 0.03, top = y + 1.0;
  const rail = Mat.METAL_PAINTED;
  box(lm, A + d - r, A + d - r, B - d + r, A + d + r, top - 0.05, top, rail, THIN_F);
  box(lm, A + d - r, B - d - r, B - d + r, B - d + r, top - 0.05, top, rail, THIN_F);
  box(lm, A + d - r, A + d - r, A + d + r, B - d + r, top - 0.05, top, rail, THIN_F);
  box(lm, B - d - r, A + d - r, B - d + r, B - d + r, top - 0.05, top, rail, THIN_F);
  for (let k = 0; k <= 5; k++) {
    const t = A + d + ((B - A - 2 * d) * k) / 5;
    for (const [um, vm] of [[t, A + d], [t, B - d], [A + d, t], [B - d, t]] as [number, number][]) {
      box(lm, um - 0.02, vm - 0.02, um + 0.02, vm + 0.02, y, top, rail, THIN_F);
    }
  }
  // window band on the shaft walls between the tiers: dark glass boxes, a few lit from inside
  const wy0 = y + 0.9, wy1 = y + 2.2;
  const glass = Mat.PLASTIC; // dark glossy panes (RUBBER is rubber now: bloom, crazing)
  const inset = 0.02;
  for (let k = 0; k < 3; k++) {
    const t0 = A + 0.6 + k * 2.4, t1 = t0 + 1.6;
    box(lm, t0, A - inset, t1, A + inset, wy0, wy1, glass, THIN_F);
    box(lm, t0, B - inset, t1, B + inset, wy0, wy1, glass, THIN_F);
    box(lm, A - inset, t0, A + inset, t1, wy0, wy1, glass, THIN_F);
    box(lm, B - inset, t0, B + inset, t1, wy0, wy1, glass, THIN_F);
  }
  if (lit) {
    // one lit window: a warm panel facing into the shaft (someone left a light on up there)
    const side = lm.rng.int(0, 3), k = lm.rng.int(0, 2);
    const t = A + 0.6 + k * 2.4 + 0.8;
    const pos: [number, number, number, number][] = [[t, A + 0.03, 0, 1], [t, B - 0.03, 0, -1], [A + 0.03, t, 1, 0], [B - 0.03, t, -1, 0]];
    const [um, vm, du, dv] = pos[side];
    glowPanel(lm, um, vm, (wy0 + wy1) / 2, du, dv, 1.5, 1.2, 160, kelvinToLinearRGB(3000, 0));
  }
}

export const lightWell: LandmarkGenerator = {
  kind: LandmarkKind.LIGHT_WELL, storeys: [Storey.LOBBY, Storey.SUBLEVEL], weight: 0.9, footprint: [S, S],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, S, S);
    if (!lm) return { entrances: [] };
    const s = ctx.key.s;
    const deep = s === Storey.SUBLEVEL;
    const ringCm = deep ? 300 : 270;
    const st = storeyStyle(s, ringCm);
    claim(lm, st);
    const wallMat = st.wallMat;
    const [a, b] = LIGHT_WELL.shaft;
    // the shaft: open to 12 m, terrazzo (L0) / concrete floor, plaster walls above the ring ceiling
    cells(lm, a, a, b, b, { ceilCm: LIGHT_WELL.shaftCm, ceilMat: Mat.CONCRETE_CEIL, ceilKind: CeilKind.CONCRETE, floorMat: deep ? Mat.CONCRETE_FLOOR : Mat.TERRAZZO });
    // openings in the ring, one per side (two cells wide on the entry side)
    const trim = deep ? 0 : EdgeTrim.BASEBOARD;
    const m = lm.rng.int(4, 7);
    opening(lm, m, 0, 0, -1, EdgeKind.HEADER, wallMat, trim, 230);
    opening(lm, m + 1, 0, 0, -1, EdgeKind.HEADER, wallMat, trim, 230);
    opening(lm, lm.rng.int(4, 7), S - 1, 0, 1, EdgeKind.DOORWAY, wallMat, deep ? 0 : EdgeTrim.CASING, 210);
    opening(lm, 0, lm.rng.int(4, 7), -1, 0, EdgeKind.DOORWAY, wallMat, deep ? 0 : EdgeTrim.CASING, 210);
    opening(lm, S - 1, lm.rng.int(4, 7), 1, 0, EdgeKind.HEADER, wallMat, trim, 230);

    // three fake upper floors (one lit window somewhere)
    const litTier = lm.rng.int(0, 2);
    LIGHT_WELL.tiers.forEach((y, i) => tier(lm, y, i === litTier));

    // the glazed roof: a 3x3 grid of daylight panels (every other cell), bright, cool
    const day = kelvinToLinearRGB(6200, 0.01);
    for (let v = a; v < b; v += 2) for (let u = a; u < b; u += 2) {
      recessedCells(lm, FixtureKind.SKY_PANEL, u, v, u + 2, v + 2, LIGHT_WELL.shaftCm / 100, day, 5200, LightState.ON);
    }
    // the ring's own lights: sparse, some dead (the well is the bright thing)
    const cold = kelvinToLinearRGB(deep ? 4000 : 4100, 0.03);
    const spots: [number, number][] = [[1, 1], [5, 1], [9, 1], [1, 5], [10, 5], [1, 9], [5, 10], [10, 10]];
    for (const [u, v] of spots) {
      const r = lm.rng.float();
      const stt: LightStateId = r < 0.25 ? LightState.OFF : r < 0.35 ? LightState.DYING : LightState.ON;
      if (deep) fixture(lm, FixtureKind.TUBE_STRIP, (u + 0.5) * CELL, (v + 0.5) * CELL, ringCm / 100 - 0.05, DOWN, [1, 0], cold, 8600, stt);
      else troffer(lm, u * CELL + 0.3, v * CELL, ringCm / 100, cold, 3300, stt);
    }
    if (!deep) ageCeiling(lm, 0.15, 0.03, 0.02);

    // four benches facing the square, a dead planter box in the middle
    const c = ((a + b) / 2) * CELL;
    const r = 2.2;
    prop(lm, PropKind.BENCH_TILED, c, c - r, 0, 0, 1, lm.rng.int(0, 3));
    prop(lm, PropKind.BENCH_TILED, c, c + r, 0, 0, -1, lm.rng.int(0, 3));
    prop(lm, PropKind.BENCH_TILED, c - r, c, 0, 1, 0, lm.rng.int(0, 3));
    prop(lm, PropKind.BENCH_TILED, c + r, c, 0, -1, 0, lm.rng.int(0, 3));
    box(lm, c - 0.6, c - 0.6, c + 0.6, c + 0.6, 0, 0.5, deep ? Mat.CONCRETE_WALL : Mat.TERRAZZO);
    box(lm, c - 0.52, c - 0.52, c + 0.52, c + 0.52, 0.5, 0.52, Mat.CONCRETE_FLOOR, THIN_F);
    emitter(lm, EmitterKind.VENT, c, c, LIGHT_WELL.shaftCm / 100 - 1, 0.4);
    return { entrances: lm.entrances };
  },
};
