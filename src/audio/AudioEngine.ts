// src/audio/AudioEngine.ts — WP13 audio system facade (graph, voices, propagation, reverb, ambience, dread).
//
// Nothing touches Web Audio until start() (Enter, or `autostart`; `noaudio=1` never calls it). start() creates a
// 48 kHz AudioContext and the graph, queues every buffer on the DSP worker (hum, room tone and the zone bed first,
// awaited with a timeout; the rest streams in behind) and resumes the context.
// update() (frame loop step 9) runs:
//   every frame  listener pose, flicker automation of hum voices, flicker transients (30 ms look-ahead), wade bed,
//                ambient event clock, dread director, foley
//   5 Hz         Dijkstra propagation, re-resolve hum / emitter / one-shot voices, emitter pool
//   10 Hz        hum voice allocation + hum bed
//   4 Hz         room probe -> RT60 -> IR / pre-delay / wet, zone beds
// Interface sounds (GameBus 'ui') play on the ui bus whenever the context is running (uiSounds.ts).
// Periodic tasks run on the AudioContext clock (they keep running under time=/freeze=, stop when suspended).

import type { GameBus } from '../core/events.ts';
import { SurfaceSound, type MoodId, type ZoneId } from '../core/ids.ts';
import type { PlayerState } from '../core/player.ts';
import type { QualityConfig } from '../core/quality.ts';
import { hash1, Rng } from '../core/rng.ts';
import type { AudioStats, AudioSystem, LightingRuntime, WorldQuery } from '../core/runtime.ts';
import type { FlickerMode, Settings } from '../core/settings.ts';
import { Ambience } from './ambience.ts';
import { BufferBank } from './bank.ts';
import type { SynthRequest } from './dsp/dispatch.ts';
import { Dread } from './dread.ts';
import { Emitters } from './emitters.ts';
import type { AudioEnv } from './env.ts';
import { FixtureSfx } from './fixtureSfx.ts';
import { Foley } from './foley.ts';
import { Footsteps } from './footsteps.ts';
import { AudioGraph, type OutputMeter } from './graph.ts';
import { HumVoices } from './humVoices.ts';
import { OneShots } from './oneShots.ts';
import { Reverb } from './reverb.ts';
import { Spatializer } from './spatial.ts';
import { UiSounds } from './uiSounds.ts';
import { zoneAudio } from './zoneAudio.ts';

const SAMPLE_RATE = 48000;
const RECENT_MAX = 48;
const PROP_DT = 0.2; // 5 Hz
const ALLOC_DT = 0.1; // 10 Hz
const PROBE_DT = 0.25; // 4 Hz
const START_WAIT_MS = 2500;
const METER_DT = 10; // output-level report period (s, AudioContext clock)

/** AudioStats plus the output meter (extra fields, still assignable to the §4 AudioStats contract): RMS / peak of the
 * post-limiter output over the last METER_DT window in dBFS (-120 = silence or not measured yet). */
export interface AudioStatsEx extends AudioStats { outRmsDb: number; outPeakDb: number }

interface Systems {
  ctx: AudioContext;
  env: AudioEnv;
  graph: AudioGraph;
  bank: BufferBank;
  spatial: Spatializer;
  hum: HumVoices;
  fixtures: FixtureSfx;
  foot: Footsteps;
  reverb: Reverb;
  shots: OneShots;
  amb: Ambience;
  emitters: Emitters;
  dread: Dread;
  foley: Foley;
  ui: UiSounds;
}

export function createAudioSystem(bus: GameBus, settings: Settings, q: QualityConfig): AudioSystem {
  let sys: Systems | null = null;
  let starting: Promise<void> | null = null;
  let disposed = false;
  let quality: QualityConfig = q;
  let volumes: Settings['volume'] = { ...settings.volume };
  /** the user's Master slider as last set in the settings (App fades `volumes.master` for the title silence; the ui
   * bus follows this one so Master = 0 mutes the menu sounds too) */
  let userMaster = settings.volume.master;
  let mains: 50 | 60 = settings.mainsHz === 50 ? 50 : 60;
  let flickerMode: FlickerMode = settings.flicker;
  let paused = false;
  const recent: string[] = [];
  let lastT = 0;
  const log = (msg: string): void => {
    recent.push(`${lastT.toFixed(1)}s ${msg}`);
    if (recent.length > RECENT_MAX) recent.shift();
  };
  const stats: AudioStatsEx = { state: 'none', voices: 0, rt60: 0, ir: -1, outRmsDb: -120, outPeakDb: -120 };
  const meter: OutputMeter = { n: 0, rmsDb: -120, peakDb: -120, nonFinite: 0 };
  // periodic task clocks (AudioContext time)
  let nextProp = 0, nextAlloc = 0.05, nextProbe = 0.1, nextMeter = METER_DT / 2;
  let lastWorld: WorldQuery | null = null;
  let lastPlayer: PlayerState | null = null;
  let lastZone = -1;
  let lastMood = 0;
  // listener pose cache (only touch AudioParams when it moved)
  const lp = new Float64Array(9).fill(NaN);

  // ---------------------------------------------------------------- bus wiring (events arrive before start too)
  const offs: (() => void)[] = [];
  offs.push(bus.on('footstep', (e) => { if (sys) { sys.foot.onFootstep(e); sys.foley.onStep(e.intensity, e.settle); } }));
  offs.push(bus.on('land', (e) => { if (sys) sys.foot.onLand(e); }));
  offs.push(bus.on('breath', (e) => { if (sys) sys.foley.onBreath(e); }));
  offs.push(bus.on('lightToggle', (e) => { if (sys) sys.fixtures.onToggle(e.lightId, e.on, e.x, e.y, e.z); }));
  offs.push(bus.on('flashlight', (e) => { if (sys) sys.shots.onFlashlight(e.on); }));
  offs.push(bus.on('transition', (e) => { if (sys) sys.shots.onTransition(e); }));
  offs.push(bus.on('spark', (e) => { if (sys) sys.shots.onSpark(e); }));
  offs.push(bus.on('interact', (e) => { if (sys) sys.shots.onInteract(e); }));
  offs.push(bus.on('glitch', () => { if (sys) sys.dread.onGlitch(); }));
  offs.push(bus.on('ui', (e) => {
    if (sys && sys.ui.play(e.name) && e.name !== 'hover') log(`ui ${e.name}`);
  }));
  offs.push(bus.on('teleport', () => { nextProp = nextAlloc = nextProbe = 0; }));
  offs.push(bus.on('storeyChanged', () => { nextProp = nextAlloc = nextProbe = 0; }));
  offs.push(bus.on('settingsChanged', (s) => {
    userMaster = s.volume.master;
    api.setVolumes(s.volume);
    if (s.flicker !== flickerMode) api.setFlickerMode(s.flicker);
    const m: 50 | 60 = s.mainsHz === 50 ? 50 : 60;
    if (m !== mains) setMains(m);
  }));

  function setMains(m: 50 | 60): void {
    mains = m;
    if (!sys) return;
    sys.env.mains = m;
    for (const r of HumVoices.requests(m)) void sys.bank.request(r, 0).catch(() => undefined);
    for (const r of FixtureSfx.requests(m)) void sys.bank.request(r, 1).catch(() => undefined);
    sys.hum.setMains(m);
    sys.fixtures.setMains(m);
    sys.emitters.stopAll(0.3);
    log(`mains ${m} Hz`);
  }

  function build(): Systems {
    let ctx: AudioContext;
    try { ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' }); }
    catch { ctx = new AudioContext(); }
    const graph = new AudioGraph(ctx, volumes, userMaster);
    const bank = new BufferBank(ctx);
    const spatial = new Spatializer();
    const env: AudioEnv = {
      ctx, graph, bank, spatial, rng: new Rng(hash1(0x5eed13)), hrtf: quality.hrtf, mains, flickerMode, paused,
      t: 0, now: 0, lx: 0, ly: 1.6, lz: 0, log, voices: 0,
    };
    const hum = new HumVoices(env, quality.humVoices);
    const fixtures = new FixtureSfx(env, hum);
    const foot = new Footsteps(env);
    const reverb = new Reverb(env);
    const shots = new OneShots(env);
    const amb = new Ambience(env, shots);
    const emitters = new Emitters(env);
    shots.emitters = emitters;
    const dread = new Dread(env, foot, shots);
    const foley = new Foley(env);
    const ui = new UiSounds(env);
    graph.setPaused(paused);
    void graph.calibrate();
    return { ctx, env, graph, bank, spatial, hum, fixtures, foot, reverb, shots, amb, emitters, dread, foley, ui };
  }

  /** Queue every buffer; resolve when the essentials (hum, room tone, the current zone bed) are ready. */
  function preload(s: Systems): Promise<unknown> {
    const b = s.bank;
    const essentials: Promise<AudioBuffer>[] = [];
    const zone = lastWorld && lastPlayer ? lastWorld.zoneAt(lastPlayer.x, lastPlayer.z) : 0;
    const surf = lastPlayer ? lastPlayer.surface : SurfaceSound.CARPET;
    // longest jobs first so the workers finish together
    for (const l of zoneAudio(zone).beds) essentials.push(b.request(Ambience.bedRequest(l.kind), 0));
    essentials.push(b.request(Ambience.bedRequest('roomTone'), 0));
    for (const r of HumVoices.requests(mains).slice(0, 4)) essentials.push(b.request(r, 0));
    const rest: [SynthRequest[], number][] = [
      [Footsteps.requests(surf).slice(0, 8), 0],
      [Reverb.requests(), 1],
      [FixtureSfx.requests(mains), 1],
      [HumVoices.requests(mains).slice(4), 1],
      [Footsteps.requests(surf).slice(8), 2],
      [OneShots.requests(), 2],
      [Foley.requests(), 3],
      [Ambience.requests(), 4],
    ];
    for (const [reqs, pri] of rest) for (const r of reqs) void b.request(r, pri).catch(() => undefined);
    const all = Promise.all(essentials).catch(() => undefined);
    return Promise.race([all, new Promise((res) => setTimeout(res, START_WAIT_MS))]);
  }

  function setListener(s: Systems, p: PlayerState): void {
    const x = p.eyeX, y = p.eyeY, z = p.eyeZ;
    const cy = Math.cos(p.camYaw), sy = Math.sin(p.camYaw), cp = Math.cos(p.camPitch), sp = Math.sin(p.camPitch);
    const fx = -sy * cp, fy = sp, fz = -cy * cp;
    const ux = sy * sp, uy = cp, uz = cy * sp;
    s.env.lx = x; s.env.ly = y; s.env.lz = z;
    s.spatial.setListener(x, y, z);
    if (Math.abs(x - lp[0]) + Math.abs(y - lp[1]) + Math.abs(z - lp[2]) + Math.abs(fx - lp[3]) + Math.abs(fy - lp[4]) + Math.abs(fz - lp[5]) < 1e-4) return;
    lp[0] = x; lp[1] = y; lp[2] = z; lp[3] = fx; lp[4] = fy; lp[5] = fz;
    const L = s.ctx.listener;
    const t = s.ctx.currentTime;
    if (L.positionX !== undefined) {
      const tau = 0.012;
      L.positionX.setTargetAtTime(x, t, tau); L.positionY.setTargetAtTime(y, t, tau); L.positionZ.setTargetAtTime(z, t, tau);
      L.forwardX.setTargetAtTime(fx, t, tau); L.forwardY.setTargetAtTime(fy, t, tau); L.forwardZ.setTargetAtTime(fz, t, tau);
      L.upX.setTargetAtTime(ux, t, tau); L.upY.setTargetAtTime(uy, t, tau); L.upZ.setTargetAtTime(uz, t, tau);
    } else {
      L.setPosition(x, y, z);
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  const api: AudioSystem = {
    start(): Promise<void> {
      if (disposed) return Promise.resolve();
      if (starting) return starting.then(() => sys ? sys.ctx.resume().catch(() => undefined) : undefined);
      starting = (async (): Promise<void> => {
        const s = build();
        sys = s;
        stats.state = s.ctx.state;
        s.ctx.onstatechange = (): void => { stats.state = s.ctx.state; };
        const resumed = s.ctx.resume().catch(() => undefined);
        const t0 = performance.now();
        await preload(s);
        await resumed;
        stats.state = s.ctx.state;
        log(`audio started (${s.ctx.sampleRate} Hz, ${s.ctx.state}, essentials ${Math.round(performance.now() - t0)} ms)`);
        nextProp = nextAlloc = nextProbe = 0;
        nextMeter = s.ctx.currentTime + METER_DT / 2;
      })();
      return starting;
    },

    update(t: number, dt: number, player: PlayerState, world: WorldQuery, lighting: LightingRuntime): void {
      lastWorld = world;
      lastPlayer = player;
      lastT = t;
      const s = sys;
      if (!s || disposed) return;
      const env = s.env;
      const now = s.ctx.currentTime;
      env.t = t;
      env.now = now;
      setListener(s, player);
      s.foot.setPlayer(player);
      s.shots.world = world;

      if (now >= nextProp) {
        nextProp = now + PROP_DT;
        s.spatial.update(world);
        s.hum.resolveAll();
        s.emitters.update(world);
        s.shots.resolveAll();
      }
      if (now >= nextAlloc) {
        nextAlloc = now + ALLOC_DT;
        if (s.spatial.version > 0) s.hum.allocate(world, lighting);
        stats.voices = s.hum.activeCount + s.emitters.activeCount + s.shots.count + s.amb.activeCount;
      }
      if (now >= nextProbe) {
        nextProbe = now + PROBE_DT;
        const zone = world.zoneAt(player.x, player.z);
        const mood = world.moodAt(player.x, player.z);
        s.reverb.probe(world, player.x, player.y, player.z, zone);
        s.amb.refresh(zone, mood);
        lastZone = zone;
        lastMood = mood;
        stats.rt60 = Math.round(s.reverb.rt60 * 1000) / 1000;
        stats.ir = s.reverb.irIndex;
        if (s.ctx.state === 'running') s.graph.sampleMeter();
        if (now >= nextMeter) {
          nextMeter = now + METER_DT;
          s.graph.takeMeter(meter);
          if (meter.n > 0) {
            stats.outRmsDb = Math.round(meter.rmsDb * 10) / 10;
            stats.outPeakDb = Math.round(meter.peakDb * 10) / 10;
            log(`output rms ${stats.outRmsDb} dBFS, peak ${stats.outPeakDb} dBFS`);
            if (meter.nonFinite > 0 || meter.peakDb > 0) log(`output WARNING: ${meter.nonFinite} non-finite samples, peak ${stats.outPeakDb} dBFS`);
          }
        }
      } else s.reverb.applyIR();

      s.hum.frame(lighting);
      s.fixtures.frame(dt);
      s.amb.wade(player.speed, player.waterDepth);
      s.amb.events(t, dt);
      if (lastZone >= 0) s.dread.update(t, dt, player, world, lastZone as ZoneId, lastMood as MoodId);
      s.foley.frame(player, dt);
      stats.state = s.ctx.state;
    },

    setVolumes(v: Settings['volume']): void {
      volumes = { ...v };
      if (sys) sys.graph.setVolumes(volumes, userMaster);
    },

    setFlickerMode(m: FlickerMode): void {
      flickerMode = m;
      if (sys) sys.env.flickerMode = m;
    },

    setPaused(p: boolean): void {
      paused = p;
      if (sys) { sys.env.paused = p; sys.graph.setPaused(p); }
    },

    setQuality(nq: QualityConfig): void {
      const hrtfChanged = nq.hrtf !== quality.hrtf;
      quality = nq;
      if (!sys) return;
      sys.env.hrtf = nq.hrtf;
      sys.hum.setMaxVoices(nq.humVoices);
      if (hrtfChanged) { sys.hum.setHrtf(nq.hrtf); sys.emitters.setHrtf(nq.hrtf); }
      nextAlloc = 0;
    },

    stats(): AudioStats {
      if (sys) stats.state = sys.ctx.state;
      return stats;
    },

    recentEvents(): string[] {
      return recent.slice();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const off of offs) off();
      const s = sys;
      sys = null;
      if (s) {
        s.hum.dispose();
        s.emitters.stopAll(0.05);
        s.shots.stopAll();
        s.amb.stopAll();
        s.graph.dispose();
        s.bank.dispose();
        void s.ctx.close().catch(() => undefined);
      }
      stats.state = 'closed';
      stats.voices = 0;
    },
  };
  return api;
}
