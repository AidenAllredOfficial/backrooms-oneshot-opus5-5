// tests/lighting/flicker.test.ts (WP11) — the pure flicker function: determinism, range, frame-rate independence,
// WCAG transition windows, reduced/off constraints, events <=> edges, lens shimmer twin basics.
import { describe, expect, it } from 'vitest';
import { flicker, flickerEvents, flickerMean, lensShimmer, LENS_SHIMMER_GLSL, FLICKER_TUNING } from '../../src/core/flicker.ts';
import type { FlickerEvent, FlickerSample } from '../../src/core/flicker.ts';
import { DYING_MEAN, LightState } from '../../src/core/ids.ts';
import type { LightStateId } from '../../src/core/ids.ts';
import type { FlickerMode } from '../../src/core/settings.ts';
import { hash2 } from '../../src/core/rng.ts';

const S: FlickerSample = { i: 0, tint: 0, buzz: 0 };
const iAt = (seed: number, t: number, mode: FlickerMode = 'standard', state: LightStateId = LightState.FLICKER): number => {
  flicker(state, seed, t, mode, S);
  return S.i;
};
const SEEDS = [1, 7, 12345, 0xdeadbeef >>> 0, hash2(99, 3), 424242];
const EDGE = 0.02; // every level step of the model is >= 0.05; drift/overshoot change < 0.002 per ms

describe('flicker: determinism and range', () => {
  it('is deterministic and stays within [0, 1.1] for every state and mode', () => {
    const states: LightStateId[] = [0, 1, 2, 3, 4, 5] as LightStateId[];
    const modes: FlickerMode[] = ['standard', 'reduced', 'off'];
    const a: FlickerSample = { i: 0, tint: 0, buzz: 0 };
    const b: FlickerSample = { i: 0, tint: 0, buzz: 0 };
    for (let n = 0; n < 40000; n++) {
      const h = hash2(n, 77);
      const seed = hash2(h, 1);
      const t = (h >>> 8) / 16777216 * 5000;
      const st = states[n % 6];
      const md = modes[(n >> 3) % 3];
      flicker(st, seed, t, md, a);
      flicker(st, seed, t, md, b);
      if (!Object.is(a.i, b.i)) expect(a.i).toBe(b.i);
      if (!Object.is(a.tint, b.tint)) expect(a.tint).toBe(b.tint);
      if (!Object.is(a.buzz, b.buzz)) expect(a.buzz).toBe(b.buzz);
      if (!(a.i >= 0)) expect(a.i).toBeGreaterThanOrEqual(0);
      if (!(a.i <= 1.1)) expect(a.i).toBeLessThanOrEqual(1.1);
      if (!(a.tint >= 0)) expect(a.tint).toBeGreaterThanOrEqual(0);
      if (!(a.tint <= 1)) expect(a.tint).toBeLessThanOrEqual(1);
      if (!(a.buzz >= 0)) expect(a.buzz).toBeGreaterThanOrEqual(0);
      if (!(a.buzz <= 1)) expect(a.buzz).toBeLessThanOrEqual(1);
    }
  });

  it('static states and off mode', () => {
    for (const seed of SEEDS) {
      for (let t = 0; t < 200; t += 0.37) {
        const on = iAt(seed, t, 'standard', LightState.ON);
        if (!Object.is(on, 1)) expect(on).toBe(1);
        const off = iAt(seed, t, 'standard', LightState.OFF);
        if (!Object.is(off, 0)) expect(off).toBe(0);
        const dying = iAt(seed, t, 'standard', LightState.DYING);
        if (!Object.is(dying, DYING_MEAN)) expect(dying).toBe(DYING_MEAN);
        const buzz = iAt(seed, t, 'reduced', LightState.BUZZ);
        if (!Object.is(buzz, 1)) expect(buzz).toBe(1);
        const still = iAt(seed, t, 'off', LightState.FLICKER);
        if (!Object.is(still, flickerMean(LightState.FLICKER))) expect(still).toBe(flickerMean(LightState.FLICKER));
        const still2 = iAt(seed, t, 'off', LightState.FLICKER);
        if (!Object.is(still2, 0.8)) expect(still2).toBe(0.8);
      }
    }
    const out: FlickerEvent[] = [];
    expect(flickerEvents(LightState.FLICKER, 5, 0, 1000, 'off', out)).toBe(0);
    expect(flickerEvents(LightState.ON, 5, 0, 1000, 'standard', out)).toBe(0);
    expect(flickerEvents(LightState.DYING, 5, 0, 1000, 'standard', out)).toBe(0);
  });

  it('outside bursts the light drifts by at most +-0.5 % and bursts actually happen', () => {
    let lows = 0;
    let nearOne = 0;
    for (let n = 0; n < 200000; n++) {
      const v = iAt(SEEDS[n % SEEDS.length], n * 0.01);
      if (v < 0.5) lows++;
      if (Math.abs(v - 1) <= 0.0051) nearOne++;
    }
    expect(lows).toBeGreaterThan(2000); // bursts exist
    expect(nearOne).toBeGreaterThan(150000); // mostly steady
  });
});

// ---------------------------------------------------------------- edges
interface Edge { t: number; from: number; to: number }
/** Step edges by sampling at `rate` Hz and bisecting each changing interval down to 0.05 ms. */
function edgesAt(seed: number, t0: number, t1: number, rate: number, mode: FlickerMode = 'standard'): Edge[] {
  const out: Edge[] = [];
  const n0 = Math.ceil(t0 * rate);
  const n1 = Math.floor(t1 * rate);
  let prevT = n0 / rate;
  let prev = iAt(seed, prevT, mode);
  for (let n = n0 + 1; n <= n1; n++) {
    const t = n / rate;
    const v = iAt(seed, t, mode);
    if (Math.abs(v - prev) > EDGE) {
      let a = prevT;
      let b = t;
      const va = prev;
      while (b - a > 5e-5) {
        const m = (a + b) / 2;
        if (Math.abs(iAt(seed, m, mode) - va) > EDGE / 2) b = m; else a = m;
      }
      // a true step keeps a jump across the final 50 us bracket (the strike overshoot decay does not)
      if (Math.abs(iAt(seed, b, mode) - iAt(seed, a, mode)) > EDGE) out.push({ t: b, from: va, to: v });
    }
    prev = v;
    prevT = t;
  }
  return out;
}

describe('flicker: frame-rate independence', () => {
  it('30/60/144 Hz sampling finds the same edge times within 1 ms', () => {
    for (const seed of SEEDS.slice(0, 3)) {
      const e30 = edgesAt(seed, 0, 400, 30);
      const e60 = edgesAt(seed, 0, 400, 60);
      const e144 = edgesAt(seed, 0, 400, 144);
      expect(e30.length).toBeGreaterThan(10);
      expect(e60.length).toBe(e30.length);
      expect(e144.length).toBe(e30.length);
      for (let k = 0; k < e30.length; k++) {
        if (!(Math.abs(e60[k].t - e30[k].t) <= 0.001)) expect(Math.abs(e60[k].t - e30[k].t)).toBeLessThanOrEqual(0.001);
        if (!(Math.abs(e144[k].t - e30[k].t) <= 0.001)) expect(Math.abs(e144[k].t - e30[k].t)).toBeLessThanOrEqual(0.001);
      }
    }
  });
});

// ---------------------------------------------------------------- WCAG
/** Zigzag detector: counts excursions > depth from the last extremum; returns the max count in any 1 s window. */
function maxTransitionsPerSecond(seed: number, seconds: number, mode: FlickerMode, dt: number, depth: number): { max: number; total: number; minI: number; maxI: number } {
  const q = new Float64Array(64);
  let qh = 0;
  let qt = 0;
  let max = 0;
  let total = 0;
  let ext = iAt(seed, 0, mode);
  let dir = 0; // 0 unknown, 1 rising, -1 falling
  let minI = Infinity;
  let maxI = -Infinity;
  const n1 = Math.floor(seconds / dt);
  for (let n = 1; n <= n1; n++) {
    const t = n * dt;
    const v = iAt(seed, t, mode);
    if (v < minI) minI = v;
    if (v > maxI) maxI = v;
    let fired = false;
    if (dir >= 0) {
      if (v > ext) ext = v;
      else if (ext - v > depth) { fired = true; dir = -1; ext = v; }
    }
    if (!fired && dir <= 0) {
      if (v < ext) ext = v;
      else if (v - ext > depth) { fired = true; dir = 1; ext = v; }
    }
    if (fired) {
      total++;
      q[qt++ & 63] = t;
      while (q[qh & 63] < t - 1 - 1e-9) qh++;
      const c = qt - qh;
      if (c > max) max = c;
    }
  }
  return { max, total, minI, maxI };
}

describe('flicker: photosensitivity (WCAG 2.3.1)', { tags: ['sweep'] }, () => {
  it('standard: a sliding 1 s window over 1e5 s never has > 3 transitions deeper than 0.2', () => {
    const r = maxTransitionsPerSecond(SEEDS[0], 1e5, 'standard', 0.005, 0.2);
    expect(r.total).toBeGreaterThan(1000);
    expect(r.max).toBeLessThanOrEqual(3);
    expect(r.max).toBe(3); // the limit is actually reached (the model is not trivially slow)
    for (const seed of SEEDS.slice(1, 4)) {
      expect(maxTransitionsPerSecond(seed, 2e4, 'standard', 0.005, 0.2).max).toBeLessThanOrEqual(3);
    }
  });

  it('reduced: depth <= 0.4, <= 2 transitions per second, no micro-flicker, no overshoot', () => {
    for (const seed of SEEDS.slice(0, 3)) {
      const r = maxTransitionsPerSecond(seed, 3e4, 'reduced', 0.005, 0.2);
      expect(r.max).toBeLessThanOrEqual(2);
      expect(r.total).toBeGreaterThan(100);
      expect(r.minI).toBeGreaterThanOrEqual(0.6 * (1 - FLICKER_TUNING.DRIFT) - 1e-9);
      expect(r.maxI).toBeLessThanOrEqual(1 + FLICKER_TUNING.DRIFT + 1e-9);
      // no micro-flicker: every edge is a major step (>= 0.2)
      for (const e of edgesAt(seed, 0, 2000, 1000, 'reduced')) if (!(Math.abs(e.to - e.from) > 0.2)) expect(Math.abs(e.to - e.from)).toBeGreaterThan(0.2);
    }
    const out: FlickerEvent[] = [];
    flickerEvents(LightState.FLICKER, SEEDS[0], 0, 5000, 'reduced', out);
    expect(out.some((e) => e.kind === 'tink' || e.kind === 'strike' || e.kind === 'off')).toBe(false);
    expect(out.some((e) => e.kind === 'pop')).toBe(true);
  });
});

// ---------------------------------------------------------------- events <=> edges
describe('flicker: events coincide with edges sampled at 1 ms', () => {
  it('every event sits on an edge and every classified edge has its event', () => {
    for (const seed of SEEDS.slice(0, 4)) {
      const T0 = 0;
      const T1 = 1500;
      // audio-style windows: (t0, t1] of ~16.7 ms
      const ev: FlickerEvent[] = [];
      for (let t = T0; t < T1; t += 1 / 60) flickerEvents(LightState.FLICKER, seed, t, Math.min(T1, t + 1 / 60), 'standard', ev);
      // the same set in one call
      const ev2: FlickerEvent[] = [];
      flickerEvents(LightState.FLICKER, seed, T0, T1, 'standard', ev2);
      expect(ev.length).toBe(ev2.length);
      for (let k = 1; k < ev.length; k++) if (!(ev[k].t >= ev[k - 1].t)) expect(ev[k].t).toBeGreaterThanOrEqual(ev[k - 1].t);
      const N = Math.round((T1 - T0) * 1000);
      const s = new Float64Array(N + 1);
      for (let n = 0; n <= N; n++) s[n] = iAt(seed, T0 + n / 1000);
      const edgeAt = new Uint8Array(N + 1);
      for (let n = 1; n <= N; n++) if (Math.abs(s[n] - s[n - 1]) > EDGE) edgeAt[n] = 1;
      // events -> edges (+-1 ms)
      const kinds: Record<string, number> = { tink: 0, strike: 0, pop: 0, off: 0 };
      for (const e of ev) {
        kinds[e.kind]++;
        const n = Math.ceil((e.t - T0) * 1000 - 1e-9);
        const hit = edgeAt[n] === 1 || edgeAt[Math.min(N, n + 1)] === 1 || edgeAt[Math.max(0, n - 1)] === 1;
        if (!Object.is(hit, true)) expect(hit, `${e.kind} at ${e.t} has no edge`).toBe(true);
        const before = s[Math.max(0, n - 2)];
        const after = s[Math.min(N, n + 1)];
        if (e.kind === 'off' && !(after < 0.05)) expect(after).toBeLessThan(0.05);
        if ((e.kind === 'strike' || e.kind === 'pop') && !(after > before)) expect(after).toBeGreaterThan(before);
        if (e.kind === 'tink') {
          if (!(after < before)) expect(after).toBeLessThan(before);
          if (!(before - after <= 0.2)) expect(before - after).toBeLessThanOrEqual(0.2);
        }
      }
      expect(kinds.pop).toBeGreaterThan(10);
      expect(kinds.tink).toBeGreaterThan(5);
      // edges -> events
      const has = (kind: string, n: number): boolean => ev.some((e) => e.kind === kind && Math.abs((e.t - T0) * 1000 - n) <= 1.0001);
      for (let n = 1; n <= N; n++) {
        if (!edgeAt[n]) continue;
        const a = s[n - 1];
        const b = s[n];
        if (b < a) {
          if (b < 0.05 && a >= 0.05) { if (!has('off', n)) expect(has('off', n), `fall to ${b} at ${n} ms without 'off'`).toBe(true); }
          else if (a - b <= 0.2) { if (!has('tink', n)) expect(has('tink', n), `micro drop at ${n} ms without 'tink'`).toBe(true); }
        } else if (b >= 0.5 && a < 0.5) {
          let below = true;
          for (let m = Math.max(0, n - 150); m < n; m++) if (s[m] >= 0.2) { below = false; break; }
          if (below && !has('strike', n)) expect(has('strike', n), `strike at ${n} ms without 'strike'`).toBe(true);
        }
      }
    }
  });

  it('strike events exist for deep bursts', () => {
    let strikes = 0;
    let offs = 0;
    for (const seed of SEEDS) {
      const ev: FlickerEvent[] = [];
      flickerEvents(LightState.FLICKER, seed, 0, 3000, 'standard', ev);
      for (const e of ev) { if (e.kind === 'strike') strikes++; if (e.kind === 'off') offs++; }
    }
    expect(strikes).toBeGreaterThan(5);
    expect(offs).toBeGreaterThan(5);
  });
});

describe('flicker: event thresholds see the exact levels', () => {
  it('LOW/OUT slot levels carry no drift (so 0.05 / 0.2 classify exactly what flicker() outputs)', () => {
    for (const seed of SEEDS) {
      const levels = new Map<number, number>(); // epoch -> the LOW level seen (> 0)
      for (let n = 0; n < 400000; n++) {
        const t = n * 0.005;
        const v = iAt(seed, t);
        if (v >= 0.5 || v === 0) continue;
        const e = Math.floor(t / FLICKER_TUNING.EPOCH);
        const l = levels.get(e);
        if (l === undefined) levels.set(e, v);
        else if (!Object.is(v, l)) expect(v).toBe(l); // one constant LOW level per burst
      }
      expect(levels.size).toBeGreaterThan(5);
    }
  });

  it('pathological windows are bounded (no stall on a clock jump)', () => {
    const out: FlickerEvent[] = [];
    const n = flickerEvents(LightState.FLICKER, 3, 0, 1e12, 'standard', out);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(1e6);
    expect(flickerEvents(LightState.FLICKER, 3, 0, Infinity, 'standard', out)).toBe(0);
    expect(flickerEvents(LightState.FLICKER, 3, NaN, 5, 'standard', out)).toBe(0);
  });
});

// ---------------------------------------------------------------- lens shimmer (TS side; GPU parity in harness/post.html?scene=shimmer)
describe('lensShimmer', () => {
  it('ranges, modes and seed & 255', () => {
    let minD = Infinity;
    let maxD = -Infinity;
    let dropouts = 0;
    for (let n = 0; n < 60000; n++) {
      const seed = hash2(n % 64, 5);
      const t = n * 0.0457;
      const d = lensShimmer(LightState.DYING, seed, t, 'standard');
      minD = Math.min(minD, d);
      maxD = Math.max(maxD, d);
      if (d < 0.7) dropouts++;
      const again = lensShimmer(LightState.DYING, seed, t, 'standard');
      if (!Object.is(again, d)) expect(again).toBe(d);
      const wrapped = lensShimmer(LightState.DYING, seed + 256, t, 'standard');
      if (!Object.is(wrapped, d)) expect(wrapped).toBe(d);
      const r = lensShimmer(LightState.DYING, seed, t, 'reduced');
      if (!(r >= 0.95 - 1e-9)) expect(r).toBeGreaterThanOrEqual(0.95 - 1e-9);
      if (!(r <= 1.05 + 1e-9)) expect(r).toBeLessThanOrEqual(1.05 + 1e-9);
      const b = lensShimmer(LightState.BUZZ, seed, t, 'standard');
      if (!(b >= 0.97 - 1e-9)) expect(b).toBeGreaterThanOrEqual(0.97 - 1e-9);
      if (!(b <= 1.03 + 1e-9)) expect(b).toBeLessThanOrEqual(1.03 + 1e-9);
      const buzzReduced = lensShimmer(LightState.BUZZ, seed, t, 'reduced');
      if (!Object.is(buzzReduced, 1)) expect(buzzReduced).toBe(1);
      const dyingOff = lensShimmer(LightState.DYING, seed, t, 'off');
      if (!Object.is(dyingOff, 1)) expect(dyingOff).toBe(1);
      const on = lensShimmer(LightState.ON, seed, t, 'standard');
      if (!Object.is(on, 1)) expect(on).toBe(1);
    }
    expect(minD).toBeGreaterThanOrEqual(0.6 - 1e-9);
    expect(maxD).toBeLessThanOrEqual(1.1 + 1e-9);
    expect(maxD).toBeGreaterThan(1.06);
    expect(dropouts).toBeGreaterThan(0);
    expect(dropouts).toBeLessThan(60000 * 0.05);
  });

  it('GLSL twin exposes the frozen signature and uses no textures/uniforms', () => {
    expect(LENS_SHIMMER_GLSL).toContain('float brLensShimmer(int state, float seed8, float t, int mode)');
    expect(LENS_SHIMMER_GLSL).not.toMatch(/texture|uniform|uint|>>|<<|\^/);
  });
});
