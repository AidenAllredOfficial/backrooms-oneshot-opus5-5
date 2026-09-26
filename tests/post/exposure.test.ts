// tests/post/exposure.test.ts (WP11) — auto-exposure maths and the dynamic-resolution controller.
import { describe, expect, it } from 'vitest';
import { ADAPT, ev100FromLog2, exposureFromEv, meterClamp, packLog2, stepExposure, unpackLog2 } from '../../src/post/exposureMath.ts';
import type { ExposureState } from '../../src/post/exposureMath.ts';
import { createScaleController, DYNRES } from '../../src/post/DynamicResolution.ts';
import { PHOTOMETRY } from '../../src/core/constants.ts';

describe('exposure maths', () => {
  it('packs log2 luminance into 16 bits with < 0.001 EV error', () => {
    for (let v = -15.9; v < 15.9; v += 0.0371) {
      const [hi, lo] = packLog2(v);
      expect(hi).toBeGreaterThanOrEqual(0); expect(hi).toBeLessThanOrEqual(255);
      expect(lo).toBeGreaterThanOrEqual(0); expect(lo).toBeLessThanOrEqual(255);
      expect(Math.abs(unpackLog2(hi, lo) - v)).toBeLessThan(0.001);
    }
  });

  it('EV100 calibration: K = 12.5, exposure = 1 / (1.2 * 2^EV)', () => {
    // an 18 % grey card under ~640 lux reads EV ~ 8.9: L = 0.18 * 640 / PI = 36.7 nits
    const L = 0.18 * 640 / Math.PI;
    expect(ev100FromLog2(Math.log2(L))).toBeCloseTo(Math.log2(L * 100 / 12.5), 10);
    expect(exposureFromEv(PHOTOMETRY.EV100_L0, 0, 0)).toBeCloseTo(1 / (1.2 * 2 ** 9.4), 12);
    // + bias and + brightness both brighten by one stop each
    expect(exposureFromEv(9, 1, 0)).toBeCloseTo(2 * exposureFromEv(9, 0, 0), 12);
    expect(exposureFromEv(9, 0, 1)).toBeCloseTo(2 * exposureFromEv(9, 0, 0), 12);
    // the meter clamps a pixel at 2^(EV+3) * 12.5/100 = 2^EV nits (8x the average)
    expect(meterClamp(8)).toBeCloseTo(256, 9);
  });

  it('adapts fast toward brighter, slow toward darker, and settles', () => {
    const up: ExposureState = { ev: 7, vel: 0 };
    const down: ExposureState = { ev: 9, vel: 0 };
    for (let i = 0; i < 60; i++) { stepExposure(up, 9, 1 / 60); stepExposure(down, 7, 1 / 60); }
    const upProgress = (up.ev - 7) / 2;
    const downProgress = (9 - down.ev) / 2;
    expect(upProgress).toBeGreaterThan(0.8); // tau 0.6 s
    expect(downProgress).toBeGreaterThan(0.1);
    expect(downProgress).toBeLessThan(0.35); // tau 2.5 s
    for (let i = 0; i < 60 * 20; i++) { stepExposure(up, 9, 1 / 60); stepExposure(down, 7, 1 / 60); }
    expect(up.ev).toBeCloseTo(9, 3);
    expect(down.ev).toBeCloseTo(7, 2);
    expect(ADAPT.ZETA).toBeLessThan(1); // slight hunting (camcorder)
  });

  it('reaches ~63 % at t = tau', () => {
    const a: ExposureState = { ev: 0, vel: 0 };
    for (let i = 0; i < 36; i++) stepExposure(a, 1, 1 / 60); // 0.6 s
    expect(a.ev).toBeGreaterThan(0.6);
    expect(a.ev).toBeLessThan(0.8);
  });

  it('is frame-rate independent within 2 %', () => {
    const a: ExposureState = { ev: 6, vel: 0 };
    const b: ExposureState = { ev: 6, vel: 0 };
    for (let i = 0; i < 30; i++) stepExposure(a, 10, 1 / 30);
    for (let i = 0; i < 144; i++) stepExposure(b, 10, 1 / 144);
    expect(Math.abs(a.ev - b.ev)).toBeLessThan(0.08);
  });
});

describe('dynamic resolution controller', () => {
  it('drops by 0.1 when p95 > 18 ms, floors at 0.6, recovers by 0.05 when p95 < 12 ms, capped at the preset', () => {
    const c = createScaleController(1.0);
    const run = (ms: number, seconds: number): number[] => {
      const out: number[] = [];
      for (let t = 0; t < seconds * 1000; t += ms) {
        const r = c.push(ms);
        if (!Number.isNaN(r)) out.push(r);
      }
      return out;
    };
    expect(run(25, 2.3)).toEqual([0.9]);
    const downs = run(25, 20);
    expect(downs[downs.length - 1]).toBe(DYNRES.MIN);
    expect(Math.min(...downs)).toBeGreaterThanOrEqual(DYNRES.MIN);
    const ups = run(8, 40);
    expect(ups[0]).toBeCloseTo(0.65, 10);
    expect(ups[ups.length - 1]).toBe(1.0);
    expect(run(15, 10)).toEqual([]); // between the thresholds: stable
  });

  it('uses the p95, not the mean', () => {
    const c = createScaleController(1.0);
    let changed = NaN;
    // 94 % fast frames, 6 % hitches: p95 = hitch
    for (let i = 0; i < 400 && Number.isNaN(changed); i++) changed = c.push(i % 50 < 3 ? 30 : 8);
    expect(changed).toBe(0.9);
  });
});
