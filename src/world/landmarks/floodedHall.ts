// src/world/landmarks/floodedHall.ts — FLOODED_HALL (storeys 0, 1; 12x16): 25 cm of standing water everywhere, dying
// lights, drips, puddles spreading out of the doors, drifting furniture (WP4).

import { CELL } from '../../core/constants.ts';
import { CeilKind, CellFlag, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey, TileState, setTile } from '../../core/index.ts';
import type { LightStateId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, cells, claim, DOWN, emitter, fixture, opening, prop, recessedRect } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const W = 12, L = 16;

export const floodedHall: LandmarkGenerator = {
  kind: LandmarkKind.FLOODED_HALL, storeys: [Storey.LOBBY, Storey.SUBLEVEL], weight: 1, footprint: [W, L],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const deep = ctx.key.s === Storey.SUBLEVEL;
    const wallMat = deep ? Mat.CMU_PAINTED : Mat.WALLPAPER_L0;
    const ceil = deep ? 3.0 : 2.7;
    claim(lm, deep
      ? { floorMat: Mat.CONCRETE_FLOOR, wallMat, ceilMat: Mat.CONCRETE_CEIL, ceilKind: CeilKind.CONCRETE, ceilCm: ceil * 100 }
      : { floorMat: Mat.CARPET_L0, wallMat, ceilMat: Mat.CEILING_TILE, ceilKind: CeilKind.TILES, ceilCm: ceil * 100, baseboard: true });
    cells(lm, 0, 0, W, L, { waterCm: 25, flagsSet: CellFlag.WET });
    const a = lm.f.point(0, 0), b = lm.f.point(W * CELL, L * CELL);
    g.addWater({ x0: Math.min(a[0], b[0]), z0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), z1: Math.max(a[1], b[1]), y: 0.25, floorY: 0, kind: 1 });
    // openings: both ends and one side
    const e0 = lm.rng.int(3, W - 4), e1 = lm.rng.int(3, W - 4);
    opening(lm, e0, 0, 0, -1, EdgeKind.HEADER, wallMat, deep ? 0 : EdgeTrim.BASEBOARD, 220);
    opening(lm, e0 + 1, 0, 0, -1, EdgeKind.HEADER, wallMat, deep ? 0 : EdgeTrim.BASEBOARD, 220);
    opening(lm, e1, L - 1, 0, 1, EdgeKind.DOORWAY, wallMat, deep ? 0 : EdgeTrim.CASING, 210);
    const west = lm.rng.chance(0.5);
    opening(lm, west ? 0 : W - 1, lm.rng.int(5, L - 6), west ? -1 : 1, 0, EdgeKind.DOORWAY, wallMat, deep ? 0 : EdgeTrim.CASING, 210);
    // dying lights on a 4-cell grid
    const col = kelvinToLinearRGB(deep ? 4000 : 4200, 0.04);
    let flick = false;
    for (let v = 1; v < L; v += 4) for (let u = 1; u < W; u += 4) {
      const r = lm.rng.float();
      let st: LightStateId = r < 0.62 ? LightState.DYING : r < 0.85 ? LightState.OFF : LightState.ON;
      if (!flick && r > 0.95) { st = LightState.FLICKER; flick = true; }
      if (deep) fixture(lm, FixtureKind.TUBE_STRIP, (u + 1) * CELL, (v + 0.5) * CELL, ceil - 0.05, DOWN, [1, 0], col, 8600, st);
      else {
        const p = lm.f.point(u * CELL + 0.6, v * CELL), q = lm.f.point(u * CELL + 1.2, v * CELL + 1.2);
        recessedRect(lm, FixtureKind.TROFFER_2x4, Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1]), ceil, col, 3300, st);
      }
    }
    // water damage above: stained / sagging / missing tiles
    const l = g.layout;
    if (!deep) {
      const [i0, j0, i1, j1] = lm.f.rect();
      for (let lj = j0; lj < j1; lj++) for (let li = i0; li < i1; li++) {
        const c = lj * 32 + li;
        for (let t = 0; t < 4; t++) {
          if (((l.tiles[c] >> (t * 4)) & 15) !== 0) continue;
          const r = lm.rng.float();
          if (r < 0.3) setTile(l.tiles, c, t, TileState.STAINED);
          else if (r < 0.38) setTile(l.tiles, c, t, TileState.SAGGING);
          else if (r < 0.42) setTile(l.tiles, c, t, TileState.MISSING);
        }
      }
    }
    // leaks + drips feeding the flood, a low water hum
    for (let k = 0; k < 3; k++) {
      const um = lm.rng.range(1.5, W * CELL - 1.5), vm = lm.rng.range(1.5, L * CELL - 1.5);
      const [x, z] = lm.f.point(um, vm);
      g.addLeak({ x, y: ceil, z, strength: lm.rng.range(0.6, 1) });
      emitter(lm, EmitterKind.DRIP, um, vm, 0.26, 0.4);
    }
    emitter(lm, EmitterKind.WATER, W * CELL / 2, L * CELL / 2, 0.3, 0.2);
    // furniture adrift
    const drift = [PropKind.CHAIR_STACKING, PropKind.CHAIR_STACKING, PropKind.TRASH_CAN, PropKind.CARDBOARD_BOX, PropKind.CHAIR_STACKING];
    for (const kind of drift) {
      prop(lm, kind, lm.rng.range(1.5, W * CELL - 1.5), lm.rng.range(2, L * CELL - 2), 0, 0, 1, lm.rng.int(0, 2), undefined, lm.rng.range(0, 6.28));
    }
    // puddles spreading out of the openings onto the dry floor outside: placed by placeDecals (content/decals.ts),
    // which runs after the zone has built the outside floor (a decal here would sit on the water plane and z-fight)
    return { entrances: lm.entrances };
  },
};
