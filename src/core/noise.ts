// src/core/noise.ts — deterministic CPU noise (value noise on an integer lattice, polynomial fade only).
// Safe for layout decisions (no transcendental functions). GLSL counterparts live in WP8 (textures/glsl/noise.ts).

import { hash3, hash01 } from './rng.ts';

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Value noise in [0,1). Lattice spacing 1 unit. */
export function valueNoise2(seed: number, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fade(fx), v = fade(fz);
  const a = hash01(hash3(seed, ix, iz));
  const b = hash01(hash3(seed, ix + 1, iz));
  const c = hash01(hash3(seed, ix, iz + 1));
  const d = hash01(hash3(seed, ix + 1, iz + 1));
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

/** Periodic value noise: lattice wraps every `period` units (period integer >= 1). */
export function valueNoise2P(seed: number, x: number, z: number, period: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fade(fx), v = fade(fz);
  const x0 = ((ix % period) + period) % period, z0 = ((iz % period) + period) % period;
  const x1 = (x0 + 1) % period, z1 = (z0 + 1) % period;
  const a = hash01(hash3(seed, x0, z0));
  const b = hash01(hash3(seed, x1, z0));
  const c = hash01(hash3(seed, x0, z1));
  const d = hash01(hash3(seed, x1, z1));
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

/** Fractal sum normalised to [0,1). lacunarity 2, gain 0.5; octave k uses seed + k*1013. */
export function fbm2(seed: number, x: number, z: number, octaves: number): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let k = 0; k < octaves; k++) {
    sum += amp * valueNoise2(seed + k * 1013, x * f, z * f);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Contrast curve used by fields: remaps [0,1) around 0.5 with polynomial smoothstep applied `n` times. */
export function contrast(v: number, n: number): number {
  for (let i = 0; i < n; i++) v = v * v * (3 - 2 * v);
  return v;
}
