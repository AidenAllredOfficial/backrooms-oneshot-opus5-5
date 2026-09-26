// src/audio/dsp/noise.ts — deterministic noise generators (pure). Loop variants are exactly periodic.

import type { Rng } from '../../core/rng.ts';
import { Biquad, filterLoop } from './util.ts';

/** Uniform white noise in [-1, 1). */
export function whiteNoise(rng: Rng, n: number, amp = 1): Float32Array {
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = (rng.float() * 2 - 1) * amp;
  return o;
}

/** Approximately Gaussian noise (sum of 4 uniforms, unit variance). */
export function gaussNoise(rng: Rng, n: number, amp = 1): Float32Array {
  const o = new Float32Array(n);
  const k = amp * Math.sqrt(3); // var(sum of 4 U(0,1)) = 1/3
  for (let i = 0; i < n; i++) o[i] = (rng.float() + rng.float() + rng.float() + rng.float() - 2) * k;
  return o;
}

/** Pink (-3 dB/oct) filter state, Paul Kellet's refined economy method. */
class PinkState {
  b0 = 0; b1 = 0; b2 = 0; b3 = 0; b4 = 0; b5 = 0; b6 = 0;
  step(w: number): number {
    this.b0 = 0.99886 * this.b0 + w * 0.0555179;
    this.b1 = 0.99332 * this.b1 + w * 0.0750759;
    this.b2 = 0.969 * this.b2 + w * 0.153852;
    this.b3 = 0.8665 * this.b3 + w * 0.3104856;
    this.b4 = 0.55 * this.b4 + w * 0.5329522;
    this.b5 = -0.7616 * this.b5 - w * 0.016898;
    const y = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + w * 0.5362;
    this.b6 = w * 0.115926;
    return y * 0.11;
  }
}

/** Pink noise; `loop` = exactly periodic over n (the filter state is warmed on the same white sequence). */
export function pinkNoise(rng: Rng, n: number, loop: boolean, amp = 1): Float32Array {
  const w = whiteNoise(rng, n);
  const o = new Float32Array(n);
  const st = new PinkState();
  if (loop) for (let i = 0; i < n; i++) st.step(w[i]);
  for (let i = 0; i < n; i++) o[i] = st.step(w[i]) * amp;
  return o;
}

/** Brown (-6 dB/oct) noise: leaky integrator of white noise, leak pole at ~`corner` Hz (keeps it DC-free). */
export function brownNoise(rng: Rng, n: number, sr: number, loop: boolean, amp = 1, corner = 12): Float32Array {
  const w = whiteNoise(rng, n);
  const leak = Math.exp((-2 * Math.PI * corner) / sr);
  const g = Math.sqrt(1 - leak * leak); // unit-ish variance
  let y = 0;
  if (loop) for (let i = 0; i < n; i++) y = leak * y + g * w[i];
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) { y = leak * y + g * w[i]; o[i] = y * amp; }
  return o;
}

/** Band-limited white noise (loop-seamless when `loop`): highpass(lo) -> lowpass(hi), 2nd order each. */
export function bandNoise(rng: Rng, n: number, sr: number, lo: number, hi: number, loop: boolean, amp = 1): Float32Array {
  const o = whiteNoise(rng, n, amp);
  const f1 = new Biquad().highpass(lo, 0.7071, sr), f2 = new Biquad().lowpass(hi, 0.7071, sr);
  if (loop) filterLoop(o, f1, f2);
  else { f1.run(o); f2.run(o); }
  return o;
}

/** Sparse crackle: Poisson impulses (rate per second) with power-law amplitudes (many tiny, few large). */
export function crackle(rng: Rng, n: number, sr: number, rate: number, amp: number, loop: boolean): Float32Array {
  const o = new Float32Array(n);
  let t = 0;
  for (;;) {
    t += -Math.log(1 - rng.float() * 0.999999) / Math.max(1e-6, rate);
    const i = Math.floor(t * sr);
    if (i >= n) break;
    const a = amp * Math.pow(rng.float(), 3) * (rng.float() < 0.5 ? -1 : 1);
    o[i] += a;
    const j = loop ? (i + 1) % n : i + 1;
    if (j < n) o[j] -= a * 0.6;
  }
  return o;
}
