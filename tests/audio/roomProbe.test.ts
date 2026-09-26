// tests/audio/roomProbe.test.ts — WP13 room probe acceptance: Sabine output in a 10x10x2.7 carpet room < 0.6 s, in a
// parking-like 40x40x2.6 concrete room > 1.8 s; IR choice hysteresis; pre-delay / wet mapping.

import { describe, expect, it } from 'vitest';
import { Mat } from '../../src/core/ids.ts';
import { LAYER_DEFS } from '../../src/core/materials.ts';
import {
  createRoomEstimate, IR_RT60, pickIR, preDelayOf, PROBE_MAX, PROBE_RAYS, roomFromRays, sabineRT60, wetOf,
} from '../../src/audio/roomProbe.ts';

/** Ray lengths from (cx, cz) to the walls of a W x L rectangle, capped at max. */
function rectRays(W: number, L: number, cx: number, cz: number, n = PROBE_RAYS, max = PROBE_MAX): Float32Array {
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const dx = Math.cos(a), dz = Math.sin(a);
    const tx = dx > 1e-9 ? (W - cx) / dx : dx < -1e-9 ? -cx / dx : Infinity;
    const tz = dz > 1e-9 ? (L - cz) / dz : dz < -1e-9 ? -cz / dz : Infinity;
    r[i] = Math.min(max, tx, tz);
  }
  return r;
}
const a = (m: number): number => LAYER_DEFS[m].absorption;

describe('sabineRT60', () => {
  it('is the plain Sabine formula', () => {
    expect(sabineRT60(270, 308, 0.343)).toBeCloseTo((0.161 * 270) / (308 * 0.343), 9);
    expect(sabineRT60(0, 10, 0.1)).toBe(0);
    expect(sabineRT60(10, 0, 0.1)).toBe(0);
  });
});

describe('roomFromRays', () => {
  it('10 x 10 x 2.7 carpet room (L0 materials): RT60 < 0.6 s', () => {
    const e = roomFromRays(rectRays(10, 10, 5, 5), PROBE_RAYS, PROBE_MAX, 2.7, a(Mat.CARPET_L0), a(Mat.WALLPAPER_L0), a(Mat.CEILING_TILE), createRoomEstimate());
    expect(e.area).toBeGreaterThan(90);
    expect(e.area).toBeLessThan(101);
    expect(e.volume).toBeCloseTo(e.area * 2.7, 6);
    expect(e.rt60).toBeLessThan(0.6);
    expect(e.rt60).toBeGreaterThan(0.2);
    expect(e.openness).toBe(0);
    // also straight from Sabine with the exact box
    const S = 2 * 100 + 40 * 2.7;
    const al = (100 * a(Mat.CARPET_L0) + 100 * a(Mat.CEILING_TILE) + 40 * 2.7 * a(Mat.WALLPAPER_L0)) / S;
    expect(sabineRT60(270, S, al)).toBeLessThan(0.6);
  });
  it('40 x 40 x 2.6 concrete parking: RT60 > 1.8 s', () => {
    const e = roomFromRays(rectRays(40, 40, 20, 20), PROBE_RAYS, PROBE_MAX, 2.6, a(Mat.CONCRETE_FLOOR), a(Mat.CONCRETE_WALL), a(Mat.CONCRETE_CEIL), createRoomEstimate());
    expect(e.rt60).toBeGreaterThan(1.8);
    const S = 2 * 1600 + 160 * 2.6;
    const al = (1600 * a(Mat.CONCRETE_FLOOR) + 1600 * a(Mat.CONCRETE_CEIL) + 160 * 2.6 * a(Mat.CONCRETE_WALL)) / S;
    expect(sabineRT60(1600 * 2.6, S, al)).toBeGreaterThan(1.8);
  });
  it('off-centre listener gives the same room (within the polygon error)', () => {
    const c = roomFromRays(rectRays(10, 10, 5, 5), PROBE_RAYS, PROBE_MAX, 2.7, 0.3, 0.1, 0.6, createRoomEstimate()).rt60;
    const o = roomFromRays(rectRays(10, 10, 2, 7), PROBE_RAYS, PROBE_MAX, 2.7, 0.3, 0.1, 0.6, createRoomEstimate()).rt60;
    expect(Math.abs(o - c) / c).toBeLessThan(0.2);
  });
  it('openness counts rays that hit max distance; mean free path = 4V/S', () => {
    const e = roomFromRays(rectRays(200, 6, 100, 3), PROBE_RAYS, PROBE_MAX, 2.7, 0.3, 0.1, 0.6, createRoomEstimate());
    expect(e.openness).toBeGreaterThan(0);
    expect(e.mfp).toBeCloseTo((4 * e.volume) / e.surface, 9);
  });
  it('clamps degenerate input', () => {
    const e = roomFromRays(new Float32Array(PROBE_RAYS), PROBE_RAYS, PROBE_MAX, 0, 0, 0, 0, createRoomEstimate());
    expect(Number.isFinite(e.rt60)).toBe(true);
    expect(e.rt60).toBeGreaterThan(0);
  });
});

describe('IR selection', () => {
  it('picks the nearest IR in log RT60 with +-15 % hysteresis', () => {
    expect(IR_RT60).toEqual([0.3, 0.6, 1.0, 1.6, 2.5, 4.0]);
    expect(pickIR(0.3, -1)).toBe(0);
    expect(pickIR(0.62, -1)).toBe(1);
    expect(pickIR(9, -1)).toBe(5);
    expect(pickIR(0.66, 1)).toBe(1); // inside the band: stay
    expect(pickIR(0.8, 1)).toBe(1); // outside the band, nearer to 1.0 s but inside the switching dead band
    expect(pickIR(0.85, 1)).toBe(2); // clearly nearer to 1.0 s
    expect(pickIR(0.74, 2)).toBe(2); // coming back down: still inside the dead band (0.72-0.83 s)
    expect(pickIR(0.86, 2)).toBe(2); // 1.0 * 0.85 = 0.85 -> still inside
    expect(pickIR(0.8, 2)).toBe(2); // outside the band, but 0.8 is nearer 1.0 than 0.6 in log space -> stay
    expect(pickIR(0.7, 2)).toBe(1);
  });
  it('pre-delay = mfp / 343 clamped to 5-60 ms; wet level grows with RT60 and falls with openness', () => {
    expect(preDelayOf(0.5)).toBe(0.005);
    expect(preDelayOf(6.86)).toBeCloseTo(0.02, 9);
    expect(preDelayOf(100)).toBe(0.06);
    expect(wetOf(2.5, 0)).toBeGreaterThan(wetOf(0.3, 0));
    expect(wetOf(2.5, 1)).toBeLessThan(wetOf(2.5, 0));
  });
});
