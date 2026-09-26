// src/mesh/uv.ts — material-uv, tint and small hashing helpers shared by the WP5 mesher. Pure module.
//
// Material uv rules (§2.2): horizontal faces use tile-local (x, z) / repeat; vertical faces use u = the tile-local
// coordinate along the viewer's right (up x normal) / repeat and v = y / layerRepeatY, so tower walls are exactly
// 3 m-periodic and every repeat divides the tile (seamless across tiles).

import { LAYER_DEFS, layerRepeatY } from '../core/materials.ts';
import { hash3, hash01 } from '../core/rng.ts';
import { packRGBA } from '../core/writer.ts';

export const matRepeat = (mat: number): number => (LAYER_DEFS[mat] ?? LAYER_DEFS[0]).repeat;
export const matRepeatY = (mat: number): number => layerRepeatY(LAYER_DEFS[mat] ?? LAYER_DEFS[0]);

/** Material uv of a vertex on a face with horizontal normal (nx, nz) (need not be unit). du/dv: metre offsets. */
export function vUv(mat: number, x: number, y: number, z: number, nx: number, nz: number, out: number[], du = 0, dv = 0): void {
  // right = up x n = (nz, 0, -nx)
  const len = Math.hypot(nx, nz) || 1;
  const along = (x * nz - z * nx) / len;
  out.push((along + du) / matRepeat(mat), (y + dv) / matRepeatY(mat));
}
/** Material uv of a vertex on a horizontal (or sloped) face. */
export function hUv(mat: number, x: number, z: number, out: number[]): void {
  const r = matRepeat(mat);
  out.push(x / r, z / r);
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
/** Pack a linear rgb tint in [0,1] plus an 8-bit a. */
export const tintRGB = (r: number, g: number, b: number, a = 0): number =>
  packRGBA(clamp255(r * 255), clamp255(g * 255), clamp255(b * 255), a & 255);

/** Wall tint (§5 WP5 rule 11): shade in [-0.02, 0.02], warmth byte 0..255 (warm => +R -B, about +-4 deg hue). */
export function wallTint(shade: number, warmth: number, seed: number): number {
  const h = ((warmth / 255) - 0.5) * 2 * 0.07;
  const f = (0.98 + shade) / (1 + Math.abs(h));
  return tintRGB(f * (1 + h), f, f * (1 - h), seed);
}

/** Deterministic [0,1) from three ints. */
export const h01 = (a: number, b: number, c: number): number => hash01(hash3(a | 0, b | 0, c | 0));

/** Quantize metres to 0.1 mm integers (keys). */
export const q4 = (v: number): number => Math.round(v * 10000);
/** Fixed-width sortable integer field for string keys. */
export function kf(v: number, width = 7): string {
  const s = String(Math.round(v) + 5000000);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}
