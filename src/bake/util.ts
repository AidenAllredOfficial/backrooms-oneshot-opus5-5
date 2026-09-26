// src/bake/util.ts — shared constants and small pure helpers for the light baker (WP7). Pure module.
//
// Frame convention inside the baker ("halo units"): x and z are measured in CELLS relative to the VisGrid halo
// origin (the tile's first cell minus LIGHT.HALO_CELLS); y is in metres (storey-relative). Every x/z position
// that enters a visibility ray is an integer plus a multiple of 2^-20 (see `quant`), so differences between
// positions are EXACT in float64 and every ray decision is independent of which tile (frame) computes it.
// This is what makes cached per-chunk data byte-identical to freshly computed data and keeps tile seams exact.

import { CELL, CHUNK_CELLS, LIGHT, TILE_CELLS } from '../core/constants.ts';

/** Offset of the tile's first cell inside the halo. The spec requires >= LIGHT.HALO_CELLS (24); the baker uses
 * the full 32 cells the 3x3 neighbourhood provides, so every light within R_MAX of every world-anchored patch it
 * may evaluate (tile + PATCH_MARGIN) is inside the halo: patch values stay pure functions of world position. */
export const HALO_OFF = Math.max(LIGHT.HALO_CELLS, CHUNK_CELLS); // 32
/** Halo width in cells (tile 16 + 2 x 32). */
export const HALO = TILE_CELLS + 2 * HALO_OFF; // 80
/** Probe grid: tile cells plus a 1-cell ring. */
export const PROBE_N = TILE_CELLS + 2; // 18
export const PROBE_OFF = HALO_OFF - 1; // halo index of the first probe cell

const QSCALE = 1048576; // 2^20
/** Quantize a cell-unit coordinate to a multiple of 2^-20 (exact dyadic). */
export const quant = (v: number): number => Math.round(v * QSCALE) / QSCALE;

export const INV_CELL = 1 / CELL;

/** Rec.709 luma weights (the flicker `flick` channels store luma of the RGB irradiance). */
export const LR = 0.2126, LG = 0.7152, LB = 0.0722;
export const luma = (r: number, g: number, b: number): number => LR * r + LG * g + LB * b;

/** Sample point offset from the surface along its normal (m). */
export const SURF_OFF = 0.02;
/** Visibility end point offset from an emitting surface along its normal (m). */
export const EMIT_OFF = 0.02;

/** Heights of the 3 per-cell visibility / probe layers relative to (effective floor, ceiling). */
export const H_LOW = 0.4;
export const H_TOP = 0.35;

/** Deterministic tie-break comparison: larger estimate first, then smaller uid. */
export const better = (ea: number, ua: number, eb: number, ub: number): boolean => ea > eb || (ea === eb && ua < ub);

/** Squared window distance (m^2) for a light: horizontal distance plus vertical excess beyond `hAllow`. */
export function windowDist2(dxm: number, dym: number, dzm: number, hAllow: number): number {
  const ay = dym < 0 ? -dym : dym;
  const ey = ay > hAllow ? ay - hAllow : 0;
  return dxm * dxm + dzm * dzm + ey * ey;
}
/** Smooth window (1 - (d/R)^4)^2, 0 beyond R. Takes d^2 and 1/R^2. */
export function windowW(d2: number, invR2: number): number {
  const x = d2 * invR2;
  if (x >= 1) return 0;
  const f = 1 - x * x;
  return f * f;
}

/** Growable Float64 / Int32 scratch helpers (bake setup only; hot loops use preallocated arrays). */
export function growF64(a: Float64Array<ArrayBuffer>, n: number): Float64Array<ArrayBuffer> {
  if (a.length >= n) return a;
  const b = new Float64Array(Math.max(n, a.length * 2));
  b.set(a);
  return b;
}
export function growI32(a: Int32Array<ArrayBuffer>, n: number): Int32Array<ArrayBuffer> {
  if (a.length >= n) return a;
  const b = new Int32Array(Math.max(n, a.length * 2));
  b.set(a);
  return b;
}
export function growF32(a: Float32Array<ArrayBuffer>, n: number): Float32Array<ArrayBuffer> {
  if (a.length >= n) return a;
  const b = new Float32Array(Math.max(n, a.length * 2));
  b.set(a);
  return b;
}
