import { describe, expect, it } from 'vitest';
import { computeImageStats, cropRGBA, flipRowsInPlace, hueSat, meanAbsDiff } from '../../src/app/imageStats.ts';

function solid(w: number, h: number, r: number, g: number, b: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([r, g, b, 255], i * 4);
  return px;
}

const luma = (r: number, g: number, b: number): number => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

describe('computeImageStats', () => {
  it('uniform grey', () => {
    const s = computeImageStats(solid(160, 90, 128, 128, 128), 160, 90);
    expect(s.width).toBe(160);
    expect(s.height).toBe(90);
    expect(s.meanLum).toBeCloseTo(128 / 255, 6);
    expect(s.p5).toBeCloseTo(128 / 255, 6);
    expect(s.p50).toBeCloseTo(128 / 255, 6);
    expect(s.p95).toBeCloseTo(128 / 255, 6);
    expect(s.clipped).toBe(0);
    expect(s.black).toBe(0);
    expect(s.meanRGB.map((v) => +v.toFixed(6))).toEqual([+(128 / 255).toFixed(6), +(128 / 255).toFixed(6), +(128 / 255).toFixed(6)]);
    expect(s.sat).toBe(0);
    expect(s.hueDeg).toBe(0);
    for (const g of s.grid3x3) expect(g).toBeCloseTo(128 / 255, 6);
  });
  it('black and white: clipped / black fractions', () => {
    expect(computeImageStats(solid(10, 10, 0, 0, 0), 10, 10)).toMatchObject({ meanLum: 0, black: 1, clipped: 0 });
    const w = computeImageStats(solid(10, 10, 255, 255, 255), 10, 10);
    expect(w.meanLum).toBeCloseTo(1, 6);
    expect(w.clipped).toBe(1);
    expect(w.black).toBe(0);
  });
  it('Rec.709 luma on encoded values', () => {
    const s = computeImageStats(solid(4, 4, 200, 100, 50), 4, 4);
    expect(s.meanLum).toBeCloseTo(luma(200, 100, 50), 6);
  });
  it('half black / half white: mean, percentiles, fractions, grid by thirds', () => {
    const w = 6, h = 6;
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = x < 3 ? 0 : 255; // left half black, right half white
        px.set([v, v, v, 255], (y * w + x) * 4);
      }
    }
    const s = computeImageStats(px, w, h);
    expect(s.meanLum).toBeCloseTo(0.5, 6);
    expect(s.black).toBe(0.5);
    expect(s.clipped).toBe(0.5);
    expect(s.p5).toBe(0);
    expect(s.p95).toBeCloseTo(1, 6);
    // columns: thirds are x 0-1 (black), 2-3 (half), 4-5 (white)
    const g = s.grid3x3;
    for (const row of [0, 1, 2]) {
      expect(g[row * 3]).toBe(0);
      expect(g[row * 3 + 1]).toBeCloseTo(0.5, 6);
      expect(g[row * 3 + 2]).toBeCloseTo(1, 6);
    }
  });
  it('grid3x3 is row-major from the top-left (row 0 = top)', () => {
    const w = 9, h = 9;
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const cell = Math.floor(y / 3) * 3 + Math.floor(x / 3);
      const v = cell * 25;
      px.set([v, v, v, 255], (y * w + x) * 4);
    }
    const s = computeImageStats(px, w, h);
    s.grid3x3.forEach((m, i) => expect(m).toBeCloseTo((i * 25) / 255, 6));
  });
  it('percentiles of a ramp', () => {
    const n = 101;
    const px = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) px.set([i * 2, i * 2, i * 2, 255], i * 4); // 0..200
    const s = computeImageStats(px, n, 1);
    expect(s.p5).toBeCloseTo(10 / 255, 6);
    expect(s.p50).toBeCloseTo(100 / 255, 6);
    expect(s.p95).toBeCloseTo(190 / 255, 6);
  });
  it('backrooms yellow lands in the Level 0 QA band (hue 38-65, sat 0.15-0.6)', () => {
    const s = computeImageStats(solid(8, 8, 150, 132, 70), 8, 8);
    expect(s.hueDeg).toBeGreaterThan(38);
    expect(s.hueDeg).toBeLessThan(65);
    expect(s.sat).toBeGreaterThan(0.15);
    expect(s.sat).toBeLessThan(0.6);
  });
  it('alpha is ignored; empty images do not throw', () => {
    const a = solid(4, 4, 90, 90, 90);
    const b = a.slice();
    for (let i = 3; i < b.length; i += 4) b[i] = 0;
    expect(computeImageStats(b, 4, 4)).toEqual(computeImageStats(a, 4, 4));
    const e = computeImageStats(new Uint8Array(0), 0, 0);
    expect(e.meanLum).toBe(0);
    expect(e.grid3x3).toHaveLength(9);
  });
});

describe('hueSat (HSV)', () => {
  it('primaries and greys', () => {
    expect(hueSat(1, 0, 0)).toEqual({ hueDeg: 0, sat: 1 });
    expect(hueSat(0, 1, 0).hueDeg).toBeCloseTo(120, 9);
    expect(hueSat(0, 0, 1).hueDeg).toBeCloseTo(240, 9);
    expect(hueSat(1, 1, 0).hueDeg).toBeCloseTo(60, 9);
    expect(hueSat(1, 0, 1).hueDeg).toBeCloseTo(300, 9);
    expect(hueSat(0.4, 0.4, 0.4)).toEqual({ hueDeg: 0, sat: 0 });
    expect(hueSat(0, 0, 0)).toEqual({ hueDeg: 0, sat: 0 });
    expect(hueSat(1, 0.5, 0).sat).toBe(1);
    expect(hueSat(1, 0.5, 0.5).sat).toBeCloseTo(0.5, 9);
  });
});

describe('pixel helpers', () => {
  it('flipRowsInPlace reverses rows', () => {
    const px = new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]); // 1x3
    flipRowsInPlace(px, 1, 3);
    expect([...px]).toEqual([3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1]);
  });
  it('cropRGBA takes a top-left-origin fraction rect', () => {
    const w = 4, h = 4;
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) px[i * 4] = i;
    const c = cropRGBA(px, w, h, [0.5, 0.25, 0.5, 0.5]);
    expect(c.w).toBe(2);
    expect(c.h).toBe(2);
    expect([c.data[0], c.data[4], c.data[8], c.data[12]]).toEqual([6, 7, 10, 11]);
    const q = cropRGBA(new Uint8Array(160 * 90 * 4), 160, 90, [0.25, 0.25, 0.5, 0.5]); // 22.5..67.5 rows
    expect([q.w, q.h]).toEqual([80, 45]);
    const tiny = cropRGBA(px, w, h, [0.9, 0.9, 0, 0]);
    expect(tiny.w).toBe(1);
    expect(tiny.h).toBe(1);
  });
  it('meanAbsDiff', () => {
    const a = solid(4, 4, 0, 0, 0);
    const b = solid(4, 4, 255, 255, 255);
    expect(meanAbsDiff(a, a)).toBe(0);
    expect(meanAbsDiff(a, b)).toBe(1);
    expect(meanAbsDiff(a, solid(4, 4, 51, 0, 0))).toBeCloseTo(51 / 255 / 3, 9);
  });
});
