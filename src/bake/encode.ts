// src/bake/encode.ts — final lightmap encoding (WP7 §Algorithms 12). Pure module.
//
// Inputs are per compact texel (TexelSet order), already dilated. Outputs are full atlas-sized RGBA arrays:
//   irr   RGBA16F: rgb = static irradiance (lux; direct + indirect x AO), a = AO; every value clamped to HALF_MAX;
//   dir   RGBA8:   xyz = normalized dominant direction * 0.5 + 0.5 (world), a = directionality
//                  w = |sum E_l w_l| / E (luminance), clamped to [0, 1]; w = 0 and the surface normal when there is
//                  no direct light;
//   flick RGBA16F: per-channel dynamic irradiance luminance (lux), or null;
//   mask  RGBA8:   r stain, g grime, b wetness, a damage.
// Atlas texels not covered by any chart or gutter stay zero (never sampled: gutters are dilated).

import { HALF_MAX, toHalf } from '../core/half.ts';
import type { TexelSet } from './context.ts';

// Local copy of core/half.ts's table conversion (bit-identical, checked at load), inlined into the encode loops.
const hbuf = new ArrayBuffer(4);
const hf32 = new Float32Array(hbuf);
const hu32 = new Uint32Array(hbuf);
const baseT = new Uint16Array(512);
const shiftT = new Uint8Array(512);
for (let i = 0; i < 256; ++i) {
  const e = i - 127;
  let base: number, shift: number;
  if (e < -27) { base = 0; shift = 24; }
  else if (e < -14) { base = 0x0400 >> (-e - 14); shift = -e - 1; }
  else if (e <= 15) { base = (e + 15) << 10; shift = 13; }
  else if (e < 128) { base = 0x7c00; shift = 24; }
  else { base = 0x7c00; shift = 13; }
  baseT[i] = base; baseT[i | 0x100] = base | 0x8000; shiftT[i] = shift; shiftT[i | 0x100] = shift;
}
/** float -> half bits of max(0, min(v, HALF_MAX)) (NaN -> 0). */
export function clampHalf(v: number): number {
  hf32[0] = v > HALF_MAX ? HALF_MAX : v > 0 ? v : 0;
  const f = hu32[0];
  const e = (f >>> 23) & 0x1ff;
  return baseT[e] + ((f & 0x007fffff) >> shiftT[e]);
}
for (const v of [0, 1e-9, 6e-8, 1e-5, 0.1, 0.5, 1, 1.5, 300, 3299.7, 65504, 1e6]) {
  if (clampHalf(v) !== toHalf(v > HALF_MAX ? HALF_MAX : v)) throw new Error(`encode: half conversion mismatch at ${v}`);
}
const u8 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);

export interface EncodedLightmap { irr: Uint16Array; dir: Uint8Array; flick: Uint16Array | null; mask: Uint8Array }

/**
 * e: 3/texel static irradiance, v: 3/texel luminance-weighted direction sum, ao: 1/texel, f: 4/texel or null,
 * m: 4/texel mask in [0, 1].
 */
export function encodeLightmap(T: TexelSet, e: Float32Array, v: Float32Array, ao: Float32Array, f: Float32Array | null, m: Float32Array): EncodedLightmap {
  const size = T.atlasW * T.atlasH;
  const irr = new Uint16Array(size * 4);
  const dir = new Uint8Array(size * 4);
  const flick = f ? new Uint16Array(size * 4) : null;
  const mask = new Uint8Array(size * 4);
  for (let t = 0; t < T.n; t++) {
    const o = T.atlas[t] * 4;
    const r = e[t * 3], g = e[t * 3 + 1], b = e[t * 3 + 2];
    irr[o] = clampHalf(r); irr[o + 1] = clampHalf(g); irr[o + 2] = clampHalf(b); irr[o + 3] = clampHalf(ao[t]);
    const vx = v[t * 3], vy = v[t * 3 + 1], vz = v[t * 3 + 2];
    const vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
    const el = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (vl > 1e-9 && el > 1e-9) {
      let w = vl / el;
      w = w > 1 ? 1 : w;
      dir[o] = u8(vx / vl * 0.5 + 0.5); dir[o + 1] = u8(vy / vl * 0.5 + 0.5); dir[o + 2] = u8(vz / vl * 0.5 + 0.5);
      dir[o + 3] = u8(w);
    } else {
      dir[o] = u8(T.nx[t] * 0.5 + 0.5); dir[o + 1] = u8(T.ny[t] * 0.5 + 0.5); dir[o + 2] = u8(T.nz[t] * 0.5 + 0.5);
      dir[o + 3] = 0;
    }
    if (flick && f) {
      flick[o] = clampHalf(f[t * 4]); flick[o + 1] = clampHalf(f[t * 4 + 1]);
      flick[o + 2] = clampHalf(f[t * 4 + 2]); flick[o + 3] = clampHalf(f[t * 4 + 3]);
    }
    mask[o] = u8(m[t * 4]); mask[o + 1] = u8(m[t * 4 + 1]); mask[o + 2] = u8(m[t * 4 + 2]); mask[o + 3] = u8(m[t * 4 + 3]);
  }
  return { irr, dir, flick, mask };
}
