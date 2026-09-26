// src/post/exposureMath.ts (WP11) — pure auto-exposure maths shared by AutoExposurePass and the tests.
// No three, no DOM. Units: luminance in nits; EV100 = log2(L_avg * 100 / 12.5); exposure = 1 / (1.2 * 2^EV).

import { PHOTOMETRY } from '../core/constants.ts';

/** Log2 luminance packing into two bytes of an RGBA8 texel (the GPU writes it, the CPU reads it back). */
export const LOG_PACK = { MIN: -16, RANGE: 32 } as const;
/** log2(100 / 12.5): reflected-light meter calibration constant K = 12.5. */
export const EV_OFFSET = 3;
/** Asymmetric adaptation: toward a brighter scene (EV up) fast, toward a darker scene slow; slightly underdamped
 * so it hunts a little like a camcorder. */
export const ADAPT = { TAU_BRIGHTER: 0.6, TAU_DARKER: 2.5, ZETA: 0.8, MAX_STEP: 1 / 120 } as const;

/** Encode like the pack shader: q = round(clamp((v - MIN) / RANGE, 0, 1) * 65535); hi = q >> 8, lo = q & 255. */
export function packLog2(v: number): [number, number] {
  const n = Math.min(1, Math.max(0, (v - LOG_PACK.MIN) / LOG_PACK.RANGE));
  const q = Math.floor(n * 65535 + 0.5);
  return [q >> 8, q & 255];
}
export function unpackLog2(hi: number, lo: number): number {
  return ((hi * 256 + lo) / 65535) * LOG_PACK.RANGE + LOG_PACK.MIN;
}
export const ev100FromLog2 = (avgLog2Lum: number): number => avgLog2Lum + EV_OFFSET;
export const exposureFromEv = (ev100: number, bias: number, brightnessEV: number): number =>
  1 / (PHOTOMETRY.EXPOSURE_CAL * 2 ** (ev100 - bias - brightnessEV));
/** Per-pixel luminance clamp of the meter: 2^(EV + 3) * k with k = 12.5 / 100 (lenses cannot dominate). */
export const meterClamp = (ev100: number): number => 2 ** (ev100 + EV_OFFSET) * (12.5 / 100);

export interface ExposureState { ev: number; vel: number }

/** omega = OMEGA_PER_TAU / tau: a critically damped step reaches 63 % at t = tau ((1 + w t) e^(-w t) = 0.37). */
export const OMEGA_PER_TAU = 2.15;

/** Critically-damped-ish spring (zeta 0.8) toward target with asymmetric time constants; substepped. */
export function stepExposure(s: ExposureState, target: number, dt: number): void {
  if (!(dt > 0)) return;
  let left = Math.min(dt, 0.25);
  while (left > 1e-9) {
    const h = Math.min(left, ADAPT.MAX_STEP);
    const tau = target > s.ev ? ADAPT.TAU_BRIGHTER : ADAPT.TAU_DARKER;
    const w = OMEGA_PER_TAU / tau;
    const acc = w * w * (target - s.ev) - 2 * ADAPT.ZETA * w * s.vel;
    s.vel += acc * h;
    s.ev += s.vel * h;
    left -= h;
  }
}
