// src/world/landmarks/skylightHall.ts — SKYLIGHT_HALL (storey 2, 16x12): a 9 m high tiled hall under SKY_PANEL
// skylights (7000 K, 11500 nits on 19% of the ceiling: open sky through glazing, clips on camera; the baker adds
// direct sunlight through them, R2), over a POOL_TILE floor under a thin film of water (WaterRect kind 2) with two
// rows of LOUNGE_CHAIRs facing each other across the hall (WP4).
//
// Frame: u along the hall (16 cells), v across (12 cells). Panels (R2 lighting): 4 x 3 skylights of 1.8 x 2.4 m
// (3 x 4 ceiling tiles) between wide coffers and a wider margin at the walls: 144 of 768 tiles = 19% of the ceiling
// (was 62% at 4000 nits: an evenly glowing ceiling, no contrast). Fewer, brighter openings (the same sky flux as
// 31% at 7000 nits, so the same exposure) keep the hall inside the Poolrooms exposure range while the glazing clips
// (7000 nits read as a light grey grid at the hall's EV ~12.7) and the sun (bake/lights.ts gatherSun) paints crisp
// patches.

import { CELL, CEIL_TILE } from '../../core/constants.ts';
import { CeilKind, CellFlag, EdgeKind, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey, Zone } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, cells, claim, emitter, opening, prop, recessedRect } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const W = 16, L = 12;
const CEIL = 9.0;
/** Panel spans in frame ceiling tiles: [start, end) along u and along v. */
export const SKYLIGHT_PANELS_U: readonly (readonly [number, number])[] = [[3, 6], [10, 13], [19, 22], [26, 29]];
export const SKYLIGHT_PANELS_V: readonly (readonly [number, number])[] = [[4, 8], [10, 14], [16, 20]];
// R2 lighting: 11500 nits (was 4000 on 3.3x the area: the glazing read as a grey grid). The baker (bake/lights.ts
// gatherSun) also admits direct sunlight through these panels: crisp sun patches on the floor and walls.
export const SKYLIGHT = { cct: 7000, luminance: 11500, film: 1 } as const;

export const skylightHall: LandmarkGenerator = {
  kind: LandmarkKind.SKYLIGHT_HALL, storeys: [Storey.POOLROOMS], weight: 1, footprint: [W, L],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const tile = Mat.POOL_TILE;
    claim(lm, { floorMat: tile, wallMat: tile, ceilMat: tile, ceilKind: CeilKind.TILE_GLAZED, ceilCm: CEIL * 100, trimMat: tile, zone: Zone.POOLROOMS });
    // arches at both ends, a doorway in one long wall
    for (const v of [5, 6]) {
      opening(lm, 0, v, -1, 0, EdgeKind.ARCH, tile, 0, 280);
      opening(lm, W - 1, v, 1, 0, EdgeKind.ARCH, tile, 0, 280);
    }
    const side = lm.rng.chance(0.5);
    opening(lm, lm.rng.int(3, W - 4), side ? 0 : L - 1, 0, side ? -1 : 1, EdgeKind.DOORWAY, tile, 0, 210);

    // the water film over the whole floor
    cells(lm, 0, 0, W, L, { waterCm: SKYLIGHT.film, flagsSet: CellFlag.WET });
    const a = lm.f.point(0, 0), b = lm.f.point(W * CELL, L * CELL);
    g.addWater({ x0: Math.min(a[0], b[0]), z0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), z1: Math.max(a[1], b[1]), y: SKYLIGHT.film / 100, floorY: 0, kind: 2 });

    // the skylight: large recessed SKY_PANELs (split at render-tile lines by recessedRect)
    const day = kelvinToLinearRGB(SKYLIGHT.cct, 0);
    for (const [v0, v1] of SKYLIGHT_PANELS_V) {
      for (const [u0, u1] of SKYLIGHT_PANELS_U) {
        const p = lm.f.point(u0 * CEIL_TILE, v0 * CEIL_TILE), q = lm.f.point(u1 * CEIL_TILE, v1 * CEIL_TILE);
        recessedRect(lm, FixtureKind.SKY_PANEL, Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1]), CEIL, day,
          SKYLIGHT.luminance, LightState.ON);
      }
    }

    // two rows of loungers facing each other across the hall; towels on a few
    for (const [vm, dv] of [[3.1 * CELL, 1], [(L - 3.1) * CELL, -1]] as [number, 1 | -1][]) {
      for (let k = 0; k < 6; k++) {
        if (lm.rng.chance(0.15)) continue; // a gap in the row
        const um = 3.1 + 2.6 * k;
        const p = prop(lm, PropKind.LOUNGE_CHAIR, um, vm, 0, 0, dv, lm.rng.int(0, 3), undefined, lm.rng.range(-0.04, 0.04));
        if (lm.rng.chance(0.3)) {
          g.addProp({ kind: PropKind.TOWEL, variant: lm.rng.int(0, 3), x: p.x, y: 0.37, z: p.z, yaw: p.yaw, scale: 1, flags: 0, seed: lm.rng.next() });
        }
      }
    }
    // the hall hums with ventilation; water laps somewhere far off
    emitter(lm, EmitterKind.VENT, (W * CELL) / 2, (L * CELL) / 2, CEIL - 0.5, 0.35);
    emitter(lm, EmitterKind.WATER, (W * CELL) / 2, (L * CELL) / 2, 0.02, 0.12);
    return { entrances: lm.entrances };
  },
};
