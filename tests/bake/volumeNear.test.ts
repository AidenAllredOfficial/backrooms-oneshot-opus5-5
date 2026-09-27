// tests/bake/volumeNear.test.ts — prop light volume near-field (bake/volume.ts with BakeQuality.nearRays): samples
// under a desk are in its shadow and lose the far-field light the desk hides, samples above it are lit (the cell
// bitset's point below the desk top is not), samples well above are nearly unchanged.

import { describe, expect, it } from 'vitest';
import { LV } from '../../src/core/constants.ts';
import type { TileKey } from '../../src/core/grid.ts';
import { fromHalf } from '../../src/core/half.ts';
import { PropKind } from '../../src/core/ids.ts';
import type { BakeQuality } from '../../src/core/quality.ts';
import { bakeTile } from '../../src/bake/index.ts';
import { Q_HIGH, addLight, carveRoom, handNeighborhood, solidLayout, surfacesOf } from './helpers.ts';

const TILE: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };
const Q16: BakeQuality = { ...Q_HIGH, nearRays: 16 };

/** Light-volume luminance (a.rgb) of the sample (i, k, j). */
function lv(a: Uint16Array, i: number, k: number, j: number): number {
  const o = ((j * LV.NY + k) * LV.NX + i) * 4;
  return 0.2126 * fromHalf(a[o]) + 0.7152 * fromHalf(a[o + 1]) + 0.0722 * fromHalf(a[o + 2]);
}

describe('light volume near a desk', () => {
  // desk centred on the cell centre (9.0, 9.0) (its top covers the cell's bitset points below 0.72 m), a troffer
  // above it; LV samples at x, z = 8.7 (i = j = 14) lie over / under the desk, x = 10.5 (i = 17) beside it
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15);
  addLight(l, { px: 9.0, pz: 9.0, py: 2.7 });
  addLight(l, { px: 6.6, pz: 9.0, py: 2.7 });
  addLight(l, { px: 11.4, pz: 9.0, py: 2.7 });
  l.props.push({ kind: PropKind.DESK, variant: 0, x: 9.0, y: 0, z: 9.0, yaw: 0, scale: 1, flags: 0, seed: 1 });
  const nb = handNeighborhood(l);
  const s = surfacesOf(nb, TILE, 12);
  const far = bakeTile(nb, TILE, s, 'full', Q_HIGH, 'all').volume.a;
  const near = bakeTile(nb, TILE, s, 'full', Q16, 'all').volume.a;
  const nearDirect = bakeTile(nb, TILE, s, 'full', Q16, 'direct').volume.a;

  it('the sample under the desk (0.2 m) gets <= 0.6x the light of the sample 1.8 m beside it', () => {
    const under = lv(near, 14, 0, 14), beside = lv(near, 17, 0, 14);
    expect(beside).toBeGreaterThan(20);
    expect(under).toBeLessThan(0.6 * beside);
  });

  it('the sample over the desk top (0.8 m) is lit by the troffer above it (the bitset point under the desk top is not)', () => {
    const over = lv(nearDirect, 14, 1, 14);
    expect(over).toBeGreaterThan(0.5 * lv(nearDirect, 17, 1, 14));
    expect(lv(near, 14, 1, 14)).toBeGreaterThan(1.5 * lv(far, 14, 1, 14));
  });

  it('the sample 1.5 m up changes < 10%, the one at 2.3 m < 3%', () => {
    for (const [k, tol] of [[2, 0.1], [3, 0.03]]) {
      const a = lv(far, 14, k, 14), b = lv(near, 14, k, 14);
      expect(a).toBeGreaterThan(20);
      expect(Math.abs(b - a) / a, `k ${k}`).toBeLessThan(tol);
    }
  });
});
