// src/core/flicker.ts — THE pure flicker function shared by lighting uniforms (WP11), panel emissive,
// audio hum/transients (WP13) and QA. OWNERSHIP: WP0 writes this stub; WP11 replaces the bodies
// (signatures frozen). Must be deterministic, frame-rate independent (a pure function of t), allocation-free,
// and honour the photosensitivity mode (see core/settings.ts FlickerMode). Pure: no three, no DOM.
//
// Model (WP11, DESIGN §5.WP11 "Flicker"):
//  FLICKER  Time is cut into 8 s epochs; h = hash3(seed, SALT.FLICKER, epoch). With p 0.55 an epoch holds one
//           burst starting at U(0,6) s, nominal duration U(0.3,2.0) s, depth d = U(0.6,0.95). A burst is a slot
//           process: major slots of SLOT_STD (0.34 s, standard) / SLOT_RED (0.51 s, reduced); every major change of
//           the area-light level happens on a slot boundary, so a 1 s window never holds more than 3 (standard) /
//           2 (reduced) transitions. The first and last slots are LOW; inner slots are LOW or ON. LOW = 1 - d; in
//           deep bursts (d > 0.8, standard only) a LOW slot may be OUT (0). ON slots in standard mode carry
//           micro-flicker: 50 ms micro slots (odd ones only, so drops are isolated) that dip by m <= 0.18.
//           Rising out of a level < 0.2 is a ballast strike with a short overshoot (<= 1.08, tau 60 ms).
//           Outside bursts: 1 +- 0.5 % slow drift. The burst is clamped to end >= 1 slot before the epoch ends.
//  DYING    area light static at DYING_MEAN (baked); lens shimmer only (lensShimmer).
//  BUZZ     area light static on; lens shimmer +-3 % at 120 Hz.
//  ANOMALY  i = 1 here; LightingRuntime overrides the intensity per id.
// Events (flickerEvents) are generated from the same slot structure and coincide exactly with edges of flicker():
//  'off'    a fall to a level < 0.05          'strike' a rise through 0.5 from a level < 0.2 (held >= 150 ms)
//  'tink'   the fall into a micro drop        'pop'    the rise at burst end

import { DYING_MEAN, LightState } from './ids.ts';
import type { LightStateId } from './ids.ts';
import type { FlickerMode } from './settings.ts';
import { hash2, hash3, hash01, SALT } from './rng.ts';

export interface FlickerSample {
  i: number; // light intensity multiplier in [0, 1.1]
  tint: number; // 0..1 ballast colour shift (pink/green end-glow), used for DYING/FLICKER lenses
  buzz: number; // 0..1 audio buzz level
}

export interface FlickerEvent { t: number; kind: 'tink' | 'strike' | 'pop' | 'off' }

// ---------------------------------------------------------------- tunables (exported for tests / QA)
export const FLICKER_TUNING = {
  EPOCH: 8,
  BURST_P: 0.55,
  START_MAX: 6,
  DUR_MIN: 0.3,
  DUR_MAX: 2.0,
  DEPTH_MIN: 0.6,
  DEPTH_MAX: 0.95,
  SLOT_STD: 0.34, // > 1/3 s: at most 3 major transitions in any closed 1 s window
  SLOT_RED: 0.51, // > 1/2 s: at most 2 major transitions in any closed 1 s window
  MICRO_SLOT: 0.05,
  MICRO_P: 0.35,
  MICRO_MIN: 0.06,
  MICRO_MAX: 0.18, // <= 0.2 (and 1.0 - 0.82 stays a sub-0.2 excursion)
  RED_DEPTH_MAX: 0.4,
  DEEP: 0.8, // bursts deeper than this may have OUT slots
  OUT_P: 0.6,
  INNER_LOW_P: 0.55,
  OVERSHOOT: 0.08,
  OVERSHOOT_TAU: 0.06,
  DRIFT: 0.005,
  OFF_MEAN: 0.8,
} as const;

const T = FLICKER_TUNING;
/** flickerEvents looks back at most this many seconds (1.25e4 epochs); audio windows are one frame long. */
const EVENTS_MAX_SPAN = 1e5;
const STRIKE_BELOW = 0.2;
const OFF_BELOW = 0.05;
const MODE_STD = 0;
const MODE_RED = 1;
const MODE_OFF = 2;

const modeIndex = (m: FlickerMode): number => (m === 'standard' ? MODE_STD : m === 'reduced' ? MODE_RED : MODE_OFF);

// Uniform [0,1) draw number k of hash h.
const uh = (h: number, k: number): number => hash01(hash2(h, k));

// Burst descriptor, recomputed per call into module scratch (no allocation).
interface Burst { on: boolean; start: number; slots: number; slot: number; depth: number; h: number }
const B: Burst = { on: false, start: 0, slots: 0, slot: 0, depth: 0, h: 0 };
const B2: Burst = { on: false, start: 0, slots: 0, slot: 0, depth: 0, h: 0 };

/** Fill `b` with the burst of `epoch` (b.on = false if the epoch has none). mode: MODE_STD | MODE_RED. */
function burstOf(seed: number, epoch: number, mode: number, b: Burst): void {
  const h = hash3(seed | 0, SALT.FLICKER, epoch | 0);
  b.h = h;
  b.on = uh(h, 0) < T.BURST_P;
  if (!b.on) return;
  const slot = mode === MODE_RED ? T.SLOT_RED : T.SLOT_STD;
  const start = epoch * T.EPOCH + T.START_MAX * uh(h, 1);
  const dur = T.DUR_MIN + (T.DUR_MAX - T.DUR_MIN) * uh(h, 2);
  let n = Math.floor(dur / slot + 0.5);
  if (n < 1) n = 1;
  // keep >= one slot of ON between this burst's end and the next epoch (whose burst may start at 0)
  const maxN = Math.floor((epoch * T.EPOCH + T.EPOCH - slot - start) / slot);
  if (n > maxN) n = maxN;
  if (n < 1) n = 1;
  b.start = start;
  b.slots = n;
  b.slot = slot;
  const d = T.DEPTH_MIN + (T.DEPTH_MAX - T.DEPTH_MIN) * uh(h, 3);
  b.depth = mode === MODE_RED ? Math.min(T.RED_DEPTH_MAX, d * 0.42) : d;
}

/** Boundary k of a burst (exactly the expression used everywhere, so events and levels agree bit-for-bit). */
const boundary = (b: Burst, k: number): number => b.start + k * b.slot;

/** Major level of slot k (k in [0, slots)); -1 encodes "not in burst" (ON, level 1). */
function slotLevel(b: Burst, k: number, mode: number): number {
  if (k < 0 || k >= b.slots) return 1;
  const low = k === 0 || k === b.slots - 1 || uh(b.h, 10 + k) < T.INNER_LOW_P;
  if (!low) return 1;
  if (mode === MODE_STD && b.depth > T.DEEP && uh(b.h, 40 + k) < T.OUT_P) return 0;
  return 1 - b.depth;
}

/** Micro-drop depth of micro slot j inside ON slot k (0 = none). Standard mode only, odd j only. */
function microDepth(b: Burst, k: number, j: number): number {
  if ((j & 1) === 0) return 0;
  const hk = hash2(b.h, 1000 + k);
  const hj = hash2(hk, j);
  if (hash01(hj) >= T.MICRO_P) return 0;
  return T.MICRO_MIN + (T.MICRO_MAX - T.MICRO_MIN) * uh(hj, 7);
}

/** Micro slot count inside a major slot whose micro slots are fully contained (the partial tail never drops). */
const microCount = (slot: number): number => Math.floor(slot / T.MICRO_SLOT);

function drift(seed: number, t: number): number {
  const h = hash2(seed | 0, SALT.FLICKER);
  const f1 = 0.05 + 0.1 * uh(h, 1);
  const f2 = 0.13 + 0.2 * uh(h, 2);
  const p1 = 6.283185307179586 * uh(h, 3);
  const p2 = 6.283185307179586 * uh(h, 4);
  return 1 + T.DRIFT * (0.6 * Math.sin(6.283185307179586 * f1 * t + p1) + 0.4 * Math.sin(6.283185307179586 * f2 * t + p2));
}

/** Slot index of t inside burst b, robust to rounding: slot k covers [boundary(k), boundary(k+1)). */
function slotIndex(b: Burst, t: number): number {
  let k = Math.floor((t - b.start) / b.slot);
  if (t >= boundary(b, k + 1)) k++;
  else if (t < boundary(b, k)) k--;
  return k;
}

/** Sample light state at absolute time t (seconds). */
export function flicker(state: LightStateId, seed: number, t: number, mode: FlickerMode, out: FlickerSample): void {
  switch (state) {
    case LightState.OFF:
      out.i = 0; out.tint = 0; out.buzz = 0;
      return;
    case LightState.ON:
      out.i = 1; out.tint = 0; out.buzz = 0.3;
      return;
    case LightState.ANOMALY:
      out.i = 1; out.tint = 0; out.buzz = 0.3;
      return;
    case LightState.BUZZ:
      out.i = 1; out.tint = 0.05;
      out.buzz = mode === 'off' ? 0.8 : 0.8 + 0.15 * (lensShimmer(state, seed, t, mode) - 1) / 0.03;
      return;
    case LightState.DYING:
      out.i = DYING_MEAN; out.tint = 0.7;
      out.buzz = mode === 'off' ? 0.5 : Math.max(0, Math.min(1, 0.5 + 1.5 * (lensShimmer(state, seed, t, mode) - 1)));
      return;
    default:
      break;
  }
  // FLICKER
  const m = modeIndex(mode);
  if (m === MODE_OFF) {
    out.i = T.OFF_MEAN; out.tint = 0.2; out.buzz = 0.4;
    return;
  }
  const dr = drift(seed, t);
  const epoch = Math.floor(t / T.EPOCH);
  burstOf(seed, epoch, m, B);
  if (!B.on || t < B.start) {
    out.i = dr; out.tint = 0; out.buzz = 0.35;
    return;
  }
  const k = slotIndex(B, t);
  if (k >= B.slots) {
    // after the burst: possible strike overshoot from the last (LOW/OUT) slot
    const tEnd = boundary(B, B.slots);
    const last = slotLevel(B, B.slots - 1, m);
    let lv = 1;
    if (last < STRIKE_BELOW) lv += T.OVERSHOOT * Math.exp(-(t - tEnd) / T.OVERSHOOT_TAU);
    out.i = dr * lv; out.tint = 0; out.buzz = 0.35;
    return;
  }
  const lvl = slotLevel(B, k, m);
  if (lvl < 1) {
    // LOW/OUT levels carry no drift: the event thresholds (0.05 off, 0.2 strike) then classify exactly the
    // levels that flicker() outputs (a drifted 0.2005 could read 0.1995 and break events <=> edges).
    out.i = lvl;
    out.tint = lvl === 0 ? 0.9 : 0.45 + 0.3 * B.depth;
    out.buzz = lvl === 0 ? 0.1 : 0.8;
    return;
  }
  // ON slot inside the burst
  const t0 = boundary(B, k);
  const prev = slotLevel(B, k - 1, m);
  let lv = 1;
  let tint = 0.15;
  if (prev < STRIKE_BELOW) {
    lv += T.OVERSHOOT * Math.exp(-(t - t0) / T.OVERSHOOT_TAU); // no micro-flicker right after a strike
  } else if (m === MODE_STD) {
    // exact micro boundaries: micro slot j covers [t0 + j*MICRO, t0 + (j+1)*MICRO)
    let j = Math.floor((t - t0) / T.MICRO_SLOT);
    if (t >= t0 + (j + 1) * T.MICRO_SLOT) j++;
    else if (t < t0 + j * T.MICRO_SLOT) j--;
    if (j >= 0 && j < microCount(B.slot)) {
      const md = microDepth(B, k, j);
      if (md > 0) { lv *= 1 - md; tint = 0.35; }
    }
  }
  out.i = dr * lv;
  out.tint = tint;
  out.buzz = 0.6;
}

function pushEvent(out: FlickerEvent[], t: number, kind: FlickerEvent['kind']): void {
  out.push({ t, kind });
}

/** Append transient events with time in (t0, t1] to `out`; returns the number appended.
 * Used by audio to schedule sample-aligned tink/strike/pop ~30 ms ahead. Must agree with flicker(). */
export function flickerEvents(state: LightStateId, seed: number, t0: number, t1: number, mode: FlickerMode, out: FlickerEvent[]): number {
  if (state !== LightState.FLICKER || !(t1 > t0) || !Number.isFinite(t0) || !Number.isFinite(t1)) return 0;
  const m = modeIndex(mode);
  if (m === MODE_OFF) return 0;
  // safety cap for pathological windows (a clock jump must not stall the frame): only the last EVENTS_MAX_SPAN s
  if (t1 - t0 > EVENTS_MAX_SPAN) t0 = t1 - EVENTS_MAX_SPAN;
  const n0 = out.length;
  const e0 = Math.floor(t0 / T.EPOCH);
  const e1 = Math.floor(t1 / T.EPOCH);
  for (let e = e0; e <= e1; e++) {
    burstOf(seed, e, m, B2);
    if (!B2.on) continue;
    const bEnd = boundary(B2, B2.slots);
    if (B2.start > t1 || bEnd <= t0) continue;
    for (let k = 0; k <= B2.slots; k++) {
      const tb = boundary(B2, k);
      if (tb > t1) break;
      const prev = slotLevel(B2, k - 1, m); // k = 0 -> 1 (ON before the burst)
      const cur = slotLevel(B2, k, m); // k = slots -> 1 (ON after the burst)
      if (tb > t0) {
        if (cur < OFF_BELOW && prev >= OFF_BELOW) pushEvent(out, tb, 'off');
        if (cur >= 0.5 && prev < STRIKE_BELOW) pushEvent(out, tb, 'strike');
        if (k === B2.slots) pushEvent(out, tb, 'pop');
      }
      // micro drops inside ON slots (standard only, not right after a strike)
      if (k < B2.slots && m === MODE_STD && cur === 1 && prev >= STRIKE_BELOW) {
        const tNext = boundary(B2, k + 1);
        if (tNext <= t0) continue;
        const mc = microCount(B2.slot);
        for (let j = 1; j < mc; j += 2) {
          const tm = tb + j * T.MICRO_SLOT;
          if (tm > t1) break;
          if (tm <= t0) continue;
          if (microDepth(B2, k, j) > 0) pushEvent(out, tm, 'tink');
        }
      }
    }
  }
  return out.length - n0;
}

// ---------------------------------------------------------------- lens shimmer (TS twin of LENS_SHIMMER_GLSL)
// Integer hash on small non-negative ints (every intermediate < 2^31): exact in GLSL ES 3.00 highp int and in
// JS doubles. Only `seed & 255` is used. Float steps are rounded with Math.fround where GLSL computes in float32.
const SH_P = 65521;
function shH(x: number): number {
  x = (x * 1103 + 4271) % SH_P;
  x = (x * 2029 + 331) % SH_P;
  return x;
}
function shLat(i: number, ch: number, s8: number): number {
  let h = shH(i + ch * 4096);
  h = shH(h + s8 * 257);
  return (h % 1024) / 1023;
}
const f32 = Math.fround;
function shNoise(x: number, ch: number, s8: number): number {
  const fl = Math.floor(x);
  const fr = f32(x - fl);
  const i0 = fl % 4096;
  const i1 = (i0 + 1) % 4096;
  const a = shLat(i0, ch, s8);
  const b = shLat(i1, ch, s8);
  const w = fr * fr * (3 - 2 * fr);
  return a + (b - a) * w;
}
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Emissive-only shimmer multiplier for SHIMMER lenses (DYING: 0.5-2 Hz +-10% with dropouts; BUZZ: +-3% at 120 Hz).
 * Uses ONLY the low 8 bits of `seed` (vertices carry tint.a = seed & 255) so CPU and GPU agree bit-for-bit in
 * structure. Must equal LENS_SHIMMER_GLSL's brLensShimmer(state, float(seed & 255), t, modeIndex) within 1e-3. */
export function lensShimmer(state: LightStateId, seed: number, t: number, mode: FlickerMode): number {
  if (mode === 'off') return 1;
  const s8 = seed & 255;
  const tf = f32(t > 0 ? t : 0);
  if (state === LightState.DYING) {
    const f = f32(0.5 + 1.5 * shLat(s8, 8, s8));
    const x = f32(tf * f);
    const x2 = f32(f32(x * 2.37) + 17);
    const n = 0.65 * shNoise(x, 0, s8) + 0.35 * shNoise(x2, 1, s8);
    const amp = mode === 'reduced' ? 0.05 : 0.1;
    let v = 1 + amp * Math.max(-1, Math.min(1, 1.4 * (2 * n - 1)));
    if (mode === 'standard') {
      const ds = f32(tf * 2);
      const dfl = Math.floor(ds);
      const dfr = f32(ds - dfl);
      const di = dfl % 4096;
      if (shLat(di, 2, s8) < 0.035) {
        const w = clamp01((dfr - 0.1) / 0.05) * clamp01((0.45 - dfr) / 0.05);
        v = v + (0.6 - v) * w;
      }
    }
    return v;
  }
  if (state === LightState.BUZZ) {
    if (mode === 'reduced') return 1;
    const ph = shLat(s8, 9, s8);
    // 120 is an integer: fract(120 t) = fract(120 fract(t)); fract(t) is exact in float32 -> no large arguments
    const tfr = f32(tf - Math.floor(tf));
    const c = f32(f32(tfr * 120) + ph);
    const fr = f32(c - Math.floor(c));
    const slow = shNoise(f32(tf * 0.7), 3, s8);
    return 1 + 0.03 * Math.sin(6.2831853 * fr) * (0.75 + 0.25 * slow);
  }
  return 1;
}

/** GLSL twin of lensShimmer, owned by WP11 (implemented together with the TS version), injected verbatim by WP9.
 * Signature frozen: state = LightState (from aux.w), seed8 = tint.a * 255, mode 0 standard / 1 reduced / 2 off.
 * Only float/int arithmetic and hash-by-fract (no textures, no uniforms). */
export const LENS_SHIMMER_GLSL: string = `
int brShH(int x) {
  x = (x * 1103 + 4271) % 65521;
  x = (x * 2029 + 331) % 65521;
  return x;
}
float brShLat(int i, int ch, int s8) {
  int h = brShH(i + ch * 4096);
  h = brShH(h + s8 * 257);
  return float(h % 1024) / 1023.0;
}
float brShNoise(float x, int ch, int s8) {
  float fl = floor(x);
  float fr = x - fl;
  int i0 = int(fl) % 4096;
  int i1 = (i0 + 1) % 4096;
  float a = brShLat(i0, ch, s8);
  float b = brShLat(i1, ch, s8);
  float w = fr * fr * (3.0 - 2.0 * fr);
  return a + (b - a) * w;
}
float brLensShimmer(int state, float seed8, float t, int mode) {
  if (mode == 2) return 1.0;
  int s8 = int(seed8 + 0.5) % 256;
  t = max(t, 0.0);
  if (state == 3) {
    float f = 0.5 + 1.5 * brShLat(s8, 8, s8);
    float x = t * f;
    float x2 = x * 2.37 + 17.0;
    float n = 0.65 * brShNoise(x, 0, s8) + 0.35 * brShNoise(x2, 1, s8);
    float amp = mode == 1 ? 0.05 : 0.1;
    float v = 1.0 + amp * clamp(1.4 * (2.0 * n - 1.0), -1.0, 1.0);
    if (mode == 0) {
      float ds = t * 2.0;
      float dfl = floor(ds);
      float dfr = ds - dfl;
      int di = int(dfl) % 4096;
      if (brShLat(di, 2, s8) < 0.035) {
        float w = clamp((dfr - 0.1) / 0.05, 0.0, 1.0) * clamp((0.45 - dfr) / 0.05, 0.0, 1.0);
        v = v + (0.6 - v) * w;
      }
    }
    return v;
  }
  if (state == 4) {
    if (mode == 1) return 1.0;
    float ph = brShLat(s8, 9, s8);
    float c = fract(t) * 120.0 + ph;
    float fr = c - floor(c);
    float slow = brShNoise(t * 0.7, 3, s8);
    return 1.0 + 0.03 * sin(6.2831853 * fr) * (0.75 + 0.25 * slow);
  }
  return 1.0;
}
`;

/** Mean intensity of a state (used to bake overflow/static states and for mode 'off'). */
export function flickerMean(state: LightStateId): number {
  return state === LightState.OFF ? 0 : state === LightState.DYING ? DYING_MEAN : state === LightState.FLICKER ? 0.8 : 1;
}
