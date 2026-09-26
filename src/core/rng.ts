// src/core/rng.ts — deterministic hashing and RNG. Math.random / Date are BANNED in pure modules
// (core, world, mesh, bake, props, lighting/flicker, player/controller, audio/dsp). Enforced by tests/arch.
// Layout DECISIONS must use only + - * / floor imul sqrt and these helpers (no sin/cos/exp/pow/log).

import { GEN_VERSION } from './constants.ts';

/** One salt per subsystem so adding draws in one subsystem never reshuffles another. Append-only. */
export const SALT = {
  DISTRICT: 1, DISTRICT_ZONE: 2, DISTRICT_PARAMS: 3, MOOD: 4, FIELD_POWER: 5, FIELD_DECAY: 6, FIELD_HUMIDITY: 7,
  FIELD_WARMTH: 8, WARP: 9, SEAM: 10, CHUNK: 11, ZONE_LAYOUT: 12, FIXTURE: 13, FIXTURE_STATE: 14, PROP: 15,
  VIGNETTE: 16, LANDMARK: 17, TOWER: 18, ELEVATOR: 19, ARTERY: 20, LEAK: 21, DECAL: 22, ANOMALY: 23,
  SPAWN: 24, EMITTER: 25, CONNECT: 26, TILE_STATE: 27, FLICKER: 28, AUDIO: 29, BAKE: 30, TEXGEN: 31,
  ONBOARDING: 32, EXIT_SIGN: 33, CHALK: 34, GLOBAL_FEATURE: 35,
} as const;

/** lowbias32 finalizer (Chris Wellons). Returns uint32. */
export function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}
const step = (h: number, v: number): number => mix32((h ^ Math.imul(v | 0, 0x9e3779b1)) + 0x632be5ab);

/** Hash of up to 6 int32 values, fixed-arity fast paths (no rest-array allocation). */
export const hash1 = (a: number): number => step(0x2545f491 ^ GEN_VERSION, a);
export const hash2 = (a: number, b: number): number => step(hash1(a), b);
export const hash3 = (a: number, b: number, c: number): number => step(hash2(a, b), c);
export const hash4 = (a: number, b: number, c: number, d: number): number => step(hash3(a, b, c), d);
export const hash5 = (a: number, b: number, c: number, d: number, e: number): number => step(hash4(a, b, c, d), e);
export const hash6 = (a: number, b: number, c: number, d: number, e: number, f: number): number =>
  step(hash5(a, b, c, d, e), f);
/** Variadic hash (allocates; not for inner loops). hashN(a,b,c) === hash3(a,b,c). */
export function hashN(...xs: number[]): number {
  let h = 0x2545f491 ^ GEN_VERSION;
  for (let i = 0; i < xs.length; i++) h = step(h, xs[i]);
  return h;
}
/** uint32 -> [0,1) using the top 24 bits (exact in float64). */
export const hash01 = (h: number): number => (h >>> 8) / 16777216;

/** FNV-1a over UTF-16 code units, then mixed. Seed strings made only of digits are parsed as uint32. */
export function hashString(s: string): number {
  if (/^\d{1,9}$/.test(s)) return Number(s) >>> 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h);
}

/** sfc32 generator. Deterministic across Node and browsers. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  constructor(seed: number) {
    this.a = mix32(seed ^ 0xa341316c);
    this.b = mix32(seed ^ 0xc8013ea4);
    this.c = mix32(seed ^ 0xad90777d);
    this.d = mix32(seed ^ 0x7e95761e) | 1;
    for (let i = 0; i < 12; i++) this.next();
  }
  /** uint32 */
  next(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }
  /** [0,1) */
  float(): number { return this.next() / 4294967296; }
  /** [lo,hi) float */
  range(lo: number, hi: number): number { return lo + (hi - lo) * this.float(); }
  /** integer in [lo, hi] inclusive */
  int(lo: number, hi: number): number { return lo + Math.floor(this.float() * (hi - lo + 1)); }
  chance(p: number): boolean { return this.float() < p; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.float() * arr.length)]; }
  /** index chosen with probability proportional to weights[i] (weights >= 0, sum > 0) */
  weighted(weights: readonly number[]): number {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) sum += weights[i];
    let r = this.float() * sum;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }
  /** in-place Fisher-Yates */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  /** independent child stream; does not advance this stream */
  fork(tag: number): Rng { return new Rng(hash2(this.a ^ this.c, tag)); }
}

/** Rng seeded from a salt and integer coordinates: rngFor(seed, SALT.X, s, cx, cz). */
export function rngFor(seed: number, salt: number, a = 0, b = 0, c = 0, d = 0): Rng {
  return new Rng(hash6(seed, salt, a, b, c, d));
}
