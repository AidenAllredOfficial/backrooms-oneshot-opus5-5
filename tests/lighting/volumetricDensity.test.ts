// tests/lighting/volumetricDensity.test.ts (package F) — the living air: mist over the water rects (zero below the
// surface and outside the rect, feathered, e-folding above), the dust noise (mean, periodicity over the noise wrap)
// and the camera-relative noise offsets.

import { describe, expect, it } from 'vitest';
import { NOISE_WRAP } from '../../src/core/constants.ts';
import {
  DUST_PERIODS, dustDensity, dustNoise, MIST_PERIOD, mistEnvelope, noiseOffsets, VD, vnoise3, volumetricDensityGlsl,
  type MistRect,
} from '../../src/lighting/volumetricDensity.ts';

describe('volumetric density', () => {
  const pool: MistRect = { x0: -3, z0: -2, x1: 5, z1: 8, y: -1.5, k: 1 };

  it('mist: zero below the water and outside the rect, feathered at the edge, e-folding every MIST_H above it', () => {
    expect(mistEnvelope([pool], 1, -1.6, 3)).toBe(0); // below the surface
    expect(mistEnvelope([pool], -3.5, -1.4, 3)).toBe(0); // outside
    expect(mistEnvelope([pool], 1, -1.5, 3)).toBeCloseTo(1, 12); // on the surface, deep inside
    const e0 = mistEnvelope([pool], 1, -1.5, 3), e1 = mistEnvelope([pool], 1, -1.5 + VD.MIST_H, 3);
    expect(e1 / e0).toBeCloseTo(Math.exp(-1), 9);
    // feather: rises over MIST_FEATHER m inside the edge
    expect(mistEnvelope([pool], -3 + VD.MIST_FEATHER / 2, -1.5, 3)).toBeCloseTo(0.5, 9);
    expect(mistEnvelope([pool], -3 + VD.MIST_FEATHER, -1.5, 3)).toBeCloseTo(1, 9);
    // kind factor (flooded rooms carry less); overlapping rects take the max, not the sum
    expect(mistEnvelope([{ ...pool, k: VD.MIST_KIND[1] }], 1, -1.5, 3)).toBeCloseTo(0.4, 12);
    expect(mistEnvelope([pool, pool], 1, -1.5, 3)).toBeCloseTo(1, 12);
    expect(VD.MIST_KIND[2]).toBe(0); // film water: no mist
  });

  it('dust: the noise averages 0.5 (the density averages D above the settling layer) and stays in [0, 1]', () => {
    let s = 0, mn = 1, mx = 0;
    const n = 10000;
    for (let i = 0; i < n; i++) {
      const v = dustNoise(i * 0.731 % 97.3, 1.3 + (i * 0.377) % 40, (i * 1.913) % 211);
      s += v; mn = Math.min(mn, v); mx = Math.max(mx, v);
    }
    expect(s / n).toBeGreaterThan(0.47);
    expect(s / n).toBeLessThan(0.53);
    expect(mn).toBeGreaterThanOrEqual(0);
    expect(mx).toBeLessThanOrEqual(1);
    const D = 0.01;
    expect(dustDensity(D, 0.6, 0.5, 50)).toBeCloseTo(D, 12);
    expect(dustDensity(D, 0.6, 0.5, 0)).toBeCloseTo(D * (1 + VD.SETTLE), 12); // settles toward the floor
    expect(dustDensity(D, 1, 0, 50)).toBe(0);
    expect(dustDensity(D, 0, 0.9, 50)).toBeCloseTo(D, 12); // no patchiness: uniform
  });

  it('every noise lattice is periodic over NOISE_WRAP horizontally and PERIOD_Y vertically', () => {
    for (const [x, y, z] of [[3.3, 1.1, -7.2], [1200.7, 60.2, 11.1], [-45.6, 0.3, 1227.9]]) {
      const v = dustNoise(x, y, z);
      expect(dustNoise(x + NOISE_WRAP, y, z)).toBeCloseTo(v, 6);
      expect(dustNoise(x, y, z - NOISE_WRAP)).toBeCloseTo(v, 6);
      expect(dustNoise(x, y + VD.PERIOD_Y, z)).toBeCloseTo(v, 6);
    }
    for (const p of [...DUST_PERIODS, MIST_PERIOD]) for (const c of p) expect(Number.isInteger(c)).toBe(true);
    expect(DUST_PERIODS[0][0] * VD.DUST_CELL[0]).toBeCloseTo(NOISE_WRAP, 9);
    // the lattice wraps exactly at its period
    expect(vnoise3(0.3, 0.7, 0.2, 8, 8, 8, 5)).toBeCloseTo(vnoise3(8.3, 0.7, -7.8, 8, 8, 8, 5), 12);
    const g = volumetricDensityGlsl();
    for (const p of [...DUST_PERIODS, MIST_PERIOD]) expect(g).toContain(`ivec3( ${p.join(', ')} )`);
  });

  it('noise offsets: camera + wind drift wrapped into the periods (float64), continuous in time', () => {
    const o = new Float64Array(6), o2 = new Float64Array(6);
    noiseOffsets(1e6 + 0.25, 1.6, -2.5e5, 3600, o);
    expect(o[0]).toBeGreaterThanOrEqual(0); expect(o[0]).toBeLessThan(NOISE_WRAP);
    expect(o[1]).toBeGreaterThanOrEqual(0); expect(o[1]).toBeLessThan(VD.PERIOD_Y);
    expect(o[2]).toBeGreaterThanOrEqual(0); expect(o[2]).toBeLessThan(NOISE_WRAP);
    expect(o[4]).toBeGreaterThanOrEqual(0); expect(o[4]).toBeLessThan(VD.PERIOD_Y);
    // the noise seen at a fixed world point moves by the wind between two times
    noiseOffsets(1e6 + 0.25, 1.6, -2.5e5, 3601, o2);
    const d = ((o2[0] - o[0]) % NOISE_WRAP + NOISE_WRAP) % NOISE_WRAP;
    expect(d).toBeCloseTo(VD.WIND[0], 6);
  });
});
