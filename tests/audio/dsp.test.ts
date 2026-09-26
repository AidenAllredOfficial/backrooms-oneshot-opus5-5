// tests/audio/dsp.test.ts — WP13 DSP acceptance: every EmitterKind / OneShotKind / BedKind renders; deterministic;
// peak <= 1 and no NaN; hum loop seam continuous; Schroeder RT60 of makeIR within +-15 %; spectral-centroid order
// tile > concrete > carpet; loops are seamless; ambient one-shots have a >= 20 ms attack.

import { describe, expect, it } from 'vitest';
import { EmitterKind, SurfaceSound, type EmitterKindId, type SurfaceSoundId } from '../../src/core/ids.ts';
import { BED_KINDS, BED_RMS, synthBed, synthRustle } from '../../src/audio/dsp/beds.ts';
import { runSynth, synthKey, type SynthRequest } from '../../src/audio/dsp/dispatch.ts';
import { synthEmitter } from '../../src/audio/dsp/emitters.ts';
import { synthFixture } from '../../src/audio/dsp/fixtures.ts';
import { synthFootstep } from '../../src/audio/dsp/footsteps.ts';
import { synthHum } from '../../src/audio/dsp/hum.ts';
import { imageSourceTaps, makeIR } from '../../src/audio/dsp/ir.ts';
import { AMBIENT_ONESHOTS, ONESHOT_KINDS, synthOneShot } from '../../src/audio/dsp/oneshots.ts';
import { Biquad, powerSpectrum, rmsOf, rtFromSchroeder, schroederDb, spectralCentroid } from '../../src/audio/dsp/util.ts';
import { IR_BRIGHTNESS, IR_DIMS, IR_RT60 } from '../../src/audio/roomProbe.ts';

const SR = 48000;

function check(chs: Float32Array[], label: string): void {
  expect(chs.length, label).toBeGreaterThan(0);
  const n = chs[0].length;
  expect(n, label).toBeGreaterThan(0);
  let peak = 0, bad = 0;
  for (const c of chs) {
    expect(c.length, `${label} channel length`).toBe(n);
    for (let i = 0; i < c.length; i++) {
      const v = c[i];
      if (!Number.isFinite(v)) bad++;
      else if (Math.abs(v) > peak) peak = Math.abs(v);
    }
  }
  expect(bad, `${label}: non-finite samples`).toBe(0);
  expect(peak, `${label}: peak`).toBeLessThanOrEqual(1);
  expect(rmsOf(chs), `${label}: silent`).toBeGreaterThan(1e-4);
}

function same(a: Float32Array[], b: Float32Array[]): boolean {
  if (a.length !== b.length) return false;
  for (let c = 0; c < a.length; c++) {
    if (a[c].length !== b[c].length) return false;
    for (let i = 0; i < a[c].length; i++) if (a[c][i] !== b[c][i]) return false;
  }
  return true;
}

/** Largest |x[i+1]-x[i]| inside the buffer, and the wrap-around step |x[0]-x[n-1]| (max over channels). */
function steps(chs: Float32Array[]): { interior: number; seam: number } {
  let interior = 0, seam = 0;
  for (const c of chs) {
    for (let i = 1; i < c.length; i++) interior = Math.max(interior, Math.abs(c[i] - c[i - 1]));
    seam = Math.max(seam, Math.abs(c[0] - c[c.length - 1]));
  }
  return { interior, seam };
}

const EMITTER_KINDS = Object.values(EmitterKind) as EmitterKindId[];
const SURFACES = Object.values(SurfaceSound) as SurfaceSoundId[];

describe('hum', () => {
  for (const mains of [50, 60] as const) {
    for (let v = 0; v < 4; v++) {
      it(`variant ${v} @ ${mains} Hz renders, is deterministic and loops seamlessly`, () => {
        const a = synthHum(v, SR, mains, 6);
        check(a, `hum ${v}/${mains}`);
        expect(a.length).toBe(2);
        expect(a[0].length).toBe(6 * SR);
        expect(same(a, synthHum(v, SR, mains, 6))).toBe(true);
        // loop seam: first and last sample delta < 1e-3 (every channel)
        for (const c of a) expect(Math.abs(c[0] - c[c.length - 1])).toBeLessThan(1e-3);
      });
    }
  }
  it('fundamental is 2 x mains and harmonics fall off', () => {
    for (const mains of [50, 60] as const) {
      const x = synthHum(0, SR, mains, 6)[0].subarray(0, 65536);
      const p = powerSpectrum(x);
      const N = (p.length - 1) * 2;
      const band = (f: number): number => {
        const k = Math.round((f * N) / SR);
        let m = 0;
        for (let i = k - 3; i <= k + 3; i++) m = Math.max(m, p[i]);
        return m;
      };
      const f0 = band(2 * mains);
      expect(f0).toBeGreaterThan(band(mains) * 4);
      expect(f0).toBeGreaterThan(band(4 * mains));
      expect(band(4 * mains)).toBeGreaterThan(band(20 * mains) * 0.5);
    }
  });
  it('variants differ', () => {
    expect(same(synthHum(0, SR, 60, 1), synthHum(1, SR, 60, 1))).toBe(false);
  });
  // R2: the hum must be the bright buzzing ballast of the reference footage, not a dull low drone (it was: centroid
  // 170-210 Hz, <3 % of the A-weighted energy above 1.2 kHz)
  for (const mains of [60, 50] as const) {
    it(`bright ballast buzz @ ${mains} Hz: centroid > 400 Hz, 12-25 % of the A-weighted energy in 1.2-6 kHz`, () => {
      for (let v = 0; v < 4; v++) {
        const x = synthHum(v, SR, mains, 6)[0];
        const { P, df } = welch(x);
        let tot = 0, cen = 0, aTot = 0, aBand = 0;
        for (let k = 1; k < P.length; k++) {
          const f = k * df;
          tot += P[k]; cen += f * P[k];
          const w = aWeight(f);
          aTot += P[k] * w;
          if (f >= 1200 && f < 6000) aBand += P[k] * w;
        }
        const centroid = cen / tot, share = aBand / aTot;
        expect(centroid, `hum ${v}/${mains} centroid`).toBeGreaterThan(400);
        expect(share, `hum ${v}/${mains} A-weighted 1.2-6 kHz share`).toBeGreaterThan(0.12);
        expect(share, `hum ${v}/${mains} A-weighted 1.2-6 kHz share`).toBeLessThan(0.25);
        // harmonics keep going well above the old 1.2 kHz cut: the harmonic nearest 2.4 kHz stands clearly above the
        // buzz noise between harmonics (higher up the gated noise band takes over, as in the recordings)
        const f0 = 2 * mains;
        const kh = Math.round(2400 / f0) * f0;
        const at = (f: number): number => { let m = 0; for (let b = Math.round(f / df) - 2; b <= Math.round(f / df) + 2; b++) m = Math.max(m, P[b]); return m; };
        expect(at(kh), `hum ${v}/${mains} harmonic at ${kh} Hz`).toBeGreaterThan(at(kh + f0 / 2) * 4);
      }
    });
  }
});

/** Welch-averaged power spectrum (Hann, 65536-point segments, 50 % overlap). */
function welch(x: Float32Array, N = 65536): { P: Float64Array; df: number } {
  let P: Float64Array | null = null;
  for (let off = 0; off + N <= x.length; off += N / 2) {
    const p = powerSpectrum(x.subarray(off, off + N));
    if (!P) P = new Float64Array(p.length);
    for (let k = 0; k < p.length; k++) P[k] += p[k];
  }
  return { P: P ?? powerSpectrum(x), df: SR / N };
}
/** A-weighting as a power ratio (IEC 61672, +2.0 dB normalisation at 1 kHz). */
function aWeight(f: number): number {
  const f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return Math.pow(10, (20 * Math.log10(ra) + 2.0) / 10);
}

describe('footsteps', () => {
  it('every surface x 8 variants renders deterministically', () => {
    for (const s of SURFACES) {
      for (let v = 0; v < 8; v++) {
        const a = synthFootstep(s, v, SR);
        check(a, `foot ${s}/${v}`);
        expect(same(a, synthFootstep(s, v, SR))).toBe(true);
      }
      expect(same(synthFootstep(s, 0, SR), synthFootstep(s, 1, SR))).toBe(false);
    }
  });
  it('spectral centroid order: tile > concrete > carpet (mean over the 8 variants)', () => {
    const mean = (s: SurfaceSoundId): number => {
      let c = 0;
      for (let v = 0; v < 8; v++) c += spectralCentroid(synthFootstep(s, v, SR)[0], SR);
      return c / 8;
    };
    const carpet = mean(SurfaceSound.CARPET), concrete = mean(SurfaceSound.CONCRETE), tile = mean(SurfaceSound.TILE);
    expect(tile).toBeGreaterThan(concrete);
    expect(concrete).toBeGreaterThan(carpet);
    expect(concrete).toBeGreaterThan(carpet * 3);
  });
  it('carpet is soft but not dull: centroid 350-700 Hz, a 400-2500 Hz drag/scuff 40-130 ms after the heel', () => {
    let c = 0;
    for (let v = 0; v < 8; v++) {
      const x = synthFootstep(SurfaceSound.CARPET, v, SR)[0];
      c += spectralCentroid(x, SR) / 8;
      // energy of the scuff window in the drag band vs. the same band in the silence before the toe settles
      const band = (a: number, b: number): number => {
        const y = new Float32Array(x.subarray(Math.round(a * SR), Math.round(b * SR)));
        new Biquad().highpass(400, 0.7, SR).run(y);
        new Biquad().lowpass(2500, 0.7, SR).run(y);
        return rmsOf([y]);
      };
      expect(band(0.04, 0.13), `carpet ${v} scuff`).toBeGreaterThan(band(0.2, 0.3) * 3);
    }
    expect(c).toBeGreaterThan(350);
    expect(c).toBeLessThan(700);
  });
  it('heel and toe: a second hit 35-70 ms after the first', () => {
    // envelope of a concrete step has two separated maxima
    const x = synthFootstep(SurfaceSound.CONCRETE, 3, SR)[0];
    const win = Math.round(0.004 * SR);
    const env: number[] = [];
    for (let i = 0; i + win < x.length; i += win) {
      let m = 0;
      for (let j = i; j < i + win; j++) m = Math.max(m, Math.abs(x[j]));
      env.push(m);
    }
    const heel = env.indexOf(Math.max(...env.slice(0, 5)));
    const toeWin = env.slice(Math.floor(0.03 * SR / win), Math.ceil(0.075 * SR / win));
    const toe = Math.max(...toeWin);
    expect(heel).toBeLessThan(3);
    expect(toe).toBeGreaterThan(0.15 * env[heel]);
  });
});

describe('fixtures', () => {
  for (const kind of ['tink', 'strike', 'pop', 'off'] as const) {
    it(`${kind} renders (60 and 50 Hz variants), deterministic`, () => {
      for (let v = 0; v < 8; v++) {
        const a = synthFixture(kind, v, SR);
        check(a, `fixture ${kind}/${v}`);
        expect(same(a, synthFixture(kind, v, SR))).toBe(true);
      }
    });
  }
  it('pop is louder than tink', () => {
    expect(rmsOf(synthFixture('pop', 0, SR))).toBeGreaterThan(rmsOf(synthFixture('tink', 0, SR)));
  });
});

describe('emitters', () => {
  for (const kind of EMITTER_KINDS) {
    it(`kind ${kind} renders, deterministic, loops seamlessly`, () => {
      for (const mains of [60, 50] as const) {
        const a = synthEmitter(kind, 1, SR, 6, mains);
        check(a, `emitter ${kind}`);
        expect(same(a, synthEmitter(kind, 1, SR, 6, mains))).toBe(true);
        const s = steps(a);
        expect(s.seam, `emitter ${kind} seam`).toBeLessThanOrEqual(s.interior + 1e-6);
        if (kind !== EmitterKind.PHONE) expect(a[0].length).toBe(6 * SR);
      }
      expect(same(synthEmitter(kind, 0, SR, 6), synthEmitter(kind, 2, SR, 6))).toBe(false);
    });
  }
  it('PHONE cadence follows mains: US 2 s on / 4 s off, UK 0.4/0.2/0.4/2.0', () => {
    const energy = (x: Float32Array, t0: number, t1: number): number => {
      let e = 0;
      for (let i = Math.round(t0 * SR); i < Math.round(t1 * SR); i++) e += x[i] * x[i];
      return e / ((t1 - t0) * SR);
    };
    const us = synthEmitter(EmitterKind.PHONE, 0, SR, 6, 60)[0];
    expect(us.length).toBe(6 * SR);
    expect(energy(us, 0.2, 1.8)).toBeGreaterThan(20 * energy(us, 3.5, 5.8));
    const uk = synthEmitter(EmitterKind.PHONE, 0, SR, 6, 50)[0];
    expect(uk.length).toBe(6 * SR);
    expect(energy(uk, 0.05, 0.35)).toBeGreaterThan(5 * energy(uk, 1.9, 2.9));
    expect(energy(uk, 0.65, 0.95)).toBeGreaterThan(5 * energy(uk, 1.9, 2.9));
  });
});

describe('beds', () => {
  for (const kind of BED_KINDS) {
    it(`${kind} renders, deterministic, loop-seamless, normalized`, () => {
      const a = synthBed(kind, SR, 4, 1);
      check(a, `bed ${kind}`);
      expect(a.length).toBe(2);
      expect(a[0].length).toBe(4 * SR);
      expect(same(a, synthBed(kind, SR, 4, 1))).toBe(true);
      expect(same(a, synthBed(kind, SR, 4, 2))).toBe(false);
      const s = steps(a);
      expect(s.seam, `bed ${kind} seam`).toBeLessThanOrEqual(s.interior + 1e-6);
      expect(rmsOf(a)).toBeLessThanOrEqual(BED_RMS * 1.01 + (kind === 'officeHvac' ? 0.015 : 0));
    });
  }
  it('officeHvac carries a narrow CRT whine near 8 kHz', () => {
    const x = synthBed('officeHvac', SR, 4, 1)[0].subarray(0, 65536);
    const p = powerSpectrum(x);
    const N = (p.length - 1) * 2;
    let peakK = 0, peak = 0;
    for (let k = Math.round((7000 * N) / SR); k < Math.round((9000 * N) / SR); k++) if (p[k] > peak) { peak = p[k]; peakK = k; }
    const f = (peakK * SR) / N;
    expect(f).toBeGreaterThan(7800);
    expect(f).toBeLessThan(8200);
    // narrow: well above the 6-7 kHz neighbourhood
    let ref = 0;
    for (let k = Math.round((6000 * N) / SR); k < Math.round((7000 * N) / SR); k++) ref = Math.max(ref, p[k]);
    expect(peak).toBeGreaterThan(ref * 50);
  });
  it('rustle renders', () => { check(synthRustle(SR, 2, 1), 'rustle'); });
});

describe('one-shots', () => {
  for (const kind of ONESHOT_KINDS) {
    it(`${kind} renders, deterministic`, () => {
      const a = synthOneShot(kind, 0, SR);
      check(a, `oneshot ${kind}`);
      expect(same(a, synthOneShot(kind, 0, SR))).toBe(true);
      expect(same(a, synthOneShot(kind, 1, SR))).toBe(false);
      // ends at silence (no click when the buffer ends)
      const c = a[0];
      expect(Math.abs(c[c.length - 1])).toBeLessThan(1e-3);
    });
  }
  it('ambient kinds have a >= 20 ms attack (no stingers)', () => {
    for (const kind of AMBIENT_ONESHOTS) {
      for (let v = 0; v < 2; v++) {
        const x = synthOneShot(kind, v, SR)[0];
        let peak = 0, at = 0;
        for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > peak) { peak = Math.abs(x[i]); at = i; }
        expect(at / SR, `${kind} time to peak`).toBeGreaterThanOrEqual(0.02);
        let early = 0;
        for (let i = 0; i < Math.round(0.01 * SR); i++) early = Math.max(early, Math.abs(x[i]));
        expect(early, `${kind} first 10 ms`).toBeLessThan(0.3 * peak);
      }
    }
  });
});

describe('interface sounds', () => {
  it('hover is a 2-3 ms tick near 3 kHz; click / open / close are clunk + whirr, open and close last longer', () => {
    for (let v = 0; v < 2; v++) {
      const h = synthOneShot('uiHover', v, SR)[0];
      let e = 0, e4 = 0;
      for (let i = 0; i < h.length; i++) { e += h[i] * h[i]; if (i < Math.round(0.004 * SR)) e4 += h[i] * h[i]; }
      expect(e4 / e, 'hover energy inside 4 ms').toBeGreaterThan(0.95);
      const c = spectralCentroid(h, SR);
      expect(c).toBeGreaterThan(2500);
      expect(c).toBeLessThan(4000);
      const dur = (x: Float32Array): number => { let last = 0; for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.02) last = i; return last / SR; };
      const click = dur(synthOneShot('uiClick', v, SR)[0]);
      expect(click).toBeGreaterThan(0.06);
      expect(click).toBeLessThan(0.25);
      expect(dur(synthOneShot('uiOpen', v, SR)[0])).toBeGreaterThan(click);
      expect(dur(synthOneShot('uiClose', v, SR)[0])).toBeGreaterThan(click);
    }
  });
  it('phone line: a 350 + 440 Hz dial tone for ~3 s, then only hiss', () => {
    const x = synthOneShot('phoneLine', 0, SR)[0];
    const seg = (a: number): Float32Array => x.subarray(Math.round(a * SR), Math.round(a * SR) + 16384);
    const p = powerSpectrum(seg(1.0));
    const N = (p.length - 1) * 2;
    const at = (f: number): number => { const k = Math.round((f * N) / SR); return Math.max(p[k - 1], p[k], p[k + 1]); };
    expect(at(350)).toBeGreaterThan(at(395) * 30);
    expect(at(440)).toBeGreaterThan(at(395) * 30);
    expect(rmsOf([seg(1.0)])).toBeGreaterThan(rmsOf([seg(4.0)]) * 3);
  });
});

describe('impulse responses', () => {
  const midBand = (chs: Float32Array[]): Float32Array[] => chs.map((c) => {
    const o = new Float32Array(c);
    new Biquad().bandpass(1000, 0.7, SR).run(o);
    new Biquad().bandpass(1000, 0.7, SR).run(o);
    return o;
  });
  for (let i = 0; i < IR_RT60.length; i++) {
    const rt = IR_RT60[i];
    it(`RT60 ${rt} s: Schroeder T30 within +-15 % (standard set, brightness ${IR_BRIGHTNESS[i]})`, () => {
      const ir = makeIR(rt, IR_DIMS[i], IR_BRIGHTNESS[i], SR, 7 + i);
      check(ir, `ir ${rt}`);
      expect(ir.length).toBe(2);
      const t30 = rtFromSchroeder(schroederDb(midBand(ir)), SR);
      expect(t30).toBeGreaterThan(rt * 0.85);
      expect(t30).toBeLessThan(rt * 1.15);
      // broadband with full brightness
      const flat = makeIR(rt, IR_DIMS[i], 1, SR, 3);
      const tb = rtFromSchroeder(schroederDb(flat), SR);
      expect(tb).toBeGreaterThan(rt * 0.85);
      expect(tb).toBeLessThan(rt * 1.15);
    });
  }
  it('is deterministic, stereo-decorrelated, unit energy, darker when less bright', () => {
    const a = makeIR(1.0, [12, 10, 2.8], 0.6, SR, 5);
    expect(same(a, makeIR(1.0, [12, 10, 2.8], 0.6, SR, 5))).toBe(true);
    let e = 0, lr = 0, ll = 0, rr = 0;
    for (let i = 0; i < a[0].length; i++) {
      e += a[0][i] ** 2 + a[1][i] ** 2;
      lr += a[0][i] * a[1][i]; ll += a[0][i] ** 2; rr += a[1][i] ** 2;
    }
    expect(e).toBeCloseTo(1, 3);
    expect(Math.abs(lr / Math.sqrt(ll * rr))).toBeLessThan(0.3);
    const bright = spectralCentroid(makeIR(1.0, [12, 10, 2.8], 1, SR, 5)[0], SR);
    const dark = spectralCentroid(makeIR(1.0, [12, 10, 2.8], 0.2, SR, 5)[0], SR);
    expect(bright).toBeGreaterThan(dark);
  });
  it('early reflections: 12-24 image-source taps, sorted, gain falls with delay', () => {
    const taps = imageSourceTaps([10, 8, 3], [4, 1.6, 3], [6, 1.4, 4], 0.9, 24);
    expect(taps.length).toBeGreaterThanOrEqual(12);
    expect(taps.length).toBeLessThanOrEqual(24);
    for (let i = 1; i < taps.length; i++) expect(taps[i].t).toBeGreaterThanOrEqual(taps[i - 1].t);
    // first-order floor reflection: listener at 1.6 m, source at 1.4 m, 2.24 m apart
    expect(taps[0].t).toBeGreaterThan(0);
    expect(taps[taps.length - 1].g).toBeLessThan(taps[0].g);
  });
});

describe('dispatch', () => {
  it('keys are unique per request and runSynth matches the direct call', () => {
    const reqs: SynthRequest[] = [
      { op: 'hum', variant: 1, mains: 60, seconds: 1 }, { op: 'hum', variant: 1, mains: 50, seconds: 1 },
      { op: 'foot', surface: 3, variant: 2 }, { op: 'fixture', kind: 'pop', variant: 4 }, { op: 'ir', index: 0 },
      { op: 'bed', kind: 'hvac', seconds: 1, seed: 1 }, { op: 'emitter', kind: 0, variant: 1, seconds: 1, mains: 60 },
      { op: 'oneshot', kind: 'doorThud', variant: 0 }, { op: 'rustle', seconds: 1, seed: 1 },
    ];
    const keys = new Set(reqs.map(synthKey));
    expect(keys.size).toBe(reqs.length);
    expect(same(runSynth(reqs[2], SR), synthFootstep(3, 2, SR))).toBe(true);
    expect(same(runSynth(reqs[0], SR), synthHum(1, SR, 60, 1))).toBe(true);
  });
  it('renders at 44.1 kHz too', () => {
    check(synthHum(2, 44100, 60, 2), 'hum 44.1k');
    check(synthBed('hvac', 44100, 2, 1), 'bed 44.1k');
    check(synthEmitter(EmitterKind.RADIO, 0, 44100, 4), 'radio 44.1k');
    for (const c of synthHum(2, 44100, 60, 2)) expect(Math.abs(c[0] - c[c.length - 1])).toBeLessThan(1e-3);
  });
});
