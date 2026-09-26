// src/audio/fixtureSfx.ts — fixture transients (§5 WP13 "Dynamic light transients").
// Every frame, for the dynamic lights within 18 m: flickerEvents(state, seed, t + 0.03, t + 0.03 + dt) and each
// event's tink / strike / pop / off buffer is started with AudioBufferSourceNode.start(ctxTime + 0.03 + (ev.t - t)),
// i.e. sample-aligned with the visual flicker (the extra 30 ms covers the frame's display latency, minus the
// context's output latency). A transient shares its fixture's hum-voice filter + panner when voiced; otherwise it
// gets its own resolved voice. `lightToggle` events for lights NOT covered this way (e.g. director-driven ANOMALY
// lights) play strike / off at the event position.

import { flickerEvents, type FlickerEvent } from '../core/flicker.ts';
import type { LightStateId } from '../core/ids.ts';
import type { SynthRequest } from './dsp/dispatch.ts';
import { synthKey, type FixtureSfxKind } from './dsp/dispatch.ts';
import { alignedTime, type AudioEnv } from './env.ts';
import type { HumVoices } from './humVoices.ts';
import { createResolution } from './propagation.ts';
import { Voice } from './voice.ts';

const KINDS: readonly FixtureSfxKind[] = ['tink', 'strike', 'pop', 'off'];
const KIND_GAIN: Readonly<Record<FixtureSfxKind, number>> = { tink: 0.12, strike: 0.22, pop: 0.3, off: 0.14 };
const LOOKAHEAD = 0.03;
const TOGGLE_RANGE = 25;

export class FixtureSfx {
  private readonly env: AudioEnv;
  private readonly hum: HumVoices;
  private readonly evs: FlickerEvent[] = [];
  private keys: string[][] = [];
  private readonly res = createResolution();
  /** ids handled by flickerEvents during the last frame (lightToggle de-duplication) */
  private readonly handled = new Float64Array(32);
  private nHandled = 0;
  private transientsPlayed = 0;
  /** end of the last scheduled window (sim time): windows stay contiguous when dt varies frame to frame */
  private schedEnd = -Infinity;

  constructor(env: AudioEnv, hum: HumVoices) {
    this.env = env;
    this.hum = hum;
    this.setMains(env.mains);
  }

  static requests(mains: 50 | 60): SynthRequest[] {
    const r: SynthRequest[] = [];
    for (const kind of KINDS) for (let v = 0; v < 4; v++) r.push({ op: 'fixture', kind, variant: v | (mains === 50 ? 4 : 0) });
    return r;
  }

  setMains(m: 50 | 60): void {
    this.keys = KINDS.map((kind) => [0, 1, 2, 3].map((v) => synthKey({ op: 'fixture', kind, variant: v | (m === 50 ? 4 : 0) })));
  }

  get played(): number { return this.transientsPlayed; }

  /** Every frame (dt > 0): schedule the transients of (t + 0.03, t + 0.03 + dt]. The window starts where the
   * previous one ended (so a varying dt neither drops nor doubles events); a time jump restarts it. */
  frame(dt: number): void {
    const env = this.env;
    const hv = this.hum;
    this.nHandled = 0;
    if (dt <= 0 || env.paused) { this.schedEnd = -Infinity; return; }
    const t1 = env.t + LOOKAHEAD + dt;
    let t0 = env.t + LOOKAHEAD;
    if (this.schedEnd > t0 - 0.25 && this.schedEnd < t1) t0 = this.schedEnd;
    else if (this.schedEnd >= t1 && this.schedEnd < t1 + 0.25) return; // already covered (sim time stepped back a hair)
    this.schedEnd = t1;
    for (let i = 0; i < hv.dynCount.n; i++) {
      const id = hv.dynId[i];
      if (this.nHandled < this.handled.length) this.handled[this.nHandled++] = id;
      this.evs.length = 0; // flickerEvents appends
      const n = flickerEvents(hv.dynState[i] as LightStateId, hv.dynSeed[i], t0, t1, env.flickerMode, this.evs);
      for (let e = 0; e < n && e < this.evs.length; e++) {
        const ev = this.evs[e];
        const when = alignedTime(env, ev.t);
        this.play(ev.kind, id, hv.dynX[i], hv.dynY[i], hv.dynZ[i], when);
      }
    }
  }

  private play(kind: FixtureSfxKind, id: number, x: number, y: number, z: number, when: number): void {
    const env = this.env;
    if (env.graph.tapeSilent) return;
    const ki = KINDS.indexOf(kind);
    const buf = env.bank.get(this.keys[ki][id % 4]);
    if (!buf) return;
    const src = env.ctx.createBufferSource();
    src.buffer = buf;
    const g = env.ctx.createGain();
    const hv = this.hum.voiceOf(id);
    g.gain.value = KIND_GAIN[kind] * (hv ? hv.occ : 1);
    src.connect(g);
    if (hv) {
      g.connect(hv.filter);
      src.onended = (): void => { try { g.disconnect(); src.disconnect(); } catch { /* ignore */ } };
    } else {
      const v = new Voice(env.ctx, env.graph.buses.hum, { hrtf: env.hrtf });
      env.spatial.resolve(x, y, z, this.res);
      v.level = 1;
      v.apply(this.res, 0.05, true);
      g.connect(v.gain);
      src.onended = (): void => { try { g.disconnect(); src.disconnect(); } catch { /* ignore */ } v.disconnect(); };
    }
    src.start(when);
    this.transientsPlayed++;
  }

  /** WP11 lightToggle: only for lights the per-frame scheduler does not cover. */
  onToggle(lightId: number, on: boolean, x: number, y: number, z: number): void {
    const env = this.env;
    for (let i = 0; i < this.nHandled; i++) if (this.handled[i] === lightId) return;
    for (let i = 0; i < this.hum.dynCount.n; i++) if (this.hum.dynId[i] === lightId) return;
    const dx = x - env.lx, dz = z - env.lz;
    if (dx * dx + dz * dz > TOGGLE_RANGE * TOGGLE_RANGE) return;
    this.play(on ? 'strike' : 'off', lightId >>> 0, x, y, z, env.ctx.currentTime);
  }
}
