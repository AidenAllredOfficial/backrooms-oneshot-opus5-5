// src/audio/oneShots.ts — one-shot playback (positional voices re-resolved at 5 Hz, or flat on a bus) and the
// event sounds: elevator transition (motor on doorsClosing / doorsOpening, cable rumble through the ride, ding on
// doorsOpening), flashlight click, spark crackle, interact (locked-exit door rattle; phone pick-up followed by the
// open line: dial tone and hiss for ~3 s, then hiss fading out; radio: a tuning sweep onto the next station, the press
// after the last station clicks it off, the next press clicks it back on and tunes in).

import { CELL, CHUNK_CELLS } from '../core/constants.ts';
import { LandmarkKind, PropKind } from '../core/ids.ts';
import type { GameEvents } from '../core/events.ts';
import type { WorldQuery } from '../core/runtime.ts';
import { EmitterKind } from '../core/ids.ts';
import { synthKey, type SynthRequest } from './dsp/dispatch.ts';
import type { OneShotKind } from './dsp/oneshots.ts';
import type { Emitters } from './emitters.ts';
import type { AudioEnv } from './env.ts';
import type { BusName } from './graph.ts';
import { createResolution, type SourceResolution } from './propagation.ts';
import { stopSource, Voice } from './voice.ts';

export interface PlayOpts {
  bus?: BusName;
  /** linear fade-in (s); ambient events use >= 0.02 */
  attack?: number;
  rate?: number;
  rolloff?: number;
  refDistance?: number;
  /** AudioContext time to start (default now) */
  when?: number;
}

interface Active {
  voice: Voice | null;
  src: AudioBufferSourceNode;
  x: number; y: number; z: number;
  res: SourceResolution;
  end: number;
  settle: number; // no re-resolve before this time (lets the attack ramp finish)
  rate: ReturnType<AudioEnv['graph']['registerRate']> | null;
}

const MAX_ACTIVE = 32;
const cellOf = (m: number): number => Math.floor(m / CELL + 1e-7);

export class OneShots {
  private readonly env: AudioEnv;
  private readonly active: Active[] = [];
  private readonly pool: SourceResolution[] = [];
  emitters: Emitters | null = null;
  world: WorldQuery | null = null;
  private rideSrc: AudioBufferSourceNode | null = null;
  private variantCounter = 0;

  constructor(env: AudioEnv) {
    this.env = env;
  }

  static oneShotReq(kind: OneShotKind, variant: number): SynthRequest { return { op: 'oneshot', kind, variant }; }

  get count(): number { return this.active.length; }

  /** Positional one-shot, resolved through propagation now and re-resolved at 5 Hz while it plays. */
  playAt(req: SynthRequest, x: number, y: number, z: number, level: number, o: PlayOpts = {}): boolean {
    const env = this.env;
    if (env.graph.tapeSilent) return false;
    const buf = env.bank.ensure(req, 2);
    if (!buf) return false;
    if (this.active.length >= MAX_ACTIVE) this.retire(0);
    const v = new Voice(env.ctx, env.graph.buses[o.bus ?? 'sfx'], { hrtf: env.hrtf, rolloff: o.rolloff, refDistance: o.refDistance });
    const res = this.pool.pop() ?? createResolution();
    env.spatial.resolve(x, y, z, res);
    v.level = level;
    v.apply(res, 0.05, true);
    if (o.attack && o.attack > 0) v.fadeIn(o.attack);
    const src = env.ctx.createBufferSource();
    src.buffer = buf;
    const rate = o.rate ?? 1;
    src.playbackRate.value = rate;
    src.connect(v.gain);
    const when = Math.max(env.ctx.currentTime, o.when ?? 0);
    src.start(when);
    const a: Active = { voice: v, src, x, y, z, res, end: when + buf.duration / rate + 0.05, settle: env.ctx.currentTime + (o.attack ?? 0) + 0.02, rate: env.graph.registerRate(src.playbackRate, rate) };
    src.onended = (): void => this.finish(a);
    this.active.push(a);
    return true;
  }

  /** Non-positional one-shot on a bus (stereo pan -1..1). */
  playFlat(req: SynthRequest, level: number, bus: BusName, pan = 0, rate = 1, when = 0): boolean {
    const env = this.env;
    if (env.graph.tapeSilent && bus !== 'ui') return false;
    const buf = env.bank.ensure(req, 2);
    if (!buf) return false;
    const src = env.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = env.ctx.createGain();
    g.gain.value = level;
    const p = env.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(g).connect(p).connect(env.graph.buses[bus]);
    const entry = env.graph.registerRate(src.playbackRate, rate);
    src.onended = (): void => {
      env.graph.unregisterRate(entry);
      try { src.disconnect(); g.disconnect(); p.disconnect(); } catch { /* ignore */ }
    };
    src.start(Math.max(env.ctx.currentTime, when));
    return true;
  }

  private finish(a: Active): void {
    const i = this.active.indexOf(a);
    if (i >= 0) this.retire(i);
  }

  private retire(i: number): void {
    const a = this.active[i];
    this.active[i] = this.active[this.active.length - 1];
    this.active.pop();
    this.env.graph.unregisterRate(a.rate);
    if (a.voice) { a.voice.disconnect(); a.voice = null; }
    try { a.src.stop(); } catch { /* ended */ }
    try { a.src.disconnect(); } catch { /* ignore */ }
    this.pool.push(a.res);
  }

  /** 5 Hz: follow the listener (portal placement changes as you move). */
  resolveAll(): void {
    const now = this.env.ctx.currentTime;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i];
      if (now > a.end + 0.5) { this.retire(i); continue; }
      if (!a.voice || now < a.settle) continue;
      this.env.spatial.resolve(a.x, a.y, a.z, a.res);
      a.voice.apply(a.res, 0.08);
    }
  }

  /** Event one-shots use the 2 preloaded variants (alternating, with a random start). */
  private variant(): number { return (this.variantCounter++ + (this.env.rng.next() & 1)) & 1; }

  // ---------------------------------------------------------------- event sounds

  onTransition(e: GameEvents['transition']): void {
    if (e.kind !== 'elevator') return;
    const env = this.env;
    const v = this.variant();
    if (e.phase === 'doorsClosing') {
      this.playFlat(OneShots.oneShotReq('elevatorMotor', v), 0.5, 'sfx', -0.2);
    } else if (e.phase === 'ride') {
      const buf = env.bank.ensure(OneShots.oneShotReq('cableRumble', v), 1);
      if (buf) {
        stopSource(this.rideSrc);
        const src = env.ctx.createBufferSource();
        src.buffer = buf;
        const g = env.ctx.createGain();
        g.gain.value = 0.55;
        src.connect(g).connect(env.graph.buses.sfx);
        src.onended = (): void => { try { src.disconnect(); g.disconnect(); } catch { /* ignore */ } };
        src.start();
        this.rideSrc = src;
      }
    } else if (e.phase === 'doorsOpening') {
      this.playFlat(OneShots.oneShotReq('elevatorDing', v), 0.45, 'sfx', 0.25);
      this.playFlat(OneShots.oneShotReq('elevatorMotor', v ^ 1), 0.5, 'sfx', -0.2, 1, env.ctx.currentTime + 0.35);
    } else if (e.phase === 'exit' || e.phase === 'enter') {
      if (e.phase === 'exit' && this.rideSrc) { stopSource(this.rideSrc, env.ctx.currentTime + 0.3); this.rideSrc = null; }
    }
    env.log(`elevator ${e.phase}`);
  }

  onFlashlight(on: boolean): void {
    this.playFlat(OneShots.oneShotReq('flashlightClick', on ? 0 : 1), 0.35, 'foley', 0.25);
  }

  onSpark(e: GameEvents['spark']): void {
    const s = Math.max(0.2, Math.min(1.5, e.strength));
    if (this.playAt(OneShots.oneShotReq('sparkCrackle', this.variant()), e.x, e.y, e.z, 0.35 * s, { bus: 'sfx' })) {
      this.env.log(`spark ${e.x.toFixed(1)},${e.z.toFixed(1)}`);
    }
  }

  onInteract(e: GameEvents['interact']): void {
    const env = this.env;
    // e.x/y/z is the targeted prop's position (PropHit, world metres; y = its base)
    const fx = e.x, fz = e.z;
    const fy = e.y + 1.0;
    if (e.propKind === PropKind.DOOR_LEAF) {
      if (e.door) {
        this.playAt(OneShots.oneShotReq(e.door === 'latch' ? 'doorThud' : 'doorHinge', (e.seed >>> 0) & 1), fx, fy, fz, 0.13, { bus: 'sfx' });
        return;
      }
      // LOCKED_EXIT landmark doors rattle hard; the other DOOR_LEAF props (ENDLESS_HALL fakes) do not open either and
      // get a softer rattle as feedback
      const locked = this.inLockedExit(fx, fz);
      this.playAt(OneShots.oneShotReq('doorRattle', (e.seed >>> 0) & 1), fx, fy, fz, locked ? 0.5 : 0.32, { bus: 'sfx' });
      env.log(`interact door${locked ? ' (locked exit)' : ''}`);
    } else if (e.propKind === PropKind.PHONE) {
      const v = (e.seed >>> 0) & 1;
      this.playAt(OneShots.oneShotReq('phonePickup', v), fx, e.y + 0.5, fz, 0.35, { bus: 'sfx' });
      // the handset comes up toward the player: the line is heard close
      this.playAt(OneShots.oneShotReq('phoneLine', v), fx, e.y + 1.0, fz, 0.3, { bus: 'sfx', when: env.ctx.currentTime + 0.12, refDistance: 2.5 });
      this.emitters?.silenceNearest(EmitterKind.PHONE, fx, fz, 4);
      env.log('interact phone: picked up, dial tone');
    } else if (e.propKind === PropKind.RADIO) {
      const v = (e.seed >>> 0) & 1;
      const act = this.emitters ? this.emitters.cycleRadio(fx, fz, 4) : 'none';
      const y = e.y + 0.8;
      if (act === 'off' || act === 'none') {
        this.playAt(OneShots.oneShotReq('radioClick', v), fx, y, fz, 0.35, { bus: 'sfx' });
      } else {
        if (act === 'on') this.playAt(OneShots.oneShotReq('radioClick', v ^ 1), fx, y, fz, 0.3, { bus: 'sfx' });
        this.playAt(OneShots.oneShotReq('radioTune', this.variant()), fx, y, fz, 0.22, { bus: 'sfx', when: env.ctx.currentTime + (act === 'on' ? 0.05 : 0) });
      }
      env.log(`interact radio: ${act}`);
    }
  }

  /** Is the world point inside (or 1 cell around) a LOCKED_EXIT landmark? */
  private inLockedExit(x: number, z: number): boolean {
    const w = this.world;
    if (!w) return false;
    const gi = cellOf(x), gj = cellOf(z);
    const cx = Math.floor(gi / CHUNK_CELLS), cz = Math.floor(gj / CHUNK_CELLS);
    const l = w.layoutAt(cx, cz);
    if (!l) return false;
    const li = gi - cx * CHUNK_CELLS, lj = gj - cz * CHUNK_CELLS;
    for (const lm of l.landmarks) {
      if (lm.kind !== LandmarkKind.LOCKED_EXIT) continue;
      if (li >= lm.i0 - 1 && li < lm.i1 + 1 && lj >= lm.j0 - 1 && lj < lm.j1 + 1) return true;
    }
    return false;
  }

  /** Preload keys for the event kinds (cheap one-shots). */
  static requests(): SynthRequest[] {
    const r: SynthRequest[] = [];
    for (const k of ['flashlightClick', 'sparkCrackle', 'doorRattle', 'doorHinge', 'doorThud', 'phonePickup', 'phoneLine', 'radioClick', 'radioTune', 'elevatorMotor', 'elevatorDing', 'cableRumble'] as const) {
      for (let v = 0; v < 2; v++) r.push({ op: 'oneshot', kind: k, variant: v });
    }
    return r;
  }

  static key(kind: OneShotKind, variant: number): string { return synthKey({ op: 'oneshot', kind, variant }); }

  stopAll(): void {
    for (let i = this.active.length - 1; i >= 0; i--) this.retire(i);
    stopSource(this.rideSrc);
    this.rideSrc = null;
  }
}
