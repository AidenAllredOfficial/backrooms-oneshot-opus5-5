// src/audio/humVoices.ts — per-fixture fluorescent hum voices and the unvoiced hum bed (§5 WP13 "Hum voices",
// "Hum bed").
//  * 10 Hz: candidates = lit fixtures (ON / BUZZ / DYING / FLICKER / ANOMALY) within 30 m, deduplicated by id
//    (tower replicas share ids: nearest wins). d = max(euclid, path distance); score = level * hum / (1 + d^2 / 9).
//    The top q.humVoices with d <= 18 m get voices (300 ms steal fades); variant = id % 4; playback rate
//    0.995-1.005 from the fixture seed. Everything else lit within 30 m feeds the stereo hum bed:
//    gain = sqrt(sum of their contributions). Dead sectors therefore fall to room tone.
//  * 5 Hz (after propagation): each voice is re-resolved (portal / occlusion / air) with setTargetAtTime tau 0.08.
//  * every frame: non-ON voices follow flicker() 30 ms ahead through AudioParam automation (hum level with the tube
//    intensity, a gated ballast-buzz layer with flicker().buzz; DYING/BUZZ add buzz gain).

import { flicker, flickerMean, type FlickerSample } from '../core/flicker.ts';
import { EmitterKind, LightState, type LightStateId } from '../core/ids.ts';
import type { FixtureRef, LightingRuntime, WorldQuery } from '../core/runtime.ts';
import type { SynthRequest } from './dsp/dispatch.ts';
import { synthKey } from './dsp/dispatch.ts';
import { alignedTime, unit, type AudioEnv } from './env.ts';
import { createResolution, type SourceResolution } from './propagation.ts';
import { startLoop, stopSource, Voice } from './voice.ts';

const MAX_VOICES = 12;
const CAND_MAX = 256;
const VOICE_RANGE = 18;
const BED_RANGE = 30;
const STEAL_FADE = 0.3;
/** Linear gain of one hum voice at the panner reference distance (hum weight 1, level 1). The R2 hum buffers are
 * harmonically bright (peak-normalized to 0.9 like before, but ~6.5 dB louder A-weighted), so the gains came down
 * ~3.5 dB: the hum ends up ~3 dB more present against the beds than the old dull drone, without the fatigue of
 * a full +6.5 dB. */
const HUM_GAIN = 0.067;
const BED_GAIN = 0.055;
/** Distant fixtures (the bed) lose their top through the ceiling plenum and the rooms between. */
const BED_LOWPASS = 2600;
const BUZZ_GAIN = 0.55;
const HUM_SECONDS = 6;

/** Loudness multiplier of the hum by light state (BUZZ is the loud one). */
function stateLevel(state: number): number {
  switch (state) {
    case LightState.BUZZ: return 1.4;
    case LightState.DYING: return 1.05;
    case LightState.FLICKER: return 0.85;
    case LightState.ANOMALY: return 0.9;
    case LightState.OFF: return 0;
    default: return 1;
  }
}

class HumSlot {
  id = -1;
  x = 0; y = 0; z = 0;
  state = 0; seed = 0; hum = 1; dynamic = false;
  score = 0;
  voice: Voice | null = null;
  src: AudioBufferSourceNode | null = null;
  buzzSrc: AudioBufferSourceNode | null = null;
  buzzGain: GainNode | null = null;
  rateEntry: ReturnType<AudioEnv['graph']['registerRate']> | null = null;
  buzzRateEntry: ReturnType<AudioEnv['graph']['registerRate']> | null = null;
  readonly res: SourceResolution = createResolution();
  lastMul = -1;
  lastBuzz = -1;
  keep = false;
}

export class HumVoices {
  private readonly env: AudioEnv;
  private readonly refs: FixtureRef[] = [];
  // candidate arrays (reused)
  private readonly cId = new Float64Array(CAND_MAX);
  private readonly cX = new Float32Array(CAND_MAX);
  private readonly cY = new Float32Array(CAND_MAX);
  private readonly cZ = new Float32Array(CAND_MAX);
  private readonly cD = new Float32Array(CAND_MAX);
  private readonly cScore = new Float32Array(CAND_MAX);
  private readonly cState = new Uint8Array(CAND_MAX);
  private readonly cSeed = new Float64Array(CAND_MAX);
  private readonly cHum = new Float32Array(CAND_MAX);
  private readonly cDyn = new Uint8Array(CAND_MAX);
  private readonly cPick = new Uint8Array(CAND_MAX);
  private readonly slots: HumSlot[] = [];
  private maxVoices: number;
  private readonly sample: FlickerSample = { i: 1, tint: 0, buzz: 0 };
  private humKeys: string[] = [];
  private buzzKeys: string[] = [];
  // bed
  private bedSrc: AudioBufferSourceNode | null = null;
  private readonly bedGain: GainNode;
  private readonly bedFilter: BiquadFilterNode;
  private bedRate: ReturnType<AudioEnv['graph']['registerRate']> | null = null;
  private bedTarget = 0;
  /** dynamic lights within 18 m for flicker transients (refreshed at 10 Hz) */
  readonly dynCount = { n: 0 };
  readonly dynId = new Float64Array(32);
  readonly dynState = new Uint8Array(32);
  readonly dynSeed = new Float64Array(32);
  readonly dynX = new Float32Array(32);
  readonly dynY = new Float32Array(32);
  readonly dynZ = new Float32Array(32);

  constructor(env: AudioEnv, maxVoices: number) {
    this.env = env;
    this.maxVoices = Math.min(MAX_VOICES, Math.max(0, maxVoices | 0));
    for (let i = 0; i < MAX_VOICES; i++) this.slots.push(new HumSlot());
    this.bedFilter = env.ctx.createBiquadFilter();
    this.bedFilter.type = 'lowpass';
    this.bedFilter.frequency.value = BED_LOWPASS;
    this.bedGain = env.ctx.createGain();
    this.bedGain.gain.value = 0;
    this.bedFilter.connect(this.bedGain).connect(env.graph.buses.hum);
    this.setMains(env.mains);
  }

  /** Requests for the buffers this subsystem needs (for preloading). */
  static requests(mains: 50 | 60): SynthRequest[] {
    const r: SynthRequest[] = [];
    for (let v = 0; v < 4; v++) r.push({ op: 'hum', variant: v, mains, seconds: HUM_SECONDS });
    for (let v = 0; v < 4; v++) r.push({ op: 'emitter', kind: EmitterKind.BUZZ, variant: v, seconds: 6, mains });
    return r;
  }

  setMains(m: 50 | 60): void {
    this.humKeys = [];
    this.buzzKeys = [];
    for (let v = 0; v < 4; v++) {
      this.humKeys.push(synthKey({ op: 'hum', variant: v, mains: m, seconds: HUM_SECONDS }));
      this.buzzKeys.push(synthKey({ op: 'emitter', kind: EmitterKind.BUZZ, variant: v, seconds: 6, mains: m }));
    }
    // restart everything with the new buffers
    for (const s of this.slots) if (s.id >= 0) this.release(s, 0.2);
    if (this.bedSrc) { this.env.graph.unregisterRate(this.bedRate); stopSource(this.bedSrc, this.env.ctx.currentTime + 0.3); this.bedSrc = null; }
  }

  setMaxVoices(n: number): void {
    this.maxVoices = Math.min(MAX_VOICES, Math.max(0, n | 0));
  }
  setHrtf(on: boolean): void { for (const s of this.slots) if (s.voice) s.voice.setHrtf(on); }

  get activeCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.id >= 0) n++;
    return n + (this.bedSrc && this.bedTarget > 1e-4 ? 1 : 0);
  }

  /** 10 Hz: candidates, voice allocation and the bed level. */
  allocate(world: WorldQuery, lighting: LightingRuntime): void {
    const env = this.env;
    const lx = env.lx, ly = env.ly, lz = env.lz;
    const nRef = world.fixturesNear(lx, lz, BED_RANGE, this.refs);
    let n = 0;
    this.dynCount.n = 0;
    for (let r = 0; r < nRef && r < this.refs.length; r++) {
      const ref = this.refs[r];
      const f = ref.f;
      if (f.state === LightState.OFF) continue;
      const dx = ref.wx - lx, dy = ref.wy - ly, dz = ref.wz - lz;
      const eu = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (eu > BED_RANGE) continue;
      const pm = env.spatial.pathMetres(ref.wx, ref.wz);
      const d = pm < Infinity ? Math.max(eu, pm) : eu * 2.5;
      // dedupe by id (tower replicas): keep the nearest
      let dup = -1;
      for (let k = 0; k < n; k++) if (this.cId[k] === f.id) { dup = k; break; }
      const k = dup >= 0 ? dup : n;
      if (dup >= 0 && this.cD[dup] <= d) continue;
      if (k >= CAND_MAX) break;
      const dyn = f.dynamic || f.state === LightState.ANOMALY;
      const level = stateLevel(f.state) * (dyn ? Math.max(0.35, f.state === LightState.ANOMALY ? lighting.intensityOf(f.id) : flickerMean(f.state)) : 1);
      this.cId[k] = f.id; this.cX[k] = ref.wx; this.cY[k] = ref.wy; this.cZ[k] = ref.wz; this.cD[k] = d;
      this.cState[k] = f.state; this.cSeed[k] = f.seed; this.cHum[k] = f.hum; this.cDyn[k] = dyn ? 1 : 0;
      this.cScore[k] = (level * Math.max(0.05, f.hum)) / (1 + (d * d) / 9);
      this.cPick[k] = 0;
      if (dup < 0) n++;
    }
    // dynamic lights within 18 m (flicker transients)
    for (let k = 0; k < n; k++) {
      if (this.cDyn[k] === 0 || this.cD[k] > VOICE_RANGE || this.cState[k] === LightState.ANOMALY) continue;
      const j = this.dynCount.n;
      if (j >= this.dynId.length) break;
      this.dynId[j] = this.cId[k]; this.dynState[j] = this.cState[k]; this.dynSeed[j] = this.cSeed[k];
      this.dynX[j] = this.cX[k]; this.dynY[j] = this.cY[k]; this.dynZ[j] = this.cZ[k];
      this.dynCount.n = j + 1;
    }
    // top-N selection (partial selection sort over the pick flags)
    const N = this.maxVoices;
    for (let v = 0; v < N; v++) {
      let best = -1, bs = 0;
      for (let k = 0; k < n; k++) if (this.cPick[k] === 0 && this.cD[k] <= VOICE_RANGE && this.cScore[k] > bs) { bs = this.cScore[k]; best = k; }
      if (best < 0) break;
      this.cPick[best] = 1;
    }
    // keep / release existing voices
    for (const s of this.slots) {
      s.keep = false;
      if (s.id < 0) continue;
      for (let k = 0; k < n; k++) {
        // a state change (e.g. ON -> FLICKER by the anomaly director) restarts the voice: level and buzz layer differ
        if (this.cPick[k] === 1 && this.cId[k] === s.id && this.cState[k] === s.state) {
          s.keep = true; this.cPick[k] = 2; s.score = this.cScore[k];
          s.x = this.cX[k]; s.y = this.cY[k]; s.z = this.cZ[k];
          break;
        }
      }
      if (!s.keep) this.release(s, STEAL_FADE);
    }
    // start new voices
    for (let k = 0; k < n; k++) {
      if (this.cPick[k] !== 1) continue;
      const s = this.freeSlot();
      if (!s) break;
      if (this.start(s, k)) this.cPick[k] = 2;
    }
    // bed: everything lit within 30 m that has no voice
    let sum = 0;
    for (let k = 0; k < n; k++) if (this.cPick[k] !== 2) sum += this.cScore[k];
    this.bedTarget = BED_GAIN * Math.sqrt(sum);
    this.updateBed();
  }

  private freeSlot(): HumSlot | null {
    for (const s of this.slots) if (s.id < 0 && s.voice === null) return s;
    return null;
  }

  private start(s: HumSlot, k: number): boolean {
    const env = this.env;
    const id = this.cId[k];
    const variant = id % 4;
    const buf = env.bank.get(this.humKeys[variant]);
    if (!buf) return false;
    s.id = id; s.x = this.cX[k]; s.y = this.cY[k]; s.z = this.cZ[k];
    s.state = this.cState[k]; s.seed = this.cSeed[k]; s.hum = Math.max(0.05, this.cHum[k]); s.dynamic = this.cDyn[k] === 1;
    s.score = this.cScore[k];
    s.lastMul = -1; s.lastBuzz = -1;
    const v = new Voice(env.ctx, env.graph.buses.hum, { hrtf: env.hrtf });
    s.voice = v;
    const rate = 0.995 + 0.01 * unit(s.seed, 11);
    s.src = startLoop(env.ctx, buf, v.gain, rate, unit(s.seed, 12));
    s.rateEntry = env.graph.registerRate(s.src.playbackRate, rate);
    if (s.state !== LightState.ON) {
      const bb = env.bank.get(this.buzzKeys[(variant + 1) % 4]);
      if (bb) {
        s.buzzGain = env.ctx.createGain();
        s.buzzGain.gain.value = s.state === LightState.BUZZ ? BUZZ_GAIN * 0.6 : 0;
        s.buzzGain.connect(v.gain);
        const br = 0.99 + 0.02 * unit(s.seed, 13);
        s.buzzSrc = startLoop(env.ctx, bb, s.buzzGain, br, unit(s.seed, 14));
        s.buzzRateEntry = env.graph.registerRate(s.buzzSrc.playbackRate, br);
      }
    }
    v.level = HUM_GAIN * s.hum * stateLevel(s.state);
    env.spatial.resolve(s.x, s.y, s.z, s.res);
    v.apply(s.res, 0.08, true);
    v.fadeIn(STEAL_FADE);
    return true;
  }

  private release(s: HumSlot, fade: number): void {
    const env = this.env;
    if (s.voice) {
      s.voice.release(fade);
      const t = env.ctx.currentTime + fade + 0.02;
      stopSource(s.src, t);
      stopSource(s.buzzSrc, t);
    }
    env.graph.unregisterRate(s.rateEntry);
    env.graph.unregisterRate(s.buzzRateEntry);
    s.rateEntry = s.buzzRateEntry = null;
    s.voice = null; s.src = null; s.buzzSrc = null; s.buzzGain = null;
    s.id = -1;
  }

  private updateBed(): void {
    const env = this.env;
    if (!this.bedSrc && this.bedTarget > 1e-4) {
      const buf = env.bank.get(this.humKeys[0]);
      if (buf) {
        this.bedSrc = startLoop(env.ctx, buf, this.bedFilter, 1.0, 0.37);
        this.bedRate = env.graph.registerRate(this.bedSrc.playbackRate, 1);
      }
    }
    this.bedGain.gain.setTargetAtTime(this.bedTarget, env.ctx.currentTime, 0.5);
  }

  /** 5 Hz: re-resolve every voice against the new propagation field. */
  resolveAll(): void {
    for (const s of this.slots) {
      if (s.id < 0 || !s.voice) continue;
      this.env.spatial.resolve(s.x, s.y, s.z, s.res);
      s.voice.apply(s.res, 0.08);
    }
  }

  /** Every frame: flicker-driven level and buzz automation. The flicker state of the frame being rendered (sim time
   * t) is applied at ctxTime + 0.03 - outputLatency, the same display-latency alignment fixtureSfx uses for the
   * transients (an event at sim time te starts at ctxTime + 0.03 + (te - t) - outputLatency). */
  frame(lighting: LightingRuntime): void {
    const env = this.env;
    const when = alignedTime(env, env.t);
    for (const s of this.slots) {
      if (s.id < 0 || !s.voice || s.state === LightState.ON) continue;
      let i = 1, buzz = 0;
      if (s.state === LightState.ANOMALY) { i = lighting.intensityOf(s.id); buzz = 0.4 * Math.min(1, i); }
      else { flicker(s.state as LightStateId, s.seed, env.t, env.flickerMode, this.sample); i = this.sample.i; buzz = this.sample.buzz; }
      const mul = s.dynamic ? 0.35 + 0.65 * Math.min(1, i) : 1;
      const bz = BUZZ_GAIN * buzz * (s.state === LightState.BUZZ ? 1.2 : s.state === LightState.DYING ? 1 : 0.8);
      if (Math.abs(mul - s.lastMul) > 0.01) {
        s.lastMul = mul;
        s.voice.mul = mul;
        s.voice.gain.gain.setTargetAtTime(s.voice.level * s.voice.occ * mul, when, 0.012);
      }
      if (s.buzzGain && Math.abs(bz - s.lastBuzz) > 0.01) {
        s.lastBuzz = bz;
        s.buzzGain.gain.setTargetAtTime(bz, when, 0.012);
      }
    }
  }

  /** The hum voice of a fixture (fixture transients share its filter + panner), or null. */
  voiceOf(id: number): Voice | null {
    for (const s of this.slots) if (s.id === id && s.voice) return s.voice;
    return null;
  }

  stopAll(fade: number): void {
    for (const s of this.slots) if (s.id >= 0) this.release(s, fade);
    this.bedGain.gain.setTargetAtTime(0, this.env.ctx.currentTime, fade / 3);
  }

  dispose(): void {
    this.stopAll(0.05);
    stopSource(this.bedSrc);
    this.env.graph.unregisterRate(this.bedRate);
  }
}
