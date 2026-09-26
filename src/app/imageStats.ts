// src/app/imageStats.ts (WP14, pure over pixels) — luma/colour statistics of a display-referred RGBA8 capture.
//
// Conventions (the QA thresholds in §8.2 are written against these):
// - rows are top-first (row 0 = top of the screen); `flipRowsInPlace` converts GL bottom-first readbacks;
// - luma = Rec.709 weights applied to the sRGB-ENCODED channel values / 255 (display-referred "luma", not luminance);
// - percentiles are nearest-rank over all pixels; clipped = luma > 0.98, black = luma < 0.02;
// - hueDeg / sat are the HSV hue (degrees, [0, 360)) and HSV saturation ((max - min) / max) of meanRGB;
// - grid3x3 = mean luma per third, row-major from the top-left third.

import type { ImageStats } from '../core/debug.ts';

export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

let scratch = new Float32Array(0);

/** HSV hue (deg) and saturation of an RGB triple in 0..1. */
export function hueSat(r: number, g: number, b: number): { hueDeg: number; sat: number } {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  const sat = mx <= 0 ? 0 : d / mx;
  if (d <= 1e-12) return { hueDeg: 0, sat };
  let h: number;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  let deg = h * 60;
  if (deg < 0) deg += 360;
  return { hueDeg: deg, sat };
}

export function computeImageStats(rgba: Uint8Array, w: number, h: number): ImageStats {
  const W = Math.max(0, Math.floor(w));
  const H = Math.max(0, Math.floor(h));
  const n = Math.min(W * H, Math.floor(rgba.length / 4));
  if (n <= 0) {
    return {
      width: W, height: H, meanLum: 0, p5: 0, p50: 0, p95: 0, clipped: 0, black: 0,
      meanRGB: [0, 0, 0], hueDeg: 0, sat: 0, grid3x3: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
  }
  if (scratch.length < n) scratch = new Float32Array(n);
  const lum = scratch;
  const gSum = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const gCnt = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  let sr = 0, sg = 0, sb = 0, sl = 0, clipped = 0, black = 0;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] / 255;
    const g = rgba[i * 4 + 1] / 255;
    const b = rgba[i * 4 + 2] / 255;
    const l = LUMA_R * r + LUMA_G * g + LUMA_B * b;
    lum[i] = l;
    sr += r; sg += g; sb += b; sl += l;
    if (l > 0.98) clipped++;
    if (l < 0.02) black++;
    const x = i % W;
    const y = (i - x) / W;
    const cell = Math.min(2, Math.floor((y * 3) / H)) * 3 + Math.min(2, Math.floor((x * 3) / W));
    gSum[cell] += l;
    gCnt[cell]++;
  }
  const sorted = lum.subarray(0, n).slice().sort();
  const pct = (p: number): number => sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  const meanRGB: [number, number, number] = [sr / n, sg / n, sb / n];
  const hs = hueSat(meanRGB[0], meanRGB[1], meanRGB[2]);
  return {
    width: W, height: H,
    meanLum: sl / n, p5: pct(0.05), p50: pct(0.5), p95: pct(0.95),
    clipped: clipped / n, black: black / n,
    meanRGB, hueDeg: hs.hueDeg, sat: hs.sat,
    grid3x3: gSum.map((s, i) => (gCnt[i] > 0 ? s / gCnt[i] : 0)),
  };
}

/** Reverses the row order in place (GL readbacks are bottom-first). */
export function flipRowsInPlace(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const stride = w * 4;
  const tmp = new Uint8Array(stride);
  for (let y = 0; y < h >> 1; y++) {
    const a = y * stride;
    const b = (h - 1 - y) * stride;
    tmp.set(rgba.subarray(a, a + stride));
    rgba.copyWithin(a, b, b + stride);
    rgba.set(tmp, b);
  }
  return rgba;
}

/** Crops a top-first RGBA8 image to rect = [x, y, w, h] in 0..1 screen fractions (top-left origin). */
export function cropRGBA(rgba: Uint8Array, w: number, h: number, rect: readonly [number, number, number, number]): { data: Uint8Array; w: number; h: number } {
  const c = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  // start and end both round to the nearest pixel edge, so a rect of fraction f spans round(f * size) pixels
  const x0 = Math.min(w - 1, Math.round(c(rect[0]) * w));
  const y0 = Math.min(h - 1, Math.round(c(rect[1]) * h));
  const x1 = Math.max(x0 + 1, Math.min(w, Math.round(c(rect[0] + rect[2]) * w)));
  const y1 = Math.max(y0 + 1, Math.min(h, Math.round(c(rect[1] + rect[3]) * h)));
  const cw = x1 - x0;
  const ch = y1 - y0;
  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) out.set(rgba.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x1) * 4), y * cw * 4);
  return { data: out, w: cw, h: ch };
}

/** Mean absolute difference of two equally sized RGBA8 images over RGB, as a fraction of 255 (0..1). */
export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length) >> 2;
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    s += Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]);
  }
  return s / (n * 3 * 255);
}
