// src/audio/dsp/util.ts — shared DSP helpers for the offline synthesizers (pure: no DOM, no Math.random).
// Every synthesizer renders into plain Float32Arrays at an explicit sample rate. Loopable renders are made
// exactly periodic: periodic oscillators use integer cycles per loop, IIR filters run "circularly" (two passes so
// the state at the loop start equals the state at the loop end) and grains that overrun the end wrap to the start.

import { hash4, Rng, SALT } from '../../core/rng.ts';

export const TAU = Math.PI * 2;

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(1e-12, g));
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clampN = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const smooth01 = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/** Deterministic RNG for a synthesizer: (domain, kind, variant, seed) -> sfc32 stream. */
export function dspRng(domain: number, kind: number, variant: number, seed = 0): Rng {
  return new Rng(hash4(SALT.AUDIO, domain, (kind * 4099 + variant) | 0, seed | 0));
}
/** Domains (first hash word) so different synthesizers never share streams. */
export const DOMAIN = { HUM: 1, FOOT: 2, FIXTURE: 3, IR: 4, BED: 5, EMITTER: 6, ONESHOT: 7, RUSTLE: 8 } as const;

export const samplesOf = (seconds: number, sampleRate: number): number => Math.max(1, Math.round(seconds * sampleRate));

/** Loop frequency quantized to an integer number of cycles over n samples (>= 1 cycle). */
export function loopFreq(f: number, n: number, sampleRate: number): number {
  const cycles = Math.max(1, Math.round((f * n) / sampleRate));
  return (cycles * sampleRate) / n;
}

// ---------------------------------------------------------------- filters

/** RBJ biquad (transposed direct form II). Coefficients in float64. */
export class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  z1 = 0; z2 = 0;

  reset(): this { this.z1 = 0; this.z2 = 0; return this; }

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): this {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  private w(f: number, sr: number): number { return (TAU * clampN(f, 1, sr * 0.49)) / sr; }

  lowpass(f: number, q: number, sr: number): this {
    const w = this.w(f, sr), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this.set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }
  highpass(f: number, q: number, sr: number): this {
    const w = this.w(f, sr), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this.set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }
  /** Band-pass, constant 0 dB peak gain. */
  bandpass(f: number, q: number, sr: number): this {
    const w = this.w(f, sr), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this.set(al, 0, -al, 1 + al, -2 * c, 1 - al);
  }
  peaking(f: number, q: number, db: number, sr: number): this {
    const A = Math.pow(10, db / 40), w = this.w(f, sr), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this.set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }
  lowshelf(f: number, db: number, sr: number): this {
    const A = Math.pow(10, db / 40), w = this.w(f, sr), c = Math.cos(w), s = Math.sin(w);
    const al = (s / 2) * Math.SQRT2, sq = 2 * Math.sqrt(A) * al;
    return this.set(A * (A + 1 - (A - 1) * c + sq), 2 * A * (A - 1 - (A + 1) * c), A * (A + 1 - (A - 1) * c - sq),
      A + 1 + (A - 1) * c + sq, -2 * (A - 1 + (A + 1) * c), A + 1 + (A - 1) * c - sq);
  }
  highshelf(f: number, db: number, sr: number): this {
    const A = Math.pow(10, db / 40), w = this.w(f, sr), c = Math.cos(w), s = Math.sin(w);
    const al = (s / 2) * Math.SQRT2, sq = 2 * Math.sqrt(A) * al;
    return this.set(A * (A + 1 + (A - 1) * c + sq), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - sq),
      A + 1 - (A - 1) * c + sq, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - sq);
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  run(buf: Float32Array, from = 0, to = buf.length): void {
    for (let i = from; i < to; i++) buf[i] = this.process(buf[i]);
  }
}

export const lp = (f: number, q: number, sr: number): Biquad => new Biquad().lowpass(f, q, sr);
export const hp = (f: number, q: number, sr: number): Biquad => new Biquad().highpass(f, q, sr);
export const bp = (f: number, q: number, sr: number): Biquad => new Biquad().bandpass(f, q, sr);

/** Run a cascade of filters over a buffer (one-shot, zero initial state). */
export function filterChain(buf: Float32Array, ...fs: Biquad[]): Float32Array {
  for (const f of fs) { f.reset(); f.run(buf); }
  return buf;
}

/** Circular (loop-seamless) filtering: warm each filter on the buffer once, then filter for real, so the state
 * entering sample 0 equals the state leaving sample n-1. Exact for any stable IIR once the warm pass is longer
 * than the filter's memory (true for every filter used here: n >= 1 s, poles well inside the unit circle). */
export function filterLoop(buf: Float32Array, ...fs: Biquad[]): Float32Array {
  for (const f of fs) {
    f.reset();
    for (let i = 0; i < buf.length; i++) f.process(buf[i]);
    f.run(buf);
  }
  return buf;
}

/** One-pole smoother / lowpass (y += a (x - y)). */
export class OnePole {
  a = 1; y = 0;
  set(f: number, sr: number): this { this.a = 1 - Math.exp((-TAU * f) / sr); return this; }
  process(x: number): number { this.y += this.a * (x - this.y); return this.y; }
}

/** Remove DC (circular one-pole highpass ~ f Hz) from a loop. */
export function dcBlockLoop(buf: Float32Array, f: number, sr: number): void {
  filterLoop(buf, hp(f, 0.7071, sr));
}

// ---------------------------------------------------------------- buffers

export function mono(n: number): Float32Array[] { return [new Float32Array(n)]; }
export function stereo(n: number): Float32Array[] { return [new Float32Array(n), new Float32Array(n)]; }

export function peakOf(chs: readonly Float32Array[]): number {
  let p = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > p) p = a; }
  return p;
}
export function rmsOf(chs: readonly Float32Array[]): number {
  let s = 0, n = 0;
  for (const c of chs) { for (let i = 0; i < c.length; i++) s += c[i] * c[i]; n += c.length; }
  return n > 0 ? Math.sqrt(s / n) : 0;
}
export function scale(chs: readonly Float32Array[], g: number): void {
  for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= g;
}
/** Scale so the absolute peak equals `peak` (no-op for silence). */
export function normalizePeak(chs: Float32Array[], peak: number): Float32Array[] {
  const p = peakOf(chs);
  if (p > 1e-9) scale(chs, peak / p);
  return chs;
}
/** Scale to a target RMS, then guarantee the absolute peak stays <= maxPeak (scaling down further if needed). */
export function normalizeRms(chs: Float32Array[], rms: number, maxPeak = 0.98): Float32Array[] {
  const r = rmsOf(chs);
  if (r > 1e-12) scale(chs, rms / r);
  const p = peakOf(chs);
  if (p > maxPeak) scale(chs, maxPeak / p);
  return chs;
}
/** Replace any non-finite sample with 0 (defensive; synthesizers should never produce them). */
export function sanitize(chs: Float32Array[]): Float32Array[] {
  for (const c of chs) for (let i = 0; i < c.length; i++) if (!Number.isFinite(c[i])) c[i] = 0;
  return chs;
}

/** Linear fade in/out (seconds) of a one-shot. */
export function fadeEdges(chs: readonly Float32Array[], fadeIn: number, fadeOut: number, sr: number): void {
  for (const c of chs) {
    const n = c.length;
    const a = Math.min(n, Math.round(fadeIn * sr)), b = Math.min(n, Math.round(fadeOut * sr));
    for (let i = 0; i < a; i++) c[i] *= i / a;
    for (let i = 0; i < b; i++) c[n - 1 - i] *= i / b;
  }
}

/** Add `src` (scaled by g) into `dst` at sample offset `at`, wrapping past the end (loopable scatter). */
export function addWrapped(dst: Float32Array, src: Float32Array, at: number, g: number): void {
  const n = dst.length;
  let j = ((at % n) + n) % n;
  for (let i = 0; i < src.length; i++) {
    dst[j] += src[i] * g;
    if (++j === n) j = 0;
  }
}
/** Add `src` into `dst` at offset `at`, clipped to the buffer (one-shot scatter). */
export function addAt(dst: Float32Array, src: Float32Array, at: number, g: number): void {
  const i0 = Math.max(0, -at), i1 = Math.min(src.length, dst.length - at);
  for (let i = i0; i < i1; i++) dst[at + i] += src[i] * g;
}

/** Circular rotation choosing the start where the loop seam step is smallest across all channels (any rotation of
 * an exactly periodic loop is still seamless; this also makes the first/last-sample delta tiny). */
export function rotateToQuietSeam(chs: Float32Array[]): Float32Array[] {
  const n = chs[0].length;
  if (n < 4) return chs;
  let best = 0, bestV = Infinity;
  for (let i = 0; i < n; i++) {
    const p = i === 0 ? n - 1 : i - 1;
    let v = 0;
    for (const c of chs) { const d = Math.abs(c[i] - c[p]); if (d > v) v = d; }
    if (v < bestV) { bestV = v; best = i; if (v === 0) break; }
  }
  if (best === 0) return chs;
  return chs.map((c) => {
    const o = new Float32Array(n);
    o.set(c.subarray(best));
    o.set(c.subarray(0, best), n - best);
    return o;
  });
}

// ---------------------------------------------------------------- periodic oscillators

/** Sine table of exactly n entries (one full cycle over the loop). sinTab[k] = sin(2 pi k / n). */
export function sineTable(n: number): Float64Array {
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = Math.sin((TAU * i) / n);
  return t;
}

/** Add a sine with an integer number of cycles over the buffer (exactly periodic), phase in [0,1). */
export function addLoopSine(dst: Float32Array, cycles: number, amp: number, phase: number, tab: Float64Array): void {
  const n = dst.length;
  const step = Math.round(cycles) % n;
  let k = Math.floor(phase * n) % n;
  for (let i = 0; i < n; i++) {
    dst[i] += amp * tab[k];
    k += step;
    if (k >= n) k -= n;
  }
}

/** Periodic smooth random curve in [0,1] with `knots` control points (cosine interpolation), loop-seamless. */
export function periodicCurve(rng: Rng, n: number, knots: number, out?: Float32Array): Float32Array {
  const o = out ?? new Float32Array(n);
  const k = Math.max(2, knots | 0);
  const v = new Float64Array(k);
  for (let i = 0; i < k; i++) v[i] = rng.float();
  for (let i = 0; i < n; i++) {
    const x = (i / n) * k;
    const i0 = Math.floor(x) % k, i1 = (i0 + 1) % k;
    const f = x - Math.floor(x);
    const w = 0.5 - 0.5 * Math.cos(Math.PI * f);
    o[i] = v[i0] + (v[i1] - v[i0]) * w;
  }
  return o;
}

// ---------------------------------------------------------------- grains (one-shot building blocks)

/** Exponentially decaying sine (modal partial) with optional linear pitch glide; tau = 1/e decay time (s). */
export function modeGrain(sr: number, f: number, tau: number, amp: number, len: number, phase = 0, glide = 0): Float32Array {
  const n = Math.max(1, Math.round(len * sr));
  const o = new Float32Array(n);
  let ph = phase * TAU;
  const k = Math.exp(-1 / (tau * sr));
  let e = amp;
  for (let i = 0; i < n; i++) {
    const fi = f * (1 + (glide * i) / n);
    ph += (TAU * fi) / sr;
    o[i] = e * Math.sin(ph);
    e *= k;
  }
  return o;
}

/** Add a modal partial directly into a buffer at offset `at` (clipped), decaying from amp with 1/e time tau. */
export function addMode(dst: Float32Array, sr: number, at: number, f: number, tau: number, amp: number, phase = 0, attack = 0.0005): void {
  const n = Math.min(dst.length - at, Math.round(tau * sr * 7));
  if (n <= 0) return;
  const w = (TAU * f) / sr;
  const k = Math.exp(-1 / (tau * sr));
  const na = Math.max(1, Math.round(attack * sr));
  let e = amp;
  const c = Math.cos(w), s = Math.sin(w);
  let re = Math.cos(phase * TAU), im = Math.sin(phase * TAU);
  for (let i = 0; i < n; i++) {
    const a = i < na ? i / na : 1;
    if (at + i >= 0) dst[at + i] += e * a * im;
    const r2 = re * c - im * s;
    im = re * s + im * c;
    re = r2;
    e *= k;
  }
}

/** Filtered noise burst: white noise shaped by an attack/decay envelope, then through the given filters. */
export function noiseBurst(rng: Rng, sr: number, len: number, attack: number, tau: number, amp: number, ...fs: Biquad[]): Float32Array {
  const n = Math.max(1, Math.round(len * sr));
  const o = new Float32Array(n);
  const na = Math.max(1, Math.round(attack * sr));
  const k = Math.exp(-1 / (tau * sr));
  let e = 1;
  for (let i = 0; i < n; i++) {
    const a = i < na ? i / na : 1;
    if (i >= na) e *= k;
    o[i] = (rng.float() * 2 - 1) * a * e * amp;
  }
  for (const f of fs) { f.reset(); f.run(o); }
  return o;
}

/** Click: a few samples of band-limited impulse (raised-cosine window), polarity from rng. */
export function addClick(dst: Float32Array, sr: number, at: number, amp: number, widthS: number): void {
  const w = Math.max(2, Math.round(widthS * sr));
  for (let i = 0; i < w; i++) {
    const j = at + i;
    if (j < 0 || j >= dst.length) continue;
    const x = i / w;
    // one period of a sine windowed by a raised cosine: zero-mean click
    dst[j] += amp * Math.sin(TAU * x) * (0.5 - 0.5 * Math.cos(TAU * x));
  }
}

/** Bubble: sine chirp rising in pitch (Minnaert resonance collapsing), exponential decay. */
export function addBubble(dst: Float32Array, sr: number, at: number, f0: number, rise: number, tau: number, amp: number, wrap = false): void {
  const n = Math.round(tau * sr * 6);
  let ph = 0;
  let e = amp;
  const k = Math.exp(-1 / (tau * sr));
  const L = dst.length;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f0 * (1 + rise * (t / (tau * 3)));
    ph += (TAU * f) / sr;
    const a = i < 24 ? i / 24 : 1;
    let j = at + i;
    if (wrap) j = ((j % L) + L) % L;
    else if (j >= L) break;
    if (j >= 0) dst[j] += e * a * Math.sin(ph);
    e *= k;
  }
}

/** Mix `src` into `dst` with gain. Lengths may differ (min). */
export function mixInto(dst: Float32Array, src: Float32Array, g: number): void {
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) dst[i] += src[i] * g;
}

/** Gentle saturating soft clip (tanh-like, unity slope at 0). */
export function softClip(chs: readonly Float32Array[], drive: number): void {
  const k = Math.max(1e-3, drive);
  const norm = 1 / Math.tanh(k);
  for (const c of chs) for (let i = 0; i < c.length; i++) c[i] = Math.tanh(c[i] * k) * norm;
}

// ---------------------------------------------------------------- analysis (used by tests and the IR builder)

/** In-place iterative radix-2 FFT (re, im of length 2^k). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -TAU / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const ai = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j + len / 2] = re[i + j] - ar; im[i + j + len / 2] = im[i + j] - ai;
        re[i + j] += ar; im[i + j] += ai;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Magnitude-squared spectrum of a (Hann-windowed, zero-padded) signal; bins 0..N/2. */
export function powerSpectrum(x: Float32Array, n?: number): Float64Array {
  let N = 1;
  const want = n ?? x.length;
  while (N < want) N <<= 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  const m = Math.min(x.length, N);
  for (let i = 0; i < m; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((TAU * i) / Math.max(1, m - 1)));
  fft(re, im);
  const out = new Float64Array(N / 2 + 1);
  for (let i = 0; i <= N / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
  return out;
}

/** Spectral centroid (Hz) of a signal. */
export function spectralCentroid(x: Float32Array, sr: number): number {
  const p = powerSpectrum(x);
  const N = (p.length - 1) * 2;
  let num = 0, den = 0;
  for (let i = 1; i < p.length; i++) { num += p[i] * ((i * sr) / N); den += p[i]; }
  return den > 0 ? num / den : 0;
}

/** Schroeder backward-integrated energy decay (dB, 0 at t=0) of the sum of the channels' energies. */
export function schroederDb(chs: readonly Float32Array[]): Float64Array {
  const n = chs[0].length;
  const e = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    for (const c of chs) acc += c[i] * c[i];
    e[i] = acc;
  }
  const e0 = e[0] || 1;
  for (let i = 0; i < n; i++) e[i] = 10 * Math.log10(Math.max(1e-30, e[i] / e0));
  return e;
}

/** RT60 estimate from a Schroeder curve: least-squares slope between `hiDb` and `loDb` (e.g. -5 .. -35 = T30). */
export function rtFromSchroeder(edc: Float64Array, sr: number, hiDb = -5, loDb = -35): number {
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (let i = 0; i < edc.length; i++) {
    const v = edc[i];
    if (v > hiDb) continue;
    if (v < loDb) break;
    const t = i / sr;
    sx += t; sy += v; sxx += t * t; sxy += t * v; n++;
  }
  if (n < 8) return 0;
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return slope < 0 ? -60 / slope : 0;
}
