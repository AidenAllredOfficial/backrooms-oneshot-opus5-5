// src/audio/dsp/footsteps.ts — per-surface footstep synthesis (pure, mono).
// A step is a heel hit plus a softer toe hit 35-70 ms later (8 variants per surface, `variant & 7`).
// Surface recipes (§5 WP13 table):
//   carpet        900 Hz LP noise + 80 Hz thump + -17 dB fibre fizz + 400-2500 Hz drag/scuff 40-120 ms after the
//                 heel; the toe is brighter (R2)
//   carpetWet     carpet + 600->1200 Hz band-pass squelch + bubble chirps
//   concrete      3 kHz click + 180 Hz body + grit
//   tile          concrete + Q8 ring at 2.2-3.4 kHz
//   metal         6-mode modal synthesis
//   grate         metal + rattle
//   waterShallow  splash plus bubbles
//   waterDeep     400 Hz slosh
//   stair         hollow 120 Hz
//   vinyl, wood   variants of the above

import type { Rng } from '../../core/rng.ts';
import type { SurfaceSoundId } from '../../core/ids.ts';
import { crackle } from './noise.ts';
import {
  addBubble, addClick, addMode, Biquad, bp, DOMAIN, dspRng, hp, lp, noiseBurst, normalizePeak, sanitize, samplesOf, TAU,
} from './util.ts';

/** Output peak per surface (relative loudness: carpet is soft, metal/tile are loud). Index = SurfaceSound id. */
const PEAK: readonly number[] = [0.42, 0.5, 0.78, 0.85, 0.9, 0.68, 0.72, 0.75, 0.8, 0.85, 0.9];
/** Buffer length per surface (s). */
const LEN: readonly number[] = [0.32, 0.4, 0.32, 0.36, 0.65, 0.3, 0.36, 0.55, 0.9, 0.4, 0.55];

type HitFn = (o: Float32Array, at: number, s: number, rng: Rng, sr: number, heel: boolean) => void;

function place(o: Float32Array, src: Float32Array, at: number, g: number): void {
  const n = Math.min(src.length, o.length - at);
  for (let i = 0; i < n; i++) o[at + i] += src[i] * g;
}

// ---------------------------------------------------------------- components

function carpetHit(o: Float32Array, at: number, s: number, rng: Rng, sr: number, heel: boolean): void {
  // soft thump through the pad (the heel carries the weight; the toe barely thumps)
  const tw = heel ? 1 : 0.55;
  addMode(o, sr, at, 72 + 16 * rng.float(), 0.032, 0.75 * s * tw, 0.25, 0.003);
  addMode(o, sr, at, 150 + 40 * rng.float(), 0.018, 0.2 * s * tw, rng.float(), 0.002);
  // muffled pile noise (4th-order LP; the toe presses the pile at a flatter angle: brighter)
  const f = (heel ? 800 : 1300) + 250 * rng.float();
  const nz = noiseBurst(rng, sr, 0.12, 0.002, heel ? 0.028 : 0.035, 2.2 * s, lp(f, 0.7, sr), lp(f, 0.7, sr));
  place(o, nz, at, 1);
  // fibre fizz: the crushed pile and grit in it (R2: -17 dB, was -24 dB; the toe a little brighter)
  const fz = noiseBurst(rng, sr, 0.06, 0.001, heel ? 0.018 : 0.024, 1, hp(3800, 0.7, sr));
  const cr = crackle(rng, fz.length, sr, 3000, 1, false);
  for (let i = 0; i < fz.length; i++) fz[i] = (fz[i] + cr[i] * Math.exp(-i / (0.02 * sr))) * s;
  new Biquad().highpass(3200, 0.7, sr).run(fz);
  place(o, fz, at + Math.round(0.004 * sr), heel ? 0.11 : 0.14);
  if (heel) {
    // drag / scuff: the sole sliding on the pile as the foot rolls through, 40-120 ms after the heel
    const dAt = at + Math.round((0.04 + 0.05 * rng.float()) * sr);
    const len = 0.035 + 0.045 * rng.float();
    const n = Math.round(len * sr);
    const bpf = [hp(400, 0.7, sr), lp(2500, 0.7, sr), bp(900 + 700 * rng.float(), 0.8, sr)];
    const g = new Biquad().lowpass(90, 0.7, sr); // grain of the pile (slow random AM)
    for (let i = 0; i < n && dAt + i < o.length; i++) {
      const u = i / n;
      const e = Math.sin(Math.PI * Math.min(1, u)) ** 1.5;
      const grain = 0.5 + Math.min(1.5, Math.abs(g.process(rng.float() * 2 - 1)) * 10);
      let x = (rng.float() * 2 - 1) * e * grain;
      for (const b of bpf) x = b.process(x);
      o[dAt + i] += x * 0.3 * s;
    }
  }
}

function squelch(o: Float32Array, at: number, s: number, rng: Rng, sr: number): void {
  // band-pass squelch sweeping 600 -> 1200 Hz over ~80 ms
  const n = Math.round(0.14 * sr);
  const f = new Biquad();
  const t0 = 0.06 + 0.04 * rng.float();
  for (let i = 0; i < n; i++) {
    if ((i & 31) === 0) f.bandpass(600 * Math.pow(2, Math.min(1, i / sr / t0)), 3, sr);
    const t = i / sr;
    const env = Math.min(1, t / 0.01) * Math.exp(-t / 0.045);
    const x = f.process((rng.float() * 2 - 1) * env);
    if (at + i < o.length) o[at + i] += x * 1.6 * s;
  }
  // bubble chirps
  const k = 2 + Math.floor(rng.float() * 3);
  for (let b = 0; b < k; b++) {
    addBubble(o, sr, at + Math.round((0.02 + 0.12 * rng.float()) * sr), 700 + 900 * rng.float(), 0.35, 0.008 + 0.008 * rng.float(), 0.14 * s);
  }
}

function concreteHit(o: Float32Array, at: number, s: number, rng: Rng, sr: number, bright: number): void {
  // sharp click centred near 3 kHz (heel edge on hard floor)
  const cl = noiseBurst(rng, sr, 0.03, 0.0002, 0.0045, 3.2 * s, bp(2800 * bright + 300 * rng.float(), 1.1, sr));
  place(o, cl, at, 1);
  // body (floor slab + shoe)
  addMode(o, sr, at, 165 + 35 * rng.float(), 0.022, 0.4 * s, 0.25, 0.0008);
  addMode(o, sr, at, 390 + 80 * rng.float(), 0.011, 0.2 * s, rng.float(), 0.0005);
  // grit: sparse micro-crackle of dust / sand under the sole
  const gn = Math.round(0.05 * sr);
  const g = crackle(rng, gn, sr, 1400, 1, false);
  for (let i = 0; i < gn; i++) g[i] *= Math.exp(-i / (0.02 * sr));
  new Biquad().highpass(2500, 0.7, sr).run(g);
  place(o, g, at + Math.round(0.002 * sr), 0.35 * s);
}

function tileHit(o: Float32Array, at: number, s: number, rng: Rng, sr: number): void {
  concreteHit(o, at, s * 0.9, rng, sr, 1.25);
  // Q8 ring at 2.2-3.4 kHz: the glazed tile excited by the heel click
  const f = 2200 + 1200 * rng.float();
  const imp = new Float32Array(Math.round(0.06 * sr));
  addClick(imp, sr, 0, 1, 0.0003);
  const r = new Biquad().bandpass(f, 8, sr);
  r.run(imp);
  place(o, imp, at, 7 * s);
  addMode(o, sr, at, f, 0.012, 0.2 * s, rng.float());
  addMode(o, sr, at, f * 1.53, 0.006, 0.08 * s, rng.float());
}

const METAL_RATIOS = [1, 1.62, 2.31, 2.97, 3.84, 4.61] as const;
function metalHit(o: Float32Array, at: number, s: number, rng: Rng, sr: number, base: number, tauScale: number): void {
  const f0 = base * (0.9 + 0.2 * rng.float());
  for (let m = 0; m < 6; m++) {
    const f = f0 * METAL_RATIOS[m] * (0.97 + 0.06 * rng.float());
    const tau = (0.2 / (1 + m * 0.3)) * tauScale * (0.8 + 0.4 * rng.float());
    addMode(o, sr, at, f, tau, (0.18 + 0.3 * rng.float()) * s, rng.float(), 0.0003);
  }
  const ex = noiseBurst(rng, sr, 0.02, 0.0002, 0.003, 1.6 * s, hp(1200, 0.7, sr));
  place(o, ex, at, 1);
  addMode(o, sr, at, 95 + 20 * rng.float(), 0.028, 0.45 * s, 0.25, 0.001);
}

function rattle(o: Float32Array, at: number, s: number, rng: Rng, sr: number): void {
  const k = 6 + Math.floor(rng.float() * 5);
  for (let i = 0; i < k; i++) {
    const t = 0.012 + 0.13 * Math.pow(rng.float(), 1.4);
    const a = s * 0.22 * (1 - t / 0.16) * (0.5 + 0.5 * rng.float());
    const p = at + Math.round(t * sr);
    addMode(o, sr, p, 1800 + 3200 * rng.float(), 0.004 + 0.004 * rng.float(), a, rng.float(), 0.0002);
    addMode(o, sr, p, 600 + 700 * rng.float(), 0.008, a * 0.5, rng.float(), 0.0003);
  }
}

function splash(o: Float32Array, at: number, s: number, rng: Rng, sr: number, heel: boolean): void {
  const sp = noiseBurst(rng, sr, 0.3, 0.004, heel ? 0.07 : 0.05, 1.1 * s, bp(2300 + 900 * rng.float(), 0.55, sr), lp(7000, 0.7, sr));
  // granular droplets: amplitude-modulate the splash with random grains
  const g = new Biquad().lowpass(60, 0.7, sr);
  for (let i = 0; i < sp.length; i++) sp[i] *= 0.6 + 1.2 * Math.max(0, g.process(rng.float() * 2 - 1) * 8);
  place(o, sp, at, 1);
  const k = 5 + Math.floor(rng.float() * 6);
  for (let b = 0; b < k; b++) {
    addBubble(o, sr, at + Math.round((0.01 + 0.24 * rng.float()) * sr), 600 + 2200 * rng.float(), 0.45, 0.006 + 0.014 * rng.float(), (0.08 + 0.12 * rng.float()) * s);
  }
  addMode(o, sr, at, 110 + 30 * rng.float(), 0.03, 0.25 * s, 0.25, 0.004);
}

function slosh(o: Float32Array, at: number, s: number, rng: Rng, sr: number): void {
  // 400 Hz slosh: low-passed water mass moving around the leg, slow swell
  const n = Math.round(0.8 * sr);
  const f1 = new Biquad().lowpass(380 + 80 * rng.float(), 0.9, sr), f2 = new Biquad().lowpass(420, 0.7, sr);
  const sw = 4 + 3 * rng.float();
  for (let i = 0; i < n && at + i < o.length; i++) {
    const t = i / sr;
    const env = (1 - Math.exp(-t / 0.05)) * Math.exp(-t / 0.22) * (0.75 + 0.25 * Math.sin(TAU * sw * t));
    o[at + i] += f2.process(f1.process((rng.float() * 2 - 1) * env)) * 2.2 * s;
  }
  // plunge and a few low bubbles
  addMode(o, sr, at, 95 + 25 * rng.float(), 0.06, 0.35 * s, 0.25, 0.01);
  const k = 3 + Math.floor(rng.float() * 4);
  for (let b = 0; b < k; b++) {
    addBubble(o, sr, at + Math.round((0.05 + 0.4 * rng.float()) * sr), 250 + 450 * rng.float(), 0.3, 0.015 + 0.02 * rng.float(), 0.1 * s);
  }
}

function stairHit(o: Float32Array, at: number, s: number, rng: Rng, sr: number): void {
  concreteHit(o, at, s * 0.7, rng, sr, 0.9);
  // hollow 120 Hz: the stair flight's cavity resonance
  addMode(o, sr, at, 112 + 16 * rng.float(), 0.09, 0.85 * s, 0.25, 0.002);
  addMode(o, sr, at, 238 + 20 * rng.float(), 0.05, 0.3 * s, rng.float(), 0.001);
  const nz = noiseBurst(rng, sr, 0.2, 0.001, 0.04, 1.2 * s, bp(120, 5, sr));
  place(o, nz, at, 1);
}

function vinylHit(o: Float32Array, at: number, s: number, rng: Rng, sr: number): void {
  const cl = noiseBurst(rng, sr, 0.03, 0.0003, 0.004, 1.1 * s, bp(2100 + 400 * rng.float(), 1, sr));
  place(o, cl, at, 1);
  addMode(o, sr, at, 140 + 30 * rng.float(), 0.02, 0.5 * s, 0.25, 0.001);
  addMode(o, sr, at, 330 + 60 * rng.float(), 0.01, 0.15 * s, rng.float(), 0.0006);
  if (rng.float() < 0.3) {
    // rubber-sole squeak
    const n = Math.round(0.045 * sr);
    const at2 = at + Math.round(0.01 * sr);
    let ph = 0;
    const f0 = 2600 + 700 * rng.float();
    for (let i = 0; i < n && at2 + i < o.length; i++) {
      const t = i / n;
      ph += (TAU * f0 * (1 + 0.2 * t)) / sr;
      o[at2 + i] += Math.sin(ph) * Math.sin(Math.PI * t) * 0.08 * s;
    }
  }
}

function woodHit(o: Float32Array, at: number, s: number, rng: Rng, sr: number): void {
  addMode(o, sr, at, 115 + 45 * rng.float(), 0.05, 0.6 * s, 0.25, 0.0015);
  addMode(o, sr, at, 300 + 50 * rng.float(), 0.035, 0.3 * s, rng.float(), 0.0008);
  addMode(o, sr, at, 690 + 90 * rng.float(), 0.02, 0.2 * s, rng.float(), 0.0005);
  const cl = noiseBurst(rng, sr, 0.03, 0.0003, 0.004, 0.8 * s, bp(2000, 1, sr));
  place(o, cl, at, 1);
}

// ---------------------------------------------------------------- surfaces

const HITS: readonly HitFn[] = [
  /* carpet */ (o, at, s, r, sr, heel) => carpetHit(o, at, s, r, sr, heel),
  /* carpetWet */ (o, at, s, r, sr, heel) => { carpetHit(o, at, s, r, sr, heel); if (heel) squelch(o, at + Math.round(0.012 * sr), s, r, sr); else squelch(o, at, s * 0.5, r, sr); },
  /* concrete */ (o, at, s, r, sr) => concreteHit(o, at, s, r, sr, 1),
  /* tile */ (o, at, s, r, sr) => tileHit(o, at, s, r, sr),
  /* metal */ (o, at, s, r, sr) => metalHit(o, at, s, r, sr, 430, 1),
  /* vinyl */ (o, at, s, r, sr) => vinylHit(o, at, s, r, sr),
  /* wood */ (o, at, s, r, sr) => woodHit(o, at, s, r, sr),
  /* waterShallow */ (o, at, s, r, sr, heel) => splash(o, at, s, r, sr, heel),
  /* waterDeep */ (o, at, s, r, sr, heel) => { if (heel) slosh(o, at, s, r, sr); else slosh(o, at, s * 0.45, r, sr); },
  /* stairConcrete */ (o, at, s, r, sr) => stairHit(o, at, s, r, sr),
  /* grate */ (o, at, s, r, sr) => { metalHit(o, at, s * 0.8, r, sr, 720, 0.45); rattle(o, at, s, r, sr); },
];

export function synthFootstep(surface: SurfaceSoundId, variant: number, sampleRate: number): Float32Array[] {
  const sr = sampleRate;
  const si = surface >= 0 && surface < HITS.length ? surface : 0;
  const rng = dspRng(DOMAIN.FOOT, si, variant & 7);
  const o = new Float32Array(samplesOf(LEN[si], sr));
  const hit = HITS[si];
  // heel strike
  const heel = 0.85 + 0.15 * rng.float();
  hit(o, 0, heel, rng, sr, true);
  // toe (roll-off onto the ball of the foot) 35-70 ms later, softer
  const toeAt = Math.round((0.035 + 0.035 * rng.float()) * sr);
  hit(o, toeAt, heel * (0.45 + 0.25 * rng.float()), rng, sr, false);
  // tiny DC/rumble cleanup and a 3 ms fade-out so buffers end at silence
  const dc = new Biquad().highpass(35, 0.7, sr);
  dc.run(o);
  const fo = Math.min(o.length, Math.round(0.02 * sr));
  for (let i = 0; i < fo; i++) o[o.length - 1 - i] *= i / fo;
  return [normalizePeak(sanitize([o]), PEAK[si])[0]];
}
