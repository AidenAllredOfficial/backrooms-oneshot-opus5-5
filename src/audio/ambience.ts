// src/audio/ambience.ts — beds and ambient events (§5 WP13 "Ambience", "Wading").
//  * room tone: always on at -42 dBFS (what is left when a dead sector falls silent);
//  * per-zone beds (zoneAudio.ts) keyed by WorldQuery.zoneAt(listener), 1.5 s crossfades, mood trim;
//  * wade bed: gain ∝ speed * waterDepth (0 when dry), low-passed deeper as the water rises;
//  * Poisson ambient events: L0 1/40 s, industrial 1/25 s, pools 1/20 s; minimum gap 15 s; never the same kind
//    twice in a row; placed at a reachable cell 25-60 m away through the propagation field (heard through the
//    portal / occlusion rules), peak -18 dBFS, >= 20 ms attack. No stingers.

import type { MoodId, ZoneId } from '../core/ids.ts';
import type { BedKind } from './dsp/beds.ts';
import { BED_RMS } from './dsp/beds.ts';
import type { SynthRequest } from './dsp/dispatch.ts';
import type { AudioEnv } from './env.ts';
import { dbToGain } from './env.ts';
import type { BusName } from './graph.ts';
import { OneShots } from './oneShots.ts';
import { startLoop, stopSource } from './voice.ts';
import {
  EVENT_HEIGHT, EVENT_MAX_DIST, EVENT_MIN_DIST, EVENT_MIN_GAP, EVENT_PEAK_DBFS, EVENT_TABLE, moodBedDb, ROOM_TONE_DBFS,
  ZONE_AUDIO, zoneAudio, type EventFamily,
} from './zoneAudio.ts';

const BED_SECONDS = 8;
const XFADE = 1.5;
const BED_REF_DB = 20 * Math.log10(BED_RMS); // -20 dBFS
const WADE_GAIN = 0.9;

interface BedPlayer {
  kind: BedKind;
  src: AudioBufferSourceNode | null;
  gain: GainNode;
  rate: ReturnType<AudioEnv['graph']['registerRate']> | null;
  target: number;
}

export class Ambience {
  private readonly env: AudioEnv;
  private readonly oneShots: OneShots;
  private readonly beds = new Map<BedKind, BedPlayer>();
  private zone: ZoneId = -1 as ZoneId;
  private mood: MoodId = 0;
  // wade
  private wadeSrc: AudioBufferSourceNode | null = null;
  private wadeGain: GainNode | null = null;
  private wadeFilter: BiquadFilterNode | null = null;
  private wadeRate: ReturnType<AudioEnv['graph']['registerRate']> | null = null;
  private wadeLastG = -1;
  private wadeLastF = -1;
  // Poisson events
  private nextEvent = -1;
  private lastEventT = -1e9;
  private lastKind = '';
  private readonly pos: [number, number] = [0, 0];
  private readonly wts: number[] = [];
  private family: EventFamily = 'L0';
  eventsPlayed = 0;

  constructor(env: AudioEnv, oneShots: OneShots) {
    this.env = env;
    this.oneShots = oneShots;
  }

  static bedRequest(kind: BedKind): SynthRequest { return { op: 'bed', kind, seconds: BED_SECONDS, seed: 1 }; }
  static requests(): SynthRequest[] {
    const r: SynthRequest[] = [Ambience.bedRequest('roomTone')];
    const seen = new Set<string>();
    for (const z of ZONE_AUDIO) for (const b of z.beds) if (!seen.has(b.kind)) { seen.add(b.kind); r.push(Ambience.bedRequest(b.kind)); }
    r.push(Ambience.bedRequest('wade'));
    for (const fam of ['L0', 'industrial', 'pools'] as const) for (const k of EVENT_TABLE[fam].kinds) for (let v = 0; v < 2; v++) r.push(OneShots.oneShotReq(k, v));
    return r;
  }

  get activeCount(): number {
    let n = 0;
    for (const b of this.beds.values()) if (b.src && b.target > 0) n++;
    return n + (this.wadeSrc && this.wadeGain && this.wadeGain.gain.value > 1e-3 ? 1 : 0);
  }

  private busOf(kind: BedKind): BusName { return kind === 'water' || kind === 'wade' ? 'water' : 'amb'; }

  private setBed(kind: BedKind, dbfs: number | null): void {
    const env = this.env;
    const t = env.ctx.currentTime;
    let b = this.beds.get(kind);
    const target = dbfs === null ? 0 : dbToGain(dbfs - BED_REF_DB);
    if (!b) {
      if (target <= 0) return;
      const gain = env.ctx.createGain();
      gain.gain.value = 0;
      gain.connect(env.graph.buses[this.busOf(kind)]);
      b = { kind, src: null, gain, rate: null, target: 0 };
      this.beds.set(kind, b);
    }
    b.target = target;
    if (!b.src && target > 0) {
      const buf = env.bank.ensure(Ambience.bedRequest(kind), 1);
      if (!buf) { b.target = target; return; } // retried by refresh()
      const r = 1;
      b.src = startLoop(env.ctx, buf, b.gain, r, env.rng.float());
      b.rate = env.graph.registerRate(b.src.playbackRate, r);
    }
    b.gain.gain.cancelScheduledValues(t);
    b.gain.gain.setValueAtTime(b.gain.gain.value, t);
    b.gain.gain.linearRampToValueAtTime(target, t + XFADE);
    if (target <= 0 && b.src) {
      stopSource(b.src, t + XFADE + 0.05);
      env.graph.unregisterRate(b.rate);
      b.src = null; b.rate = null;
    }
  }

  /** Called at 4 Hz with the listener's zone and mood. */
  refresh(zone: ZoneId, mood: MoodId): void {
    const env = this.env;
    this.setBedIfNeeded('roomTone', ROOM_TONE_DBFS);
    if (zone !== this.zone || mood !== this.mood) {
      const prev = this.zone;
      this.zone = zone; this.mood = mood;
      const def = zoneAudio(zone);
      this.family = def.family;
      const trim = moodBedDb(mood);
      for (const [kind, b] of this.beds) {
        if (kind === 'roomTone' || kind === 'wade') continue;
        if (!def.beds.some((l) => l.kind === kind) && b.target > 0) this.setBed(kind, null);
      }
      for (const l of def.beds) this.setBed(l.kind, l.dbfs + trim);
      if (prev >= 0) env.log(`zone beds -> ${def.beds.map((l) => l.kind).join('+')} (zone ${zone}, mood ${mood})`);
    } else {
      // buffers that were not ready at the zone change
      for (const b of this.beds.values()) if (!b.src && b.target > 0 && b.kind !== 'wade') this.setBed(b.kind, 20 * Math.log10(b.target) + BED_REF_DB);
    }
  }

  private setBedIfNeeded(kind: BedKind, dbfs: number): void {
    const b = this.beds.get(kind);
    if (!b || !b.src) this.setBed(kind, dbfs);
  }

  /** Every frame: the wade bed follows speed x depth. */
  wade(speed: number, depth: number): void {
    const env = this.env;
    const g = depth > 0.02 ? WADE_GAIN * Math.min(1.5, (speed / 1.45) * Math.min(1, depth / 0.6)) : 0;
    if (!this.wadeSrc) {
      if (g <= 0) return;
      const buf = env.bank.ensure(Ambience.bedRequest('wade'), 1);
      if (!buf) return;
      this.wadeFilter = env.ctx.createBiquadFilter();
      this.wadeFilter.type = 'lowpass';
      this.wadeGain = env.ctx.createGain();
      this.wadeGain.gain.value = 0;
      this.wadeFilter.connect(this.wadeGain).connect(env.graph.buses.water);
      this.wadeSrc = startLoop(env.ctx, buf, this.wadeFilter, 1, 0);
      this.wadeRate = env.graph.registerRate(this.wadeSrc.playbackRate, 1);
    }
    if (this.wadeGain && this.wadeFilter) {
      const t = env.ctx.currentTime;
      const f = 3200 - 2300 * Math.min(1, Math.max(0, depth));
      if (Math.abs(g - this.wadeLastG) > 0.005) { this.wadeLastG = g; this.wadeGain.gain.setTargetAtTime(g, t, 0.12); }
      if (Math.abs(f - this.wadeLastF) > 20) { this.wadeLastF = f; this.wadeFilter.frequency.setTargetAtTime(f, t, 0.2); }
    }
  }

  /** Poisson ambient events (dt = simulation dt; nothing happens while paused or frozen). */
  events(t: number, dt: number): void {
    const env = this.env;
    if (dt <= 0 || env.paused) return;
    const tab = EVENT_TABLE[this.family];
    if (this.nextEvent < 0) this.nextEvent = t + EVENT_MIN_GAP * 0.5 + this.expo(tab.rate);
    if (t < this.nextEvent) return;
    this.nextEvent = t + EVENT_MIN_GAP + this.expo(tab.rate);
    if (t - this.lastEventT < EVENT_MIN_GAP) return;
    // weights, never the same kind twice in a row
    this.wts.length = 0;
    for (let i = 0; i < tab.kinds.length; i++) this.wts.push(tab.kinds[i] === this.lastKind ? 0 : tab.weights[i]);
    const ki = env.rng.weighted(this.wts);
    const kind = tab.kinds[ki];
    if (!env.spatial.pickReachable(env.rng, EVENT_MIN_DIST, EVENT_MAX_DIST, this.pos)) return;
    const y = EVENT_HEIGHT[kind] ?? 1.0;
    // level so the peak reaches EVENT_PEAK_DBFS at the listener before occlusion losses (undo the panner's
    // inverse-distance attenuation; buffers peak at ~0.6-0.9)
    const dx = this.pos[0] - env.lx, dz = this.pos[1] - env.lz;
    const d = Math.max(1.5, Math.sqrt(dx * dx + dz * dz));
    const level = Math.min(4, dbToGain(EVENT_PEAK_DBFS) * (d / 1.5));
    const variant = env.rng.int(0, 1);
    if (this.oneShots.playAt(OneShots.oneShotReq(kind, variant), this.pos[0], y, this.pos[1], level, { bus: 'sfx', attack: 0.025 })) {
      this.lastKind = kind;
      this.lastEventT = t;
      this.eventsPlayed++;
      env.log(`ambient ${kind} at ${d.toFixed(0)} m`);
    }
  }

  private expo(rate: number): number { return -Math.log(1 - this.env.rng.float() * 0.999999) / rate; }

  stopAll(): void {
    const t = this.env.ctx.currentTime;
    for (const b of this.beds.values()) {
      b.gain.gain.setTargetAtTime(0, t, 0.1);
      const src = b.src;
      stopSource(src, t + 0.5);
      if (src) {
        const ended = src.onended;
        src.onended = (ev): void => { ended?.call(src, ev); b.gain.disconnect(); };
      } else b.gain.disconnect();
      this.env.graph.unregisterRate(b.rate);
      b.src = null;
    }
    this.beds.clear();
    stopSource(this.wadeSrc);
    this.env.graph.unregisterRate(this.wadeRate);
    this.wadeSrc = null;
    this.wadeFilter?.disconnect();
    this.wadeGain?.disconnect();
    this.wadeFilter = this.wadeGain = null;
    this.wadeRate = null;
    this.wadeLastG = this.wadeLastF = -1;
  }
}
