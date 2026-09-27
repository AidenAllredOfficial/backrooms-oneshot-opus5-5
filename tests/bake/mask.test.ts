// tests/bake/mask.test.ts — surface mask (WP7 bake/mask.ts) details that the lightmap-level tests do not isolate: the
// pool splash zone (package B): wet deck within 1.2 m of a pool's water edge, nothing on the pool's own floor or far
// from it, and the same value at the same world point whichever tile's bake evaluates it (seamless tiles).

import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import type { TileKey } from '../../src/core/grid.ts';
import { cellIdx } from '../../src/core/grid.ts';
import { createJob } from '../../src/bake/job.ts';
import { createMaskCache, maskAt, maskOut } from '../../src/bake/mask.ts';
import { carveRoom, handNeighborhood, Q_HIGH, solidLayout } from './helpers.ts';

describe('surface mask: pool splash zone', () => {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 2, 2, 30, 30);
  for (let c = 0; c < 1024; c++) { l.decay[c] = 0; l.humidity[c] = 0; } // no humidity puddles: splash only
  // a pool of cells i 12..16 (x 14.4 .. 19.2 m: its east edge is the q0 | q1 tile line), j 10..20
  for (let j = 10; j < 20; j++) for (let i = 12; i < 16; i++) { l.floorCm[cellIdx(i, j)] = -150; l.waterCm[cellIdx(i, j)] = -20; }
  l.water.push({ x0: 12 * CELL, z0: 10 * CELL, x1: 16 * CELL, z1: 20 * CELL, y: -0.2, floorY: -1.5, kind: 0 });
  const nb = handNeighborhood(l);
  const tiles: TileKey[] = [{ s: 0, cx: 0, cz: 0, q: 0 }, { s: 0, cx: 0, cz: 0, q: 1 }];
  const jobs = tiles.map((t) => createJob(nb, t, Q_HIGH, null));
  const caches = jobs.map((j) => createMaskCache(j));
  /** Mask B of an up-facing floor texel at world (chunk-local) metres (x, z), evaluated by tile k's bake. */
  const wetAt = (k: number, x: number, z: number): number => {
    const g = jobs[k].g;
    const hx = x / CELL - g.gi0, hz = z / CELL - g.gj0;
    const c = Math.floor(hz) * g.n + Math.floor(hx);
    maskAt(jobs[k], caches[k], hx, g.floor[c], hz, 0, 1, 0, c, 1, 9);
    return maskOut.b;
  };

  it('wets the deck next to the water, fading out by 1.2 m, and leaves the pool floor and far floors dry', () => {
    let near = 0;
    for (let z = 12.1; z < 23.9; z += 0.37) near = Math.max(near, wetAt(1, 19.2 + 0.05, z));
    expect(near).toBeGreaterThan(0.4);
    expect(near).toBeLessThanOrEqual(0.75 + 1e-9);
    for (let z = 12.1; z < 23.9; z += 0.37) expect(wetAt(1, 19.2 + 1.25, z)).toBe(0);
    expect(wetAt(0, 16.5, 18)).toBe(0); // the submerged pool floor (below the water line)
    expect(wetAt(1, 30, 18)).toBe(0);
  });

  it('is seamless: both tiles bake the same value at the same world point', () => {
    let n = 0;
    for (let x = 18.5; x < 20.4; x += 0.13) {
      for (let z = 11.5; z < 24.5; z += 0.29) {
        expect(wetAt(0, x, z), `(${x}, ${z})`).toBeCloseTo(wetAt(1, x, z), 9); // (the mask is stored as bytes)
        if (wetAt(0, x, z) > 0) n++;
      }
    }
    expect(n).toBeGreaterThan(20);
  });
});
