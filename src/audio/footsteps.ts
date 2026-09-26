// src/audio/footsteps.ts — the player's footsteps and landings (§5 WP13 "Footsteps").
// On `footstep`: the surface buffer (8 variants, never the same twice in a row), detune +-50 cents, +-1.5 dB, pan
// +-0.15 per foot; gain by gait (crouch 0.3, walk 0.75, sprint 1.0; settle steps 0.35); reverb send 0.35 (foot bus).
// Water depth overrides the surface. Damp carpet (cell humidity above ~0.58, the same field that grows the damp
// stains) squelches: the chance of a carpetWet step rises to 85 % by humidity 0.8. The foot bus also feeds the LATE_ECHO tap (a 350 ms delayed copy, driven by
// dread.ts). `land`: a heavier double hit scaled by the impact.

import { CELL, CHUNK_CELLS } from '../core/constants.ts';
import { cellIdx } from '../core/grid.ts';
import { SurfaceSound, type SurfaceSoundId } from '../core/ids.ts';
import type { GameEvents } from '../core/events.ts';
import type { PlayerState } from '../core/player.ts';
import { synthKey, type SynthRequest } from './dsp/dispatch.ts';
import type { AudioEnv } from './env.ts';

const SURFACES = 11;
const VARIANTS = 8;
const FOOT_GAIN = 0.85;
const ECHO_DELAY = 0.35;
const GAIT_WALK = 0.75;
/** Carpet humidity (0..1) where wet steps start, where they reach their maximum share, and that share. */
const DAMP_LO = 0.58, DAMP_HI = 0.8, DAMP_MAX = 0.85;

export class Footsteps {
  private readonly env: AudioEnv;
  private readonly keys: string[][] = [];
  private readonly last = new Int8Array(SURFACES).fill(-1);
  private player: PlayerState | null = null;
  // LATE_ECHO tap: foot bus -> delay 350 ms -> LP -> gain -> sfx bus
  private readonly echoDelay: DelayNode;
  private readonly echoFilter: BiquadFilterNode;
  readonly echoGain: GainNode;
  private echoLevel = 0;
  steps = 0;

  constructor(env: AudioEnv) {
    this.env = env;
    for (let s = 0; s < SURFACES; s++) {
      const row: string[] = [];
      for (let v = 0; v < VARIANTS; v++) row.push(synthKey({ op: 'foot', surface: s as SurfaceSoundId, variant: v }));
      this.keys.push(row);
    }
    const ctx = env.ctx;
    this.echoDelay = ctx.createDelay(1);
    this.echoDelay.delayTime.value = ECHO_DELAY;
    this.echoFilter = ctx.createBiquadFilter();
    this.echoFilter.type = 'lowpass';
    this.echoFilter.frequency.value = 2800;
    this.echoGain = ctx.createGain();
    this.echoGain.gain.value = 0;
    env.graph.buses.foot.connect(this.echoDelay).connect(this.echoFilter).connect(this.echoGain).connect(env.graph.buses.sfx);
  }

  static requests(first: SurfaceSoundId): SynthRequest[] {
    const r: SynthRequest[] = [];
    const order: number[] = [first];
    for (let s = 0; s < SURFACES; s++) if (s !== first) order.push(s);
    for (const s of order) for (let v = 0; v < VARIANTS; v++) r.push({ op: 'foot', surface: s as SurfaceSoundId, variant: v });
    return r;
  }

  setPlayer(p: PlayerState): void { this.player = p; }

  /** Water depth overrides the floor surface. */
  static surfaceFor(surface: SurfaceSoundId, waterDepth: number): SurfaceSoundId {
    if (waterDepth > 0.3) return SurfaceSound.WATER_DEEP;
    if (waterDepth > 0.03) return SurfaceSound.WATER_SHALLOW;
    return surface >= 0 && surface < SURFACES ? surface : SurfaceSound.CARPET;
  }

  /** Share of carpetWet steps on carpet of humidity h (0 below DAMP_LO, smooth to DAMP_MAX at DAMP_HI). */
  static wetShare(h: number): number {
    if (!(h > DAMP_LO)) return 0;
    const u = Math.min(1, (h - DAMP_LO) / (DAMP_HI - DAMP_LO));
    return DAMP_MAX * u * u * (3 - 2 * u);
  }

  /** Humidity field (0..1) of the cell under (x, z) from the resident layout (0 when not resident). */
  private humidityAt(x: number, z: number): number {
    const w = this.env.spatial.world;
    if (!w || !Number.isFinite(x) || !Number.isFinite(z)) return 0;
    const gi = Math.floor(x / CELL + 1e-7), gj = Math.floor(z / CELL + 1e-7);
    const cx = Math.floor(gi / CHUNK_CELLS), cz = Math.floor(gj / CHUNK_CELLS);
    const l = w.layoutAt(cx, cz);
    if (!l) return 0;
    return l.humidity[cellIdx(gi - cx * CHUNK_CELLS, gj - cz * CHUNK_CELLS)] / 255;
  }

  /** A ready buffer of the surface: a random variant different from the last one (any ready one as fallback). */
  private pick(surface: number): AudioBuffer | null {
    const env = this.env;
    const row = this.keys[surface];
    let v = env.rng.int(0, VARIANTS - 2);
    if (v >= this.last[surface]) v++;
    for (let k = 0; k < VARIANTS; k++) {
      const vv = (v + k) % VARIANTS;
      const b = env.bank.get(row[vv]);
      if (b) { this.last[surface] = vv; return b; }
    }
    env.bank.ensure({ op: 'foot', surface: surface as SurfaceSoundId, variant: v }, 0);
    return null;
  }

  onFootstep(e: GameEvents['footstep']): void {
    const env = this.env;
    if (env.graph.tapeSilent) return;
    let surface = Footsteps.surfaceFor(e.surface, e.waterDepth);
    if (surface === SurfaceSound.CARPET && env.rng.float() < Footsteps.wetShare(this.humidityAt(e.x, e.z))) surface = SurfaceSound.CARPET_WET;
    const buf = this.pick(surface);
    if (!buf) return;
    const p = this.player;
    let gait = GAIT_WALK;
    if (e.settle) gait = 0.35;
    else if (p && p.crouch > 0.5) gait = 0.3;
    else if (p && p.speed > 2.3) gait = 1.0;
    const inten = Number.isFinite(e.intensity) ? Math.min(1.2, Math.max(0.2, e.intensity)) : 1;
    const rng = env.rng;
    const db = rng.range(-1.5, 1.5);
    const cents = rng.range(-50, 50);
    const pan = (e.foot === 0 ? -0.15 : 0.15) + rng.range(-0.03, 0.03);
    this.play(buf, FOOT_GAIN * gait * (0.8 + 0.2 * inten) * Math.pow(10, db / 20), Math.pow(2, cents / 1200), pan, 0);
    this.steps++;
  }

  onLand(e: GameEvents['land']): void {
    const env = this.env;
    if (env.graph.tapeSilent) return;
    const surface = Footsteps.surfaceFor(e.surface, this.player ? this.player.waterDepth : 0);
    const g = FOOT_GAIN * Math.min(1.3, Math.max(0.35, e.impact / 3));
    const a = this.pick(surface), b = this.pick(surface);
    const t = env.ctx.currentTime;
    if (a) this.play(a, g, 0.82, -0.1, t);
    if (b) this.play(b, g * 0.8, 0.78, 0.1, t + 0.012);
    env.log(`land impact ${e.impact.toFixed(1)}`);
  }

  private play(buf: AudioBuffer, gain: number, rate: number, pan: number, when: number): void {
    const ctx = this.env.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(g).connect(p).connect(this.env.graph.buses.foot);
    src.onended = (): void => { try { src.disconnect(); g.disconnect(); p.disconnect(); } catch { /* ignore */ } };
    src.start(when > 0 ? when : 0);
  }

  /** LATE_ECHO tap level (0 = off); fast release so the echo stops when you stop. */
  setEcho(level: number): void {
    if (level === this.echoLevel) return;
    this.echoLevel = level;
    const t = this.env.ctx.currentTime;
    this.echoGain.gain.setTargetAtTime(level, t, level > 0 ? 0.3 : 0.03);
  }

  /** Buffer for phantom footsteps (dread): a ready variant of the surface. */
  phantomRequest(surface: SurfaceSoundId): SynthRequest {
    return { op: 'foot', surface, variant: this.env.rng.int(0, VARIANTS - 1) };
  }
}
