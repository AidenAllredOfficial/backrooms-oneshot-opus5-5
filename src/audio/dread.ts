// src/audio/dread.ts — the dread director (§5 WP13): rare, gated, never a stinger.
//  * LATE_ECHO anomaly sites: while inside one (r from the site) and moving, the footstep bus gets an extra 350 ms
//    delayed tap; it stops the moment you stop.
//  * "Not your footsteps": only after stillFor >= 20 s in a DARK or DYING mood, with p 0.2 (rolled once per still
//    period) and a 10-minute cooldown: 4-9 steps, 14-22 m away (reachable through the field), each step one cell
//    further from the listener (moving AWAY). They stop if you move.
//  * RINGING_PHONE: handled by the emitter pool (60 m audibility, stops within 3 m).
//  * Glitch (the `glitch` event, emitted only by traversal): tape-stop (playback rate -> 0.3 over 0.4 s), then
//    0.6 s of silence (graph.tapeStop).

import { CELL, CHUNK_CELLS, CHUNK_SIZE } from '../core/constants.ts';
import { AnomalyKind, Mood, type MoodId, type SurfaceSoundId, type ZoneId } from '../core/ids.ts';
import type { PlayerState } from '../core/player.ts';
import type { WorldQuery } from '../core/runtime.ts';
import type { AudioEnv } from './env.ts';
import type { Footsteps } from './footsteps.ts';
import type { OneShots } from './oneShots.ts';
import { zoneAudio } from './zoneAudio.ts';

const STILL_S = 20;
const P_PHANTOM = 0.2;
const COOLDOWN = 600;
const ECHO_LEVEL = 0.42;

export class Dread {
  private readonly env: AudioEnv;
  private readonly foot: Footsteps;
  private readonly shots: OneShots;
  inEcho = false;
  private echoCheckT = 0;
  private prevStill = 0;
  private lastPhantom = -1e9;
  // phantom walker
  private stepsLeft = 0;
  private nextStepT = 0;
  private readonly walker: [number, number] = [0, 0];
  private walkerSurface = 0;
  private walkerGain = 0;
  phantomRuns = 0;

  constructor(env: AudioEnv, foot: Footsteps, shots: OneShots) {
    this.env = env;
    this.foot = foot;
    this.shots = shots;
  }

  update(t: number, dt: number, p: PlayerState, world: WorldQuery, zone: ZoneId, mood: MoodId): void {
    const env = this.env;
    // ---- LATE_ECHO (site check at 2 Hz, tap level every frame)
    if (t - this.echoCheckT >= 0.5 || t < this.echoCheckT) {
      this.echoCheckT = t;
      this.inEcho = this.lateEchoAt(world, p.x, p.z);
    }
    this.foot.setEcho(this.inEcho && p.speed > 0.25 && !env.paused ? ECHO_LEVEL : 0);

    // ---- not your footsteps
    if (dt > 0 && !env.paused) {
      const still = p.stillFor;
      const crossed = this.prevStill < STILL_S && still >= STILL_S;
      this.prevStill = still;
      if (crossed && (mood === Mood.DARK || mood === Mood.DYING) && t - this.lastPhantom >= COOLDOWN && this.stepsLeft === 0) {
        this.lastPhantom = t; // the roll consumes the cooldown only when it fires (below)
        if (env.rng.float() < P_PHANTOM && env.spatial.pickReachable(env.rng, 14, 22, this.walker)) {
          this.stepsLeft = env.rng.int(4, 9);
          this.nextStepT = t + env.rng.range(0.4, 1.2);
          this.walkerSurface = zoneAudio(zone).stepSurface;
          this.walkerGain = 0.55;
          this.phantomRuns++;
          env.log(`dread: footsteps x${this.stepsLeft}, moving away`);
        } else {
          this.lastPhantom = -1e9;
        }
      }
      if (this.stepsLeft > 0) {
        if (still < 0.5) { this.stepsLeft = 0; env.log('dread: footsteps stop (player moved)'); }
        else if (t >= this.nextStepT) this.step(t);
      }
    }
  }

  private step(t: number): void {
    const env = this.env;
    // advance ~0.75 m per step: one cell (1.2 m) on most steps
    if (env.rng.float() < 0.62) env.spatial.stepAway(env.rng, this.walker);
    const req = this.foot.phantomRequest(this.walkerSurface as SurfaceSoundId);
    const ok = this.shots.playAt(req, this.walker[0], 0.05, this.walker[1], this.walkerGain, {
      bus: 'sfx', rate: Math.pow(2, env.rng.range(-40, 40) / 1200),
    });
    if (!ok) env.bank.ensure(req, 0);
    this.walkerGain *= 0.93;
    this.stepsLeft--;
    this.nextStepT = t + env.rng.range(0.5, 0.6);
  }

  private lateEchoAt(world: WorldQuery, x: number, z: number): boolean {
    // chunk derived from the global cell (§2: never from metres directly)
    const cx0 = Math.floor(Math.floor(x / CELL + 1e-7) / CHUNK_CELLS), cz0 = Math.floor(Math.floor(z / CELL + 1e-7) / CHUNK_CELLS);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const l = world.layoutAt(cx0 + dx, cz0 + dz);
      if (!l) continue;
      const ox = (cx0 + dx) * CHUNK_SIZE, oz = (cz0 + dz) * CHUNK_SIZE;
      for (const a of l.anomalies) {
        if (a.kind !== AnomalyKind.LATE_ECHO) continue;
        const ex = ox + a.x - x, ez = oz + a.z - z;
        if (ex * ex + ez * ez <= a.r * a.r) return true;
      }
    }
    return false;
  }

  onGlitch(): void {
    this.env.graph.tapeStop();
    this.stepsLeft = 0;
    this.env.log('glitch: tape stop');
  }
}
