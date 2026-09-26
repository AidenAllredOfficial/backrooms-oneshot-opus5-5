// src/audio/dsp/ir.ts — synthetic impulse responses (image-source early reflections + 3-band tail) (pure).
//  * Early reflections: first/second-order image sources of a shoebox `dims` = [W, L, H] m (source ~2 m from the
//    listener), the 12-24 earliest taps, gain ∝ 1/t (spherical spreading) x wall reflectance^order, each tap panned
//    by its arrival direction and softened with order.
//  * Late tail: independent noise per channel (stereo decorrelated), split into 3 bands (< 250 Hz, mid, > 4 kHz),
//    each band x exp(-6.91 t / RT60_band); RT60_mid = rt60, low slightly longer, high = rt60 x (0.3 + 0.7 brightness).
//  * 10-30 ms tail fade-in (longer for bigger rooms). The IR is normalized to unit energy (sum over both
//    channels) so crossfading between IRs keeps the wet level constant; t = 0 is the first reflection (the
//    runtime pre-delay supplies the initial time gap).

import { SPEED_OF_SOUND } from '../../core/constants.ts';
import { Biquad, DOMAIN, dspRng, sanitize, stereo } from './util.ts';

export interface IRTap { t: number; g: number; pan: number; order: number }

/** Image-source taps (sorted by time, relative to the direct path) for a shoebox; exported for tests. */
export function imageSourceTaps(dims: [number, number, number], lis: [number, number, number], src: [number, number, number], refl: number, maxTaps: number): IRTap[] {
  const taps: IRTap[] = [];
  const d0 = Math.hypot(src[0] - lis[0], src[1] - lis[1], src[2] - lis[2]);
  const coord = (n: number, D: number, s: number): number => ((n & 1) === 0 ? n * D + s : (n + 1) * D - s);
  for (let nx = -2; nx <= 2; nx++) for (let ny = -2; ny <= 2; ny++) for (let nz = -2; nz <= 2; nz++) {
    const order = Math.abs(nx) + Math.abs(ny) + Math.abs(nz);
    if (order === 0 || order > 2) continue;
    const ix = coord(nx, dims[0], src[0]), iy = coord(ny, dims[2], src[1]), iz = coord(nz, dims[1], src[2]);
    const dx = ix - lis[0], dy = iy - lis[1], dz = iz - lis[2];
    const d = Math.hypot(dx, dy, dz);
    taps.push({ t: (d - d0) / SPEED_OF_SOUND, g: Math.pow(refl, order) * (d0 / d), pan: dx / d, order });
  }
  taps.sort((a, b) => a.t - b.t);
  return taps.slice(0, Math.max(12, Math.min(24, maxTaps)));
}

export function makeIR(rt60: number, dims: [number, number, number], brightness: number, sampleRate: number, seed: number): Float32Array[] {
  const sr = sampleRate;
  const rt = Math.min(8, Math.max(0.1, Number.isFinite(rt60) ? rt60 : 1));
  const b = Math.min(1, Math.max(0, Number.isFinite(brightness) ? brightness : 0.7));
  const W = Math.max(1.5, dims[0]), L = Math.max(1.5, dims[1]), H = Math.max(2, dims[2]);
  const n = Math.max(64, Math.ceil(sr * Math.min(8, rt * 1.25 + 0.12)));
  const out = stereo(n);
  const rng = dspRng(DOMAIN.IR, Math.round(rt * 100), Math.round(b * 100), seed);

  // ---- early reflections
  const V = W * L * H, S = 2 * (W * L + W * H + L * H);
  const alpha = Math.min(0.95, Math.max(0.02, (0.161 * V) / (S * rt)));
  const refl = Math.sqrt(1 - alpha);
  const lis: [number, number, number] = [W * (0.3 + 0.4 * rng.float()), 1.6, L * (0.3 + 0.4 * rng.float())];
  const ang = rng.float() * Math.PI * 2, r = Math.min(2.2, 0.35 * Math.min(W, L));
  const src: [number, number, number] = [
    Math.min(W - 0.2, Math.max(0.2, lis[0] + Math.cos(ang) * r)), 1.4, Math.min(L - 0.2, Math.max(0.2, lis[2] + Math.sin(ang) * r)),
  ];
  const taps = imageSourceTaps([W, L, H], lis, src, refl, 12 + Math.floor(rng.float() * 13));
  const t0 = taps.length > 0 ? taps[0].t : 0;
  const er = stereo(n);
  let erE = 0;
  for (const tp of taps) {
    const at = Math.round((tp.t - t0 + 0.0005) * sr);
    const w = 2 + tp.order * 3 + Math.round((1 - b) * 4); // wider pulse = duller reflection
    const pl = Math.sqrt(0.5 * (1 - 0.8 * tp.pan)), pr = Math.sqrt(0.5 * (1 + 0.8 * tp.pan));
    for (let i = 0; i < w; i++) {
      const j = at + i;
      if (j >= n) break;
      const h = (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / w)) * (2 / w) * tp.g;
      er[0][j] += h * pl;
      er[1][j] += h * pr;
    }
  }
  for (let i = 0; i < n; i++) erE += er[0][i] * er[0][i] + er[1][i] * er[1][i];

  // ---- late tail (3 bands)
  const rtLow = rt * (1.1 + 0.15 * (1 - b)), rtMid = rt, rtHigh = rt * (0.3 + 0.7 * b);
  const gHigh = 0.35 + 0.65 * b;
  const mfp = (4 * V) / S;
  const fadeIn = 0.01 + 0.02 * Math.min(1, Math.max(0, (mfp - 1.5) / 8));
  const kl = Math.exp(-6.91 / (rtLow * sr)), km = Math.exp(-6.91 / (rtMid * sr)), kh = Math.exp(-6.91 / (rtHigh * sr));
  const tail = stereo(n);
  let tailE = 0;
  for (let ch = 0; ch < 2; ch++) {
    const cr = rng.fork(ch + 1);
    const l1 = new Biquad().lowpass(250, 0.7071, sr), l2 = new Biquad().lowpass(250, 0.7071, sr);
    const h1 = new Biquad().highpass(4000, 0.7071, sr), h2 = new Biquad().highpass(4000, 0.7071, sr);
    let el = 1, em = 1, eh = 1;
    const o = tail[ch];
    const nf = Math.max(1, Math.round(fadeIn * sr));
    for (let i = 0; i < n; i++) {
      const x = cr.float() * 2 - 1;
      const lo = l2.process(l1.process(x));
      const hi = h2.process(h1.process(x));
      const mid = x - lo - hi;
      const f = i < nf ? 0.5 - 0.5 * Math.cos((Math.PI * i) / nf) : 1;
      o[i] = (lo * el + mid * em + hi * eh * gHigh) * f;
      el *= kl; em *= km; eh *= kh;
      tailE += o[i] * o[i];
    }
  }
  // tail-to-early energy ratio grows with reverberance
  const ratio = Math.min(14, Math.max(2, 2 + 3 * rt));
  const tg = erE > 0 && tailE > 0 ? Math.sqrt((ratio * erE) / tailE) : 1;
  for (let ch = 0; ch < 2; ch++) {
    const o = out[ch], e = er[ch], t = tail[ch];
    for (let i = 0; i < n; i++) o[i] = e[i] + t[i] * tg;
  }
  // 20 ms fade-out at the (already ~-75 dB) end, then unit-energy normalization
  const fo = Math.min(n, Math.round(0.02 * sr));
  for (const o of out) for (let i = 0; i < fo; i++) o[n - 1 - i] *= i / fo;
  let E = 0;
  for (const o of out) for (let i = 0; i < n; i++) E += o[i] * o[i];
  const g = E > 0 ? 1 / Math.sqrt(E) : 1;
  for (const o of out) for (let i = 0; i < n; i++) o[i] *= g;
  return sanitize(out);
}
