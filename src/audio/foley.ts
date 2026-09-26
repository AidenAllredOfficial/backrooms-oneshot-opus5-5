// src/audio/foley.ts — the player's body (§5 WP13 "Foley"): breathing driven by the `breath` event (after ~4 s of
// sprinting, recovering over ~10 s: WP12 computes rate/depth) and cloth rustle. The rustle is the body moving, not
// the camera: a swish per footstep (scaled by speed), crouch transitions and only FAST turns (yaw rate above ~4 rad/s,
// a whip-around; its share is capped at 0.25), with a 150 ms attack and a slower release, so ordinary mouse-look is
// silent (R2: the old yaw-proportional drive put a 2.4 kHz hiss on every look). Landing thumps live in footsteps.ts;
// the pause muffle is in graph.ts.

import type { GameEvents } from '../core/events.ts';
import type { PlayerState } from '../core/player.ts';
import type { SynthRequest } from './dsp/dispatch.ts';
import type { AudioEnv } from './env.ts';
import { Ambience } from './ambience.ts';
import { startLoop } from './voice.ts';

const BREATH_GAIN = 0.55;
const BREATH_BASE_HZ = 1 / 3.2; // the breath bed's cycle
const RUSTLE_GAIN = 0.35;
/** Yaw rate (rad/s) below which turning makes no cloth sound, the span over which it reaches full share, the cap. */
const YAW_GATE = 4, YAW_SPAN = 4, YAW_SHARE = 0.25;
/** Rustle smoothing (setTargetAtTime tau, s): 150 ms attack, 350 ms release. */
const RUSTLE_ATTACK = 0.15, RUSTLE_RELEASE = 0.35;

export class Foley {
  private readonly env: AudioEnv;
  private breathSrc: AudioBufferSourceNode | null = null;
  private readonly breathGain: GainNode;
  private breathTarget = 0;
  private breathRate = 1;
  private breathRateEntry: ReturnType<AudioEnv['graph']['registerRate']> | null = null;
  private rustleSrc: AudioBufferSourceNode | null = null;
  private readonly rustleGain: GainNode;
  private readonly rustleFilter: BiquadFilterNode;
  private lastYaw = NaN;
  private lastCrouch = 0;
  private crouchKick = 0;
  private lastRustle = -1;
  private yawSm = 0;
  private stepKick = 0;

  reset(): void {
    this.lastYaw = NaN;
    this.lastRustle = -1;
    this.lastCrouch = this.crouchKick = this.stepKick = this.yawSm = this.breathTarget = 0;
    this.breathGain.gain.setTargetAtTime(0, this.env.ctx.currentTime, 0.05);
    this.rustleGain.gain.setTargetAtTime(0, this.env.ctx.currentTime, 0.05);
  }

  constructor(env: AudioEnv) {
    this.env = env;
    const ctx = env.ctx;
    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0;
    this.breathGain.connect(env.graph.buses.foley);
    this.rustleFilter = ctx.createBiquadFilter();
    this.rustleFilter.type = 'bandpass';
    this.rustleFilter.frequency.value = 1800;
    this.rustleFilter.Q.value = 0.5;
    this.rustleGain = ctx.createGain();
    this.rustleGain.gain.value = 0;
    this.rustleFilter.connect(this.rustleGain).connect(env.graph.buses.foley);
  }

  static requests(): SynthRequest[] {
    return [Ambience.bedRequest('breath'), { op: 'rustle', seconds: 4, seed: 1 }];
  }

  onBreath(e: GameEvents['breath']): void {
    const env = this.env;
    let rate = Number.isFinite(e.rate) ? e.rate : 0;
    if (rate > 5) rate /= 60; // tolerate breaths-per-minute
    this.breathTarget = BREATH_GAIN * Math.min(1, Math.max(0, Number.isFinite(e.depth) ? e.depth : 0));
    this.breathRate = rate > 0 ? Math.min(1.9, Math.max(0.6, rate / BREATH_BASE_HZ)) : 1;
    if (!this.breathSrc && this.breathTarget > 0.005) {
      const buf = env.bank.ensure(Ambience.bedRequest('breath'), 1);
      if (buf) {
        this.breathSrc = startLoop(env.ctx, buf, this.breathGain, this.breathRate, 0.02);
        this.breathRateEntry = env.graph.registerRate(this.breathSrc.playbackRate, this.breathRate);
      }
    }
    const t = env.ctx.currentTime;
    this.breathGain.gain.setTargetAtTime(this.breathTarget, t, 0.6);
    if (this.breathSrc && !env.graph.tapeSilent) this.breathSrc.playbackRate.setTargetAtTime(this.breathRate, t, 1.0);
    if (this.breathRateEntry) this.breathRateEntry.base = this.breathRate;
  }

  /** A footstep: the trouser legs / jacket swish once per step (rhythmic, not a constant hiss). */
  onStep(intensity: number, settle: boolean): void {
    const i = Number.isFinite(intensity) ? Math.min(1.2, Math.max(0.2, intensity)) : 1;
    this.stepKick = Math.max(this.stepKick, (settle ? 0.3 : 0.7) * i);
  }

  /** Every frame. */
  frame(p: PlayerState, dt: number): void {
    const env = this.env;
    if (dt <= 0) return;
    let yawRate = 0;
    if (Number.isFinite(this.lastYaw)) {
      let d = p.camYaw - this.lastYaw;
      if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
      yawRate = Math.abs(d) / dt;
    }
    this.lastYaw = p.camYaw;
    const dc = Math.abs(p.crouch - this.lastCrouch) / dt;
    this.lastCrouch = p.crouch;
    this.crouchKick = Math.max(this.crouchKick * Math.exp(-dt / 0.25), Math.min(1, dc * 0.6));
    // mouse deltas arrive in bursts: smooth the yaw rate over ~60 ms before gating it
    const k = 1 - Math.exp(-dt / 0.06);
    this.yawSm += (Math.min(40, yawRate) - this.yawSm) * k;
    const yawDrive = Math.min(1, Math.max(0, (this.yawSm - YAW_GATE) / YAW_SPAN)) * YAW_SHARE;
    const walk = Math.min(1, Math.max(0, p.speed) / 3.2);
    this.stepKick *= Math.exp(-dt / 0.16);
    const target = RUSTLE_GAIN * Math.min(1.2, walk * (0.2 + 0.5 * this.stepKick) + this.crouchKick * 0.9 + yawDrive);
    if (!this.rustleSrc) {
      if (target < 0.01) return;
      const buf = env.bank.ensure({ op: 'rustle', seconds: 4, seed: 1 }, 2);
      if (!buf) return;
      this.rustleSrc = startLoop(env.ctx, buf, this.rustleFilter, 1, 0.3);
    }
    if (Math.abs(target - this.lastRustle) > 0.004) {
      const tau = target > this.lastRustle ? RUSTLE_ATTACK : RUSTLE_RELEASE;
      this.lastRustle = target;
      this.rustleGain.gain.setTargetAtTime(target, env.ctx.currentTime, tau);
    }
  }
}
