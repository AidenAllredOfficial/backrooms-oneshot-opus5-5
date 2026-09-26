// src/audio/dsp/hum.ts — fluorescent hum loops (pure).
// A magnetic ballast does not drone, it BUZZES: the laminations of its core rattle at 2 x mains (magnetostriction)
// and the loose steel turns that sine into a bright, gritty, harmonically rich tone. Recipe (R2 audio, "bright
// ballast buzz"):
//  * fundamental f0 = 2 x mains; harmonics k*f0 up to 5 kHz. Amplitude k^-1.2 up to the 4th harmonic, then a
//    flatter k^-0.8 roll-off (the rattle keeps the upper harmonics alive); odd harmonics +3 dB (the asymmetric
//    magnetostriction of the core); per-ballast +-2 dB jitter (+-3 dB above 1 kHz, so every ballast has its own
//    "vowel");
//  * the troffer housing shapes what reaches the air: the small steel box radiates the fundamental poorly (first-order
//    high-pass at 220 Hz), its panels ring broadly at 560-900 Hz (+8 dB, per variant) and their mass rolls the top off
//    (second-order low-pass at 1.6 kHz). Result: centroid ~470-610 Hz, 15-22 % of the A-weighted energy in 1.2-6 kHz
//    (was 170-210 Hz / <3 %: a dull drone);
//  * weak mains leakage (mains and 3 x mains) from the transformer core;
//  * a ballast buzz: a 2-6 kHz noise band gated at every current peak (gate s^2, a pulse at 2 x mains);
//  * slow AM 0.2-0.8 Hz at ~10 %;
//  * the sum drives a per-sample asymmetric soft clip x + 0.15 x^2 -> tanh(1.3 x) (loose laminations hitting each
//    other), then the DC it produced is removed (exact mean: the loop is periodic).
// Every periodic component has an integer number of cycles over the loop, the noise band is filtered circularly and
// the clip is a memoryless per-sample map, so the loop is exactly periodic; it is finally rotated to its quietest
// seam. Stereo channels are decorrelated (bed use); voices use ch 0.

import { bandNoise } from './noise.ts';
import {
  addLoopSine, DOMAIN, dspRng, normalizePeak, peakOf, rotateToQuietSeam, samplesOf, sanitize, sineTable, stereo,
} from './util.ts';

/** Character of the 4 ballast variants: buzz level, harmonic tilt offset, AM depth, mains-leak level, clip drive. */
const VARIANTS = [
  { buzz: 0.36, tilt: 0.0, am: 0.1, leak: 0.1, drive: 1.3, res: 720 }, // typical 1980s magnetic ballast
  { buzz: 0.5, tilt: -0.06, am: 0.1, leak: 0.12, drive: 1.45, res: 900 }, // buzzy, loose laminations
  { buzz: 0.3, tilt: 0.08, am: 0.08, leak: 0.16, drive: 1.2, res: 560 }, // duller, transformer-heavy
  { buzz: 0.42, tilt: -0.03, am: 0.12, leak: 0.08, drive: 1.35, res: 800 }, // slightly unstable
] as const;

/** Highest harmonic frequency (Hz). */
const HARMONIC_TOP = 5000;
/** Housing transfer: radiation high-pass (Hz), panel resonance gain (dB), mass low-pass (Hz). */
const HOUSING_HP = 220;
const HOUSING_PEAK_DB = 8;
const HOUSING_LP = 1600;
/** Harmonic index where the k^-1.2 roll-off turns into the flatter k^-0.8 one. */
const KNEE = 4;

/** Relative amplitude of harmonic k (before jitter) for a variant tilt: k^-1.2 to the 4th harmonic, ~k^-0.8 after,
 * odd harmonics +3 dB. Exported for the spectral tests. */
export function humHarmonicAmp(k: number, tilt = 0): number {
  const lo = Math.pow(Math.min(k, KNEE), -1.2 + (k > 1 ? tilt : 0));
  const hi = k > KNEE ? Math.pow(k / KNEE, -0.8 + tilt) : 1;
  return lo * hi * (k % 2 === 1 ? Math.SQRT2 : 1);
}

/** Transfer of the troffer housing (source -> air): the small steel box radiates the 120 Hz fundamental poorly
 * (first-order high-pass at hp), its sheet-metal panels ring broadly around fr (a +pg dB, Q ~1.2 resonance that
 * gives every ballast its "vowel") and the panel mass rolls the top off (second-order low-pass at lp). */
function housing(f: number, hp: number, fr: number, pg: number, lp: number): number {
  const r = f / hp;
  const high = r / Math.sqrt(1 + r * r);
  const q = 1.2;
  const x = q * (f / fr - fr / f);
  const peak = 1 + (Math.pow(10, pg / 20) - 1) / Math.sqrt(1 + x * x);
  const l = f / lp;
  const low = 1 / Math.sqrt(1 + l * l * l * l);
  return high * peak * low;
}

export function synthHum(variant: number, sampleRate: number, mainsHz: 50 | 60, seconds: number): Float32Array[] {
  const sr = sampleRate;
  const n = samplesOf(seconds, sr);
  const v = VARIANTS[((variant % 4) + 4) % 4];
  const rng = dspRng(DOMAIN.HUM, mainsHz, variant | 0);
  const tab = sineTable(n);
  const out = stereo(n);
  const f0 = 2 * mainsHz;
  const cyc0 = Math.max(1, Math.round((f0 * n) / sr)); // e.g. 720 cycles in 6 s at 120 Hz
  const cycMains = Math.max(1, Math.round((mainsHz * n) / sr));

  // harmonic amplitudes shared by both channels (same ballast), phases slightly different per channel
  const kMax = Math.max(1, Math.min(Math.floor(HARMONIC_TOP / f0), Math.floor((0.45 * sr) / f0)));
  const amps = new Float64Array(kMax + 1);
  const phases = new Float64Array(kMax + 1);
  for (let k = 1; k <= kMax; k++) {
    const range = k * f0 > 1000 ? 3 : 2;
    const jitterDb = (rng.float() * 2 - 1) * range;
    amps[k] = humHarmonicAmp(k, v.tilt) * housing(k * f0, HOUSING_HP, v.res, HOUSING_PEAK_DB, HOUSING_LP) * Math.pow(10, jitterDb / 20);
    phases[k] = rng.float();
  }
  const mainsPhase = rng.float();
  const amCycles = Math.max(1, Math.round(((0.2 + 0.6 * rng.float()) * n) / sr));
  const amPhase = [rng.float(), rng.float()];
  const buzzPhase = rng.float();

  for (let ch = 0; ch < 2; ch++) {
    const o = out[ch];
    for (let k = 1; k <= kMax; k++) {
      const dph = ch === 0 ? 0 : (rng.float() - 0.5) * 0.08; // small inter-channel phase drift
      addLoopSine(o, cyc0 * k, amps[k], (phases[k] + dph + 1) % 1, tab);
    }
    // weak mains-frequency leakage and its 3rd harmonic (transformer core)
    addLoopSine(o, cycMains, v.leak, mainsPhase, tab);
    addLoopSine(o, cycMains * 3, v.leak * 0.35, (mainsPhase * 3) % 1, tab);

    // ballast buzz: 2-6 kHz band, gated by pulses at every current peak (2 x mains)
    const band = bandNoise(rng, n, sr, 2000, 6000, true, 1);
    let bi = Math.floor(buzzPhase * n) % n;
    const bStep = cyc0 % n;
    for (let i = 0; i < n; i++) {
      const s = 0.5 + 0.5 * tab[bi];
      o[i] += band[i] * v.buzz * 2.2 * s * s;
      bi += bStep;
      if (bi >= n) bi -= n;
    }

    // slow AM (integer cycles per loop)
    let ai = Math.floor(amPhase[ch] * n) % n;
    const aStep = amCycles % n;
    for (let i = 0; i < n; i++) {
      o[i] *= 1 + v.am * tab[ai];
      ai += aStep;
      if (ai >= n) ai -= n;
    }
  }

  // loose laminations: asymmetric soft clip on the sum (both channels share one drive so the image stays centred)
  const pk = peakOf(out);
  const norm = pk > 0 ? 1 / pk : 1;
  for (const o of out) {
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const x = o[i] * norm;
      const y = Math.tanh(v.drive * (x + 0.15 * x * x));
      o[i] = y;
      mean += y;
    }
    mean /= n;
    for (let i = 0; i < n; i++) o[i] -= mean;
  }
  return rotateToQuietSeam(normalizePeak(sanitize(out), 0.9));
}
