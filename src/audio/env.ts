// src/audio/env.ts — shared runtime state handed to every audio subsystem (one per AudioSystem).

import type { Rng } from '../core/rng.ts';
import type { FlickerMode } from '../core/settings.ts';
import type { BufferBank } from './bank.ts';
import type { AudioGraph } from './graph.ts';
import type { Spatializer } from './spatial.ts';

export interface AudioEnv {
  readonly ctx: AudioContext;
  readonly graph: AudioGraph;
  readonly bank: BufferBank;
  readonly spatial: Spatializer;
  readonly rng: Rng;
  hrtf: boolean;
  mains: 50 | 60;
  flickerMode: FlickerMode;
  paused: boolean;
  /** simulation time of the current update, and AudioContext time sampled at the same moment */
  t: number;
  now: number;
  /** listener (eye) position */
  lx: number; ly: number; lz: number;
  /** append to recentEvents() (allocates a string: call only on notable, infrequent events) */
  log(msg: string): void;
  /** count of active voices (positional + beds) for stats() */
  voices: number;
}

/** Seeded hash -> [0,1) for per-source variation (playback rate, loop offset). */
export function unit(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt | 0, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  return (h >>> 8) / 16777216;
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);

/** Display-latency compensation (s) between a frame's simulation time and when the frame is on screen (§5 WP13:
 * transients start at ctxTime + 0.03 + (t_event - now)). */
export const DISPLAY_LATENCY = 0.03;

/** Output latency of the context (s): audio scheduled at ctx time T is heard at about T + outputLatency. */
export function outputLatencyOf(ctx: BaseAudioContext): number {
  const c = ctx as BaseAudioContext & { outputLatency?: number; baseLatency?: number };
  const l = c.outputLatency ?? c.baseLatency ?? 0;
  return Number.isFinite(l) && l > 0 ? Math.min(0.2, l) : 0;
}

/** AudioContext time at which something happening at simulation time `simT` must start to be heard together with
 * the frame that shows it: ctxNow + DISPLAY_LATENCY + (simT - t) - outputLatency, never in the past. */
export function alignedTime(env: AudioEnv, simT: number): number {
  return Math.max(env.now, env.now + DISPLAY_LATENCY + (simT - env.t) - outputLatencyOf(env.ctx));
}
