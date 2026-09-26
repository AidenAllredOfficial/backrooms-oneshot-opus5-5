// src/audio/dsp/fixtures.ts — fixture transients: tink / strike / pop / off (pure, mono).
// `variant & 3` picks the timbre; `variant & 4` selects 50 Hz mains for the hum onset/decay (default 60 Hz),
// since the frozen signature has no mains parameter (WP13-internal convention, see AudioEngine).
//  tink:   3 ms starter click + a ~4 kHz ring (the glow-starter contact / tube pinging as it warms).
//  strike: low thump, arc zap, then hum onset with a 0.97 -> 1.0 pitch glide over 0.3 s.
//  pop:    a louder click with a fizzing tail (ballast / tube failure).
//  off:    contact click and the hum collapsing (pitch sag + fast decay).

import { addClick, addMode, bp, DOMAIN, dspRng, filterChain, hp, lp, normalizePeak, sanitize, samplesOf, smooth01, TAU } from './util.ts';
import { crackle } from './noise.ts';

const KINDS = { tink: 0, strike: 1, pop: 2, off: 3 } as const;
/** Output peak per kind: relative loudness is baked in (the engine applies one fixture gain). */
const PEAK = { tink: 0.35, strike: 0.7, pop: 0.95, off: 0.4 } as const;

/** Hum partials (2 x mains harmonics, n^-1.2) with a time-varying pitch multiplier and amplitude envelope. */
function addHum(o: Float32Array, sr: number, at: number, mains: number, pitch: (t: number) => number, env: (t: number) => number, amp: number): void {
  const f0 = 2 * mains;
  const kMax = Math.floor(1200 / f0);
  const ph = new Float64Array(kMax + 1);
  const amps = new Float64Array(kMax + 1);
  for (let k = 1; k <= kMax; k++) amps[k] = Math.pow(k, -1.2);
  for (let i = at; i < o.length; i++) {
    const t = (i - at) / sr;
    const e = env(t);
    const p = pitch(t);
    let s = 0;
    for (let k = 1; k <= kMax; k++) {
      ph[k] += (TAU * f0 * k * p) / sr;
      s += amps[k] * Math.sin(ph[k]);
    }
    o[i] += s * e * amp;
  }
}

export function synthFixture(kind: 'tink' | 'strike' | 'pop' | 'off', variant: number, sampleRate: number): Float32Array[] {
  const sr = sampleRate;
  const v = variant | 0;
  const mains = (v & 4) !== 0 ? 50 : 60;
  const rng = dspRng(DOMAIN.FIXTURE, KINDS[kind], v);
  const len = kind === 'strike' ? 1.1 : kind === 'pop' ? 0.7 : kind === 'off' ? 0.45 : 0.3;
  const o = new Float32Array(samplesOf(len, sr));

  if (kind === 'tink') {
    // 3 ms click
    const click = new Float32Array(Math.round(0.003 * sr));
    for (let i = 0; i < click.length; i++) click[i] = (rng.float() * 2 - 1) * Math.exp(-i / (0.0007 * sr));
    filterChain(click, hp(1500, 0.7, sr));
    for (let i = 0; i < click.length; i++) o[i] += click[i] * 0.8;
    // 4 kHz ring (+ an inharmonic partner mode), variant-detuned
    const f = 3700 + 600 * rng.float();
    addMode(o, sr, 0, f, 0.035 + 0.02 * rng.float(), 0.45, rng.float());
    addMode(o, sr, 0, f * (1.47 + 0.05 * rng.float()), 0.018, 0.18, rng.float());
    addMode(o, sr, 0, f * 0.53, 0.012, 0.1, rng.float());
  } else if (kind === 'strike') {
    // thump: the ballast inrush / fixture housing flexing
    addMode(o, sr, 0, 55 + 20 * rng.float(), 0.05, 0.9, 0.25, 0.002);
    addMode(o, sr, 0, 140 + 40 * rng.float(), 0.025, 0.35, rng.float(), 0.001);
    // zap: arc strike, a bright noise burst with crackle
    const zapN = Math.round(0.06 * sr);
    const zap = new Float32Array(zapN);
    for (let i = 0; i < zapN; i++) zap[i] = (rng.float() * 2 - 1) * Math.exp(-i / (0.015 * sr));
    const cr = crackle(rng, zapN, sr, 900, 1.5, false);
    for (let i = 0; i < zapN; i++) zap[i] += cr[i] * Math.exp(-i / (0.02 * sr));
    filterChain(zap, hp(900, 0.7, sr), lp(9000, 0.7, sr));
    const z0 = Math.round(0.008 * sr);
    for (let i = 0; i < zapN && z0 + i < o.length; i++) o[z0 + i] += zap[i] * 0.55;
    addClick(o, sr, 0, 0.5, 0.0015);
    // hum onset: 0.97 -> 1.0 glide over 0.3 s, fades in over 0.12 s and out towards the end of the buffer
    const h0 = Math.round(0.02 * sr);
    addHum(o, sr, h0, mains, (t) => 0.97 + 0.03 * smooth01(t / 0.3), (t) => smooth01(t / 0.12) * (1 - smooth01((t - 0.65) / 0.4)), 0.32);
  } else if (kind === 'pop') {
    addClick(o, sr, 0, 1.0, 0.0008);
    addClick(o, sr, Math.round(0.0011 * sr), -0.7, 0.0012);
    addMode(o, sr, 0, 90 + 30 * rng.float(), 0.03, 0.55, 0.25, 0.0008);
    // fizz tail: dense crackle + hiss, decaying over ~0.4 s
    const n = o.length;
    const fz = crackle(rng, n, sr, 2500, 1, false);
    for (let i = 0; i < n; i++) fz[i] = (fz[i] + (rng.float() * 2 - 1) * 0.25) * Math.exp(-i / (0.13 * sr)) * (1 + 0.6 * Math.sin((TAU * 23 * i) / sr));
    filterChain(fz, hp(2200, 0.7, sr), bp(5200, 0.6, sr));
    for (let i = 0; i < n; i++) o[i] += fz[i] * 1.4;
  } else {
    // off: contact click, then the hum collapses in pitch and level (magnetic ring-down)
    addClick(o, sr, 0, 0.6, 0.0012);
    addMode(o, sr, 0, 3000 + 800 * rng.float(), 0.01, 0.12, rng.float());
    addHum(o, sr, 0, mains, (t) => 1 - 0.06 * smooth01(t / 0.08), (t) => Math.exp(-t / 0.05), 0.3);
    addMode(o, sr, 0, 60 + 15 * rng.float(), 0.04, 0.3, 0.25, 0.002);
  }
  return [normalizePeak(sanitize([o]), PEAK[kind])[0]];
}
