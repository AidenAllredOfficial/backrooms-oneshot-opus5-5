// src/audio/emitters.ts — the 8-voice emitter pool (§5 WP13 "Emitters from layout.emitters within 25 m").
// At 5 Hz: WorldQuery.emittersNear, score = gain * kindLevel / (1 + (d/6)^2) with d the effective (path) distance,
// top 8 get looping synthEmitter voices (300 ms steal fades), each resolved through propagation. PHONE (RINGING_PHONE
// vignettes) is audible to 60 m (lower roll-off) and stops for good when the player comes within 3 m or picks it
// up. A RADIO cycles stations on interact (R2): each press sweeps the dial (the tuning one-shot plays over a 0.5 s gap)
// onto the next of its 4 station renders; the press after the last station switches it off, the next one back on.

import { hash3 } from '../core/rng.ts';
import { EmitterKind, type EmitterKindId } from '../core/ids.ts';
import type { EmitterRef, WorldQuery } from '../core/runtime.ts';
import { synthKey, type SynthRequest } from './dsp/dispatch.ts';
import { unit, type AudioEnv } from './env.ts';
import { createResolution, type SourceResolution } from './propagation.ts';
import { startLoop, stopSource, Voice } from './voice.ts';

const POOL = 8;
const RANGE = 25;
const PHONE_RANGE = 60;
const PHONE_STOP = 3;
const CAND_MAX = 128;
const LOOP_S = 8;
/** Linear level per EmitterKind (DRIP VENT PIPE MACHINE WATER STEAM RADIO PHONE BUZZ) at the reference distance. */
const LEVEL: readonly number[] = [0.3, 0.16, 0.2, 0.16, 0.25, 0.22, 0.2, 0.5, 0.14];
const NAMES: readonly string[] = ['DRIP', 'VENT', 'PIPE', 'MACHINE', 'WATER', 'STEAM', 'RADIO', 'PHONE', 'BUZZ'];

const emitterKey = (kind: number, x: number, z: number): number => hash3(kind, Math.round(x * 4), Math.round(z * 4));

class Slot {
  key = -1;
  kind = 0;
  x = 0; y = 0; z = 0;
  seed = 0;
  level = 0;
  voice: Voice | null = null;
  src: AudioBufferSourceNode | null = null;
  rate: ReturnType<AudioEnv['graph']['registerRate']> | null = null;
  /** per-source gain between the loop and the voice (radio station crossfades) */
  srcGain: GainNode | null = null;
  readonly res: SourceResolution = createResolution();
}

/** Stations a radio cycles through before the press that switches it off. */
export const RADIO_STATIONS = 4;
/** Silence between two stations while the dial sweeps (s). */
const TUNE_GAP = 0.5;
export type RadioAction = 'tune' | 'off' | 'on' | 'none';

export class Emitters {
  private readonly env: AudioEnv;
  private readonly refs: EmitterRef[] = [];
  private readonly slots: Slot[] = [];
  private readonly stopped = new Set<number>();
  /** radio key -> station offset (0 = the station it was found on) */
  private readonly station = new Map<number, number>();
  private readonly cKey = new Float64Array(CAND_MAX);
  private readonly cIdx = new Int32Array(CAND_MAX);
  private readonly cScore = new Float32Array(CAND_MAX);
  private readonly cPick = new Uint8Array(CAND_MAX);

  constructor(env: AudioEnv) {
    this.env = env;
    for (let i = 0; i < POOL; i++) this.slots.push(new Slot());
  }

  static request(kind: EmitterKindId, variant: number, mains: 50 | 60): SynthRequest {
    return { op: 'emitter', kind, variant: variant & 3, seconds: kind === EmitterKind.PHONE ? 6 : LOOP_S, mains };
  }

  get activeCount(): number { let n = 0; for (const s of this.slots) if (s.key >= 0) n++; return n; }

  setHrtf(on: boolean): void { for (const s of this.slots) if (s.voice) s.voice.setHrtf(on); }

  /** 5 Hz, after propagation. */
  update(world: WorldQuery): void {
    const env = this.env;
    const lx = env.lx, ly = env.ly, lz = env.lz;
    const nRef = world.emittersNear(lx, lz, PHONE_RANGE, this.refs);
    let n = 0;
    for (let r = 0; r < nRef && r < this.refs.length && n < CAND_MAX; r++) {
      const ref = this.refs[r];
      const kind = ref.e.kind;
      const dx = ref.wx - lx, dy = ref.wy - ly, dz = ref.wz - lz;
      const eu = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const phone = kind === EmitterKind.PHONE;
      if (eu > (phone ? PHONE_RANGE : RANGE)) continue;
      const key = emitterKey(kind, ref.wx, ref.wz);
      if (this.stopped.has(key)) continue;
      if (phone && Math.hypot(dx, dz) <= PHONE_STOP) {
        this.stopped.add(key);
        env.log('phone stops ringing (player within 3 m)');
        continue;
      }
      const pm = env.spatial.pathMetres(ref.wx, ref.wz);
      const d = pm < Infinity ? Math.max(eu, pm) : eu * 2.5;
      const lv = (LEVEL[kind] ?? 0.2) * Math.max(0.05, ref.e.gain);
      this.cKey[n] = key; this.cIdx[n] = r;
      this.cScore[n] = (lv / (1 + (d / 6) * (d / 6))) * (phone ? 6 : 1);
      this.cPick[n] = 0;
      n++;
    }
    for (let v = 0; v < POOL; v++) {
      let best = -1, bs = 0;
      for (let k = 0; k < n; k++) if (this.cPick[k] === 0 && this.cScore[k] > bs) { bs = this.cScore[k]; best = k; }
      if (best < 0) break;
      this.cPick[best] = 1;
    }
    for (const s of this.slots) {
      if (s.key < 0) continue;
      let keep = false;
      for (let k = 0; k < n; k++) {
        if (this.cPick[k] === 1 && this.cKey[k] === s.key) { keep = true; this.cPick[k] = 2; break; }
      }
      if (!keep) this.release(s, 0.3);
    }
    for (let k = 0; k < n; k++) {
      if (this.cPick[k] !== 1) continue;
      const s = this.free();
      if (!s) break;
      const ref = this.refs[this.cIdx[k]];
      if (this.start(s, ref, this.cKey[k])) this.cPick[k] = 2;
    }
    for (const s of this.slots) {
      if (s.key < 0 || !s.voice) continue;
      env.spatial.resolve(s.x, s.y, s.z, s.res);
      s.voice.apply(s.res, 0.08);
    }
  }

  private free(): Slot | null {
    for (const s of this.slots) if (s.key < 0) return s;
    return null;
  }

  private start(s: Slot, ref: EmitterRef, key: number): boolean {
    const env = this.env;
    const kind = ref.e.kind;
    const variant = ((ref.e.seed >>> 0) + (this.station.get(key) ?? 0)) & 3;
    const buf = env.bank.ensure(Emitters.request(kind, variant, env.mains), 3);
    if (!buf) return false;
    s.key = key; s.kind = kind; s.x = ref.wx; s.y = ref.wy; s.z = ref.wz; s.seed = ref.e.seed;
    const phone = kind === EmitterKind.PHONE;
    const v = new Voice(env.ctx, env.graph.buses[kind === EmitterKind.WATER || kind === EmitterKind.DRIP ? 'water' : 'amb'], {
      hrtf: env.hrtf, rolloff: phone ? 0.5 : 1,
    });
    s.voice = v;
    const rate = phone || kind === EmitterKind.RADIO ? 1 : 0.97 + 0.06 * unit(s.seed, 21);
    // a radio's other stations are needed the moment it is retuned: queue them now (cheap, low priority)
    if (kind === EmitterKind.RADIO) for (let k = 1; k < RADIO_STATIONS; k++) void env.bank.request(Emitters.request(kind, variant + k, env.mains), 4).catch(() => undefined);
    s.srcGain = env.ctx.createGain();
    s.srcGain.connect(v.gain);
    s.src = startLoop(env.ctx, buf, s.srcGain, rate, phone ? 0 : unit(s.seed, 22));
    s.rate = env.graph.registerRate(s.src.playbackRate, rate);
    v.level = (LEVEL[kind] ?? 0.2) * Math.max(0.05, ref.e.gain);
    env.spatial.resolve(s.x, s.y, s.z, s.res);
    v.apply(s.res, 0.08, true);
    v.fadeIn(0.3);
    env.log(`emitter ${NAMES[kind] ?? kind} on at ${s.x.toFixed(1)},${s.z.toFixed(1)}`);
    return true;
  }

  private release(s: Slot, fade: number): void {
    const env = this.env;
    if (s.voice) s.voice.release(fade);
    stopSource(s.src, env.ctx.currentTime + fade + 0.02);
    env.graph.unregisterRate(s.rate);
    s.rate = null; s.voice = null; s.src = null; s.srcGain = null; s.key = -1;
  }

  /** Nearest RADIO within r of (x, z): a voiced slot, else a resident emitter. Key -1 when none. */
  private nearestRadio(x: number, z: number, r: number): { key: number; seed: number; slot: Slot | null } {
    let best: Slot | null = null, bd = r * r;
    for (const s of this.slots) {
      if (s.key < 0 || s.kind !== EmitterKind.RADIO) continue;
      const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
      if (d <= bd) { bd = d; best = s; }
    }
    if (best) return { key: best.key, seed: best.seed, slot: best };
    const w = this.env.spatial.world;
    if (!w) return { key: -1, seed: 0, slot: null };
    const n = w.emittersNear(x, z, r, this.refs);
    let bk = -1, seed = 0, bdd = Infinity;
    for (let i = 0; i < n && i < this.refs.length; i++) {
      const e = this.refs[i];
      if (e.e.kind !== EmitterKind.RADIO) continue;
      const d = (e.wx - x) * (e.wx - x) + (e.wz - z) * (e.wz - z);
      if (d < bdd) { bdd = d; bk = emitterKey(EmitterKind.RADIO, e.wx, e.wz); seed = e.e.seed; }
    }
    return { key: bk, seed, slot: null };
  }

  /** Radio interaction (see header): 'tune' = moved to the next station (the new one starts after TUNE_GAP),
   * 'off' = switched off after the last station, 'on' = an off radio switched back on (next 5 Hz update starts it),
   * 'none' = no radio within r. */
  cycleRadio(x: number, z: number, r: number): RadioAction {
    const env = this.env;
    const hit = this.nearestRadio(x, z, r);
    if (hit.key < 0) return 'none';
    const key = hit.key;
    if (this.stopped.has(key)) {
      this.stopped.delete(key);
      this.station.set(key, 0);
      return 'on';
    }
    const next = (this.station.get(key) ?? 0) + 1;
    if (next >= RADIO_STATIONS) {
      this.station.set(key, 0);
      this.stopped.add(key);
      if (hit.slot) this.release(hit.slot, 0.06);
      return 'off';
    }
    this.station.set(key, next);
    const s = hit.slot;
    if (!s || !s.voice || !s.srcGain) return 'tune'; // not voiced: it starts on the new station when it is
    // cut the old station quickly (the tuning sweep covers the gap), start the new one after it
    const t = env.ctx.currentTime;
    const oldGain = s.srcGain, oldSrc = s.src;
    oldGain.gain.cancelScheduledValues(t);
    oldGain.gain.setValueAtTime(oldGain.gain.value, t);
    oldGain.gain.linearRampToValueAtTime(0, t + 0.06);
    stopSource(oldSrc, t + 0.08);
    if (oldSrc) {
      const done = oldSrc.onended;
      oldSrc.onended = (ev: Event): void => { done?.call(oldSrc, ev); try { oldGain.disconnect(); } catch { /* ignore */ } };
    } else {
      try { oldGain.disconnect(); } catch { /* ignore */ }
    }
    env.graph.unregisterRate(s.rate);
    s.rate = null;
    s.src = null;
    const g = env.ctx.createGain();
    g.gain.value = 0;
    g.connect(s.voice.gain);
    s.srcGain = g;
    const req = Emitters.request(EmitterKind.RADIO, ((hit.seed >>> 0) + next) & 3, env.mains);
    const begin = (buf: AudioBuffer): void => {
      if (s.key !== key || s.srcGain !== g) return; // released or retuned again meanwhile
      const at = Math.max(env.ctx.currentTime, t + TUNE_GAP);
      s.src = startLoop(env.ctx, buf, g, 1, unit(s.seed + next, 22));
      s.rate = env.graph.registerRate(s.src.playbackRate, 1);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(1, at + 0.15);
    };
    const ready = env.bank.get(synthKey(req));
    if (ready) begin(ready);
    else void env.bank.request(req, 0).then(begin).catch(() => undefined);
    return 'tune';
  }

  /** Stop (for good) the nearest emitter of `kind` within r of (x, z): phone picked up, radio switched off. */
  silenceNearest(kind: EmitterKindId, x: number, z: number, r: number): void {
    let best: Slot | null = null, bd = r * r;
    for (const s of this.slots) {
      if (s.key < 0 || s.kind !== kind) continue;
      const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
      if (d <= bd) { bd = d; best = s; }
    }
    if (best) {
      this.stopped.add(best.key);
      this.release(best, 0.06);
      return;
    }
    // not voiced right now: remember the nearest candidate so it never starts
    const w = this.env.spatial.world;
    if (!w) return;
    const n = w.emittersNear(x, z, r, this.refs);
    let bk = -1, bdd = Infinity;
    for (let i = 0; i < n && i < this.refs.length; i++) {
      const e = this.refs[i];
      if (e.e.kind !== kind) continue;
      const d = (e.wx - x) * (e.wx - x) + (e.wz - z) * (e.wz - z);
      if (d < bdd) { bdd = d; bk = emitterKey(kind, e.wx, e.wz); }
    }
    if (bk >= 0) this.stopped.add(bk);
  }

  stopAll(fade: number): void { for (const s of this.slots) if (s.key >= 0) this.release(s, fade); }
}
