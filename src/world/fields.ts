// src/world/fields.ts — continuous power / decay / humidity / warmth fields (WP1).
//
// Each field is fbm2(hash3(seed, SALT.FIELD_X, s), x/λ, z/λ, octaves) over WORLD metres, λ from FIELD_WAVELENGTH:
//   power:    2 octaves, contrast(v, 1); storey 0 adds 0.45·(1 − smoothstep(15, 45, |xz|)) so the spawn is lit
//   decay:    3 octaves
//   humidity: 3 octaves; storey 2 adds +0.25
//   warmth:   1 octave
// Every value is clamped to [0, 0.999] so it stays in [0, 1) and floor(v·256) fits a Uint8.

import { FIELD_WAVELENGTH } from '../core/constants.ts';
import { clamp, smoothstep } from '../core/grid.ts';
import type { StoreyId } from '../core/ids.ts';
import { contrast, fbm2 } from '../core/noise.ts';
import { hash3, SALT } from '../core/rng.ts';
import type { FieldSampler } from '../core/world.ts';

const MAX = 0.999;

export function createFieldSampler(seed: number, s: StoreyId): FieldSampler {
  const sp = hash3(seed, SALT.FIELD_POWER, s);
  const sd = hash3(seed, SALT.FIELD_DECAY, s);
  const sh = hash3(seed, SALT.FIELD_HUMIDITY, s);
  const sw = hash3(seed, SALT.FIELD_WARMTH, s);
  const lp = 1 / FIELD_WAVELENGTH.power, ld = 1 / FIELD_WAVELENGTH.decay;
  const lh = 1 / FIELD_WAVELENGTH.humidity, lw = 1 / FIELD_WAVELENGTH.warmth;
  const humidAdd = s === 2 ? 0.25 : 0;
  return {
    power(x, z) {
      let v = contrast(fbm2(sp, x * lp, z * lp, 2), 1);
      if (s === 0) v += 0.45 * (1 - smoothstep(15, 45, Math.sqrt(x * x + z * z)));
      return clamp(v, 0, MAX);
    },
    decay: (x, z) => clamp(fbm2(sd, x * ld, z * ld, 3), 0, MAX),
    humidity: (x, z) => clamp(fbm2(sh, x * lh, z * lh, 3) + humidAdd, 0, MAX),
    warmth: (x, z) => clamp(fbm2(sw, x * lw, z * lw, 1), 0, MAX),
  };
}

/** FieldSampler whose decay is offset by `add` (clamped to [0, 0.999]); LightingProfile.decayAdd (DARK: +0.2). */
export function withDecayAdd(f: FieldSampler, add: number): FieldSampler {
  if (!add) return f;
  return {
    power: f.power,
    decay: (x, z) => clamp(f.decay(x, z) + add, 0, MAX),
    humidity: f.humidity,
    warmth: f.warmth,
  };
}

/** Field value in [0,1) -> stored byte. */
export const fieldByte = (v: number): number => Math.floor(clamp(v, 0, MAX) * 256);
