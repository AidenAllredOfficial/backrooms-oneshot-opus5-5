// src/audio/graph.ts — the Web Audio graph (§5 WP13 "Graph"):
//   voice: src -> gain -> BiquadFilter(lowpass, occlusion) -> Panner(HRTF | equalpower; inverse, ref 1.5) -> bus
//   buses: hum, water, amb, foot, foley, sfx, ui(dry)
//   bus -> master;  bus -> send(bus factor) -> wet(g_wet) -> preDelay -> [ConvolverA x fade x ConvolverB] -> EQ -> master
//   master -> pause muffle (LP + gain) -> tape (glitch) -> post (make-up gain) -> DynamicsCompressor -> limiter -> out
// ui joins after the muffle/tape stage (menus stay clear while paused). The compressors' implicit make-up gain
// (Chromium applies one) is measured once in an OfflineAudioContext and cancelled, so levels are browser-independent.
// Loudness (R2): the sources are authored with lots of headroom (walking in Level 0 measured ~-26 dBFS RMS with the
// linear sliders at their defaults), so `post` adds MAKEUP_DB in front of the bus compressor (it also makes up the
// 3.8 dB the perceptual sliders take at their defaults); walking in Level 0 now sits around -19 dBFS RMS. The
// compressor only catches loud events (threshold COMP_DB), the limiter holds the true peak under ~-2 dBFS (threshold
// LIMIT_DB, 1 ms attack, a -0.5 dB trim for the inter-sample overshoot).
// Sliders are perceptual: gain = v^2 (0 = mute, the default 0.8 = -3.9 dB, 0.5 = -12 dB).

import type { Settings } from '../core/settings.ts';

export const BUS_NAMES = ['hum', 'water', 'amb', 'foot', 'foley', 'sfx', 'ui'] as const;
export type BusName = (typeof BUS_NAMES)[number];
/** Reverb send per bus (x g_wet). Footsteps: 0.35 (§5 WP13). */
const SEND: Readonly<Record<BusName, number>> = { hum: 0.9, water: 0.7, amb: 0.35, foot: 0.35, foley: 0.15, sfx: 1.0, ui: 0 };
const IR_FADE = 1.5;
/** Make-up gain in front of the bus compressor (dB). */
export const MAKEUP_DB = 15;
/** Bus compressor: catches loud events only. */
const COMP_DB = -14, COMP_RATIO = 3, COMP_KNEE = 6;
/** Output limiter threshold (dBFS) and the trim after it (headroom for inter-sample peaks). */
const LIMIT_DB = -2.5, LIMIT_RATIO = 20, LIMIT_TRIM_DB = -0.5;

/** Perceptual slider law: 0..1 slider -> linear gain v^2 (0 = mute, 1 = unity). Non-finite -> 1. */
export function sliderGain(v: number): number {
  const x = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
  return x * x;
}

interface RateEntry { param: AudioParam; base: number }

/** Output level report (graph.takeMeter). */
export interface OutputMeter { n: number; rmsDb: number; peakDb: number; nonFinite: number }

export class AudioGraph {
  readonly ctx: AudioContext;
  readonly buses: Record<BusName, GainNode>;
  private readonly volume: Record<BusName, number> = { hum: 1, water: 1, amb: 1, foot: 1, foley: 1, sfx: 1, ui: 1 };
  readonly master: GainNode;
  private readonly muffle: BiquadFilterNode;
  private readonly pauseGain: GainNode;
  private readonly tape: GainNode;
  private readonly post: GainNode;
  private readonly comp: DynamicsCompressorNode;
  private readonly compTrim: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly limTrim: GainNode;
  readonly wet: GainNode;
  private readonly preDelay: DelayNode;
  private readonly conv: [ConvolverNode, ConvolverNode];
  private readonly convGain: [GainNode, GainNode];
  private readonly lowShelf: BiquadFilterNode;
  private readonly highShelf: BiquadFilterNode;
  private active = 0;
  private convReadyAt = 0;
  readonly irOf: [number, number] = [-1, -1];
  private readonly rates: RateEntry[] = [];
  private tapeUntil = 0;
  paused = false;
  /** output meter: post-limiter tap (null when the context has no AnalyserNode) */
  private readonly analyser: AnalyserNode | null = null;
  private readonly meterBuf: Float32Array<ArrayBuffer> | null = null;
  private meterSq = 0;
  private meterN = 0;
  private meterPeak = 0;
  private meterBad = 0;

  constructor(ctx: AudioContext, vol: Settings['volume'], uiMaster = 1) {
    this.ctx = ctx;
    const g = (v = 1): GainNode => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.master = g();
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.Q.value = 0.5;
    this.pauseGain = g();
    this.tape = g();
    this.post = g(Math.pow(10, MAKEUP_DB / 20));
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = COMP_DB; this.comp.ratio.value = COMP_RATIO; this.comp.knee.value = COMP_KNEE;
    this.comp.attack.value = 0.01; this.comp.release.value = 0.25;
    this.compTrim = g();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = LIMIT_DB; this.limiter.ratio.value = LIMIT_RATIO; this.limiter.knee.value = 0;
    this.limiter.attack.value = 0.001; this.limiter.release.value = 0.08;
    this.limTrim = g(Math.pow(10, LIMIT_TRIM_DB / 20));
    this.master.connect(this.muffle).connect(this.pauseGain).connect(this.tape).connect(this.post);
    this.post.connect(this.comp).connect(this.compTrim).connect(this.limiter).connect(this.limTrim).connect(ctx.destination);
    if (typeof ctx.createAnalyser === 'function') {
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      this.limTrim.connect(a); // analysers are pulled without an output connection
      this.analyser = a;
      this.meterBuf = new Float32Array(a.fftSize);
    }

    // reverb
    this.wet = g(0.25);
    this.preDelay = ctx.createDelay(0.2);
    this.preDelay.delayTime.value = 0.015;
    this.conv = [ctx.createConvolver(), ctx.createConvolver()];
    this.conv[0].normalize = false; this.conv[1].normalize = false;
    this.convGain = [g(0), g(0)];
    this.lowShelf = ctx.createBiquadFilter(); this.lowShelf.type = 'lowshelf'; this.lowShelf.frequency.value = 220;
    this.highShelf = ctx.createBiquadFilter(); this.highShelf.type = 'highshelf'; this.highShelf.frequency.value = 4000;
    this.wet.connect(this.preDelay);
    for (let i = 0; i < 2; i++) { this.preDelay.connect(this.conv[i]); this.conv[i].connect(this.convGain[i]).connect(this.lowShelf); }
    this.lowShelf.connect(this.highShelf).connect(this.master);

    const buses = {} as Record<BusName, GainNode>;
    for (const b of BUS_NAMES) {
      const bus = g();
      buses[b] = bus;
      if (b === 'ui') { bus.connect(this.post); continue; }
      bus.connect(this.master);
      const send = g(SEND[b]);
      bus.connect(send).connect(this.wet);
    }
    this.buses = buses;
    this.setVolumes(vol, uiMaster);
  }

  /** Settings sliders 0..1 map perceptually (sliderGain: v^2; the default 0.8 is -3.9 dB, 0 mutes). The ui bus
   * does not follow `v.master` (the title fades that to 0 while its menu clicks must stay audible); it follows
   * `uiMaster` instead, the user's own Master slider (unfaded), so Master = 0 still silences everything. */
  setVolumes(v: Settings['volume'], uiMaster = 1): void {
    const t = this.ctx.currentTime;
    const sq = sliderGain;
    this.master.gain.setTargetAtTime(sq(v.master), t, 0.05);
    this.volume.hum = sq(v.hum);
    this.volume.amb = this.volume.water = sq(v.ambience);
    this.volume.foot = this.volume.foley = this.volume.sfx = sq(v.sfx);
    this.volume.ui = sq(v.ui) * sq(uiMaster);
    for (const b of BUS_NAMES) this.buses[b].gain.setTargetAtTime(this.volume[b], t, 0.05);
  }

  /** Pause: everything behind an 800 Hz low-pass at -12 dB (ui bus excluded). */
  setPaused(p: boolean): void {
    this.paused = p;
    const t = this.ctx.currentTime;
    this.muffle.frequency.cancelScheduledValues(t);
    this.muffle.frequency.setTargetAtTime(p ? 800 : 20000, t, p ? 0.08 : 0.2);
    this.pauseGain.gain.setTargetAtTime(p ? Math.pow(10, -12 / 20) : 1, t, p ? 0.08 : 0.2);
  }

  /** Reverb parameters, smoothed. */
  setReverb(preDelay: number, wet: number, lowDb: number, highDb: number): void {
    const t = this.ctx.currentTime;
    this.preDelay.delayTime.setTargetAtTime(preDelay, t, 0.4);
    this.wet.gain.setTargetAtTime(wet, t, 0.6);
    this.lowShelf.gain.setTargetAtTime(lowDb, t, 0.8);
    this.highShelf.gain.setTargetAtTime(highDb, t, 0.8);
  }

  /** Load an IR into the idle convolver and crossfade to it over 1.5 s. False while a crossfade is running. */
  swapIR(buf: AudioBuffer, index: number): boolean {
    const t = this.ctx.currentTime;
    if (this.irOf[this.active] === index) return true;
    if (t < this.convReadyAt) return false;
    const next = this.irOf[this.active] < 0 ? this.active : 1 - this.active;
    this.conv[next].buffer = buf;
    this.irOf[next] = index;
    const a = this.convGain[next].gain, b = this.convGain[1 - next].gain;
    a.cancelScheduledValues(t); b.cancelScheduledValues(t);
    a.setValueAtTime(a.value, t); b.setValueAtTime(b.value, t);
    // equal-power crossfade
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      const x = i / steps;
      a.linearRampToValueAtTime(Math.sin((x * Math.PI) / 2), t + x * IR_FADE);
      if (next !== this.active) b.linearRampToValueAtTime(Math.cos((x * Math.PI) / 2), t + x * IR_FADE);
    }
    this.active = next;
    this.convReadyAt = t + IR_FADE + 0.05;
    return true;
  }
  get activeIR(): number { return this.irOf[this.active]; }

  // ---------------------------------------------------------------- tape stop (glitch)
  /** Register a source playbackRate for the glitch tape-stop; returns a handle for unregisterRate. */
  registerRate(param: AudioParam, base: number): RateEntry {
    const e = { param, base };
    this.rates.push(e);
    return e;
  }
  unregisterRate(e: RateEntry | null): void {
    if (!e) return;
    const i = this.rates.indexOf(e);
    if (i >= 0) { this.rates[i] = this.rates[this.rates.length - 1]; this.rates.pop(); }
  }
  /** Glitch: every registered source's playback rate falls to 0.3 over 0.4 s (and the output darkens), then 0.6 s
   * of silence, then everything is restored. */
  tapeStop(): void {
    const t = this.ctx.currentTime;
    const stop = 0.4, silent = 0.6;
    if (t < this.tapeUntil) { this.extendTapeStop(t, silent); return; }
    for (const e of this.rates) {
      const p = e.param;
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(e.base * 0.3, t + stop);
      p.setValueAtTime(e.base * 0.3, t + stop + silent);
      p.linearRampToValueAtTime(e.base, t + stop + silent + 0.05);
    }
    const tg = this.tape.gain;
    tg.cancelScheduledValues(t);
    tg.setValueAtTime(tg.value, t);
    tg.linearRampToValueAtTime(0.7, t + stop * 0.8);
    tg.linearRampToValueAtTime(0, t + stop + 0.03);
    tg.setValueAtTime(0, t + stop + silent);
    tg.linearRampToValueAtTime(1, t + stop + silent + 0.35);
    const mf = this.muffle.frequency;
    mf.cancelScheduledValues(t);
    mf.setValueAtTime(mf.value, t);
    mf.exponentialRampToValueAtTime(1200, t + stop);
    mf.setValueAtTime(1200, t + stop + silent);
    mf.exponentialRampToValueAtTime(this.paused ? 800 : 20000, t + stop + silent + 0.3);
    this.tapeUntil = t + stop + silent;
  }
  /** A glitch during a running tape stop extends the silence (one continuous stop) instead of restarting the ramp,
   * which would blip the output back up toward 0.7. The ramp-down already scheduled is kept; only the recovery moves. */
  private extendTapeStop(t: number, silent: number): void {
    const silenceStart = this.tapeUntil - silent; // end of the ramp-down of the running stop
    const end = Math.max(this.tapeUntil, t + silent);
    const cut = Math.max(t, silenceStart) + 0.031; // after the last ramp-down event (gain reaches 0 at +0.03)
    for (const e of this.rates) {
      e.param.cancelScheduledValues(cut);
      e.param.setValueAtTime(e.base * 0.3, end);
      e.param.linearRampToValueAtTime(e.base, end + 0.05);
    }
    const tg = this.tape.gain;
    tg.cancelScheduledValues(cut);
    tg.setValueAtTime(0, end);
    tg.linearRampToValueAtTime(1, end + 0.35);
    const mf = this.muffle.frequency;
    mf.cancelScheduledValues(cut);
    mf.setValueAtTime(1200, end);
    mf.exponentialRampToValueAtTime(this.paused ? 800 : 20000, end + 0.3);
    this.tapeUntil = end;
  }
  /** True while the tape-stop silence is running (new sounds are skipped). */
  get tapeSilent(): boolean { return this.ctx.currentTime < this.tapeUntil; }

  /** Measure and cancel the compressors' implicit make-up gain (Chromium: (1/saturate(1))^0.6). */
  async calibrate(): Promise<void> {
    const OAC: typeof OfflineAudioContext | undefined = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    if (!OAC) return;
    const sr = 22050;
    const measure = async (threshold: number, ratio: number, knee: number): Promise<number> => {
      const oc = new OAC(1, sr / 2, sr);
      const osc = oc.createOscillator();
      osc.frequency.value = 200;
      const pre = oc.createGain();
      pre.gain.value = 0.01; // -40 dBFS: far below both thresholds
      const c = oc.createDynamicsCompressor();
      c.threshold.value = threshold; c.ratio.value = ratio; c.knee.value = knee;
      osc.connect(pre).connect(c).connect(oc.destination);
      osc.start();
      const out = await oc.startRendering();
      const d = out.getChannelData(0);
      let p = 0;
      for (let i = d.length >> 1; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
      const g = p / 0.01;
      return Number.isFinite(g) && g > 0.2 && g < 20 ? g : 1;
    };
    try {
      const gc = await measure(COMP_DB, COMP_RATIO, COMP_KNEE);
      const gl = await measure(LIMIT_DB, LIMIT_RATIO, 0);
      const t = this.ctx.currentTime;
      this.compTrim.gain.setTargetAtTime(1 / gc, t, 0.05);
      this.limTrim.gain.setTargetAtTime(Math.pow(10, LIMIT_TRIM_DB / 20) / gl, t, 0.05);
    } catch {
      /* keep unity trims */
    }
  }

  /** Sample the output (post-limiter) meter: accumulates mean square, peak and non-finite samples over ~43 ms of the
   * most recent output. Call at a low rate (the room-probe clock); read with takeMeter(). No allocation. */
  sampleMeter(): void {
    const a = this.analyser, b = this.meterBuf;
    if (!a || !b) return;
    a.getFloatTimeDomainData(b);
    let sq = 0, pk = this.meterPeak, bad = 0;
    for (let i = 0; i < b.length; i++) {
      const v = b[i];
      if (!Number.isFinite(v)) { bad++; continue; }
      sq += v * v;
      const m = v < 0 ? -v : v;
      if (m > pk) pk = m;
    }
    this.meterSq += sq;
    this.meterN += b.length;
    this.meterPeak = pk;
    this.meterBad += bad;
  }

  /** Output level since the last call: RMS / peak in dBFS (-120 floor) and the count of non-finite samples; resets
   * the accumulators. `n` = samples measured (0 without an analyser). */
  takeMeter(out: OutputMeter): OutputMeter {
    const n = this.meterN;
    const rms = n > 0 ? Math.sqrt(this.meterSq / n) : 0;
    out.n = n;
    out.rmsDb = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
    out.peakDb = this.meterPeak > 1e-6 ? 20 * Math.log10(this.meterPeak) : -120;
    out.nonFinite = this.meterBad;
    this.meterSq = 0; this.meterN = 0; this.meterPeak = 0; this.meterBad = 0;
    return out;
  }

  dispose(): void {
    try { this.analyser?.disconnect(); } catch { /* ignore */ }
    try { this.master.disconnect(); this.post.disconnect(); this.wet.disconnect(); } catch { /* ignore */ }
    for (const b of BUS_NAMES) { try { this.buses[b].disconnect(); } catch { /* ignore */ } }
    this.rates.length = 0;
  }
}
