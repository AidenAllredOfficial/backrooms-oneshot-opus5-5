// src/audio/dsp/beds.ts — loopable ambience beds (pure, stereo).
// Every bed is exactly periodic over its length (integer-cycle oscillators, circularly filtered noise, wrapped
// events) and normalized to BED_RMS (-20 dBFS RMS, peak <= 0.98) so the engine's per-zone dB table is absolute.

import type { Rng } from '../../core/rng.ts';
import { bandNoise, brownNoise, pinkNoise, whiteNoise } from './noise.ts';
import {
  addBubble, addLoopSine, addWrapped, bp, DOMAIN, dspRng, filterLoop, hp, lp, normalizeRms, periodicCurve, rotateToQuietSeam,
  sanitize, samplesOf, sineTable, stereo, TAU,
} from './util.ts';

export type BedKind = 'roomTone' | 'hvac' | 'water' | 'pump' | 'drone' | 'breath' | 'officeHvac' | 'fanDrone' | 'roofCreaks' | 'wade';
export const BED_KINDS: readonly BedKind[] = ['roomTone', 'hvac', 'water', 'pump', 'drone', 'breath', 'officeHvac', 'fanDrone', 'roofCreaks', 'wade'];
/** RMS every bed is normalized to (linear, = -20 dBFS). */
export const BED_RMS = 0.1;

/** Scatter Poisson events (rate per second) over a loop of n samples; calls fn(sampleIndex) for each. */
function poisson(rng: Rng, n: number, sr: number, rate: number, fn: (at: number) => void): void {
  let t = rng.float() / Math.max(1e-6, rate);
  const T = n / sr;
  while (t < T) {
    fn(Math.floor(t * sr));
    t += -Math.log(1 - rng.float() * 0.999999) / rate;
  }
}

/** Mix shared + independent noise per channel for a partially correlated stereo image. */
function stereoize(shared: Float32Array, a: Float32Array, b: Float32Array, corr: number): Float32Array[] {
  const n = shared.length;
  const o = stereo(n);
  const ks = Math.sqrt(corr), ki = Math.sqrt(1 - corr);
  for (let i = 0; i < n; i++) { o[0][i] = shared[i] * ks + a[i] * ki; o[1][i] = shared[i] * ks + b[i] * ki; }
  return o;
}

function mulCurve(chs: Float32Array[], c: Float32Array, depth: number): void {
  for (const o of chs) for (let i = 0; i < o.length; i++) o[i] *= 1 - depth + depth * 2 * c[i];
}

function airNoise(rng: Rng, n: number, sr: number, lo: number, hi: number, corr: number): Float32Array[] {
  const mk = (): Float32Array => filterLoop(pinkNoise(rng, n, true), hp(lo, 0.7071, sr), lp(hi, 0.7071, sr));
  return stereoize(mk(), mk(), mk(), corr);
}

function addTo(dst: Float32Array[], src: Float32Array[], g: number): void {
  for (let c = 0; c < dst.length; c++) {
    const s = src[Math.min(c, src.length - 1)], d = dst[c];
    for (let i = 0; i < d.length; i++) d[i] += s[i] * g;
  }
}

function hvacCore(rng: Rng, n: number, sr: number, tab: Float64Array): Float32Array[] {
  const o = airNoise(rng, n, sr, 70, 1400, 0.55);
  // duct resonance bump
  for (const c of o) filterLoop(c, bp(240 + 60 * rng.float(), 1.2, sr));
  const air = airNoise(rng, n, sr, 70, 1400, 0.55);
  addTo(o, air, 1.4);
  // low rumble
  const rum = brownNoise(rng, n, sr, true, 1, 8);
  filterLoop(rum, lp(110, 0.7071, sr));
  addTo(o, [rum], 0.5);
  // blower blade-pass tone (faint, stable)
  const bpCyc = Math.round((110 + 30 * rng.float()) * n / sr);
  for (let k = 1; k <= 4; k++) for (const c of o) addLoopSine(c, bpCyc * k, 0.02 / k, rng.float(), tab);
  // slow level wander
  mulCurve(o, periodicCurve(rng, n, 5), 0.12);
  return o;
}

export function synthBed(kind: BedKind, sampleRate: number, seconds: number, seed: number): Float32Array[] {
  const sr = sampleRate;
  const n = samplesOf(seconds, sr);
  const rng = dspRng(DOMAIN.BED, BED_KINDS.indexOf(kind), 0, seed);
  const tab = sineTable(n);
  let o: Float32Array[];

  switch (kind) {
    case 'roomTone': {
      // the "sound of an empty building": brown + a little pink, rolled off above 2.5 kHz
      const mk = (): Float32Array => {
        const b = brownNoise(rng, n, sr, true, 1, 15);
        const p = pinkNoise(rng, n, true, 0.5);
        for (let i = 0; i < n; i++) b[i] = b[i] * 0.55 + p[i];
        return filterLoop(b, hp(22, 0.7071, sr), lp(2500, 0.7071, sr));
      };
      o = stereoize(mk(), mk(), mk(), 0.4);
      break;
    }
    case 'hvac':
      o = hvacCore(rng, n, sr, tab);
      break;
    case 'officeHvac': {
      o = hvacCore(rng, n, sr, tab);
      filterLoop(o[0], lp(1000, 0.7071, sr)); filterLoop(o[1], lp(1000, 0.7071, sr));
      normalizeRms(o, BED_RMS);
      // CRT flyback whine: a narrow band near 8 kHz at -40 dBFS RMS (amplitude 0.0141), slowly wavering
      const fw = 7900 + 200 * rng.float();
      const cyc = Math.round((fw * n) / sr);
      const w = periodicCurve(rng, n, 3);
      const whine = new Float32Array(n);
      addLoopSine(whine, cyc, 0.0141, rng.float(), tab);
      addLoopSine(whine, cyc + Math.round((3 * n) / sr), 0.004, rng.float(), tab); // sideband: narrow band, not a pure tone
      for (let i = 0; i < n; i++) whine[i] *= 0.8 + 0.4 * w[i];
      addTo(o, [whine], 1);
      return rotateToQuietSeam(sanitize(o));
    }
    case 'water': {
      // pool hall: lapping against the gutters, the filter return trickle, distant drips
      o = stereo(n);
      for (let ch = 0; ch < 2; ch++) {
        const cr = rng.fork(ch + 11);
        const lap = new Float32Array(n);
        poisson(cr, n, sr, 1.3, (at) => {
          const len = Math.round((0.25 + 0.35 * cr.float()) * sr);
          const g = new Float32Array(len);
          for (let i = 0; i < len; i++) {
            const t = i / len;
            g[i] = (cr.float() * 2 - 1) * Math.sin(Math.PI * Math.pow(t, 0.6)) ** 2;
          }
          addWrapped(lap, g, at, 0.4 + 0.6 * cr.float());
        });
        filterLoop(lap, lp(650 + 200 * cr.float(), 0.9, sr), hp(90, 0.7071, sr));
        const trickle = bandNoise(cr, n, sr, 1800, 6500, true, 0.12);
        const am = periodicCurve(cr, n, 17);
        for (let i = 0; i < n; i++) o[ch][i] = lap[i] * 1.8 + trickle[i] * (0.6 + 0.8 * am[i]);
        poisson(cr, n, sr, 0.35, (at) => addBubble(o[ch], sr, at, 1300 + 1500 * cr.float(), 0.3, 0.02 + 0.03 * cr.float(), 0.18, true));
      }
      const low = brownNoise(rng, n, sr, true, 1, 10);
      filterLoop(low, lp(180, 0.7071, sr));
      addTo(o, [low], 0.35);
      break;
    }
    case 'pump': {
      // positive-displacement pump: motor harmonics, piston thump + valve click each stroke, pulsing flow noise
      o = stereo(n);
      const motorCyc = Math.round((29.5 * n) / sr);
      for (let k = 1; k <= 8; k++) for (const c of o) addLoopSine(c, motorCyc * k, 0.12 / Math.pow(k, 0.9), rng.float(), tab);
      const strokes = Math.max(1, Math.round((1.1 * n) / sr));
      const stroke = new Float32Array(Math.round(0.35 * sr));
      for (let i = 0; i < stroke.length; i++) {
        const t = i / sr;
        stroke[i] = Math.sin(TAU * 58 * t) * Math.exp(-t / 0.07) * 0.8 + Math.sin(TAU * 131 * t) * Math.exp(-t / 0.03) * 0.3;
      }
      const click = whiteNoise(rng, Math.round(0.03 * sr));
      for (let i = 0; i < click.length; i++) click[i] *= Math.exp(-i / (0.004 * sr)) * 0.5;
      const flow = airNoise(rng, n, sr, 60, 900, 0.7);
      for (let s = 0; s < strokes; s++) {
        const at = Math.round((s * n) / strokes);
        for (const c of o) { addWrapped(c, stroke, at, 1); addWrapped(c, click, at + Math.round(0.18 * sr), 1); }
      }
      filterLoop(o[0], hp(25, 0.7071, sr)); filterLoop(o[1], hp(25, 0.7071, sr));
      // flow pulses with each stroke
      const pc = Math.max(1, strokes);
      for (const f of flow) for (let i = 0; i < n; i++) f[i] *= 0.6 + 0.4 * (0.5 + 0.5 * tab[(Math.floor((i * pc) % n))]);
      addTo(o, flow, 1.2);
      break;
    }
    case 'drone': {
      // deep industrial drone: beating low partials over rumble, slow swells
      o = stereo(n);
      const base = 41 + 10 * rng.float();
      const c0 = Math.round((base * n) / sr);
      const partials: [number, number][] = [[c0, 0.5], [c0 + Math.max(1, Math.round((0.35 * n) / sr)), 0.4], [c0 * 2 + 1, 0.22], [c0 * 3, 0.08], [Math.round(c0 * 1.5), 0.1]];
      for (const [cy, a] of partials) { addLoopSine(o[0], cy, a, rng.float(), tab); addLoopSine(o[1], cy, a, rng.float(), tab); }
      const rum = [brownNoise(rng, n, sr, true, 1, 6), brownNoise(rng, n, sr, true, 1, 6)];
      for (const r of rum) filterLoop(r, lp(180, 0.7071, sr));
      addTo(o, rum, 0.8);
      const res = [bandNoise(rng, n, sr, 250, 380, true, 0.25), bandNoise(rng, n, sr, 250, 380, true, 0.25)];
      addTo(o, res, 1);
      mulCurve(o, periodicCurve(rng, n, 4), 0.3);
      break;
    }
    case 'breath': {
      // close breathing (mouth/nose), ~3.2 s cycles: inhale (brighter, rising) then longer exhale (duller)
      const m = new Float32Array(n);
      const cycles = Math.max(1, Math.round(n / sr / 3.2));
      const per = n / cycles;
      for (let c = 0; c < cycles; c++) {
        const at = Math.round(c * per);
        const inL = Math.round((0.9 + 0.3 * rng.float()) * sr), exL = Math.round((1.2 + 0.4 * rng.float()) * sr);
        const gap = Math.round(0.12 * sr);
        const inh = whiteNoise(rng, inL);
        const f1 = bp(1300 + 300 * rng.float(), 1.3, sr), f2 = bp(2600, 2, sr);
        for (let i = 0; i < inL; i++) {
          const t = i / inL;
          const x = inh[i];
          inh[i] = (f1.process(x) + 0.5 * f2.process(x)) * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.7)), 1.5) * 0.9;
        }
        addWrapped(m, inh, at, 1);
        const exh = whiteNoise(rng, exL);
        const g1 = bp(650 + 200 * rng.float(), 0.9, sr), g2 = lp(2600, 0.7071, sr);
        for (let i = 0; i < exL; i++) {
          const t = i / exL;
          exh[i] = g2.process(g1.process(exh[i])) * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.45)), 2) * 1.1;
        }
        addWrapped(m, exh, at + inL + gap, 1);
      }
      filterLoop(m, hp(120, 0.7071, sr));
      const b = new Float32Array(m);
      const d = Math.round(0.0004 * sr);
      o = [m, b];
      // tiny inter-aural difference so it sits inside the head, not hard-centre
      if (d > 0) { const t = new Float32Array(n); t.set(b.subarray(n - d), 0); t.set(b.subarray(0, n - d), d); o = [m, t]; }
      break;
    }
    case 'fanDrone': {
      // large exhaust fan: blade-pass harmonics, a second slightly detuned fan (slow beating), rotation AM on air
      o = stereo(n);
      const bpf = 90 + 25 * rng.float();
      const c1 = Math.round((bpf * n) / sr), c2 = c1 + Math.max(1, Math.round((0.6 * n) / sr));
      for (let k = 1; k <= 6; k++) {
        const a = 0.25 / Math.pow(k, 1.3);
        addLoopSine(o[0], c1 * k, a, rng.float(), tab); addLoopSine(o[1], c1 * k, a * 0.8, rng.float(), tab);
        addLoopSine(o[0], c2 * k, a * 0.6, rng.float(), tab); addLoopSine(o[1], c2 * k, a * 0.75, rng.float(), tab);
      }
      const air = airNoise(rng, n, sr, 55, 1800, 0.5);
      const rot = Math.round(((bpf / 7) * n) / sr);
      let ri = 0;
      for (let i = 0; i < n; i++) {
        const g = 1 + 0.12 * tab[ri];
        air[0][i] *= g; air[1][i] *= g;
        ri += rot; if (ri >= n) ri -= n;
      }
      addTo(o, air, 1.3);
      break;
    }
    case 'roofCreaks': {
      // a big roof moving: sparse stick-slip creaks and thermal ticks over faint wind
      o = airNoise(rng, n, sr, 30, 500, 0.3);
      for (const c of o) for (let i = 0; i < n; i++) c[i] *= 0.35;
      const wind = [brownNoise(rng, n, sr, true, 1, 5), brownNoise(rng, n, sr, true, 1, 5)];
      for (const w of wind) filterLoop(w, lp(260, 0.7071, sr));
      addTo(o, wind, 0.6);
      mulCurve(o, periodicCurve(rng, n, 6), 0.35);
      for (let ch = 0; ch < 2; ch++) {
        const cr = rng.fork(ch + 21);
        poisson(cr, n, sr, 0.22, (at) => {
          const len = Math.round((0.25 + 0.6 * cr.float()) * sr);
          const cg = new Float32Array(len);
          let ph = 0;
          const r0 = 35 + 70 * cr.float(), r1 = r0 * (0.6 + 0.9 * cr.float());
          for (let i = 0; i < len; i++) {
            const t = i / len;
            const r = r0 + (r1 - r0) * t;
            const prev = ph;
            ph += r / sr;
            if (Math.floor(ph) !== Math.floor(prev)) cg[i] = (0.6 + 0.4 * cr.float()) * Math.sin(Math.PI * t);
          }
          const fa = bp(260 + 500 * cr.float(), 6, sr), fb2 = bp(700 + 700 * cr.float(), 8, sr);
          for (let i = 0; i < len; i++) { const x = cg[i]; cg[i] = fa.process(x) * 3 + fb2.process(x) * 2; }
          addWrapped(o[ch], cg, at, 0.9 + 0.6 * cr.float());
        });
        poisson(cr, n, sr, 0.3, (at) => {
          const tk = new Float32Array(Math.round(0.12 * sr));
          const f = 900 + 1800 * cr.float();
          for (let i = 0; i < tk.length; i++) tk[i] = Math.sin((TAU * f * i) / sr) * Math.exp(-i / (0.018 * sr));
          addWrapped(o[ch], tk, at, 0.12 + 0.2 * cr.float());
        });
      }
      break;
    }
    case 'wade': {
      // water moving around the legs while wading: sloshing low noise pulsing with the stride, bubbles
      o = stereo(n);
      const stride = Math.max(1, Math.round((1.6 * n) / sr));
      for (let ch = 0; ch < 2; ch++) {
        const cr = rng.fork(ch + 31);
        const x = whiteNoise(cr, n);
        filterLoop(x, lp(850, 0.8, sr), bp(480, 0.7, sr));
        let si = Math.floor(cr.float() * n);
        const wob = periodicCurve(cr, n, 23);
        for (let i = 0; i < n; i++) {
          const s = 0.5 + 0.5 * tab[si];
          o[ch][i] = x[i] * (0.35 + 0.9 * s * s) * (0.8 + 0.4 * wob[i]) * 2.5;
          si += stride; if (si >= n) si -= n;
        }
        poisson(cr, n, sr, 7, (at) => addBubble(o[ch], sr, at, 350 + 1100 * cr.float(), 0.4, 0.008 + 0.015 * cr.float(), 0.05 + 0.08 * cr.float(), true));
      }
      break;
    }
    default:
      o = stereo(n);
  }
  normalizeRms(sanitize(o), BED_RMS);
  return rotateToQuietSeam(o);
}

/** Cloth rustle loop (foley; not a BedKind): crinkly band-limited noise with fast random AM, stereo, BED_RMS. */
export function synthRustle(sampleRate: number, seconds: number, seed: number): Float32Array[] {
  const sr = sampleRate;
  const n = samplesOf(seconds, sr);
  const rng = dspRng(DOMAIN.RUSTLE, 0, 0, seed);
  const o = stereo(n);
  for (let ch = 0; ch < 2; ch++) {
    const cr = rng.fork(ch + 1);
    const x = whiteNoise(cr, n);
    filterLoop(x, hp(700, 0.7071, sr), lp(7000, 0.7071, sr), bp(2400, 0.5, sr));
    const am = periodicCurve(cr, n, Math.max(8, Math.round((n / sr) * 18)));
    for (let i = 0; i < n; i++) { const a = am[i]; o[ch][i] = x[i] * a * a * a; }
  }
  normalizeRms(sanitize(o), BED_RMS);
  return rotateToQuietSeam(o);
}
