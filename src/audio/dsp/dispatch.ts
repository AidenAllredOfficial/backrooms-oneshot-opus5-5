// src/audio/dsp/dispatch.ts — one serializable request type for every synthesizer (pure). Used by the DSP worker
// and by the main-thread fallback, so both produce bit-identical buffers.

import type { EmitterKindId, SurfaceSoundId } from '../../core/ids.ts';
import { IR_BRIGHTNESS, IR_DIMS, IR_RT60 } from '../roomProbe.ts';
import { synthBed, synthRustle, type BedKind } from './beds.ts';
import { synthEmitter } from './emitters.ts';
import { synthFixture } from './fixtures.ts';
import { synthFootstep } from './footsteps.ts';
import { synthHum } from './hum.ts';
import { makeIR } from './ir.ts';
import { synthOneShot, type OneShotKind } from './oneshots.ts';

export type FixtureSfxKind = 'tink' | 'strike' | 'pop' | 'off';

export type SynthRequest =
  | { op: 'hum'; variant: number; mains: 50 | 60; seconds: number }
  | { op: 'foot'; surface: SurfaceSoundId; variant: number }
  | { op: 'fixture'; kind: FixtureSfxKind; variant: number }
  | { op: 'ir'; index: number }
  | { op: 'bed'; kind: BedKind; seconds: number; seed: number }
  | { op: 'emitter'; kind: EmitterKindId; variant: number; seconds: number; mains: 50 | 60 }
  | { op: 'oneshot'; kind: OneShotKind; variant: number }
  | { op: 'rustle'; seconds: number; seed: number };

/** Stable cache key of a request. */
export function synthKey(r: SynthRequest): string {
  switch (r.op) {
    case 'hum': return `hum:${r.variant}:${r.mains}:${r.seconds}`;
    case 'foot': return `foot:${r.surface}:${r.variant}`;
    case 'fixture': return `fix:${r.kind}:${r.variant}`;
    case 'ir': return `ir:${r.index}`;
    case 'bed': return `bed:${r.kind}:${r.seconds}:${r.seed}`;
    case 'emitter': return `em:${r.kind}:${r.variant}:${r.seconds}:${r.mains}`;
    case 'oneshot': return `os:${r.kind}:${r.variant}`;
    case 'rustle': return `rustle:${r.seconds}:${r.seed}`;
  }
}

/** Seed used for every IR of the standard set. */
export const IR_SEED = 7;

export function runSynth(r: SynthRequest, sampleRate: number): Float32Array[] {
  switch (r.op) {
    case 'hum': return synthHum(r.variant, sampleRate, r.mains, r.seconds);
    case 'foot': return synthFootstep(r.surface, r.variant, sampleRate);
    case 'fixture': return synthFixture(r.kind, r.variant, sampleRate);
    case 'ir': {
      const i = Math.min(IR_RT60.length - 1, Math.max(0, r.index | 0));
      return makeIR(IR_RT60[i], IR_DIMS[i], IR_BRIGHTNESS[i], sampleRate, IR_SEED + i);
    }
    case 'bed': return synthBed(r.kind, sampleRate, r.seconds, r.seed);
    case 'emitter': return synthEmitter(r.kind, r.variant, sampleRate, r.seconds, r.mains);
    case 'oneshot': return synthOneShot(r.kind, r.variant, sampleRate);
    case 'rustle': return synthRustle(sampleRate, r.seconds, r.seed);
  }
}
