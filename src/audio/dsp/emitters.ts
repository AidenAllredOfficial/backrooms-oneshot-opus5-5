// src/audio/dsp/emitters.ts — loopable emitter sources (pure, mono).
// All renders are exactly periodic (see dsp/util.ts). `variant & 3` picks the character. PHONE rounds its length to
// whole ring cadences (US 2 s on / 4 s off at 60 Hz mains, UK 0.4/0.2/0.4/2.0 s at 50 Hz); every other kind is
// exactly `seconds` long. Peak-normalized per kind (the relative loudness of each kind is baked into EMITTER_PEAK).

import type { Rng } from '../../core/rng.ts';
import { EmitterKind, type EmitterKindId } from '../../core/ids.ts';
import { bandNoise, brownNoise, crackle, pinkNoise, whiteNoise } from './noise.ts';
import {
  addBubble, addLoopSine, addWrapped, bp, DOMAIN, dspRng, filterLoop, hp, lp, normalizePeak, periodicCurve, rotateToQuietSeam,
  sanitize, samplesOf, sineTable, softClip, TAU,
} from './util.ts';

export const EMITTER_KIND_COUNT = 9;
/** Output peak per EmitterKind (DRIP, VENT, PIPE, MACHINE, WATER, STEAM, RADIO, PHONE, BUZZ). */
export const EMITTER_PEAK: readonly number[] = [0.8, 0.5, 0.6, 0.6, 0.6, 0.7, 0.6, 0.9, 0.6];

function poisson(rng: Rng, n: number, sr: number, rate: number, fn: (at: number) => void): void {
  let t = rng.float() / Math.max(1e-6, rate);
  const T = n / sr;
  while (t < T) {
    fn(Math.floor(t * sr));
    t += -Math.log(1 - rng.float() * 0.999999) / rate;
  }
}

function decaySine(sr: number, f: number, tau: number, len: number, amp: number, phase: number): Float32Array {
  const m = Math.round(len * sr);
  const o = new Float32Array(m);
  for (let i = 0; i < m; i++) o[i] = amp * Math.sin(TAU * (f * (i / sr) + phase)) * Math.exp(-i / (tau * sr)) * Math.min(1, i / 16);
  return o;
}

/** Circular-rotated periodic gate curve made of on/off segments with smooth (fade s) edges. */
function gateCurve(rng: Rng, n: number, sr: number, onMin: number, onMax: number, offMin: number, offMax: number, floor: number, fade: number): Float32Array {
  const g = new Float32Array(n);
  const segs: number[] = [];
  let t = 0;
  const T = n / sr;
  while (t < T) {
    const on = onMin + (onMax - onMin) * rng.float();
    const off = offMin + (offMax - offMin) * rng.float();
    segs.push(t, Math.min(T, t + on));
    t += on + off;
  }
  const nf = Math.max(1, Math.round(fade * sr));
  g.fill(floor);
  for (let s = 0; s < segs.length; s += 2) {
    const a = Math.round(segs[s] * sr), b = Math.round(segs[s + 1] * sr);
    for (let i = a - nf; i < b + nf; i++) {
      const j = ((i % n) + n) % n;
      let w = 1;
      if (i < a) w = (i - (a - nf)) / nf;
      else if (i >= b) w = 1 - (i - b) / nf;
      const v = floor + (1 - floor) * (0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, w))));
      if (v > g[j]) g[j] = v;
    }
  }
  return g;
}

// ---------------------------------------------------------------- kinds

function drip(rng: Rng, n: number, sr: number, v: number): Float32Array {
  const o = new Float32Array(n);
  const rate = [0.55, 0.9, 1.4, 0.3][v];
  const base = 1500 + 1500 * rng.float();
  poisson(rng, n, sr, rate, (at) => {
    const f = base * (0.85 + 0.3 * rng.float());
    addBubble(o, sr, at, f, 0.25 + 0.2 * rng.float(), 0.01 + 0.015 * rng.float(), 0.9, true);
    // the long tail: the puddle / pipe cavity keeps ringing, plus a soft splash smear
    addWrapped(o, decaySine(sr, f * (1.02 + 0.03 * rng.float()), 0.12 + 0.12 * rng.float(), 0.9, 0.12, rng.float()), at + 30, 1);
    const tail = whiteNoise(rng, Math.round(0.6 * sr));
    const f1 = bp(f, 12, sr);
    for (let i = 0; i < tail.length; i++) tail[i] = f1.process(tail[i]) * Math.exp(-i / (0.16 * sr));
    addWrapped(o, tail, at, 0.9);
    if (rng.float() < 0.2) addBubble(o, sr, at + Math.round((0.05 + 0.1 * rng.float()) * sr), f * 1.3, 0.3, 0.008, 0.4, true);
  });
  return o;
}

function vent(rng: Rng, n: number, sr: number, v: number, tab: Float64Array): Float32Array {
  const lo = [300, 250, 400, 200][v], hi = [2500, 1800, 3200, 1500][v];
  const o = bandNoise(rng, n, sr, lo, hi, true, 1);
  const extra = pinkNoise(rng, n, true, 1);
  filterLoop(extra, lp(500, 0.7071, sr));
  const lfo = periodicCurve(rng, n, 3 + v);
  const flutter = periodicCurve(rng, n, Math.max(8, Math.round((n / sr) * 3)));
  for (let i = 0; i < n; i++) o[i] = (o[i] + extra[i] * 0.8) * (0.65 + 0.45 * lfo[i]) * (0.92 + 0.16 * flutter[i]);
  // faint whistle across the grille slats
  const wc = Math.round(((650 + 700 * rng.float()) * n) / sr);
  const w = new Float32Array(n);
  addLoopSine(w, wc, 0.035 * (v === 2 ? 2 : 1), rng.float(), tab);
  for (let i = 0; i < n; i++) o[i] += w[i] * lfo[i];
  return o;
}

function pipe(rng: Rng, n: number, sr: number, v: number, tab: Float64Array): Float32Array {
  const o = brownNoise(rng, n, sr, true, 0.5, 10);
  filterLoop(o, lp(160, 0.7071, sr));
  const c0 = Math.round(((52 + 25 * rng.float()) * n) / sr);
  addLoopSine(o, c0, 0.35, rng.float(), tab);
  addLoopSine(o, c0 * 2, 0.15, rng.float(), tab);
  addLoopSine(o, c0 * 3 + 1, 0.06, rng.float(), tab);
  const flow = bandNoise(rng, n, sr, 200, 900, true, 0.25);
  const fl = periodicCurve(rng, n, 5);
  for (let i = 0; i < n; i++) o[i] += flow[i] * (0.5 + fl[i]);
  // irregular ticks (thermal expansion), sometimes in quick clusters
  poisson(rng, n, sr, [0.5, 0.8, 0.3, 1.1][v], (at) => {
    const k = rng.float() < 0.3 ? 2 + Math.floor(rng.float() * 3) : 1;
    for (let j = 0; j < k; j++) {
      const p = at + Math.round(j * (0.04 + 0.09 * rng.float()) * sr);
      addWrapped(o, decaySine(sr, 1600 + 2500 * rng.float(), 0.008, 0.06, 0.5, rng.float()), p, 1);
      addWrapped(o, decaySine(sr, 420 + 500 * rng.float(), 0.02, 0.12, 0.3, rng.float()), p, 1);
    }
  });
  return o;
}

function machine(rng: Rng, n: number, sr: number, v: number, mains: number, tab: Float64Array): Float32Array {
  const o = new Float32Array(n);
  const cm = Math.round((mains * n) / sr);
  for (let k = 1; k <= 10; k++) {
    const a = (k === 2 ? 0.5 : 0.25) / Math.pow(k, 0.8);
    addLoopSine(o, cm * k, a, rng.float(), tab);
  }
  // cooling fan: air noise with blade-pass AM
  const fan = pinkNoise(rng, n, true, 1);
  filterLoop(fan, hp(100, 0.7071, sr), lp(2500, 0.7071, sr));
  const rot = Math.round(((35 + 20 * rng.float()) * n) / sr);
  let ri = Math.floor(rng.float() * n);
  for (let i = 0; i < n; i++) {
    o[i] += fan[i] * (0.9 + 0.12 * tab[ri]) * (v === 1 ? 1.4 : 0.9);
    ri += rot; if (ri >= n) ri -= n;
  }
  // server / relay ticking for some variants
  if (v === 3) poisson(rng, n, sr, 0.7, (at) => addWrapped(o, decaySine(sr, 2800, 0.004, 0.03, 0.4, 0), at, 1));
  return o;
}

function water(rng: Rng, n: number, sr: number, v: number): Float32Array {
  const o = new Float32Array(n);
  poisson(rng, n, sr, [1.4, 1.0, 2.0, 0.8][v], (at) => {
    const len = Math.round((0.2 + 0.4 * rng.float()) * sr);
    const g = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      g[i] = (rng.float() * 2 - 1) * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.55)), 2);
    }
    addWrapped(o, g, at, 0.5 + 0.5 * rng.float());
  });
  filterLoop(o, lp(700 + 250 * v, 0.9, sr), hp(80, 0.7071, sr));
  for (let i = 0; i < n; i++) o[i] *= 2;
  poisson(rng, n, sr, 1.5, (at) => addBubble(o, sr, at, 500 + 1200 * rng.float(), 0.3, 0.01 + 0.01 * rng.float(), 0.1, true));
  return o;
}

function steam(rng: Rng, n: number, sr: number, v: number): Float32Array {
  const hiss = whiteNoise(rng, n);
  filterLoop(hiss, hp(2200, 0.7071, sr), bp(5200 + 1500 * rng.float(), 0.7, sr));
  const env = new Float32Array(n).fill(0.08);
  // bursts with a pressure envelope: fast onset, decaying pressure, sputtering flutter
  poisson(rng, n, sr, [0.35, 0.5, 0.25, 0.7][v], (at) => {
    const len = Math.round((0.6 + 2.2 * rng.float()) * sr);
    const p0 = 0.6 + 0.4 * rng.float();
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const e = p0 * Math.min(1, t / 0.03) * Math.exp(-t / (len / sr / 1.6)) * (0.85 + 0.15 * Math.sin(TAU * (9 + 5 * p0) * t));
      const j = (at + i) % n;
      if (e > env[j]) env[j] = e;
    }
  });
  const o = new Float32Array(n);
  const low = bandNoise(rng, n, sr, 300, 1200, true, 0.25);
  for (let i = 0; i < n; i++) o[i] = hiss[i] * env[i] * 2 + low[i] * env[i];
  return o;
}

const MIDI = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
function radio(rng: Rng, n: number, sr: number, v: number): Float32Array {
  const o = new Float32Array(n);
  // easy-listening progression, 4 chords over the loop, key per variant
  const key = [57, 60, 55, 62][v] + (rng.float() < 0.5 ? 0 : -12) + 12;
  const progs: readonly (readonly number[])[][] = [
    [[0, 4, 7, 11], [9, 12, 16, 19], [5, 9, 12, 16], [7, 11, 14, 17]], // Imaj7 vi7 IVmaj7 V7
    [[2, 5, 9, 12], [7, 11, 14, 17], [0, 4, 7, 11], [9, 12, 16, 19]], // ii7 V7 Imaj7 vi7
  ];
  const prog = progs[v & 1];
  const chordLen = n / 4;
  const beat = chordLen / 4;
  const note = (at: number, m: number, amp: number, dur: number, bright: number): void => {
    const f = MIDI(m);
    const len = Math.round(dur * sr);
    const g = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.008) * Math.exp(-t / (dur * 0.45));
      const ph = TAU * f * t;
      g[i] = env * (Math.sin(ph) + bright * 0.35 * Math.sin(2 * ph) * Math.exp(-t / 0.25) + 0.08 * Math.sin(3 * ph));
    }
    addWrapped(o, g, at, amp);
  };
  for (let c = 0; c < 4; c++) {
    const ch = prog[c];
    const c0 = Math.round(c * chordLen);
    // bass: root on beats 1 and 3
    note(c0, key - 24 + ch[0], 0.55, (beat * 1.9) / sr, 0.6);
    note(Math.round(c0 + 2 * beat), key - 24 + ch[0] + (rng.float() < 0.5 ? 7 : 0), 0.45, (beat * 1.9) / sr, 0.6);
    // electric-piano comping: chord on 1, and a push on the "and" of 2
    for (const iv of ch) note(c0, key + iv, 0.16, (beat * 3.5) / sr, 1);
    for (const iv of ch) note(Math.round(c0 + 1.5 * beat), key + iv, 0.1, (beat * 2) / sr, 1);
    // lazy melody from chord tones
    const mt = ch[Math.floor(rng.float() * 4)] + 12;
    note(Math.round(c0 + beat * (rng.float() < 0.5 ? 0 : 1)), key + mt, 0.2, (beat * 2.5) / sr, 0.3);
    note(Math.round(c0 + beat * 3), key + ch[Math.floor(rng.float() * 4)] + 12, 0.14, (beat * 1.2) / sr, 0.3);
  }
  // tiny speaker: band-pass 300 Hz - 3 kHz, gentle saturation, then crackle + hiss
  filterLoop(o, hp(300, 0.7071, sr), hp(300, 0.7071, sr), lp(3000, 0.7071, sr), lp(3000, 0.7071, sr));
  softClip([o], 1.6);
  const cr = crackle(rng, n, sr, 6, 0.6, true);
  const hs = bandNoise(rng, n, sr, 1500, 6000, true, 0.03);
  filterLoop(cr, hp(1000, 0.7071, sr));
  const fade = periodicCurve(rng, n, 4); // reception drifting
  for (let i = 0; i < n; i++) o[i] = o[i] * (0.75 + 0.25 * fade[i]) + cr[i] + hs[i] * (1.2 - fade[i]);
  return o;
}

function phone(rng: Rng, sr: number, seconds: number, v: number, mains: number): Float32Array {
  const uk = mains === 50;
  const period = uk ? 3 : 6;
  const reps = Math.max(1, Math.round(seconds / period));
  const n = Math.round(reps * period * sr);
  const o = new Float32Array(n);
  // two gongs of different pitch, struck alternately by the ringer clapper at the ring-current frequency
  const fA = [1180, 1320, 980, 1450][v] * (0.98 + 0.04 * rng.float());
  const fB = fA * (1.19 + 0.04 * rng.float());
  const ring = uk ? 25 : 20;
  const bursts: [number, number][] = uk ? [[0, 0.4], [0.6, 1.0]] : [[0, 2]];
  const partials = [1, 2.76, 5.4] as const;
  const strike = (at: number, f: number, a: number): void => {
    for (let p = 0; p < 3; p++) addWrapped(o, decaySine(sr, f * partials[p], 0.35 / (1 + p * 1.5), 1.2 / (1 + p), a / (1 + p * 1.2), rng.float()), at, 1);
  };
  for (let r = 0; r < reps; r++) {
    for (const [a, b] of bursts) {
      for (let t = a; t < b; t += 1 / ring) {
        const at = Math.round((r * period + t) * sr);
        strike(at, fA, 0.12 * (0.9 + 0.2 * rng.float()));
        strike(at + Math.round(sr / ring / 2), fB, 0.1 * (0.9 + 0.2 * rng.float()));
      }
    }
  }
  // the phone body / mechanism buzz under the bells
  filterLoop(o, hp(250, 0.7071, sr));
  return o;
}

function buzz(rng: Rng, n: number, sr: number, v: number, mains: number, tab: Float64Array): Float32Array {
  const o = new Float32Array(n);
  const c0 = Math.round((2 * mains * n) / sr);
  const kMax = Math.floor(4000 / (2 * mains));
  for (let k = 1; k <= kMax; k++) addLoopSine(o, c0 * k, 0.3 / Math.pow(k, 0.75) * (k % 2 === 0 ? 1.2 : 1), rng.float(), tab);
  // arcing noise band gated at 2 x mains
  const band = bandNoise(rng, n, sr, 1800, 7000, true, 1);
  let bi = Math.floor(rng.float() * n);
  for (let i = 0; i < n; i++) {
    const s = 0.5 + 0.5 * tab[bi];
    o[i] += band[i] * 0.5 * s * s * s * s;
    bi += c0; if (bi >= n) bi -= n;
  }
  const g = gateCurve(rng, n, sr, [0.4, 0.2, 0.8, 0.15][v], [2.0, 1.0, 3.5, 0.6][v], 0.15, [1.5, 0.8, 1.0, 0.5][v], 0.12, 0.012);
  for (let i = 0; i < n; i++) o[i] *= g[i];
  softClip([o], 1.3);
  return o;
}

/** Loopable source for every EmitterKind (DRIP, VENT, PIPE, MACHINE, WATER, STEAM, RADIO, PHONE, BUZZ). */
export function synthEmitter(kind: EmitterKindId, variant: number, sampleRate: number, seconds: number, mainsHz: 50 | 60 = 60): Float32Array[] {
  const sr = sampleRate;
  const v = ((variant % 4) + 4) % 4;
  const rng = dspRng(DOMAIN.EMITTER, kind, variant | 0, mainsHz);
  const n = samplesOf(seconds, sr);
  let o: Float32Array;
  switch (kind) {
    case EmitterKind.DRIP: o = drip(rng, n, sr, v); break;
    case EmitterKind.VENT: o = vent(rng, n, sr, v, sineTable(n)); break;
    case EmitterKind.PIPE: o = pipe(rng, n, sr, v, sineTable(n)); break;
    case EmitterKind.MACHINE: o = machine(rng, n, sr, v, mainsHz, sineTable(n)); break;
    case EmitterKind.WATER: o = water(rng, n, sr, v); break;
    case EmitterKind.STEAM: o = steam(rng, n, sr, v); break;
    case EmitterKind.RADIO: o = radio(rng, n, sr, v); break;
    case EmitterKind.PHONE: o = phone(rng, sr, seconds, v, mainsHz); break;
    case EmitterKind.BUZZ: o = buzz(rng, n, sr, v, mainsHz, sineTable(n)); break;
    default: o = new Float32Array(n);
  }
  const peak = EMITTER_PEAK[kind] ?? 0.6;
  const out = normalizePeak(sanitize([o]), peak);
  // PHONE keeps its cadence phase (ring starts at t = 0); the others start at their quietest seam
  return kind === EmitterKind.PHONE ? out : rotateToQuietSeam(out);
}
