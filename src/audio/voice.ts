// src/audio/voice.ts — a spatial voice chain: sources -> gain -> envelope -> lowpass (occlusion + air) -> panner -> bus.
// Voices are positioned from SourceResolution (propagation.ts): the apparent position, cutoff and path gain.
// `gain` carries level * occlusion * flicker (smoothed setTargetAtTime automation, 5 Hz / per frame); the separate
// `envelope` node carries the start / steal fades, so the two automation streams never overwrite each other (a
// fade-in keeps its clean linear shape while the level follows flicker or propagation).

import type { SourceResolution } from './propagation.ts';

export interface VoiceOpts { hrtf: boolean; refDistance?: number; rolloff?: number }

export class Voice {
  readonly ctx: AudioContext;
  readonly gain: GainNode;
  /** fade envelope (0..1): fadeIn / release */
  readonly envelope: GainNode;
  readonly filter: BiquadFilterNode;
  readonly panner: PannerNode;
  /** caller level (linear) and occlusion gain; gain = level * occ * mul */
  level = 1;
  occ = 1;
  /** flicker-driven multiplier (hum voices) */
  mul = 1;
  alive = true;
  private readonly usesParams: boolean;

  constructor(ctx: AudioContext, bus: AudioNode, o: VoiceOpts) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.envelope = ctx.createGain();
    this.envelope.gain.value = 1;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 0.6;
    this.filter.frequency.value = 20000;
    this.panner = ctx.createPanner();
    this.panner.panningModel = o.hrtf ? 'HRTF' : 'equalpower';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = o.refDistance ?? 1.5;
    this.panner.rolloffFactor = o.rolloff ?? 1;
    this.panner.maxDistance = 10000;
    this.usesParams = this.panner.positionX !== undefined;
    this.gain.connect(this.envelope).connect(this.filter).connect(this.panner).connect(bus);
  }

  setHrtf(on: boolean): void { this.panner.panningModel = on ? 'HRTF' : 'equalpower'; }

  /** Position immediately (first placement: no glide from the origin). */
  place(x: number, y: number, z: number): void {
    const p = this.panner;
    if (this.usesParams) {
      const t = this.ctx.currentTime;
      p.positionX.cancelScheduledValues(t); p.positionY.cancelScheduledValues(t); p.positionZ.cancelScheduledValues(t);
      p.positionX.setValueAtTime(x, t); p.positionY.setValueAtTime(y, t); p.positionZ.setValueAtTime(z, t);
    } else p.setPosition(x, y, z);
  }

  /** Glide towards a resolved position / cutoff / gain (tau seconds). */
  apply(r: SourceResolution, tau: number, first = false): void {
    const t = this.ctx.currentTime;
    if (first) this.place(r.x, r.y, r.z);
    else if (this.usesParams) {
      this.panner.positionX.setTargetAtTime(r.x, t, tau);
      this.panner.positionY.setTargetAtTime(r.y, t, tau);
      this.panner.positionZ.setTargetAtTime(r.z, t, tau);
    } else this.panner.setPosition(r.x, r.y, r.z);
    const fc = Math.min(20000, Math.max(80, r.cutoff));
    if (first) this.filter.frequency.setValueAtTime(fc, t);
    else this.filter.frequency.setTargetAtTime(fc, t, tau * 1.5);
    this.occ = r.gain;
    this.setGain(tau, first);
  }

  /** Apply level*occ with smoothing (first = jump). */
  setGain(tau: number, first = false): void {
    const t = this.ctx.currentTime;
    const v = this.level * this.occ * this.mul;
    if (first) { this.gain.gain.cancelScheduledValues(t); this.gain.gain.setValueAtTime(v, t); }
    else this.gain.gain.setTargetAtTime(v, t, tau);
  }

  /** Fade in from silence over `s` seconds (linear envelope, starting now); the level automation is independent. */
  fadeIn(s: number): void {
    const t = this.ctx.currentTime;
    const g = this.envelope.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(1, t + Math.max(0.005, s));
  }

  /** Fade out over `s` seconds, then disconnect everything (sources must be stopped by the owner). */
  release(s: number): void {
    if (!this.alive) return;
    this.alive = false;
    const t = this.ctx.currentTime;
    const g = this.envelope.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + Math.max(0.01, s));
    setTimeout(() => this.disconnect(), (s + 0.1) * 1000);
  }

  disconnect(): void {
    this.alive = false;
    try { this.gain.disconnect(); this.envelope.disconnect(); this.filter.disconnect(); this.panner.disconnect(); } catch { /* ignore */ }
  }
}

/** Start a looping buffer source at a random offset (seeded) into `dest`; returns the node. */
export function startLoop(ctx: AudioContext, buf: AudioBuffer, dest: AudioNode, rate: number, offsetFrac: number, when = 0): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  s.playbackRate.value = rate;
  s.connect(dest);
  s.start(when > 0 ? when : 0, Math.max(0, Math.min(0.999, offsetFrac)) * buf.duration);
  return s;
}

export function stopSource(s: AudioBufferSourceNode | null, when = 0): void {
  if (!s) return;
  try { s.stop(when); } catch { /* already stopped */ }
  const d = (): void => { try { s.disconnect(); } catch { /* ignore */ } };
  if (when <= 0) d();
  else s.onended = d;
}
