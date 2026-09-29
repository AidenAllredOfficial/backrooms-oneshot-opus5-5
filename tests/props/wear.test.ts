// tests/props/wear.test.ts — texture realism v2 lane E: the prop wear threshold (chunks/family/props.ts). The exposed
// share over a rank-normalised W (P(W < x) = x) must equal the wear level at every ramp width, so the wear does not
// brighten or fade with distance when the footprint widens the ramp (mip-linear), and it is monotonic in the level.

import { describe, expect, it } from 'vitest';
import { wearExposure } from '../../src/materials/chunks/family/props.ts';

const meanExposure = (a: number, l: number, n = 20000): number => {
  let s = 0;
  for (let i = 0; i < n; i++) s += wearExposure((i + 0.5) / n, a, l);
  return s / n;
};

describe('prop wear exposure', () => {
  it('the mean over a uniform W is the level, for every ramp half-width', () => {
    for (const a of [0.01, 0.05, 0.15, 0.3, 0.5]) {
      for (const l of [0, 0.002, 0.01, 0.03, 0.1, 0.25, 0.5, 0.8, 0.97, 1]) {
        expect(Math.abs(meanExposure(a, l) - l), `a ${a} l ${l}`).toBeLessThan(2e-3);
      }
    }
  });

  it('is monotonic in the level and exactly 0 / 1 at the ends', () => {
    for (const a of [0.02, 0.3]) {
      for (const w of [0, 0.2, 0.5, 0.9]) {
        let prev = -1;
        for (let l = 0; l <= 1.0001; l += 0.01) {
          const e = wearExposure(w, a, l);
          expect(e).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = e;
        }
      }
      expect(wearExposure(0.3, a, 0)).toBe(0);
      expect(wearExposure(0.7, a, 1)).toBe(1);
    }
  });
});
