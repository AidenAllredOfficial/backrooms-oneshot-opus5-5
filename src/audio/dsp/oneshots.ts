// src/audio/dsp/oneshots.ts — ambient and event one-shot synthesis (pure, mono).
// Ambient kinds are rendered with a >= 20 ms attack (no stingers: nothing may jump out); peaks are normalized
// per kind (ONESHOT_PEAK) and the engine applies placement gain. `variant` seeds the render (any int).

import type { Rng } from '../../core/rng.ts';
import { brownNoise, crackle, pinkNoise, whiteNoise } from './noise.ts';
import {
  addBubble, addClick, addMode, Biquad, bp, DOMAIN, dspRng, filterChain, hp, lp, normalizePeak, sanitize, samplesOf, smooth01, TAU,
} from './util.ts';

export type OneShotKind =
  | 'doorThud' | 'chairScrape' | 'tileCreak' | 'ballastPop' | 'damperClunk' // L0
  | 'pipeKnock' | 'metalGroan' | 'pumpCycle' | 'chainRattle' // industrial
  | 'dripPlink' | 'drainGurgle' | 'filterPump' // pools
  | 'elevatorMotor' | 'elevatorDing' | 'cableRumble' | 'flashlightClick' | 'doorRattle' | 'phonePickup' | 'radioClick' | 'sparkCrackle'
  | 'phoneLine' | 'radioTune' // interaction loops (R2)
  | 'uiHover' | 'uiClick' | 'uiOpen' | 'uiClose'; // interface (R2): camcorder buttons and tape transport

export const ONESHOT_KINDS: readonly OneShotKind[] = [
  'doorThud', 'chairScrape', 'tileCreak', 'ballastPop', 'damperClunk',
  'pipeKnock', 'metalGroan', 'pumpCycle', 'chainRattle',
  'dripPlink', 'drainGurgle', 'filterPump',
  'elevatorMotor', 'elevatorDing', 'cableRumble', 'flashlightClick', 'doorRattle', 'phonePickup', 'radioClick', 'sparkCrackle',
  'phoneLine', 'radioTune', 'uiHover', 'uiClick', 'uiOpen', 'uiClose',
];
/** Interface kinds (played flat on the ui bus). */
export const UI_ONESHOTS: readonly OneShotKind[] = ['uiHover', 'uiClick', 'uiOpen', 'uiClose'];
/** Kinds used by the Poisson ambient director: rendered with a >= 20 ms attack. */
export const AMBIENT_ONESHOTS: ReadonlySet<OneShotKind> = new Set<OneShotKind>([
  'doorThud', 'chairScrape', 'tileCreak', 'ballastPop', 'damperClunk', 'pipeKnock', 'metalGroan', 'pumpCycle', 'chainRattle',
  'dripPlink', 'drainGurgle', 'filterPump',
]);
const PEAK: Readonly<Record<OneShotKind, number>> = {
  doorThud: 0.9, chairScrape: 0.7, tileCreak: 0.6, ballastPop: 0.8, damperClunk: 0.85,
  pipeKnock: 0.9, metalGroan: 0.8, pumpCycle: 0.8, chainRattle: 0.75,
  dripPlink: 0.7, drainGurgle: 0.75, filterPump: 0.75,
  elevatorMotor: 0.6, elevatorDing: 0.6, cableRumble: 0.7, flashlightClick: 0.5, doorRattle: 0.9, phonePickup: 0.6,
  radioClick: 0.6, sparkCrackle: 0.9,
  phoneLine: 0.6, radioTune: 0.7, uiHover: 0.9, uiClick: 0.9, uiOpen: 0.9, uiClose: 0.9,
};
const LEN: Readonly<Record<OneShotKind, number>> = {
  doorThud: 1.4, chairScrape: 1.6, tileCreak: 1.3, ballastPop: 0.9, damperClunk: 1.2,
  pipeKnock: 2.2, metalGroan: 4.2, pumpCycle: 5.5, chainRattle: 2.0,
  dripPlink: 2.2, drainGurgle: 2.8, filterPump: 6.0,
  elevatorMotor: 3.2, elevatorDing: 2.2, cableRumble: 6.5, flashlightClick: 0.15, doorRattle: 1.1, phonePickup: 1.8,
  radioClick: 0.6, sparkCrackle: 1.0,
  phoneLine: 4.8, radioTune: 0.9, uiHover: 0.04, uiClick: 0.24, uiOpen: 0.42, uiClose: 0.42,
};

type Synth = (o: Float32Array, rng: Rng, sr: number) => void;

function place(o: Float32Array, src: Float32Array, at: number, g: number): void {
  const n = Math.min(src.length, o.length - at);
  for (let i = Math.max(0, -at); i < n; i++) o[at + i] += src[i] * g;
}
function env(o: Float32Array, sr: number, f: (t: number) => number): void {
  for (let i = 0; i < o.length; i++) o[i] *= f(i / sr);
}
function noise(rng: Rng, sr: number, len: number): Float32Array { return whiteNoise(rng, Math.round(len * sr)); }

/** Stick-slip friction pulse train at a time-varying rate (Hz), each pulse a short unit spike. */
function stickSlip(rng: Rng, sr: number, len: number, rate: (t: number) => number, jitter: number): Float32Array {
  const n = Math.round(len * sr);
  const o = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const prev = ph;
    ph += (rate(t) * (1 + jitter * (rng.float() * 2 - 1))) / sr;
    if (Math.floor(ph) !== Math.floor(prev)) { o[i] += 1; if (i + 1 < n) o[i + 1] -= 0.5; }
  }
  return o;
}

/** A camcorder transport button: plastic key clunk (press + release), then the tape mechanism answering with a
 * short motor whirr and gear chatter. dir 0 = a plain click (short whirr), 1 = open (spin-up, pitch rising: the
 * mechanism loading), -1 = close (spin-down, falling, and a final latch). */
function camButton(o: Float32Array, rng: Rng, sr: number, dir: number): void {
  const key = (at: number, a: number): void => {
    const c = noise(rng, sr, 0.012);
    filterChain(c, bp(2600 + 700 * rng.float(), 1.3, sr));
    env(c, sr, (t) => Math.exp(-t / 0.0014));
    place(o, c, at, 1.3 * a);
    addMode(o, sr, at, 190 + 50 * rng.float(), 0.014, 0.55 * a, 0.25, 0.0008); // key body into the chassis
    addMode(o, sr, at, 1250 + 250 * rng.float(), 0.004, 0.25 * a, rng.float(), 0.0003);
  };
  key(0, 1);
  const whirrAt = 0.03 + 0.01 * rng.float();
  const len = dir === 0 ? 0.11 : 0.3;
  const f0 = 150 + 30 * rng.float();
  const n = Math.round(len * sr);
  const at = Math.round(whirrAt * sr);
  const chatter = new Biquad().bandpass(1800 + 600 * rng.float(), 2.5, sr);
  const hiss = new Biquad().bandpass(3500, 0.9, sr);
  let ph = 0, gp = 0;
  for (let i = 0; i < n && at + i < o.length; i++) {
    const u = i / n;
    // speed profile: click = quick bump, open = rising, close = falling
    const sp = dir === 0 ? Math.sin(Math.PI * u) : dir > 0 ? smooth01(u * 1.6) : 1 - smooth01(u * 1.1 - 0.1);
    const e = Math.min(1, i / (0.012 * sr)) * (1 - smooth01((u - 0.8) / 0.2));
    ph += (TAU * f0 * (0.55 + 0.6 * sp)) / sr;
    gp += (TAU * f0 * 7 * (0.55 + 0.6 * sp)) / sr; // gear mesh
    const motor = Math.sin(ph) * 0.5 + Math.sin(2 * ph) * 0.3 + Math.sin(3 * ph) * 0.18;
    const gear = chatter.process((rng.float() * 2 - 1) * (0.5 + 0.5 * Math.sin(gp)) ** 3);
    o[at + i] += (motor * 0.18 + gear * 0.5 + hiss.process(rng.float() * 2 - 1) * 0.04) * (0.35 + 0.65 * sp) * e;
  }
  if (dir === 0) key(Math.round((0.07 + 0.02 * rng.float()) * sr), 0.45); // key release
  else if (dir < 0) key(Math.round((whirrAt + len * 0.92) * sr), 0.7); // latch as the mechanism stops
  else key(Math.round(0.09 * sr), 0.35);
}

const S: Readonly<Record<OneShotKind, Synth>> = {
  doorThud: (o, rng, sr) => {
    // a heavy door closing somewhere: body thump, latch click, then the room carrying it
    addMode(o, sr, 0, 62 + 18 * rng.float(), 0.14, 1, 0.25, 0.004);
    addMode(o, sr, 0, 118 + 30 * rng.float(), 0.08, 0.5, rng.float(), 0.003);
    const body = noise(rng, sr, 0.35);
    filterChain(body, lp(320, 0.7, sr));
    env(body, sr, (t) => Math.min(1, t / 0.003) * Math.exp(-t / 0.06));
    place(o, body, 0, 1.6);
    addClick(o, sr, Math.round(0.018 * sr), 0.25, 0.0012);
    addMode(o, sr, Math.round(0.018 * sr), 2400 + 600 * rng.float(), 0.015, 0.1, rng.float());
    const tail = noise(rng, sr, 1.3);
    filterChain(tail, lp(1500, 0.7, sr), hp(80, 0.7, sr));
    env(tail, sr, (t) => Math.min(1, t / 0.02) * Math.exp(-t / 0.3));
    place(o, tail, Math.round(0.01 * sr), 0.18);
  },
  chairScrape: (o, rng, sr) => {
    // chair leg dragged a short way: band-passed friction noise gliding up, stick-slip chatter, leg resonance
    const len = 0.6 + 0.6 * rng.float();
    const n = Math.min(o.length, Math.round(len * sr));
    const f = new Biquad();
    const f0 = 450 + 250 * rng.float(), f1 = f0 * (1.3 + 0.4 * rng.float());
    const chat = stickSlip(rng, sr, len, (t) => 35 + 30 * (t / len), 0.25);
    const res = new Biquad().bandpass(1300 + 500 * rng.float(), 9, sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if ((i & 31) === 0) f.bandpass(f0 + (f1 - f0) * smooth01(t / len), 2.2, sr);
      const e = Math.sin(Math.PI * Math.min(1, t / len)) ** 0.7;
      const x = (rng.float() * 2 - 1) * (0.6 + 0.8 * Math.min(1, chat[i] * 3 + 0.2));
      o[i] += (f.process(x) * 1.2 + res.process(chat[i]) * 2.5) * e;
    }
  },
  tileCreak: (o, rng, sr) => {
    // a ceiling tile shifting in its grid: slow creak (stick-slip through panel modes) and a dust trickle
    const len = 0.45 + 0.45 * rng.float();
    const cr = stickSlip(rng, sr, len, (t) => 22 + 45 * Math.sin(Math.PI * t / len), 0.15);
    const a = bp(380 + 250 * rng.float(), 7, sr), b = bp(900 + 400 * rng.float(), 9, sr), c = bp(1900, 5, sr);
    for (let i = 0; i < cr.length && i < o.length; i++) {
      const x = cr[i];
      o[i] += (a.process(x) * 2 + b.process(x) * 1.4 + c.process(x) * 0.5) * Math.sin(Math.PI * i / cr.length);
    }
    const dust = crackle(rng, Math.round(0.8 * sr), sr, 180, 0.4, false);
    filterChain(dust, hp(3000, 0.7, sr));
    env(dust, sr, (t) => Math.exp(-t / 0.3));
    place(o, dust, Math.round(len * 0.6 * sr), 1);
  },
  ballastPop: (o, rng, sr) => {
    // distant ballast failing: pop, crackle, a last gasp of buzz
    addClick(o, sr, 0, 1, 0.0009);
    addMode(o, sr, 0, 85 + 25 * rng.float(), 0.035, 0.6, 0.25, 0.001);
    const fz = crackle(rng, Math.round(0.6 * sr), sr, 1800, 1, false);
    env(fz, sr, (t) => Math.exp(-t / 0.15));
    filterChain(fz, hp(1800, 0.7, sr));
    place(o, fz, 0, 1.2);
    const bz = new Float32Array(Math.round(0.5 * sr));
    for (let i = 0; i < bz.length; i++) {
      const t = i / sr;
      const s = 0.5 + 0.5 * Math.sin(TAU * 120 * t);
      bz[i] = (rng.float() * 2 - 1) * s ** 4 * Math.exp(-t / 0.12);
    }
    filterChain(bz, bp(3000, 0.8, sr));
    place(o, bz, Math.round(0.03 * sr), 0.8);
  },
  damperClunk: (o, rng, sr) => {
    // HVAC damper blade slamming in the duct: metallic clunk, short rattle, hollow duct resonance
    addMode(o, sr, 0, 118 + 25 * rng.float(), 0.09, 0.8, 0.25, 0.002);
    addMode(o, sr, 0, 262 + 40 * rng.float(), 0.07, 0.5, rng.float(), 0.001);
    addMode(o, sr, 0, 415 + 60 * rng.float(), 0.05, 0.35, rng.float(), 0.001);
    addMode(o, sr, 0, 1330 + 300 * rng.float(), 0.02, 0.15, rng.float(), 0.0005);
    const k = 3 + Math.floor(rng.float() * 4);
    for (let i = 0; i < k; i++) {
      const at = Math.round((0.03 + 0.12 * rng.float()) * sr);
      addMode(o, sr, at, 700 + 900 * rng.float(), 0.012, 0.18 * (1 - i / k), rng.float());
    }
    const duct = noise(rng, sr, 0.9);
    filterChain(duct, bp(170 + 40 * rng.float(), 6, sr));
    env(duct, sr, (t) => Math.min(1, t / 0.005) * Math.exp(-t / 0.18));
    place(o, duct, 0, 3);
  },
  pipeKnock: (o, rng, sr) => {
    // water hammer: 3-5 decaying knocks on a pipe (free-free bar modes 1 : 2.76 : 5.40)
    const f0 = 300 + 220 * rng.float();
    const k = 3 + Math.floor(rng.float() * 3);
    let t = 0;
    for (let i = 0; i < k; i++) {
      const a = (1 - i / (k + 1)) * (0.7 + 0.3 * rng.float());
      const at = Math.round(t * sr);
      addMode(o, sr, at, f0, 0.25, a, rng.float(), 0.0008);
      addMode(o, sr, at, f0 * 2.756, 0.12, a * 0.5, rng.float(), 0.0005);
      addMode(o, sr, at, f0 * 5.404, 0.05, a * 0.25, rng.float(), 0.0003);
      addMode(o, sr, at, 70 + 20 * rng.float(), 0.05, a * 0.6, 0.25, 0.002);
      t += 0.12 + 0.18 * rng.float();
    }
  },
  metalGroan: (o, rng, sr) => {
    // structural steel under slow load: stick-slip at a slowly bending pitch through a bank of metal modes
    const len = Math.min(o.length / sr - 0.3, 2.2 + 1.5 * rng.float());
    const p0 = 45 + 40 * rng.float(), bend = 0.7 + 0.6 * rng.float();
    const src = stickSlip(rng, sr, len, (t) => p0 * (1 + (bend - 1) * smooth01(t / len) + 0.05 * Math.sin(TAU * 0.7 * t)), 0.04);
    const modes = [bp(190 + 60 * rng.float(), 14, sr), bp(430 + 90 * rng.float(), 16, sr), bp(760 + 150 * rng.float(), 18, sr), bp(1250 + 200 * rng.float(), 20, sr)];
    const g = [2.2, 1.6, 1.1, 0.6];
    for (let i = 0; i < o.length; i++) {
      const t = i / sr;
      const x = i < src.length ? src[i] * Math.sin(Math.PI * Math.min(1, t / len)) ** 0.8 : 0;
      let y = 0;
      for (let m = 0; m < 4; m++) y += modes[m].process(x) * g[m];
      o[i] += y;
    }
  },
  pumpCycle: (o, rng, sr) => {
    // a pump starting, running and stopping: clunk, motor spin-up, steady run, spin-down, clunk
    const f = 24 + 8 * rng.float();
    const run = 2.2 + 1.2 * rng.float();
    const up = 0.7, down = 1.2;
    const T = up + run + down;
    const ph = new Float64Array(7);
    const flow = pinkNoise(rng, o.length, false, 1);
    filterChain(flow, lp(900, 0.7, sr), hp(60, 0.7, sr));
    for (let i = 0; i < o.length; i++) {
      const t = i / sr;
      const sp = t < up ? smooth01(t / up) : t < up + run ? 1 : 1 - smooth01((t - up - run) / down);
      let y = 0;
      for (let k = 1; k <= 6; k++) { ph[k] += (TAU * f * k * (0.3 + 0.7 * sp)) / sr; y += Math.sin(ph[k]) / (k * 0.9); }
      o[i] = (y * 0.35 + flow[i] * 0.8) * sp * (t < T ? 1 : 0);
    }
    addMode(o, sr, 0, 75, 0.06, 0.9, 0.25, 0.002);
    addMode(o, sr, Math.round((up + run + down * 0.9) * sr), 70, 0.07, 0.7, 0.25, 0.002);
  },
  chainRattle: (o, rng, sr) => {
    // a hanging chain disturbed: bursts of dense link clicks with a swinging density
    const len = 1.0 + 0.6 * rng.float();
    const swing = 1.4 + 0.8 * rng.float();
    let t = 0.01;
    while (t < len) {
      const dens = 25 + 70 * Math.abs(Math.sin(Math.PI * swing * t)) * (1 - t / len);
      const a = (0.2 + 0.8 * rng.float()) * (1 - 0.7 * t / len);
      const at = Math.round(t * sr);
      addMode(o, sr, at, 2200 + 3800 * rng.float(), 0.004 + 0.006 * rng.float(), a * 0.5, rng.float(), 0.0002);
      addMode(o, sr, at, 900 + 900 * rng.float(), 0.01, a * 0.25, rng.float(), 0.0003);
      t += 1 / dens * (0.5 + rng.float());
    }
  },
  dripPlink: (o, rng, sr) => {
    // a single drop into standing water, with a long ringing tail
    const f = 1200 + 1300 * rng.float();
    addBubble(o, sr, 0, f, 0.3, 0.02, 0.9);
    addMode(o, sr, 10, f * 1.01, 0.35, 0.15, rng.float(), 0.002);
    const tail = noise(rng, sr, 2.0);
    filterChain(tail, bp(f, 14, sr));
    env(tail, sr, (t) => Math.min(1, t / 0.01) * Math.exp(-t / 0.45));
    place(o, tail, 0, 1.2);
    if (rng.float() < 0.5) addBubble(o, sr, Math.round(0.25 * sr), f * 0.8, 0.3, 0.012, 0.25);
  },
  drainGurgle: (o, rng, sr) => {
    // air pushing through a drain trap: low bubble chirps in clusters, glugging low noise
    const len = 1.5 + 1.0 * rng.float();
    let t = 0.05;
    while (t < len) {
      addBubble(o, sr, Math.round(t * sr), 180 + 420 * rng.float(), 0.5, 0.02 + 0.03 * rng.float(), 0.4 + 0.6 * rng.float());
      t += 0.03 + 0.14 * rng.float() * rng.float();
    }
    const glug = brownNoise(rng, o.length, sr, false, 1, 20);
    filterChain(glug, lp(300, 0.8, sr));
    env(glug, sr, (tt) => Math.max(0, Math.sin(Math.PI * Math.min(1, tt / len))) * (0.6 + 0.4 * Math.sin(TAU * 5 * tt)));
    place(o, glug, 0, 1.2);
  },
  filterPump: (o, rng, sr) => {
    // pool filter pump cycling: motor ramp, humming run with water rush, ramp down
    const f = 29 + 3 * rng.float();
    const T = o.length / sr;
    const ph = new Float64Array(9);
    const rush = pinkNoise(rng, o.length, false, 1);
    filterChain(rush, hp(250, 0.7, sr), lp(2500, 0.7, sr));
    for (let i = 0; i < o.length; i++) {
      const t = i / sr;
      const sp = smooth01(t / 1.2) * (1 - smooth01((t - (T - 1.8)) / 1.6));
      let y = 0;
      for (let k = 1; k <= 8; k++) { ph[k] += (TAU * f * k * (0.5 + 0.5 * sp)) / sr; y += Math.sin(ph[k]) * (k === 4 ? 0.8 : 1 / k); }
      o[i] = y * 0.3 * sp + rush[i] * sp * sp * 0.9;
    }
  },
  elevatorMotor: (o, rng, sr) => {
    // door operator motor: whine rising, rollers rumbling on the track, then easing off
    const len = o.length / sr;
    const f = 95 + 15 * rng.float();
    const ph = new Float64Array(6);
    let gph = 0;
    const roll = brownNoise(rng, o.length, sr, false, 1, 30);
    filterChain(roll, lp(400, 0.7, sr));
    for (let i = 0; i < o.length; i++) {
      const t = i / sr;
      const sp = smooth01(t / 0.5) * (1 - smooth01((t - (len - 0.8)) / 0.7));
      let y = 0;
      for (let k = 1; k <= 5; k++) { ph[k] += (TAU * f * k * (0.6 + 0.4 * sp)) / sr; y += Math.sin(ph[k]) / k; }
      gph += (TAU * 620 * (0.6 + 0.4 * sp)) / sr;
      o[i] = (y * 0.35 + Math.sin(gph) * 0.06 + roll[i] * 0.9) * sp;
    }
    addMode(o, sr, Math.round((len - 0.3) * sr), 90, 0.05, 0.4, 0.25, 0.003); // doors meet
  },
  elevatorDing: (o, rng, sr) => {
    // hall chime: struck bell partials
    const f = 1050 + 150 * rng.float();
    const parts: [number, number, number][] = [[1, 1, 0.9], [2.0, 0.35, 0.6], [2.76, 0.25, 0.45], [5.4, 0.1, 0.2], [0.5, 0.2, 1.1]];
    for (const [r, a, tau] of parts) addMode(o, sr, 0, f * r, tau, a, rng.float(), 0.001);
  },
  cableRumble: (o, rng, sr) => {
    // the cab moving in the shaft: low rumble, cables passing the sheaves, guide-shoe ticks
    const r = brownNoise(rng, o.length, sr, false, 1, 8);
    filterChain(r, lp(150, 0.7, sr));
    const hiss = pinkNoise(rng, o.length, false, 0.3);
    filterChain(hiss, bp(600, 0.8, sr));
    const T = o.length / sr;
    for (let i = 0; i < o.length; i++) {
      const t = i / sr;
      const e = smooth01(t / 0.8) * (1 - smooth01((t - (T - 1.2)) / 1.1));
      o[i] = (r[i] * 1.2 + hiss[i] * (0.6 + 0.4 * Math.sin(TAU * 0.9 * t))) * e;
    }
    let t = 0.4;
    while (t < T - 0.8) {
      addMode(o, sr, Math.round(t * sr), 1800 + 1500 * rng.float(), 0.01, 0.05 + 0.05 * rng.float(), rng.float());
      t += 0.25 + 0.6 * rng.float();
    }
  },
  flashlightClick: (o, rng, sr) => {
    // plastic tail switch: press click, release click ~40 ms later
    const c = noise(rng, sr, 0.01);
    filterChain(c, bp(3200 + 600 * rng.float(), 1.4, sr));
    env(c, sr, (t) => Math.exp(-t / 0.0012));
    place(o, c, 0, 1.5);
    addMode(o, sr, 0, 1900 + 300 * rng.float(), 0.004, 0.3, rng.float());
    const at = Math.round((0.035 + 0.015 * rng.float()) * sr);
    place(o, c, at, 0.8);
    addMode(o, sr, at, 2600 + 300 * rng.float(), 0.003, 0.2, rng.float());
  },
  doorRattle: (o, rng, sr) => {
    // locked handle turned and the door shaken against its latch
    const k = 4 + Math.floor(rng.float() * 4);
    let t = 0.02;
    for (let i = 0; i < k; i++) {
      const a = 0.6 + 0.4 * rng.float();
      const at = Math.round(t * sr);
      addMode(o, sr, at, 1500 + 1300 * rng.float(), 0.012, a * 0.4, rng.float(), 0.0003); // latch tongue
      addMode(o, sr, at, 3300 + 1500 * rng.float(), 0.006, a * 0.2, rng.float(), 0.0002);
      addMode(o, sr, at, 85 + 20 * rng.float(), 0.06, a * 0.8, 0.25, 0.002); // door leaf thud
      addMode(o, sr, at, 190 + 30 * rng.float(), 0.04, a * 0.35, rng.float(), 0.001);
      t += 0.08 + 0.09 * rng.float();
    }
  },
  phonePickup: (o, rng, sr) => {
    // handset lifted off the cradle (hook-switch clunk), then an open line: faint band-limited hiss, fading out
    addMode(o, sr, 0, 160 + 40 * rng.float(), 0.03, 0.7, 0.25, 0.001);
    addClick(o, sr, Math.round(0.01 * sr), 0.5, 0.001);
    addMode(o, sr, Math.round(0.01 * sr), 2600, 0.008, 0.2, rng.float());
    const hiss = pinkNoise(rng, o.length, false, 1);
    filterChain(hiss, hp(300, 0.7, sr), lp(3400, 0.7, sr));
    env(hiss, sr, (t) => smooth01((t - 0.05) / 0.1) * (1 - smooth01((t - 0.9) / 0.8)));
    place(o, hiss, 0, 0.12);
  },
  radioClick: (o, rng, sr) => {
    // rotary switch clicking off; the speaker pops and the last of the signal collapses
    addClick(o, sr, 0, 0.8, 0.001);
    addMode(o, sr, 0, 2100 + 400 * rng.float(), 0.006, 0.3, rng.float());
    addMode(o, sr, Math.round(0.004 * sr), 70, 0.03, 0.5, 0.25, 0.001); // speaker pop
    const sq = noise(rng, sr, 0.4);
    filterChain(sq, hp(400, 0.7, sr), lp(3000, 0.7, sr));
    env(sq, sr, (t) => Math.exp(-t / 0.05));
    place(o, sq, Math.round(0.002 * sr), 0.3);
  },
  phoneLine: (o, rng, sr) => {
    // the handset held away from the ear: an open line. Dial tone (350 + 440 Hz, the precise-tone plan) through a
    // carbon earpiece (300-3400 Hz band, a little asymmetric saturation), line hiss and 60 Hz crosstalk under it.
    // After ~3 s the exchange gives up: the tone drops with a click and only the hiss is left, fading out.
    const T = o.length / sr;
    const stop = 3.1 + 0.4 * rng.float();
    const hiss = pinkNoise(rng, o.length, false, 1);
    filterChain(hiss, hp(300, 0.7, sr), lp(3400, 0.7, sr));
    const band = [hp(300, 0.7071, sr), lp(3400, 0.7071, sr)];
    let p1 = rng.float() * TAU, p2 = rng.float() * TAU, pm = 0;
    for (let i = 0; i < o.length; i++) {
      const t = i / sr;
      const on = smooth01((t - 0.18) / 0.03) * (1 - smooth01((t - stop) / 0.012));
      p1 += (TAU * 350) / sr; p2 += (TAU * 440) / sr; pm += (TAU * 60) / sr;
      let x = (Math.sin(p1) + Math.sin(p2)) * 0.5 * on;
      x = Math.tanh(1.6 * (x + 0.12 * x * x)); // carbon earpiece
      x = band[1].process(band[0].process(x));
      const tail = 1 - smooth01((t - (T - 1.2)) / 1.1);
      o[i] = x * 0.55 + (hiss[i] * 0.09 + Math.sin(pm) * 0.012 * on) * smooth01((t - 0.05) / 0.1) * tail;
    }
    addClick(o, sr, Math.round(stop * sr), 0.12, 0.001);
  },
  radioTune: (o, rng, sr) => {
    // turning the dial between stations: band static, a heterodyne whistle gliding through, and snatches of other
    // stations (band-passed babble with a syllabic rhythm) as the pointer passes them
    const T = o.length / sr;
    const st = noise(rng, sr, T);
    filterChain(st, hp(350, 0.7, sr), lp(4200, 0.7, sr));
    const talk = noise(rng, sr, T);
    filterChain(talk, bp(700 + 400 * rng.float(), 1.6, sr), bp(1100 + 500 * rng.float(), 1.2, sr));
    const passA = 0.2 + 0.15 * rng.float(), passB = 0.5 + 0.15 * rng.float();
    const f0 = 2600 + 1200 * rng.float(), f1 = 150 + 150 * rng.float();
    let ph = 0, sy = rng.float() * TAU;
    const syl = 4.5 + 2 * rng.float();
    for (let i = 0; i < o.length; i++) {
      const t = i / sr;
      const u = t / T;
      const env = smooth01(t / 0.02) * (1 - smooth01((t - (T - 0.12)) / 0.1));
      // whistle: glides down to near zero-beat at the middle and back up (the dial passing a carrier)
      const f = f1 + (f0 - f1) * Math.abs(2 * u - 1) ** 1.5;
      ph += (TAU * f) / sr;
      sy += (TAU * syl) / sr;
      const nearA = Math.exp(-(((t - passA) / 0.045) ** 2)), nearB = Math.exp(-(((t - passB) / 0.05) ** 2));
      const voice = talk[i] * (0.5 + 0.5 * Math.sin(sy)) ** 2 * (nearA + nearB) * 2.2;
      o[i] = (st[i] * (0.55 - 0.35 * (nearA + nearB)) + Math.sin(ph) * 0.1 + voice) * env;
    }
  },
  uiHover: (o, rng, sr) => {
    // a 2-3 ms tick: the soft detent of a jog dial (3 kHz partial with a sliver of plastic noise)
    addMode(o, sr, 0, 2900 + 200 * rng.float(), 0.0009, 1, 0, 0.0002);
    const c = noise(rng, sr, 0.004);
    filterChain(c, bp(4200, 1.2, sr));
    env(c, sr, (t) => Math.exp(-t / 0.0006));
    place(o, c, 0, 0.6);
  },
  uiClick: (o, rng, sr) => camButton(o, rng, sr, 0),
  uiOpen: (o, rng, sr) => camButton(o, rng, sr, 1),
  uiClose: (o, rng, sr) => camButton(o, rng, sr, -1),
  sparkCrackle: (o, rng, sr) => {
    // arcing: dense crackle (power-law pops), bursts of 120 Hz arc buzz
    const len = 0.4 + 0.5 * rng.float();
    const cr = crackle(rng, o.length, sr, 2500, 1.4, false);
    filterChain(cr, hp(1800, 0.7, sr));
    env(cr, sr, (t) => (t < len ? 1 : Math.exp(-(t - len) / 0.05)) * (0.4 + 0.6 * Math.abs(Math.sin(TAU * 3.3 * t))));
    place(o, cr, 0, 1);
    const bz = new Float32Array(o.length);
    for (let i = 0; i < bz.length; i++) {
      const t = i / sr;
      const s = 0.5 + 0.5 * Math.sin(TAU * 120 * t);
      bz[i] = (rng.float() * 2 - 1) * s ** 6 * (t < len ? 1 : Math.exp(-(t - len) / 0.03));
    }
    filterChain(bz, bp(2500, 0.7, sr));
    place(o, bz, 0, 0.9);
    addClick(o, sr, 0, 0.9, 0.0008);
  },
};

export function synthOneShot(kind: OneShotKind, variant: number, sampleRate: number): Float32Array[] {
  const sr = sampleRate;
  const ki = ONESHOT_KINDS.indexOf(kind);
  const rng = dspRng(DOMAIN.ONESHOT, ki < 0 ? 99 : ki, variant | 0);
  const o = new Float32Array(samplesOf(LEN[kind] ?? 1, sr));
  const fn = S[kind];
  if (fn) fn(o, rng, sr);
  // rumble cleanup
  const dc = new Biquad().highpass(28, 0.7071, sr);
  dc.run(o);
  // no stingers: ambient kinds ramp in over a 40 ms raised cosine (>= 20 ms attack); all kinds end at silence
  if (AMBIENT_ONESHOTS.has(kind)) {
    const na = Math.round(0.04 * sr);
    for (let i = 0; i < na && i < o.length; i++) o[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / na);
  }
  const nf = Math.min(o.length, Math.round(0.03 * sr));
  for (let i = 0; i < nf; i++) o[o.length - 1 - i] *= i / nf;
  return [normalizePeak(sanitize([o]), PEAK[kind] ?? 0.8)[0]];
}
