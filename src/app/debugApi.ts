// src/app/debugApi.ts (WP14) — window.__backrooms: the full §7.2 BackroomsDebugAPI surface, plus the capture
// contract v2 (captureGate 2, whenReady, load, frames: core/debug.ts).

import type { BackroomsDebugAPI, DebugStats, ImageStats, LayerAlbedoReport, LoadResult, MemoryStats } from '../core/debug.ts';
import type { GameEvents } from '../core/events.ts';
import { DEBUG_VIEW_NAMES, MOOD_NAMES, SURFACE_NAMES, ZONE_NAMES } from '../core/ids.ts';
import { worldToCell, worldToChunk } from '../core/grid.ts';
import type { QualityName } from '../core/quality.ts';
import { QUALITY_NAMES } from '../core/quality.ts';
import type { FlickerMode } from '../core/settings.ts';
import type { WorldGen } from '../core/world.ts';
import { createWorldGen } from '../world/worldgen.ts';
import { getCaptureControl, getStreamTiming } from '../stream/ChunkStreamer.ts';
import { flicker, flickerEvents, type FlickerEvent, type FlickerSample } from '../core/flicker.ts';
import { LightState } from '../core/ids.ts';
import type { AppCore } from './appState.ts';
import { runAutowalk, runWalk } from './autowalk.ts';
import { computeImageStats, cropRGBA } from './imageStats.ts';
import { teleportPlayer } from './loop.ts';
import { createPerfRecorder } from './perf.ts';
import { createGpuProfiler, hookAll } from './gpuProfile.ts';
import { postInternals } from '../post/PostStack.ts';
import { asciiAround, cellInfoAt } from './worldDebug.ts';
import type { WaterRippleStats } from '../materials/water/WaterRipples.ts';
import { gotoStoreyOrder } from './urlParams.ts';

export const APP_VERSION = '1.0.0';
/** Capture contract version (core/debug.ts BackroomsDebugAPI.captureGate). */
export const CAPTURE_GATE_VERSION = 2;
export const CAPTURE_W = 160;
export const CAPTURE_H = 90;
const EVENT_LOG_SIZE = 200;

/** Operations the debug API delegates to the app shell. */
export interface DebugHost {
  setQuality(q: QualityName): Promise<void>;
  setFlicker(mode: FlickerMode): void;
  newSeed(seed: string): Promise<void>;
  /** a whole shot in place (App.ts) */
  load(search: string): Promise<LoadResult>;
}

const EVENT_NAMES: readonly (keyof GameEvents)[] = [
  'footstep', 'land', 'breath', 'lightToggle', 'flashlight', 'zoneChanged', 'storeyChanged', 'transition', 'anomaly',
  'glitch', 'spark', 'interact', 'tileLoaded', 'tileUnloaded', 'chunkLoaded', 'chunkUnloaded', 'teleport',
  'settingsChanged', 'pause', 'ready', 'ui',
];

const round = (v: number, d = 3): number => {
  const k = 10 ** d;
  return Math.round(v * k) / k;
};

function describe(name: keyof GameEvents, e: unknown): string {
  if (name === 'settingsChanged') return 'settingsChanged';
  try {
    return `${name} ${JSON.stringify(e, (_k, v: unknown) => (typeof v === 'number' ? round(v) : v))}`;
  } catch {
    return String(name);
  }
}

export interface DebugApiHandle {
  api: BackroomsDebugAPI;
  /** records a line into the events() log (worker errors, app notes) */
  log(line: string): void;
  /** empties the events() log (a new shot in place starts with a fresh page's log) */
  resetLog(): void;
}

export function createDebugApi(core: AppCore, host: DebugHost): DebugApiHandle {
  const log: string[] = [];
  const push = (line: string): void => {
    log.push(`${core.clock.t.toFixed(2)} ${line}`);
    if (log.length > EVENT_LOG_SIZE) log.splice(0, log.length - EVENT_LOG_SIZE);
  };
  for (const name of EVENT_NAMES) core.bus.on(name, (e: unknown) => push(describe(name, e)));

  let gen: WorldGen | null = null;
  let genInit: object | null = null;
  const worldGen = (): WorldGen | null => {
    const s = core.sys;
    if (!s) return null;
    if (!gen || genInit !== s.init) { gen = createWorldGen(s.init.opts); genInit = s.init; }
    return gen;
  };
  const need = <T>(what: string, f: (sys: NonNullable<AppCore['sys']>) => T): T => {
    const s = core.sys;
    if (!s) throw new Error(`${what}: the app has not booted yet`);
    return f(s);
  };

  const memory = (): MemoryStats => {
    const s = core.sys;
    const m = s ? getStreamTiming(s.streamer)?.memory() ?? null : null;
    const pm = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return {
      heapMB: pm ? Math.round(pm.usedJSHeapSize / 2 ** 20) : null,
      texBytes: m?.texBytes ?? 0, geoBytes: m?.geoBytes ?? 0, pooledBytes: m?.texPooledBytes ?? 0,
    };
  };

  const stats = (): DebugStats => {
    const s = core.sys;
    const r = core.renderer;
    const st = s?.player.state;
    const ss = s?.streamer.stats();
    const ri = r?.info;
    const fs = core.frameStats.summary();
    let dyn = 0;
    // each tile's own dynamic light is slot 0 (DYN_SLOT_OFFSETS[0] = [0, 0]); slots 1-8 are neighbours' copies
    if (s) for (const t of s.streamer.tiles()) if (t.dynLights[0]) dyn++;
    const q = s?.streamer.query;
    const cap = s ? getCaptureControl(s.streamer) : null;
    const gate = cap && core.params.bake === 'full' ? cap.stats() : null;
    const loaded = !!(st && q && q.isLoaded(st.x, st.z));
    const a = s && core.params.audio ? s.audio.stats() : null;
    return {
      version: APP_VERSION, seed: core.params.seedText, quality: s?.q.name ?? 'medium',
      renderScale: s ? s.post.renderScale : 1, readyPhase: core.debug.readyPhase, ready: core.debug.ready,
      fps: round(fs.fps, 1),
      frameMs: { avg: round(fs.avg, 2), p95: round(fs.p95, 2), max: round(fs.max, 2), max5s: round(fs.max5s, 2) },
      cpuMs: round(fs.cpuMs, 2), gpuMs: core.gpu?.ms != null ? round(core.gpu.ms, 2) : null,
      render: {
        drawCalls: ri?.render.calls ?? 0, triangles: ri?.render.triangles ?? 0, programs: ri?.programs?.length ?? 0,
        textures: ri?.memory.textures ?? 0, texturesPooled: ss?.texturesPooled ?? 0, geometries: ri?.memory.geometries ?? 0,
      },
      chunks: { resident: ss?.chunksResident ?? 0, desired: ss?.chunksDesired ?? 0, layoutsPending: ss?.layoutsPending ?? 0 },
      tiles: {
        resident: ss?.tilesResident ?? 0, preview: ss?.tilesPreview ?? 0, full: ss?.tilesFull ?? 0, queued: ss?.queued ?? 0,
        inFlight: ss?.inFlight ?? 0, uploadsPending: ss?.uploadsPending ?? 0, fadingIn: ss?.fadingIn ?? 0,
        otherStoreys: ss?.tilesOtherStoreys ?? 0,
        ...(gate ? { gate: gate.gateTiles, gateReady: gate.gateReady, scope: gate.scope } : {}),
      },
      workers: { count: ss?.workers ?? 0, busy: ss?.workersBusy ?? 0 },
      bake: { lastMs: round(ss?.bakeLastMs ?? 0, 1), avgMs: round(ss?.bakeAvgMs ?? 0, 1), buildAvgMs: round(ss?.buildAvgMs ?? 0, 1) },
      player: {
        s: st?.s ?? 0, x: round(st?.x ?? 0), y: round(st?.y ?? 0), z: round(st?.z ?? 0),
        yaw: round(st?.yaw ?? 0, 4), pitch: round(st?.pitch ?? 0, 4),
        zone: loaded && q && st ? ZONE_NAMES[q.zoneAt(st.x, st.z)] ?? '' : '',
        mood: loaded && q && st ? MOOD_NAMES[q.moodAt(st.x, st.z)] ?? '' : '',
        surface: st ? SURFACE_NAMES[st.surface] ?? String(st.surface) : '',
        cell: st ? [worldToCell(st.x), worldToCell(st.z)] : [0, 0],
        chunk: st ? [worldToChunk(st.x), worldToChunk(st.z)] : [0, 0],
        onGround: st?.onGround ?? true, fly: st?.fly ?? false,
      },
      exposure: s
        ? { ev100: round(s.post.exposure.ev100, 3), value: s.post.exposure.value, locked: s.post.exposure.locked }
        : { ev100: 0, value: 0, locked: false },
      lights: { dynamicResident: dyn, flickerMode: core.flickerMode },
      audio: a ? { state: a.state, voices: a.voices, rt60: round(a.rt60, 3) } : null,
      timeFrozen: core.clock.frozen,
      warnings: [...core.params.warnings, ...core.warnings],
      errors: [...core.errors],
      memory: memory(),
    };
  };

  const api: BackroomsDebugAPI = {
    ready: false,
    isReady: () => api.ready,
    captureGate: CAPTURE_GATE_VERSION,
    whenReady() {
      if (api.ready) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const off = core.bus.on('ready', () => { off(); resolve(); });
      });
    },
    load: (search) => host.load(String(search ?? '')),
    frames(n) {
      const k = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
      if (k === 0 || !core.sys) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let left = k;
        core.hooks.push(() => {
          if (--left > 0) return false;
          resolve();
          return true;
        });
      });
    },
    readyPhase: 'boot',
    version: APP_VERSION,
    get seed() { return core.params.seedText; },
    newSeed: (seed) => host.newSeed(seed),
    stats,
    teleport: (t) => teleportPlayer(core, t),
    async goto(target) {
      const s = need('goto', (x) => x);
      const st = s.player.state;
      const q = String(target);
      let sp = null;
      for (const gs of gotoStoreyOrder(q, st.s, core.params.forceZone)) {
        sp = await s.streamer.findNearest(q, { s: gs, x: st.x, z: st.z }, 24);
        if (sp) break;
      }
      if (!sp) return false;
      await teleportPlayer(core, { x: sp.x, z: sp.z, s: sp.s, yaw: sp.yaw, pitch: sp.pitch });
      return true;
    },
    look(yaw, pitch) {
      const s = core.sys;
      if (!s || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
      const st = s.player.state;
      const p = Math.max(-1.5, Math.min(1.5, pitch));
      st.yaw = yaw; st.pitch = p; st.camYaw = yaw; st.camPitch = p;
    },
    async setQuality(q) {
      if (!QUALITY_NAMES.includes(q)) { core.warn(`setQuality: unknown preset '${String(q)}'`); return; }
      await host.setQuality(q);
    },
    setView(v) {
      const i = DEBUG_VIEW_NAMES.indexOf(String(v).toLowerCase());
      if (i < 0) { core.warn(`setView: unknown view '${String(v)}'`); return; }
      core.sys?.materials.setDebugView(i);
    },
    setTime(t) {
      if (t === null) core.clock.set(null);
      else if (Number.isFinite(t)) {
        core.clock.set(t);
        core.sys?.post.snapExposure(); // §7.1 time=: freeze at t and snap exposure (deterministic captures)
      }
    },
    setExposure(ev) { core.sys?.post.setExposureLock(ev === null || !Number.isFinite(ev) ? null : ev); },
    setFlashlight(on) { core.sys?.lighting.flashlight.set(!!on); },
    setPost(p) { core.sys?.post.setEnabled(p); },
    setFlicker(mode) {
      if (mode !== 'standard' && mode !== 'reduced' && mode !== 'off') { core.warn(`setFlicker: unknown mode '${String(mode)}'`); return; }
      host.setFlicker(mode);
    },
    waitForIdle(timeoutMs = 15000) {
      const s = core.sys;
      if (!s) return Promise.resolve(false);
      const deadline = performance.now() + Math.max(0, timeoutMs);
      return new Promise<boolean>((resolve) => {
        let calm = 0;
        core.hooks.push(() => {
          if (s.streamer.isIdle()) {
            if (++calm >= 2) { resolve(true); return true; } // idle on two consecutive frames
          } else calm = 0;
          if (performance.now() > deadline) { resolve(false); return true; }
          return false;
        });
      });
    },
    cellAt(x, z) {
      const s = core.sys;
      return s ? cellInfoAt(s.streamer.query, s.streamer.storey, x, z) : null;
    },
    zoneAt(x, z) {
      const s = core.sys;
      if (!s || !s.streamer.query.isLoaded(x, z)) return '';
      return ZONE_NAMES[s.streamer.query.zoneAt(x, z)] ?? '';
    },
    findNearest(query, maxChunks = 24) {
      const s = core.sys;
      if (!s) return Promise.resolve(null);
      const st = s.player.state;
      return s.streamer.findNearest(String(query), { s: st.s, x: st.x, z: st.z }, maxChunks);
    },
    ascii(radiusCells = 24) {
      const s = core.sys;
      if (!s) return '';
      const st = s.player.state;
      return asciiAround(s.streamer.query, st.x, st.z, radiusCells);
    },
    gen: {
      asciiMap(s, cx0, cz0, cx1, cz1) {
        const sys = core.sys;
        if (!sys) return Promise.resolve('');
        return sys.streamer.asciiMap(s, cx0, cz0, cx1, cz1);
      },
      districtAt(s, cx, cz) {
        const g = worldGen();
        if (!g) return { id: 0, zone: '', mood: '' };
        const d = g.districtAt(s, Math.floor(cx), Math.floor(cz));
        return { id: d.id, zone: ZONE_NAMES[d.zone] ?? String(d.zone), mood: MOOD_NAMES[d.mood] ?? String(d.mood) };
      },
    },
    perf(seconds) {
      if (!core.sys) return Promise.reject(new Error('perf: the app has not booted yet'));
      const rec = createPerfRecorder(seconds);
      return new Promise((resolve) => {
        core.hooks.push((frameMs) => {
          const ri = core.renderer?.info.render;
          if (!rec.frame(frameMs, ri?.calls ?? 0, ri?.triangles ?? 0, core.gpu?.lastMs ?? null)) return false;
          resolve(rec.report());
          return true;
        });
      });
    },
    gpuBench(repeats = 20) {
      const s = core.sys;
      const r = core.renderer;
      if (!s || !r) return Promise.reject(new Error('gpuBench: the app has not booted yet'));
      const gl = r.getContext() as WebGL2RenderingContext;
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number } | null;
      if (!ext) return Promise.reject(new Error('gpuBench: EXT_disjoint_timer_query_webgl2 unavailable'));
      const k = Math.max(1, Math.min(200, Math.floor(Number.isFinite(repeats) ? repeats : 20)));
      const ROUNDS = 7;
      const results: number[] = [];
      const pending: WebGLQuery[] = [];
      let rounds = 0;
      let waited = 0;
      return new Promise((resolve) => {
        core.hooks.push(() => {
          // between frames: one round = this frame's GPU work (mirror + post stack) k times inside one query
          for (let i = pending.length - 1; i >= 0; i--) {
            const q = pending[i];
            if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
            results.push((gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6 / k);
            gl.deleteQuery(q);
            pending.splice(i, 1);
          }
          if (rounds < ROUNDS) {
            const g = s.materials.globals;
            const waterY = g.reflOn.value > 0.5 ? g.reflY.value : null;
            const q = gl.createQuery() as WebGLQuery;
            gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
            for (let i = 0; i < k; i++) {
              // package D: the probe's steady state (one face captured and re-filtered every PROBE.STEADY_EVERY frames)
              s.probe.update(r, core.scene, core.camera, s.streamer.query, s.player.state, s.features.probe);
              s.reflection.update(r, core.scene, core.camera, waterY);
              s.post.render(0, core.clock.t);
            }
            gl.endQuery(ext.TIME_ELAPSED_EXT);
            pending.push(q);
            rounds++;
            return false;
          }
          if (pending.length > 0 && ++waited < 120) return false;
          for (const q of pending) gl.deleteQuery(q);
          results.sort((x, y) => x - y);
          resolve({
            ms: results.length ? round(results[results.length >> 1], 3) : null, rounds: results.length, repeats: k,
            buffer: [r.domElement.width, r.domElement.height], reflection: s.materials.globals.reflOn.value > 0.5,
          });
          return true;
        });
      });
    },
    gpuProfile(seconds) {
      const s = core.sys;
      const r = core.renderer;
      if (!s || !r) return Promise.reject(new Error('gpuProfile: the app has not booted yet'));
      const prof = createGpuProfiler(r.getContext() as WebGL2RenderingContext);
      const pi = postInternals(s.post);
      if (!prof || !pi) return Promise.reject(new Error('gpuProfile: EXT_disjoint_timer_query_webgl2 unavailable'));
      const dur = Math.max(0.2, Math.min(120, Number.isFinite(seconds) ? seconds : 3)) * 1000;
      return new Promise((resolve) => {
        let unhook: (() => void) | null = null;
        let gpu = core.gpu;
        let elapsed = 0;
        let drain = 0;
        core.hooks.push((frameMs) => {
          if (!unhook && drain === 0) {
            // between frames: suspend the frame timer (its query would enclose the segments), then hook
            gpu = core.gpu;
            core.gpu = null;
            unhook = hookAll(prof, {
              renderer: r, passes: [...pi.passes], finalPass: pi.finalPass, reflection: s.reflection, ripples: s.ripples, probe: s.probe,
            });
            return false;
          }
          prof.poll();
          if (unhook) {
            prof.endFrame();
            elapsed += frameMs;
            if (elapsed < dur) return false;
            unhook();
            unhook = null;
            prof.stop();
            core.gpu = gpu;
          }
          // let the last queries resolve
          if (++drain < 30) return false;
          const rep = prof.report();
          prof.dispose();
          const ri = r.info.render;
          resolve({ ...rep, drawCalls: ri.calls, triangles: ri.triangles, buffer: [r.domElement.width, r.domElement.height] });
          return true;
        });
      });
    },
    async imageStats(rect): Promise<ImageStats> {
      const px = await need('imageStats', (s) => s.post.capture(CAPTURE_W, CAPTURE_H));
      if (!rect) return computeImageStats(px, CAPTURE_W, CAPTURE_H);
      const c = cropRGBA(px, CAPTURE_W, CAPTURE_H, rect);
      return computeImageStats(c.data, c.w, c.h);
    },
    autowalk: (o) => runAutowalk(core, o),
    walk: (path, speed) => runWalk(core, path, speed),
    async layerAlbedoCheck(): Promise<LayerAlbedoReport[]> {
      const s = core.sys;
      const r = core.renderer;
      if (!s || !r) return [];
      // QA-only: loaded on demand (keeps the texture-layer checker out of the main bundle)
      const { layerAlbedoCheck } = await import('../textures/albedoCheck.ts');
      return layerAlbedoCheck(r, s.textures);
    },
    audio: {
      stats: () => core.sys?.audio.stats() ?? { state: 'none', voices: 0, rt60: 0, ir: 0 },
      recentEvents: () => core.sys?.audio.recentEvents() ?? [],
    },
    events: () => [...log],
    flickerWindow(after) {
      const s = core.sys;
      if (!s || core.flickerMode === 'off') return null;
      const st = s.player.state;
      const fx = -Math.sin(st.camYaw), fz = -Math.cos(st.camYaw);
      let best: { x: number; y: number; z: number; seed: number } | null = null, bestScore = Infinity;
      for (const t of s.streamer.tiles()) {
        const d = t.dynLights[0];
        if (!d || d.state !== LightState.FLICKER) continue;
        const ex = d.x - st.eyeX, ez = d.z - st.eyeZ, dist = Math.hypot(ex, ez);
        if (dist > 20) continue;
        const cos = dist > 1e-3 ? (ex * fx + ez * fz) / dist : 1;
        if (cos < 0.3) continue;
        const score = dist * (2 - cos); // near and central
        if (score < bestScore) { bestScore = score; best = { x: d.x, y: d.y, z: d.z, seed: d.seed }; }
      }
      if (!best) return null;
      const t0 = after !== undefined && Number.isFinite(after) ? after : core.clock.t;
      const evs: FlickerEvent[] = [];
      const smp: FlickerSample = { i: 1, tint: 0, buzz: 0 };
      // the burst end ('pop') of the first burst that starts after t0 + 1 s; its last slot is LOW (core/flicker.ts)
      for (let a = t0 + 1; a < t0 + 600; a += 16) {
        evs.length = 0;
        flickerEvents(LightState.FLICKER, best.seed, a, a + 16, core.flickerMode, evs);
        const pop = evs.find((e) => e.kind === 'pop');
        if (!pop) continue;
        const low = pop.t - 0.12;
        flicker(LightState.FLICKER, best.seed, low, core.flickerMode, smp);
        const lowLevel = smp.i;
        // walk back to the burst start: the last steady (>= 0.98) moment before it
        let high = low;
        for (let k = 0; k < 200; k++) {
          high -= 0.05;
          flicker(LightState.FLICKER, best.seed, high, core.flickerMode, smp);
          if (smp.i >= 0.98) {
            // 0.25 s earlier: clear of a micro-drop at the burst edge
            flicker(LightState.FLICKER, best.seed, high - 0.25, core.flickerMode, smp);
            if (smp.i >= 0.98) { high -= 0.25; break; }
          }
        }
        if (lowLevel > 0.8) continue; // a shallow burst: look for a deeper one
        return { x: best.x, y: best.y, z: best.z, high: Math.round(high * 1000) / 1000, low: Math.round(low * 1000) / 1000, lowLevel };
      }
      return null;
    },
  };
  // package E: __backrooms.water, the ripple simulation (time= freezes it: poke, then step to see rings)
  const water: WaterDebugApi = {
    poke(dx, dz, amp = 1) { core.sys?.ripples.poke(Number(dx) || 0, Number(dz) || 0, Number.isFinite(amp) ? amp : 1); },
    step(n) { core.sys?.ripples.step(Number(n) || 0); },
    stats: () => core.sys?.ripples.stats() ?? null,
  };
  (api as BackroomsDebugAPI & { water: WaterDebugApi }).water = water;
  // package D: __backrooms.probe, the reflection probe's anchor, box and captured faces
  const probe: ProbeDebugApi = {
    stats() {
      const p = core.sys?.probe;
      if (!p) return null;
      const r3 = (a: ArrayLike<number>): number[] => Array.from(a, (v) => Math.round(v * 1000) / 1000);
      return {
        valid: p.info.valid, faces: p.info.faces, anchor: r3(p.info.anchor), box: r3(p.info.box),
        cpuMs: r3([p.info.cpuMs])[0], cpuMeanMs: r3([p.info.cpuMeanMs])[0], calls: p.info.calls,
      };
    },
    faces: () => (core.sys && core.renderer ? core.sys.probe.faceMeans(core.renderer) : null),
    enable(on) {
      if (core.sys) core.sys.features.probe = !!on;
    },
  };
  (api as BackroomsDebugAPI & { probe: ProbeDebugApi }).probe = probe;
  return { api, log: push, resetLog: () => { log.length = 0; } };
}

/** __backrooms.probe: stats() = the published anchor and room box (world metres; box = xmin, ymin, zmin, xmax, ymax,
 * zmax), the faces captured by the last update, the main-thread cost (last capture, running mean per frame) and the
 * draw calls of the last captured face; faces() = the mean capture radiance per face (+X, -X, +Y, -Y, +Z, -Z), then
 * the filtered cube along the 6 axes at every mip; enable(on) = the URL probe= toggle at runtime (interleaved A/B
 * timing; the live probe is kept while off and republished when on). */
export interface ProbeDebugApi {
  stats(): { valid: boolean; faces: number; anchor: number[]; box: number[]; cpuMs: number; cpuMeanMs: number; calls: number } | null;
  faces(): number[][] | null;
  enable(on: boolean): void;
}

/** __backrooms.water: poke(dx, dz, amp) queues a footstep-sized impulse x amp at dx m right / dz m ahead of the eye;
 * step(n) runs n 1/60 s steps now; stats() describes the window (plane, kind, origin, steps, drips). */
export interface WaterDebugApi {
  poke(dx: number, dz: number, amp?: number): void;
  step(n: number): void;
  stats(): WaterRippleStats | null;
}
