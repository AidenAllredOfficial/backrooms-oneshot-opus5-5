// src/world/landmarks/chairCathedral.ts — CHAIR_CATHEDRAL (storey 0, 24x24): a 7.2 m nave with two pillar rows, every
// light dead except one PENDANT_LINEAR over a lone CHAIR_STACKING in the centre, facing away from the entrance (WP4).

import { CELL } from '../../core/constants.ts';
import { CeilKind, CellFlag, EdgeKind, EdgeTrim, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, cells, claim, DOWN, fixture, opening, prop, recessedRect } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const S = 24;
const CEIL = 7.2;

export const chairCathedral: LandmarkGenerator = {
  kind: LandmarkKind.CHAIR_CATHEDRAL, storeys: [Storey.LOBBY], weight: 0.8, footprint: [S, S],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, S, S);
    if (!lm) return { entrances: [] };
    const wallMat = Mat.WALLPAPER_L0;
    claim(lm, { floorMat: Mat.CARPET_L0, wallMat, ceilMat: Mat.CEILING_TILE, ceilKind: CeilKind.TILES, ceilCm: CEIL * 100, baseboard: true });
    // main entrance: a wide header at the foot of the nave; side doors
    opening(lm, 11, 0, 0, -1, EdgeKind.HEADER, wallMat, 0, 300);
    opening(lm, 12, 0, 0, -1, EdgeKind.HEADER, wallMat, 0, 300);
    opening(lm, 0, lm.rng.int(4, 9), -1, 0, EdgeKind.DOORWAY, wallMat, EdgeTrim.CASING, 210);
    opening(lm, S - 1, lm.rng.int(14, 19), 1, 0, EdgeKind.DOORWAY, wallMat, EdgeTrim.CASING, 210);
    // two rows of square pillars along the nave (SOLID cells: full-height masses)
    const pillars: [number, number][] = [];
    for (const u of [6, 17]) for (const v of [4, 9, 14, 19]) pillars.push([u, v]);
    for (const [u, v] of pillars) cells(lm, u, v, u + 1, v + 1, { flagsSet: CellFlag.SOLID });
    // a dead troffer grid at 7.2 m
    const dead = kelvinToLinearRGB(4100, 0.03);
    for (let v = 1; v < S; v += 4) for (let u = 2; u < S; u += 4) {
      if (pillars.some(([pu, pv]) => pu === u && pv === v)) continue;
      const a = lm.f.point(u * CELL, v * CELL), b = lm.f.point(u * CELL + 0.6, v * CELL + 1.2);
      recessedRect(lm, FixtureKind.TROFFER_2x4, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), CEIL, dead, 3300, LightState.OFF);
    }
    // the one light: a linear pendant hung 3.2 m above the floor, over the chair
    const c = (S / 2) * CELL;
    fixture(lm, FixtureKind.PENDANT_LINEAR, c, c, 3.2, DOWN, [1, 0], kelvinToLinearRGB(3600, 0.02), 6000, LightState.ON, { hum: 0.4 });
    // the chair, in the centre, facing away from the entrance (+v)
    prop(lm, PropKind.CHAIR_STACKING, c, c + 0.15, 0, 0, 1, 0, undefined, lm.rng.range(-0.08, 0.08));
    return { entrances: lm.entrances };
  },
};
