// tests/bake/ao.test.ts — analytic AO regressions (src/bake/ao.ts).
//   - a long straight wall darkens a receiver strip running along it UNIFORMLY: the 1.2 m edge segments of one wall
//     line count once (min distance per line), not once per segment (the old per-segment product gave a lumpy
//     1.2 m-periodic dark band along every ceiling-wall junction);
//   - a room corner is still darker than the middle of a wall (two perpendicular lines).

import { describe, expect, it } from 'vitest';
import { STD_CEIL_CM } from '../../src/core/constants.ts';
import type { TileKey } from '../../src/core/grid.ts';
import { aoAt, aoOut } from '../../src/bake/ao.ts';
import { createJob } from '../../src/bake/job.ts';
import { Q_HIGH, carveRoom, handNeighborhood, solidLayout } from './helpers.ts';

const TILE: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };

describe('AO along a long straight wall', () => {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15);
  const job = createJob(handNeighborhood(l), TILE, Q_HIGH, null);
  const g = job.g, n = g.n;
  const ceil = STD_CEIL_CM / 100;
  /** AO of a receiver at chunk-local cell coordinates (x, z), height y, normal n. */
  const ao = (x: number, z: number, y: number, nx: number, ny: number, nz: number): number => {
    const hx = x - g.hl0, hz = z - g.hm0;
    const c = Math.floor(hz) * n + Math.floor(hx);
    aoAt(job, hx, y, hz, nx, ny, nz, c, 0, false);
    return aoOut.ao;
  };

  it('is uniform along the wall (ceiling strip and floor strip, several offsets)', () => {
    for (const [y, ny] of [[ceil - 0.02, -1], [0.02, 1]] as const) {
      for (const off of [0.12, 0.25, 0.5]) {
        let lo = Infinity, hi = -Infinity;
        for (let x = 3; x <= 12; x += 0.05) {
          const a = ao(x, 1 + off, y, 0, ny, 0);
          if (a < lo) lo = a;
          if (a > hi) hi = a;
        }
        expect(hi / lo, `y ${y} offset ${off} cells`).toBeLessThan(1.005);
      }
    }
  });
  it('still darkens a corner more than the middle of a wall', () => {
    const mid = ao(8, 1.2, ceil - 0.02, 0, -1, 0);
    const corner = ao(1.2, 1.2, ceil - 0.02, 0, -1, 0);
    expect(corner).toBeLessThan(mid * 0.95);
  });
});
