// src/bake/sh.ts — real SH-L1 helpers (4 coefficients per colour channel) and probe ray directions. Pure module.
// Coefficient order: [Y00, Y1-1 (y), Y10 (z), Y11 (x)]. RGB SH are stored as 12 floats: r0..r3, g0..g3, b0..b3.

import { hash01, hash4, SALT } from '../core/rng.ts';

export const Y00 = 0.282095;
export const Y1 = 0.488603;
/** Irradiance convolution: A0 = pi, A1 = 2 pi / 3. */
const E0 = Math.PI * Y00;
const E1 = (2 * Math.PI / 3) * Y1;

/** Irradiance at unit normal n from radiance SH (one channel, 4 coefficients at sh[o..o+3]); clamped >= 0. */
export function shIrradiance(sh: Float32Array | Float64Array, o: number, nx: number, ny: number, nz: number): number {
  const e = E0 * sh[o] + E1 * (sh[o + 1] * ny + sh[o + 2] * nz + sh[o + 3] * nx);
  return e > 0 ? e : 0;
}
/** Direction-averaged (L0) irradiance of one channel. */
export const shIrradianceL0 = (sh: Float32Array | Float64Array, o: number): number => E0 * sh[o];
/** L1 irradiance vector scale: E(n) = L0 + E1 * (c . n). */
export const SH_E1 = E1;

// ---------------------------------------------------------------- Fibonacci sphere directions

const fibCache = new Map<number, Float64Array>();
/** N unit directions on a Fibonacci sphere (3 floats each). */
export function fibonacciDirs(nDirs: number): Float64Array {
  let d = fibCache.get(nDirs);
  if (d) return d;
  d = new Float64Array(nDirs * 3);
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < nDirs; i++) {
    const y = 1 - (2 * i + 1) / nDirs;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * ga;
    d[i * 3] = Math.cos(phi) * r; d[i * 3 + 1] = y; d[i * 3 + 2] = Math.sin(phi) * r;
  }
  fibCache.set(nDirs, d);
  return d;
}

/** Random rotation (row-major 3x3 in `m`) from a hash of integer world coordinates (Shoemake quaternion). */
export function hashRotation(a: number, b: number, c: number, m: Float64Array): void {
  const h = hash4(a, b, c, SALT.BAKE);
  const u1 = hash01(h), u2 = hash01(hash4(h, a, b, 0x2c1b3c6d)), u3 = hash01(hash4(h, c, a, 0x297a2d39));
  const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
  const qx = s1 * Math.sin(2 * Math.PI * u2), qy = s1 * Math.cos(2 * Math.PI * u2);
  const qz = s2 * Math.sin(2 * Math.PI * u3), qw = s2 * Math.cos(2 * Math.PI * u3);
  m[0] = 1 - 2 * (qy * qy + qz * qz); m[1] = 2 * (qx * qy - qz * qw); m[2] = 2 * (qx * qz + qy * qw);
  m[3] = 2 * (qx * qy + qz * qw); m[4] = 1 - 2 * (qx * qx + qz * qz); m[5] = 2 * (qy * qz - qx * qw);
  m[6] = 2 * (qx * qz - qy * qw); m[7] = 2 * (qy * qz + qx * qw); m[8] = 1 - 2 * (qx * qx + qy * qy);
}
