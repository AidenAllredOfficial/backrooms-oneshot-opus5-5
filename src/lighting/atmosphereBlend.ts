// src/lighting/atmosphereBlend.ts (WP11) — zone x mood atmosphere targets and the 1.5 s crossfade.
// No three, no DOM: unit-testable in Node. Allocation-free after construction.

import { ZONE_COUNT } from '../core/ids.ts';
import type { AtmosphereParams, AtmosphereState, ColorGrade } from '../core/runtime.ts';
import { ATMOSPHERES, MOOD_EXTRA, MOOD_MODS } from './atmospheres.ts';

export const ATMOSPHERE_FADE_S = 1.5;

type V3 = [number, number, number];

function newGrade(): ColorGrade {
  return {
    temperature: 0, tint: 0, saturation: 1, contrast: 1,
    lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], shadowTint: [1, 1, 1], highlightTint: [1, 1, 1], pedestal: 0,
    toe: 0,
  };
}
export function newParams(): AtmosphereParams {
  return {
    hazeDensity: 0, hazeTint: [1, 1, 1], hazeAlbedo: 0.5, ev100Range: [6.5, 11], exposureBias: 0, bloomIntensity: 0.5,
    aoIntensity: 2, aoColor: [0, 0, 0], grain: 0.5, grade: newGrade(),
  };
}
export function newAtmosphereState(): AtmosphereState {
  return { ...newParams(), grade: newGrade(), hazeTint: [1, 1, 1], ev100Range: [6.5, 11], aoColor: [0, 0, 0], camIrradiance: [0, 0, 0], edgeFog: [0, 0] };
}

const c3 = (d: V3, s: readonly number[]): void => { d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; };
const l3 = (d: V3, a: readonly number[], b: readonly number[], w: number): void => {
  d[0] = a[0] + (b[0] - a[0]) * w; d[1] = a[1] + (b[1] - a[1]) * w; d[2] = a[2] + (b[2] - a[2]) * w;
};

export function copyParams(d: AtmosphereParams, s: AtmosphereParams): void {
  d.hazeDensity = s.hazeDensity; c3(d.hazeTint, s.hazeTint); d.hazeAlbedo = s.hazeAlbedo;
  d.ev100Range[0] = s.ev100Range[0]; d.ev100Range[1] = s.ev100Range[1]; d.exposureBias = s.exposureBias;
  d.bloomIntensity = s.bloomIntensity; d.aoIntensity = s.aoIntensity; c3(d.aoColor, s.aoColor); d.grain = s.grain;
  const g = d.grade, h = s.grade;
  g.temperature = h.temperature; g.tint = h.tint; g.saturation = h.saturation; g.contrast = h.contrast;
  g.pedestal = h.pedestal ?? 0;
  g.toe = h.toe ?? 0;
  c3(g.lift, h.lift); c3(g.gamma, h.gamma); c3(g.gain, h.gain); c3(g.shadowTint, h.shadowTint); c3(g.highlightTint, h.highlightTint);
}

const lp = (w: number, x: number, y: number): number => x + (y - x) * w;

/** d = a + (b - a) * w for every numeric field (d may alias a or b). */
export function lerpParams(d: AtmosphereParams, a: AtmosphereParams, b: AtmosphereParams, w: number): void {
  d.hazeDensity = lp(w, a.hazeDensity, b.hazeDensity); l3(d.hazeTint, a.hazeTint, b.hazeTint, w); d.hazeAlbedo = lp(w, a.hazeAlbedo, b.hazeAlbedo);
  d.ev100Range[0] = lp(w, a.ev100Range[0], b.ev100Range[0]); d.ev100Range[1] = lp(w, a.ev100Range[1], b.ev100Range[1]);
  d.exposureBias = lp(w, a.exposureBias, b.exposureBias); d.bloomIntensity = lp(w, a.bloomIntensity, b.bloomIntensity);
  d.aoIntensity = lp(w, a.aoIntensity, b.aoIntensity); l3(d.aoColor, a.aoColor, b.aoColor, w); d.grain = lp(w, a.grain, b.grain);
  const g = d.grade, ga = a.grade, gb = b.grade;
  g.temperature = lp(w, ga.temperature, gb.temperature); g.tint = lp(w, ga.tint, gb.tint);
  g.saturation = lp(w, ga.saturation, gb.saturation); g.contrast = lp(w, ga.contrast, gb.contrast);
  g.pedestal = lp(w, ga.pedestal ?? 0, gb.pedestal ?? 0);
  g.toe = lp(w, ga.toe ?? 0, gb.toe ?? 0);
  l3(g.lift, ga.lift, gb.lift, w); l3(g.gamma, ga.gamma, gb.gamma, w); l3(g.gain, ga.gain, gb.gain, w);
  l3(g.shadowTint, ga.shadowTint, gb.shadowTint, w); l3(g.highlightTint, ga.highlightTint, gb.highlightTint, w);
}

/** Target params for a (zone, mood) pair: ATMOSPHERES[zone] modified by MOOD_MODS[mood] (+ MOOD_EXTRA). */
export function atmosphereTarget(zone: number, mood: number, out: AtmosphereParams): AtmosphereParams {
  const z = zone >= 0 && zone < ZONE_COUNT ? zone : 0;
  const m = mood >= 0 && mood < MOOD_MODS.length ? mood : 0;
  copyParams(out, ATMOSPHERES[z]);
  const mm = MOOD_MODS[m];
  const mx = MOOD_EXTRA[m];
  out.hazeDensity *= mm.hazeMul;
  out.hazeTint[0] *= mm.tintMul[0]; out.hazeTint[1] *= mm.tintMul[1]; out.hazeTint[2] *= mm.tintMul[2];
  out.ev100Range[0] = Math.max(out.ev100Range[0] + mm.evShift, mm.evMin);
  out.ev100Range[1] = Math.max(out.ev100Range[1] + mm.evShift, out.ev100Range[0] + 0.5);
  out.bloomIntensity *= mx.bloomMul;
  out.grain *= mx.grainMul;
  out.grade.saturation *= mx.saturationMul;
  out.exposureBias *= mx.biasMul;
  return out;
}

export interface AtmosphereBlender {
  /** current blended params (live object, updated in place) */
  readonly current: AtmosphereParams;
  readonly zone: number;
  readonly mood: number;
  /** progress of the running crossfade in [0,1] (1 = settled) */
  readonly progress: number;
  /** advance by dt seconds toward (zone, mood); snap = jump there immediately */
  update(zone: number, mood: number, dt: number, snap: boolean): AtmosphereParams;
}

export function createAtmosphereBlender(): AtmosphereBlender {
  const cur = newParams();
  const from = newParams();
  const to = newParams();
  let zone = -1;
  let mood = -1;
  let alpha = 1;
  const b: AtmosphereBlender = {
    get current() { return cur; },
    get zone() { return zone; },
    get mood() { return mood; },
    get progress() { return alpha; },
    update(z, m, dt, snap) {
      // normalise first (an unloaded cell may report NaN/undefined; NaN !== NaN would restart the fade every frame)
      z = z >= 0 && z < ZONE_COUNT ? z | 0 : 0;
      m = m >= 0 && m < MOOD_MODS.length ? m | 0 : 0;
      if (z !== zone || m !== mood) {
        const first = zone < 0;
        zone = z; mood = m;
        copyParams(from, cur);
        atmosphereTarget(z, m, to);
        alpha = first ? 1 : 0;
      }
      if (snap) alpha = 1;
      else if (alpha < 1) alpha = Math.min(1, alpha + dt / ATMOSPHERE_FADE_S);
      const w = alpha * alpha * (3 - 2 * alpha);
      if (alpha >= 1) copyParams(cur, to);
      else lerpParams(cur, from, to, w);
      return cur;
    },
  };
  return b;
}
