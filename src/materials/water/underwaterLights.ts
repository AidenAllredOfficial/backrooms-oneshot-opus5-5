// src/materials/water/underwaterLights.ts — package E: the UNDERWATER lamps whose light the water body scatters
// toward the eye (WaterMaterial, BR_WATER_VOLLIGHT: brWaterLamps). Every SCAN_FRAMES frames the pure picker keeps the
// nearest `max` lamps that are on, under water and not behind the camera; every frame their positions are written
// camera-relative (MaterialGlobals uwPos / uwDir / uwCol / nUw), so the shader works in small numbers. The ripple
// system (WaterRipples.update) drives it, sharing its frame and world scan cadence.
// lampScatter is the TS twin of the shader's integral (tan substitution), unit-tested against brute force.

import { CELL } from '../../core/constants.ts';
import { chunkOriginX, chunkOriginZ, worldToChunk } from '../../core/grid.ts';
import { DYING_MEAN, FixtureKind, LightState } from '../../core/ids.ts';
import { fixtureRadiance } from '../../core/layout.ts';
import type { MaterialGlobals } from '../../core/runtime.ts';
import { waterAtCell, type RippleWorld } from './rippleSources.ts';

export const UW = {
  RANGE: 25, // m from the eye
  SCAN_FRAMES: 6,
  /** a lamp more than 2 m away whose direction from the eye has a cosine below this with the view is behind */
  BEHIND_COS: -0.35,
  MAX: 4,
} as const;

export interface UwLamp {
  x: number; y: number; z: number; // world metres (y storey-relative)
  nx: number; ny: number; nz: number; // facing (unit)
  r: number; g: number; b: number; // luminous intensity along the facing, per channel (cd)
  radius: number; // m (the integral's closest-approach floor)
  dist: number; // m from the eye at the scan
  id: number;
}

/** Luminous intensity (cd, along the facing) scale of a lamp in a light state (0 = no light): static ON / BUZZ full,
 * DYING at its mean; OFF and the dynamic states (flicker channels) contribute nothing. */
export function lampStateScale(state: number): number {
  if (state === LightState.ON || state === LightState.BUZZ) return 1;
  if (state === LightState.DYING) return DYING_MEAN;
  return 0;
}

/**
 * The nearest `max` UNDERWATER lamps around the eye (3 x 3 chunks, within RANGE m), sorted by distance then id:
 * lit (lampStateScale > 0), in water (the lamp's cell holds water above it), not behind the camera (forward fx, fz).
 * Writes `out` (cleared) and returns the count.
 */
export function pickUnderwaterLights(world: RippleWorld, ex: number, ey: number, ez: number, fx: number, fz: number, max: number, out: UwLamp[]): number {
  out.length = 0;
  if (max <= 0) return 0;
  const cand: UwLamp[] = [];
  const cx0 = worldToChunk(ex), cz0 = worldToChunk(ez);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const l = world.layoutAt(cx0 + dx, cz0 + dz);
      if (!l) continue;
      const ox = chunkOriginX(cx0 + dx), oz = chunkOriginZ(cz0 + dz);
      for (const f of l.fixtures) {
        if (f.kind !== FixtureKind.UNDERWATER) continue;
        const k = f.dynamic ? 0 : lampStateScale(f.state);
        if (k <= 0) continue;
        const x = ox + f.px, y = f.py, z = oz + f.pz;
        const ddx = x - ex, ddy = y - ey, ddz = z - ez;
        const dist = Math.hypot(ddx, ddy, ddz);
        if (dist > UW.RANGE) continue;
        const h = Math.hypot(ddx, ddz);
        if (h > 2 && (ddx * fx + ddz * fz) / h < UW.BEHIND_COS) continue;
        // the lamp's own cell (half a cell in front of the wall it sits in) must hold water above it
        const nl = Math.hypot(f.nx, f.ny, f.nz) || 1;
        const nx = f.nx / nl, ny = f.ny / nl, nz = f.nz / nl;
        const wy = waterAtCell(world, x + nx * CELL * 0.25, z + nz * CELL * 0.25);
        if (wy === null || wy <= y) continue;
        // luminance x the lens area (rect w x h; disc of diameter w)
        const I = fixtureRadiance(f) * (f.shape === 0 ? f.w * f.h : Math.PI * 0.25 * f.w * f.w) * k;
        cand.push({ x, y, z, nx, ny, nz, r: I * f.color[0], g: I * f.color[1], b: I * f.color[2], radius: 0.5 * Math.max(f.w, f.h), dist, id: f.id });
      }
    }
  }
  cand.sort((a, b) => a.dist - b.dist || a.id - b.id);
  for (let i = 0; i < cand.length && out.length < max; i++) out.push(cand[i]);
  return out.length;
}

/**
 * TS twin of the shader's lamp integral (chunks/water.ts brWaterLamps) for one lamp and one channel: radiance
 * scattered toward the eye along the segment X(s) = P + T s, s in [0, L] (T unit, pointing into the water),
 * ss * I0 * integral of max(n . w, 0) phase(w . -T) exp(-st (r + s)) / r^2 ds, with w the unit direction lamp -> X
 * and r its distance. The substitution s = tc + h tan(th) (tc the closest approach, h its distance) turns ds / r^2
 * into dth / h: `steps` midpoint samples in th (the shader uses 6).
 */
export function lampScatter(
  P: readonly number[], T: readonly number[], L: number, Q: readonly number[], n: readonly number[], I0: number,
  ss: number, st: number, phase: (mu: number) => number, steps = 6, hMin = 0.1,
): number {
  const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const QP = [Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]];
  const tc = dot(QP, T);
  const h = Math.max(Math.hypot(QP[0] - T[0] * tc, QP[1] - T[1] * tc, QP[2] - T[2] * tc), hMin);
  const a0 = Math.atan(-tc / h), a1 = Math.atan((L - tc) / h);
  let sum = 0;
  for (let j = 0; j < steps; j++) {
    const th = a0 + (a1 - a0) * ((j + 0.5) / steps);
    const s = tc + h * Math.tan(th);
    const w = [P[0] + T[0] * s - Q[0], P[1] + T[1] * s - Q[1], P[2] + T[2] * s - Q[2]];
    const r = Math.hypot(w[0], w[1], w[2]);
    const wn = [w[0] / r, w[1] / r, w[2] / r];
    sum += Math.max(dot(n, wn), 0) * phase(-dot(wn, T)) * Math.exp(-st * (r + s));
  }
  return ss * I0 * sum * ((a1 - a0) / (steps * h));
}

export interface UnderwaterLights {
  /** per frame (after the camera pose): re-pick every SCAN_FRAMES frames, write the camera-relative globals */
  update(world: RippleWorld, eyeX: number, eyeY: number, eyeZ: number, camYaw: number): void;
  /** how many lamps the shader integrates (q.waterVolumetrics with the refraction pass; 0 = off) */
  setMax(n: number): void;
  readonly lamps: readonly UwLamp[];
  reset(): void;
}

export function createUnderwaterLights(globals: MaterialGlobals): UnderwaterLights {
  let max = 0, wait = 0;
  const lamps: UwLamp[] = [];
  const publish = (ex: number, ey: number, ez: number): void => {
    const n = Math.min(lamps.length, max, globals.uwPos.value.length);
    for (let i = 0; i < n; i++) {
      const l = lamps[i];
      globals.uwPos.value[i].set(l.x - ex, l.y - ey, l.z - ez, 0);
      globals.uwDir.value[i].set(l.nx, l.ny, l.nz, l.radius);
      globals.uwCol.value[i].set(l.r, l.g, l.b, 0);
    }
    globals.nUw.value = n;
  };
  return {
    lamps,
    update(world, ex, ey, ez, camYaw) {
      if (max <= 0) { globals.nUw.value = 0; return; }
      if (--wait <= 0) {
        wait = UW.SCAN_FRAMES;
        pickUnderwaterLights(world, ex, ey, ez, -Math.sin(camYaw), -Math.cos(camYaw), max, lamps);
      }
      publish(ex, ey, ez);
    },
    setMax(n) {
      max = Math.max(0, Math.min(UW.MAX, Math.floor(n)));
      wait = 0;
      if (max <= 0) { lamps.length = 0; globals.nUw.value = 0; }
    },
    reset() {
      lamps.length = 0;
      wait = 0;
      globals.nUw.value = 0;
    },
  };
}
