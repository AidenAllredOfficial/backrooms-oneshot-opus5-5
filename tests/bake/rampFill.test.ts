// tests/bake/rampFill.test.ts — the baker's view of ramps (visgrid.ts rampSlabThickness, ao.ts):
//   - a FILLED ramp (masonry steps, sides down to the floor) occludes its whole body: the hidden floor under it is
//     inside the occluder (invalid texels, dilated) and no ray passes through it sideways;
//   - an open flight stays a thin slab under its walking line (the space under it is lit through its open sides),
//     but its underside now occludes the analytic AO of the floor under it (receivers inside the ramp's AABB used to
//     skip the ramp: the floor under a low flight got the full room ambient).

import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import type { TileKey } from '../../src/core/grid.ts';
import { Mat, SolidFlag } from '../../src/core/ids.ts';
import { aoAt, aoOut } from '../../src/bake/ao.ts';
import { occluded } from '../../src/bake/dda.ts';
import { createJob } from '../../src/bake/job.ts';
import { FILLED_BASE, insideBox, rampSlabThickness } from '../../src/bake/visgrid.ts';
import { Q_HIGH, carveRoom, handNeighborhood, solidLayout } from './helpers.ts';

const TILE: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };
const BASE = SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.WALKABLE_TOP | SolidFlag.RENDER;

describe('ramp occluders', () => {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15);
  // two 4-step flights 0 -> 0.6 m over 2 cells, ascending +x: open at z cell 4, filled at z cell 9
  const flight = (id: number, j: number, filled: boolean): void => {
    l.solids.push({
      kind: 'ramp', id, x0: 6 * CELL, z0: j * CELL, x1: 8 * CELL, z1: (j + 1) * CELL, y0: 0, y1: 0.6, dir: 0, steps: 4,
      mat: Mat.POOL_TILE, flags: BASE | (filled ? SolidFlag.FILLED : 0), bakeGroup: 0,
    });
  };
  flight(1, 4, false);
  flight(2, 9, true);
  const job = createJob(handNeighborhood(l), TILE, Q_HIGH, null);
  const g = job.g, n = g.n;
  /** halo coordinates of chunk-local cell coordinates */
  const hx = (x: number): number => x - g.hl0, hz = (z: number): number => z - g.hm0;
  const cellOf = (x: number, z: number): number => Math.floor(hz(z)) * n + Math.floor(hx(x));
  const ao = (x: number, z: number, y: number): number => {
    aoAt(job, hx(x), y, hz(z), 0, 1, 0, cellOf(x, z), 0, false);
    return aoOut.ao;
  };

  it('a filled ramp is solid from its walking line down past its low end', () => {
    expect(rampSlabThickness(0, 0.6, 4, true)).toBeCloseTo(0.6 + FILLED_BASE, 12);
    expect(rampSlabThickness(0, 0.6, 4, false)).toBeLessThan(0.05);
    for (const x of [6.1, 6.5, 7.0, 7.5, 7.9]) {
      expect(insideBox(g, cellOf(x, 9.5), hx(x), 0.02, hz(9.5), 0), `filled, floor at x ${x}`).toBe(true);
      if (x > 6.2) expect(insideBox(g, cellOf(x, 4.5), hx(x), 0.02, hz(4.5), 0), `open, floor at x ${x}`).toBe(false);
    }
    // (right at the nose of the first step the walking line is below the floor texel)
    expect(insideBox(g, cellOf(6.01, 9.5), hx(6.01), 0.02, hz(9.5), 0)).toBe(false);
  });

  it('no ray passes through a filled body; the open wedge under a flight lets light through', () => {
    // horizontal rays across the ramp (along z) 0.15 m above the floor near its high end
    expect(occluded(g, hx(7.6), 0.15, hz(8.2), hx(7.6), 0.15, hz(10.8), 0, false)).toBe(true);
    expect(occluded(g, hx(7.6), 0.15, hz(3.2), hx(7.6), 0.15, hz(5.8), 0, false)).toBe(false);
  });

  it('the floor under an open flight is occluded by its underside, the more the lower it hangs', () => {
    const open = [6.4, 7.0, 7.6].map((x) => ao(x, 4.5, 0.02));
    const clear = [6.4, 7.0, 7.6].map((x) => ao(x, 6.5, 0.02)); // the same x, 2 cells away from both flights
    // the underside ~0.08 / 0.28 / 0.46 m above the floor
    expect(open[0]).toBeLessThan(clear[0] * 0.65);
    expect(open[1]).toBeLessThan(clear[1] * 0.8);
    expect(open[2]).toBeLessThan(clear[2] * 0.92);
    // tread texels above the walking line are not occluded by their own ramp
    const h = 0.6 * (7.0 - 6) / 2;
    aoAt(job, hx(7.0), h + 0.02, hz(4.5), 0, 1, 0, cellOf(7.0, 4.5), 0, false);
    const top = aoOut.ao;
    aoAt(job, hx(7.0), h + 0.02, hz(6.5), 0, 1, 0, cellOf(7.0, 6.5), 0, false);
    expect(top).toBeGreaterThan(aoOut.ao * 0.98);
  });
});
