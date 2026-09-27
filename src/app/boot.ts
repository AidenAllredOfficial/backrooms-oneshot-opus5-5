// src/app/boot.ts (WP14) — the initialization sequence (§6.1 steps 3-5), launch toggles (§6.1 step 7) and the
// runtime quality change (§6.4 "setQuality at runtime").

import { TILE_SIZE } from '../core/constants.ts';
import { chunkOriginX, chunkOriginZ, tileOriginX, tileOriginZ, worldToChunk } from '../core/grid.ts';
import type { TileKey } from '../core/grid.ts';
import { createStartupJobs } from '../stream/StartupJobs.ts';
import { basePriority, jobPriority, rectDistance } from '../stream/priorities.ts';
import { ZONE_NAMES } from '../core/ids.ts';
import type { StoreyId } from '../core/ids.ts';
import type { LaunchParams } from '../core/debug.ts';
import { DEBUG_VIEW_NAMES } from '../core/ids.ts';
import { QUALITY, bakeQualityOf } from '../core/quality.ts';
import type { QualityConfig, QualityName } from '../core/quality.ts';
import { hashString } from '../core/rng.ts';
import type { Settings } from '../core/settings.ts';
import type { WorkerInit, WorkerRequest } from '../core/worker.ts';
import type { SpawnPoint } from '../core/world.ts';
import { generateTextures } from '../textures/TextureBaker.ts';
import { generateDetailTextures } from '../textures/DetailBaker.ts';
import { createMaterialSystem } from '../materials/MaterialSystem.ts';
import { createPlanarReflection } from '../materials/PlanarReflection.ts';
import { createWaterRipples } from '../materials/water/WaterRipples.ts';
import { createLightingRuntime } from '../lighting/LightingRuntime.ts';
import { createAnomalyDirector } from '../lighting/anomalyDirector.ts';
import { createPostStack, postInternals } from '../post/PostStack.ts';
import { createScreenSpaceReflections } from '../post/ssr/SsrTrace.ts';
import { collectPassMaterials, warmPassMaterials } from '../materials/warmup.ts';
import { createDynamicResolution } from '../post/DynamicResolution.ts';
import { bootPoolSizeFor, createWorkerPool, poolSizeFor, type WorkerPool } from '../stream/WorkerPool.ts';
import { QUERY_PRIORITY } from '../stream/priorities.ts';
import { createChunkStreamer } from '../stream/ChunkStreamer.ts';
import { createPlayerSystem } from '../player/PlayerSystem.ts';
import type { TraversalHost } from '../player/PlayerSystem.ts';
import { createInput } from '../player/input.ts';
import { createAudioSystem } from '../audio/AudioEngine.ts';
import type { AppCore, FeatureToggles, Systems } from './appState.ts';
import { isResolutionOnlyChange } from './qualityAuto.ts';
import { pixelRatioFor } from './renderer.ts';
import { gotoStoreyOrder } from './urlParams.ts';

/** Loading screen phases (§5 WP14 "Loading": textures, shaders, world, lighting). */
export type LoadPhase = 'textures' | 'shaders' | 'world' | 'lighting';

export interface BootCallbacks {
  phase(p: LoadPhase): void;
  progress(p: LoadPhase, fraction: number): void;
}

/** QUALITY[name] + user overrides (settings) + launch overrides (scale= disables dynamic resolution, radius=). */
export function buildQuality(name: QualityName, s: Settings, p: LaunchParams): QualityConfig {
  const q: QualityConfig = { ...QUALITY[name], ...s.overrides, name };
  if (p.scale !== null) { q.renderScale = p.scale; q.dynamicResolution = false; }
  if (p.radius !== null) q.streamRadius = p.radius;
  return q;
}

/** Film settings with the camcorder=1 launch override applied. */
export function filmOf(core: AppCore): Settings['film'] {
  const f = core.settings.get().film;
  return core.camcorderForced && !f.camcorder ? { ...f, camcorder: true } : f;
}

const machine = (): { hc: number; mem: number | undefined } => {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }) : null;
  return { hc: nav && nav.hardwareConcurrency ? nav.hardwareConcurrency : 4, mem: nav?.deviceMemory };
};

/** Steady-state pool: max(2, min(q.bakeWorkers, hardwareConcurrency - 4, deviceMemory GB)) (WorkerPool poolSizeFor). */
export function poolSize(q: QualityConfig): number {
  const m = machine();
  return poolSizeFor(q, m.hc, m.mem);
}

/** Boot pool: poolSize + 2 until the boot gate is ready (WorkerPool bootPoolSizeFor). */
export function bootPoolSize(q: QualityConfig): number {
  const m = machine();
  return bootPoolSizeFor(q, m.hc, m.mem);
}

/** The graphics-realism feature toggles of a launch (Systems.features). */
export function featuresOf(p: LaunchParams): FeatureToggles {
  return { ssr: p.ssr, probe: p.probe, cs: p.cs, bounce: p.bounce, vol: p.vol, reflView: p.reflView };
}

/** §6.1 step 7.2-7.4: time/freeze, exposure lock, view / flashlight / post toggles. Applied once, at the boot gate. */
export function applyLaunchToggles(core: AppCore): void {
  const s = core.sys;
  if (!s) return;
  const p = core.params;
  if (p.time !== null) core.clock.set(p.time);
  else if (p.freeze) core.clock.freezeNow();
  if (p.exposure !== 'auto') s.post.setExposureLock(p.exposure);
  const v = DEBUG_VIEW_NAMES.indexOf(p.view);
  if (v > 0) s.materials.setDebugView(v);
  if (p.flashlight) s.lighting.flashlight.set(true);
  if (!p.post) {
    s.post.setEnabled({ ao: false, bloom: false, lens: false, grain: false, smaa: false, grade: false });
  } else if (!p.ao || !p.bloom || !p.grain || !p.lens) {
    s.post.setEnabled({ ao: p.ao, bloom: p.bloom, grain: p.grain, lens: p.lens });
  }
  // graphics-realism feature toggles: the owning packages read s.features; the post stack gets ssr and the SSR
  // debug view, the materials the contact-shadow switch
  Object.assign(s.features, featuresOf(p));
  if (!p.ssr) s.post.setEnabled({ ssr: false });
  if (p.reflView !== 'off') s.post.setReflectionDebug?.(p.reflView);
  s.materials.globals.csOn.value = p.cs ? 1 : 0;
}

/** The two one-shot world queries the spawn resolution needs (the streamer's, or the bare pool's during boot). */
export interface SpawnQueries {
  spawn(s: StoreyId): Promise<SpawnPoint>;
  findNearest(query: string, from: { s: StoreyId; x: number; z: number }, maxChunks: number): Promise<SpawnPoint | null>;
}

/** Spawn queries straight on the worker pool (boot: before the streamer exists; no reinit can happen yet). */
export function poolQueries(pool: WorkerPool): SpawnQueries {
  return {
    spawn: (s) => pool.submit<'spawn'>({ t: 'spawn', job: 0, s }, QUERY_PRIORITY).promise.then((r) => r.result),
    findNearest: (query, from, maxChunks) => pool.submit<'find'>(
      { t: 'find', job: 0, query, from: { s: from.s, x: from.x, z: from.z }, maxChunks }, QUERY_PRIORITY,
    ).promise.then((r) => r.result),
  };
}

/** §6.1 step 5.3: explicit x/z, else goto/zone via findNearest (fallback: spawn), else streamer.spawn(s). */
export async function resolveSpawn(core: AppCore, queries: SpawnQueries): Promise<{ sp: SpawnPoint; explicit: boolean }> {
  const p = core.params;
  const s: StoreyId = p.s ?? 0;
  const view = (sp: SpawnPoint): SpawnPoint => ({ ...sp, yaw: p.yaw ?? sp.yaw, pitch: p.pitch ?? sp.pitch });
  if (p.x !== null && p.z !== null) {
    return {
      sp: { s, x: p.x, y: p.y ?? 0, z: p.z, yaw: p.yaw ?? 0, pitch: p.pitch ?? 0, zone: 0, score: 0, reason: 'explicit' },
      explicit: true,
    };
  }
  const base = await queries.spawn(s);
  const query = p.goto ?? (p.zone !== null ? `zone:${ZONE_NAMES[p.zone]}` : null);
  if (query !== null && query !== 'spawn') {
    // no explicit storey: deep zones / landmarks may only exist in another stratum (searched from the same xz)
    const order = p.s !== null ? [s] : gotoStoreyOrder(query, s, p.forceZone);
    for (const gs of order) {
      const found = await queries.findNearest(query, { s: gs, x: base.x, z: base.z }, 24);
      if (found) return { sp: view(found), explicit: false };
    }
    core.warn(`goto: no '${query}' within 24 chunks of the spawn (storey ${order.join('/')}); using the spawn`);
  }
  return { sp: view(base), explicit: false };
}

const mark = (name: string): void => {
  try { performance.mark(`br:${name}`); } catch { /* marks are diagnostics only */ }
};

const dprWatched = new WeakSet<AppCore>();

/**
 * HiDPI (R2 B9): re-apply the pixel ratio when devicePixelRatio changes (the window moved to another monitor, a
 * browser zoom). A `(resolution: Ndppx)` media query fires once when the ratio leaves N, so it is re-armed with the
 * new ratio on every change; resize events are checked too (some browsers only send those). The post stack's base
 * ratio is re-read (post.setQuality with the live preset), then the dynamic-resolution scale is re-applied under
 * the new pixel-ratio cap and every target is re-sized.
 */
export function watchDevicePixelRatio(core: AppCore): void {
  if (dprWatched.has(core) || typeof window === 'undefined') return;
  dprWatched.add(core);
  let applied = devicePixelRatio || 1;
  let mq: MediaQueryList | null = null;
  const onChange = (): void => {
    const dpr = devicePixelRatio || 1;
    if (dpr === applied) return;
    applied = dpr;
    arm();
    const s = core.sys;
    if (!s || innerWidth < 1 || innerHeight < 1) return;
    s.post.setQuality(s.q); // re-reads min(devicePixelRatio, maxDpr) as the render-scale base
    s.dynRes.refreshDpr();
    s.post.setSize(innerWidth, innerHeight);
  };
  const arm = (): void => {
    mq?.removeEventListener('change', onChange);
    mq = typeof matchMedia === 'function' ? matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`) : null;
    mq?.addEventListener('change', onChange);
  };
  arm();
  addEventListener('resize', onChange);
}

/** The worker init message of a launch + preset. */
export function workerInitOf(p: LaunchParams, q: QualityConfig): WorkerInit {
  return {
    opts: {
      seed: hashString(p.seedText), seedText: p.seedText, forceZone: p.forceZone, forceMood: p.forceMood,
      forceLandmark: p.forceLandmark, testScene: p.testScene, lights: p.lights,
    },
    bake: bakeQualityOf(q), bakeTerm: p.bakeTerm, validate: import.meta.env.DEV,
  };
}

/** A worker pool started before the renderer exists (App boot: during the GPU-context priming wait), with the
 * init it was created with. */
export interface EarlyPool { pool: Promise<WorkerPool>; init: WorkerInit }

export function startEarlyPool(p: LaunchParams, q: QualityConfig): EarlyPool {
  const init = workerInitOf(p, q);
  mark('pool');
  const pool = createWorkerPool(bootPoolSize(q), init);
  pool.catch(() => undefined);
  return { pool, init };
}

/** §6.1 steps 3-5. The renderer exists; `q` is resolved. Returns the systems (the loop starts after this).
 * `early`: a pool started during the GPU priming wait; reused when its bake settings match `q`. */
export async function bootSystems(core: AppCore, q: QualityConfig, cb: BootCallbacks, early?: EarlyPool): Promise<Systems> {
  const r = core.renderer;
  if (!r) throw new Error('boot: renderer missing');
  const p = core.params;
  const settings = core.settings.get();

  // The worker pool boots (module load + world generator init in every worker) and resolves the spawn (a find /
  // spawn query generates its chunks) while the main thread builds textures and compiles shaders (R2 B9: ~1 s of
  // the time to ready).
  const init = workerInitOf(p, q);
  let poolP: Promise<WorkerPool>;
  if (early) {
    const same = JSON.stringify(early.init.bake) === JSON.stringify(init.bake);
    poolP = same ? early.pool : early.pool.then(async (pool) => { await pool.reinit(init); return pool; });
  } else {
    mark('pool');
    poolP = createWorkerPool(bootPoolSize(q), init); // shrunk to poolSize(q) at the boot gate (loop.ts)
  }
  const startupP = poolP.then(createStartupJobs);
  const spawnP = startupP.then(async (startup) => {
    mark('poolReady');
    const resolved = await resolveSpawn(core, poolQueries(startup.pool));
    const sp = resolved.sp, cx = worldToChunk(sp.x), cz = worldToChunk(sp.z);
    const jobs: { req: Extract<WorkerRequest, { t: 'layout' | 'build' }>; priority: number }[] = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const key = { s: sp.s, cx: cx + dx, cz: cz + dz };
      const own = dx === 0 && dz === 0, ring = Math.max(Math.abs(dx), Math.abs(dz));
      const distance = rectDistance(sp.x, sp.z, chunkOriginX(key.cx), chunkOriginZ(key.cz), chunkOriginX(key.cx + 1), chunkOriginZ(key.cz + 1));
      jobs.push({ req: { t: 'layout', job: 0, key }, priority: jobPriority(basePriority(ring, true, distance), 'layout', false, own) });
      for (let i = 0; i < 4; i++) {
        const tile: TileKey = { ...key, q: i as TileKey['q'] };
        const x = tileOriginX(tile), z = tileOriginZ(tile);
        const d = rectDistance(sp.x, sp.z, x, z, x + TILE_SIZE, z + TILE_SIZE);
        // A bounded ring, ordered toward the starting view; the live streamer refines priorities.
        const ahead = -(x + TILE_SIZE / 2 - sp.x) * Math.sin(sp.yaw) - (z + TILE_SIZE / 2 - sp.z) * Math.cos(sp.yaw) >= 0;
        // bake 'full' (automation): these are the gate's ring, built with full lighting (ChunkStreamer fullBakeRing)
        const req: Extract<WorkerRequest, { t: 'build' }> = { t: 'build', job: 0, key: tile };
        if (p.bake === 'full') req.lighting = 'full';
        jobs.push({ req, priority: jobPriority(basePriority(ring, ahead, d), 'build', false, own) });
      }
    }
    jobs.sort((a, b) => a.priority - b.priority);
    for (const j of jobs) startup.preload(j.req, j.priority);
    mark('spawnResolved');
    return resolved;
  });
  // awaited below; a rejection before that point must not surface as an unhandled rejection
  poolP.catch(() => undefined);
  spawnP.catch(() => undefined);

  // 3 [textures]
  core.debug.readyPhase = 'textures';
  cb.phase('textures');
  mark('textures');
  const textures = await generateTextures(r, q.textureSize, q.anisotropy, (f) => cb.progress('textures', f));
  // package B: the LEAN detail-map array, only when the preset uses it (generated lazily on a later quality switch)
  if (q.detailMaps && q.shaderDetail !== 'lite') textures.detail = await generateDetailTextures(r, q.anisotropy);
  cb.progress('textures', 1);

  // 4 [shaders]
  core.debug.readyPhase = 'shaders';
  cb.phase('shaders');
  mark('shaders');
  const materials = createMaterialSystem(r, textures, q);
  const lighting = createLightingRuntime(core.scene, materials.globals, textures, q, settings, core.bus);
  lighting.setFlickerMode(core.flickerMode);
  const post = createPostStack(r, core.scene, core.camera, q, settings);
  // the frame graph publishes the pyramid and the pre-shade SSAO into the material globals; presets with split
  // frames compile its quad programs now, not at the first frame with water in view
  const frame = postInternals(post)?.scenePass;
  frame?.bindGlobals(materials.globals);
  if (frame && q.colorPyramidScale > 0) await warmPassMaterials(r, frame.materials);
  post.setSize(innerWidth, innerHeight);
  post.setFilm(filmOf(core), settings.brightnessEV);
  const reflection = createPlanarReflection(materials.globals, q);
  // package D: screen-space reflections on the frame graph (Hi-Z after the prepass, the trace after the opaque render)
  const ssr = createScreenSpaceReflections(q, () => post.renderScale);
  if (frame) ssr.attach(frame);
  if (q.ssr !== 'off') await warmPassMaterials(r, ssr.materials);
  const ripples = createWaterRipples(materials.globals, q, core.bus); // resets itself on teleports / seed changes
  const anomaly = createAnomalyDirector(core.bus, lighting, core.scene);
  cb.progress('shaders', 0.3);
  await materials.warmup(r, core.camera, core.scene);
  cb.progress('shaders', 1);

  // 5 [spawn]
  core.debug.readyPhase = 'spawn';
  cb.phase('world');
  mark('spawn');
  const startup = await startupP;
  const pool = startup.pool;
  const startS: StoreyId = p.s ?? 0;
  // bake 'full' (automation): the ready gate waits for ring 1 fully baked, so those bakes go ahead of the far ring
  const streamer = createChunkStreamer({
    renderer: r, materials, quality: q, init, bus: core.bus, pool, startStorey: startS, fullBakeRing: p.bake === 'full' ? 1 : -1,
  });
  core.scene.add(streamer.scene);
  const { sp: spawn, explicit } = await spawnP;
  mark('spawnReady');
  if (spawn.s !== streamer.storey) streamer.switchStorey(spawn.s);
  const host: TraversalHost = {
    prefetch: (s, x, z, rc) => streamer.prefetch(s, x, z, rc),
    isPrefetched: (s, x, z) => streamer.isPrefetched(s, x, z),
    switchStorey: (to) => streamer.switchStorey(to),
    findSafeSpawn: (s, x, z) => streamer.findNearest('safe', { s, x, z }, 4),
    attachDynamicMesh: (k, m) => streamer.attachDynamicMesh(k, m),
  };
  const player = createPlayerSystem(spawn, settings, core.bus, host);
  if (explicit && p.y === null) player.teleport(spawn.s, spawn.x, null, spawn.z, spawn.yaw, spawn.pitch); // snap to the floor
  if (p.fly) player.setFly(true);
  const audio = createAudioSystem(core.bus, settings, q);
  audio.setFlickerMode(core.flickerMode);
  const input = createInput(core.canvas, settings);
  const dynRes = createDynamicResolution(post, r, q);
  watchDevicePixelRatio(core);
  player.applyToCamera(core.camera, core.fov());
  // Claim every preloaded request before dropping unclaimed startup work. No GPU uploads here.
  streamer.update(spawn.x, spawn.z, -Math.sin(spawn.yaw), -Math.cos(spawn.yaw), core.camera, core.frame);
  startup.clear();
  return {
    q, features: featuresOf(p), textures, materials, lighting, post, reflection, ssr, ripples, anomaly, dynRes, pool,
    poolTarget: poolSize(q), streamer, player, audio, input, init,
    spawn: { ...spawn, reason: explicit ? 'explicit' : spawn.reason },
  };
}

/**
 * §6.4 runtime quality change. `nq` is a fresh object (never mutate the live one: systems compare old vs new).
 * A textureSize change is not applied (it needs a reload): the caller is told through the return value.
 */
export async function applyQuality(core: AppCore, nq: QualityConfig): Promise<{ reloadNeeded: boolean }> {
  const s = core.sys;
  const r = core.renderer;
  if (!s || !r) return { reloadNeeded: false };
  const old = s.q;
  const reloadNeeded = nq.textureSize !== old.textureSize;
  if (reloadNeeded) nq.textureSize = old.textureSize;
  if (isResolutionOnlyChange(old, nq)) {
    // render scale / dynamic resolution / DPR cap / prop distance (the settings sliders): no program, bake or
    // stream change, so no warmup and no ready gate; applied within the frame
    s.q = nq;
    s.post.setQuality(nq); // pixel ratio + render target sizes (the AA pass is unchanged)
    s.reflection.setQuality(nq);
    s.dynRes = createDynamicResolution(s.post, r, nq);
    await s.streamer.setQuality(nq); // propDistance only: no rebuild
    return { reloadNeeded };
  }
  core.debug.ready = false;
  core.debug.readyPhase = 'shaders';
  s.q = nq;
  r.setPixelRatio(pixelRatioFor(nq, devicePixelRatio));
  // new post passes (AO mode, SMAA preset) stay out of the frame until their programs are linked in parallel
  // (KHR_parallel_shader_compile): the switch no longer stalls a frame on a synchronous link (R2 B9)
  const internals = postInternals(s.post);
  // the pre-shade SSAO helper is a frame-graph hook, not a composer pass: a new one waits the same way
  const before = new Set<object>(internals ? [...internals.passes, internals.ao] : []);
  s.post.setQuality(nq);
  const fresh: { enabled: boolean }[] = internals ? [...internals.passes, internals.ao].filter((p) => !before.has(p)) : [];
  const wasEnabled = fresh.map((p) => p.enabled);
  for (const p of fresh) p.enabled = false;
  s.post.setSize(innerWidth, innerHeight);
  s.lighting.setQuality(nq);
  s.reflection.setQuality(nq);
  s.ssr.setQuality(nq);
  s.ripples.setQuality(nq);
  s.audio.setQuality(nq);
  if (nq.detailMaps && nq.shaderDetail !== 'lite' && !s.textures.detail) s.textures.detail = await generateDetailTextures(r, nq.anisotropy);
  s.materials.setQuality(nq);
  s.dynRes = createDynamicResolution(s.post, r, nq);
  try {
    const mats = collectPassMaterials(fresh);
    // the frame graph's own quad programs (pyramid, MRT composite) on presets with split frames; already-linked
    // programs cost nothing here
    if (internals && nq.colorPyramidScale > 0) mats.push(...internals.scenePass.materials);
    if (nq.ssr !== 'off') mats.push(...s.ssr.materials); // package D: a new trace program when ssrSteps changed
    await warmPassMaterials(r, mats);
  } finally {
    fresh.forEach((p, i) => { p.enabled = wasEnabled[i]; });
  }
  await s.materials.warmup(r, core.camera, core.scene);
  core.debug.readyPhase = 'chunks';
  await s.streamer.setQuality(nq);
  // the pool follows the preset's bakeWorkers (new workers get the new bake init)
  s.poolTarget = poolSize(nq);
  if (s.pool.size !== s.poolTarget && !core.gate.active) void s.pool.resize(s.poolTarget);
  await core.gate.open({ reason: 'quality', snapToWalkable: false });
  return { reloadNeeded };
}
