// src/stream/ChunkStreamer.ts — the WorldStreamer implementation (WP10): desired set, jobs, residency, queries.
//
// Structure:
//   createChunkStreamer(o)  wires the real GPU uploader (TileObject.ts) into
//   createStreamerCore(o)   the residency state machine + per-storey query data sets. It never touches WebGL
//                           directly, so tests/stream/residency.test.ts drives it with a fake uploader and pool.
//
// Tile lifecycle (DESIGN §5 WP10, §6.3). Transitions happen in processUploads, at most
// UPLOAD.MAX_STEPS_PER_FRAME step for current-storey tiles plus UPLOAD.PREFETCH_STEPS_PER_FRAME step for tiles of
// other storeys (prefetch groups), each in its own slot. A step is made of units (one texture upload, one mesh
// upload); it runs units while the frame's budgetMs lasts (at least one per slot and frame, so neither slot
// starves) and resumes on the next frame when the budget runs out. A started step is finished before any other
// step of its slot begins.
//   queued -> building (build job in flight) -> received
//   received  -> texUpload  (texture step: pool textures + initTexture; materials; bindings via .value)
//   texUpload -> geoUpload  (geometry step: meshes, forced GPU upload, group into its storey group)
//             -> fadingIn (bindings.fade 0 -> 1 over UPLOAD.FADE_IN_S) -> resident
//   resident + full bake -> texture step only: in-place texture swap, bake = 'full'
//   evict: resident -> evicting (removed from the scene) -> next frame: dispose -> disposed
// A full bake that arrives before the texture step is uploaded directly (the preview is skipped).

import * as THREE from 'three';
import { CHUNK_SIZE, TILE_SIZE, UPLOAD } from '../core/constants.ts';
import type { GameBus } from '../core/events.ts';
import {
  chebyshev, chunkKeyStr, tileKeyStr, tileOriginX, tileOriginZ, worldToChunk, type ChunkKey, type TileKey,
} from '../core/grid.ts';
import type { StoreyId } from '../core/ids.ts';
import type { LightmapData, MeshBuffers, TileMesh } from '../core/mesh.ts';
import { bakeQualityOf, type QualityConfig } from '../core/quality.ts';
import type {
  DynamicMeshHandle, MaterialSystem, StreamStats, TileLifecycle, TileRuntime, WorldQuery, WorldStreamer,
} from '../core/runtime.ts';
import type { WorkerInit, WorkerRequest, WorkerResponse } from '../core/worker.ts';
import {
  QUERY_PRIORITY, basePriority, createMotion, desiredChunks, fogHidden, jobPriority, keepResident, lookahead,
  rectDistance, resetMotion, updateMotion,
} from './priorities.ts';
import { createTileUploader, type TileGpu, type TileUploader, type UploaderMemory } from './TileObject.ts';
import type { JobHandle, WorkerPool } from './WorkerPool.ts';
import { chunkNumKey, createChunkData, createWorldQuery, StoreyData, type ChunkData } from './WorldQueryImpl.ts';

export interface StreamerOptions {
  renderer: THREE.WebGLRenderer; materials: MaterialSystem; quality: QualityConfig; init: WorkerInit; bus: GameBus; pool: WorkerPool; startStorey: StoreyId;
  /** optional debug hook (chunk harness atlas stats): called when a build or bake payload arrives */
  onTileData?: (key: string, kind: 'build' | 'bake', mesh: TileMesh | null, lm: LightmapData, ms: number) => void;
}

export function createChunkStreamer(o: StreamerOptions): WorldStreamer {
  const uploader = createTileUploader(o.renderer, o.materials);
  return createStreamerCore({
    quality: o.quality, init: o.init, bus: o.bus, pool: o.pool, startStorey: o.startStorey, uploader, onTileData: o.onTileData,
  });
}

// ---------------------------------------------------------------- core

export interface StreamerCoreOptions {
  quality: QualityConfig;
  init: WorkerInit;
  bus: GameBus;
  pool: WorkerPool;
  startStorey: StoreyId;
  uploader: TileUploader;
  /** milliseconds; default performance.now (fades, prefetch keep-alive) */
  clock?: () => number;
  /** milliseconds; default performance.now: measures the upload budget (tests inject a fake one) */
  budgetClock?: () => number;
  onTileData?: StreamerOptions['onTileData'];
}

/** Prefetched data expires this long after the last prefetch() call covering it. */
export const PREFETCH_KEEPALIVE_MS = 10_000;
/** The storey just left (after a completed switch): its keep-alive drops to this. A player still at the tower /
 * elevator keeps it alive through the traversal's proximity prefetch (every 0.25 s); one who walks away frees
 * ~0.5 GB of GPU memory 2 s later instead of 10 s (R2 B9). */
export const LEFT_STOREY_KEEPALIVE_MS = 2_000;
/** GPU bytes (tile textures live + geometry) above which the farthest chunks outside the desired set are evicted
 * early (the hysteresis ring, other storeys' expired data), per preset (R2 B9). Pooled textures are not counted:
 * the texture pool bounds itself. */
export const RESIDENT_BUDGET_BYTES: Readonly<Record<QualityConfig['name'], number>> = {
  low: 450 * 2 ** 20, medium: 700 * 2 ** 20, high: 900 * 2 ** 20, ultra: 1400 * 2 ** 20,
};
/** Progressive eviction: chunks removed from the scene per frame (storey switches evict ~25 chunks). */
export const MAX_EVICT_CHUNKS_PER_FRAME = 2;
/** Deferred disposal: tiles disposed per frame (each is a handful of deleteBuffer/texture releases). */
export const MAX_DISPOSE_PER_FRAME = 8;
/** Queued-job priorities are refreshed every N frames (and on every re-target). */
export const PRIORITY_REFRESH_FRAMES = 8;
const BUILD_RETRIES = 1;

const STEP_NONE = 0, STEP_TEX = 1, STEP_GEO = 2, STEP_SWAP = 3;
const STEP_NAMES = ['none', 'tex', 'geo', 'swap'];

/** Main-thread cost of the streamer (debug / harness / soak diagnostics). Maxima accumulate until reset. */
export interface StreamTiming {
  updateMs: number; uploadMs: number; maxUpdateMs: number; maxUploadMs: number;
  maxStepMs: number; maxStepKind: string; maxStepKey: string; steps: number; disposed: number;
  /** processUploads calls (frames) and how many of them exceeded their budgetMs (a unit cannot be split) */
  uploadFrames: number; overBudgetFrames: number;
  /** GPU memory held by tile builds (null with an uploader that does not track it) */
  memory(): UploaderMemory | null;
  reset(): void;
}
const timings = new WeakMap<WorldStreamer, StreamTiming>();
/** Timing record of a streamer created by createStreamerCore / createChunkStreamer (null for other objects). */
export const getStreamTiming = (st: WorldStreamer): StreamTiming | null => timings.get(st) ?? null;

interface ChunkRec {
  key: ChunkKey; ks: string; s: StoreyId; nk: number;
  layoutJob: JobHandle<Extract<WorkerResponse, { t: 'layout' }>> | null;
  data: ChunkData | null;
  tiles: TileRec[];
  desired: boolean; // in the current storey's desired set
  keepUntil: number; // prefetch keep-alive (clock ms); 0 = not prefetched
  pfx: number; pfz: number; // prefetch centre (world m) for prefetch priorities
  prio: number; // base priority (chunk)
  evicted: boolean;
  listIdx: number;
  retries: number;
  failed: boolean; // layout failed after retries (logged); never blocks readiness, not resubmitted
}

interface TileRec {
  key: TileKey; ks: string; chunk: ChunkRec;
  state: TileLifecycle;
  buildJob: JobHandle<Extract<WorkerResponse, { t: 'build' }>> | null;
  bakeJob: JobHandle<Extract<WorkerResponse, { t: 'bake' }>> | null;
  mesh: TileMesh | null; // awaiting the geometry step
  lm: LightmapData | null; // preview awaiting the texture step
  full: LightmapData | null; // full bake awaiting the texture step or a swap
  atlasHash: number; // chartHash of the atlas of the latest build (full bakes must match)
  step: number;
  partial: boolean; // the current step has started (some units done) and must be resumed first
  upLm: LightmapData | null; // lightmap of a texture step in progress
  gpu: TileGpu | null; // displayed build
  staging: TileGpu | null; // build in upload (texture step done, geometry step pending)
  stagingBake: 'preview' | 'full';
  rt: TileRuntime | null;
  fadeStart: number;
  prio: number;
  inView: boolean; // in the camera frustum at the last priority refresh (bake priority bonus)
  ox: number; oz: number;
  evicted: boolean;
  loaded: boolean; // tileLoaded emitted
  failed: boolean;
  retries: number;
  bakeRetries: number;
  bakeFailed: boolean; // full bake failed after retries (logged): the preview stays; never blocks readiness
  needBake: boolean; // a (re)bake must be requested (quality change, same atlas)
  needBuild: boolean; // a rebuild must be requested although a build is displayed (quality change, new atlas)
  upIdx: number; fadeIdx: number; liveIdx: number;
}

interface DisposeRec { gpu: TileGpu; rt: TileRuntime | null; frame: number }

function removeAt<T extends object>(list: T[], idx: number, set: (t: T, i: number) => void): void {
  const last = list.pop() as T;
  if (idx < list.length) {
    list[idx] = last;
    set(last, idx);
  }
}

export function createStreamerCore(o: StreamerCoreOptions): WorldStreamer {
  const { bus, pool, uploader } = o;
  const clock = o.clock ?? ((): number => performance.now());
  let quality = o.quality;
  let init = o.init;
  let storey: StoreyId = o.startStorey;

  // ---- scene graph: one group per storey
  const root = new THREE.Group();
  root.name = 'streamer';
  const storeyGroups = [0, 1, 2].map((s) => {
    const g = new THREE.Group();
    g.name = `storey${s}`;
    g.visible = s === storey;
    root.add(g);
    return g;
  });

  // ---- records
  const recs: Map<number, ChunkRec>[] = [new Map(), new Map(), new Map()];
  const chunkList: ChunkRec[] = [];
  const tilesByKey = new Map<string, TileRec>();
  const uploadList: TileRec[] = [];
  const fadeList: TileRec[] = [];
  const liveList: TileRec[][] = [[], [], []];
  const liveSets: Set<TileRuntime>[] = [new Set(), new Set(), new Set()];
  const disposeQ: DisposeRec[] = [];
  const evictScratch: ChunkRec[] = [];
  const desiredScratch = new Int32Array(2 * 128);

  // ---- query data (one set per storey; `query` reads the current storey's)
  const data: StoreyData[] = [new StoreyData(), new StoreyData(), new StoreyData()];
  const query: WorldQuery = createWorldQuery({ storey: () => storey, data: (s) => data[s] });

  // ---- player / targeting state
  const motion = createMotion();
  const la = { x: 0, z: 0 };
  let px = 0, pz = 0, pcx = NaN, pcz = NaN, lcx = NaN, lcz = NaN;
  let tStorey: StoreyId = storey, tRadius = -1;
  let leftStorey: StoreyId | -1 = -1; // the storey of the last completed switch (short keep-alive)
  let dirty = true;
  let frameNo = 0; // frame counter, advanced by update() (dispose delay)
  let lastPrioFrame = -1e9;
  let chunksDesired = 0;

  // ---- frustum
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  const box = new THREE.Box3();
  let haveFrustum = false;
  let viewX = 0, viewZ = -1;

  // ---- timings
  let bakeLastMs = 0, bakeSumMs = 0, bakeN = 0, buildSumMs = 0, buildN = 0;

  const timing: StreamTiming = {
    updateMs: 0, uploadMs: 0, maxUpdateMs: 0, maxUploadMs: 0, maxStepMs: 0, maxStepKind: '', maxStepKey: '', steps: 0, disposed: 0,
    uploadFrames: 0, overBudgetFrames: 0,
    memory: () => uploader.memory?.() ?? null,
    reset() { this.maxUpdateMs = 0; this.maxUploadMs = 0; this.maxStepMs = 0; this.maxStepKind = ''; this.maxStepKey = ''; },
  };
  const perf = o.budgetClock ?? ((): number => (typeof performance !== 'undefined' ? performance.now() : 0));
  // upload budget of the current frame: a resumable step starts another unit only when one more unit of the cost
  // of the last one still fits before the deadline (so the budget is overshot only by a first unit that is itself
  // larger than what is left)
  let deadline = 0, unitMark = 0;
  const more = (): boolean => {
    const n = perf();
    const unit = n - unitMark;
    unitMark = n;
    return n + unit <= deadline;
  };

  const logErr = (what: string, e: unknown): void => console.error(`[ChunkStreamer] ${what}:`, e instanceof Error ? e.message : e);

  // ================================================================ priorities

  const isPrefetchChunk = (c: ChunkRec): boolean => c.s !== storey || !c.desired;
  const isOwnChunk = (c: ChunkRec): boolean => c.s === storey && c.key.cx === pcx && c.key.cz === pcz;

  function inView(x0: number, z0: number, size: number): boolean {
    if (haveFrustum) {
      box.min.set(x0, -1, z0);
      box.max.set(x0 + size, 5, z0 + size);
      return frustum.intersectsBox(box);
    }
    const cx = x0 + size / 2 - px, cz = z0 + size / 2 - pz;
    return cx * viewX + cz * viewZ > -size;
  }

  function computeChunkPrio(c: ChunkRec): void {
    const x0 = c.key.cx * CHUNK_SIZE, z0 = c.key.cz * CHUNK_SIZE;
    if (!isPrefetchChunk(c) && !Number.isNaN(pcx)) {
      const ring = chebyshev(c.key.cx, c.key.cz, pcx, pcz);
      c.prio = basePriority(ring, inView(x0, z0, CHUNK_SIZE), rectDistance(px, pz, x0, z0, x0 + CHUNK_SIZE, z0 + CHUNK_SIZE));
      for (const t of c.tiles) {
        t.inView = inView(t.ox, t.oz, TILE_SIZE);
        t.prio = basePriority(ring, t.inView, rectDistance(px, pz, t.ox, t.oz, t.ox + TILE_SIZE, t.oz + TILE_SIZE));
      }
    } else {
      const ring = chebyshev(c.key.cx, c.key.cz, worldToChunk(c.pfx), worldToChunk(c.pfz));
      c.prio = basePriority(ring, true, rectDistance(c.pfx, c.pfz, x0, z0, x0 + CHUNK_SIZE, z0 + CHUNK_SIZE));
      for (const t of c.tiles) {
        t.inView = false;
        t.prio = basePriority(ring, true, rectDistance(c.pfx, c.pfz, t.ox, t.oz, t.ox + TILE_SIZE, t.oz + TILE_SIZE));
      }
    }
  }

  function applyJobPriorities(c: ChunkRec): void {
    const pf = isPrefetchChunk(c), own = isOwnChunk(c);
    if (c.layoutJob) c.layoutJob.priority = jobPriority(c.prio, 'layout', pf, own);
    for (const t of c.tiles) {
      if (t.buildJob) t.buildJob.priority = jobPriority(t.prio, 'build', pf, own);
      if (t.bakeJob) t.bakeJob.priority = jobPriority(t.prio, 'bake', pf, own, t.inView);
    }
  }

  function reprioritize(): void {
    for (let i = 0; i < chunkList.length; i++) {
      const c = chunkList[i];
      computeChunkPrio(c);
      applyJobPriorities(c);
    }
  }

  // ================================================================ jobs

  function submitLayout(c: ChunkRec): void {
    const h = pool.submit({ t: 'layout', job: 0, key: c.key }, jobPriority(c.prio, 'layout', isPrefetchChunk(c), isOwnChunk(c)), c.ks);
    c.layoutJob = h;
    h.promise.then((r) => {
      if (c.evicted || c.layoutJob !== h) return;
      c.layoutJob = null;
      const d = createChunkData(r.layout, r.collision);
      c.data = d;
      data[c.s].set(d);
      bus.emit('chunkLoaded', { key: c.ks });
    }, (e) => {
      if (c.evicted || c.layoutJob !== h) return;
      c.layoutJob = null;
      logErr(`layout ${c.ks} failed`, e);
      if (c.retries++ < BUILD_RETRIES) submitLayout(c);
      else c.failed = true;
    });
  }

  function submitBuild(t: TileRec): void {
    const c = t.chunk;
    const h = pool.submit({ t: 'build', job: 0, key: t.key }, jobPriority(t.prio, 'build', isPrefetchChunk(c), isOwnChunk(c)), c.ks);
    t.buildJob = h;
    t.needBuild = false;
    if (!t.gpu && !t.staging) t.state = 'building';
    h.promise.then((r) => {
      if (t.evicted || t.buildJob !== h) return;
      t.buildJob = null;
      buildSumMs += r.ms.gen + r.ms.mesh + r.ms.bake;
      buildN++;
      o.onTileData?.(t.ks, 'build', r.mesh, r.lightmap, r.ms.gen + r.ms.mesh + r.ms.bake);
      receiveBuild(t, r.mesh, r.lightmap);
    }, (e) => {
      if (t.evicted || t.buildJob !== h) return;
      t.buildJob = null;
      logErr(`build ${t.ks} failed`, e);
      if (t.retries++ < BUILD_RETRIES) submitBuild(t);
      else t.failed = true;
    });
  }

  function submitBake(t: TileRec): void {
    const c = t.chunk;
    t.needBake = false;
    const h = pool.submit({ t: 'bake', job: 0, key: t.key }, jobPriority(t.prio, 'bake', isPrefetchChunk(c), isOwnChunk(c), t.inView), c.ks);
    t.bakeJob = h;
    h.promise.then((r) => {
      if (t.evicted || t.bakeJob !== h) return;
      t.bakeJob = null;
      bakeLastMs = r.ms;
      bakeSumMs += r.ms;
      bakeN++;
      o.onTileData?.(t.ks, 'bake', null, r.lightmap, r.ms);
      receiveFull(t, r.lightmap);
    }, (e) => {
      if (t.evicted || t.bakeJob !== h) return;
      t.bakeJob = null;
      logErr(`bake ${t.ks} failed`, e);
      bakeFailedOnce(t);
    });
  }

  // ================================================================ one-shot queries (find / spawn / ascii)
  // The pool drops (never settles) every job on reinit. Queries do not depend on BakeQuality, so a quality change
  // must not strand a caller awaiting spawn()/findNearest(): pending queries are re-submitted after each reinit.

  interface QueryRec { submit(): void }
  const queries = new Set<QueryRec>();

  function runQuery<T extends 'find' | 'spawn' | 'ascii'>(req: Extract<WorkerRequest, { t: T }>): Promise<Extract<WorkerResponse, { t: T }>> {
    return new Promise((resolve, reject) => {
      let current: JobHandle<Extract<WorkerResponse, { t: T }>> | null = null;
      const rec: QueryRec = {
        submit() {
          const h = pool.submit<T>(req, QUERY_PRIORITY);
          current = h;
          h.promise.then((r) => {
            if (current !== h) return;
            queries.delete(rec);
            resolve(r);
          }, (e: unknown) => {
            if (current !== h) return;
            queries.delete(rec);
            reject(e instanceof Error ? e : new Error(String(e)));
          });
        },
      };
      queries.add(rec);
      rec.submit();
    });
  }

  function resubmitQueries(): void {
    for (const q of queries) q.submit();
  }

  // ================================================================ upload queue helpers

  function queueStep(t: TileRec, step: number): void {
    t.step = step;
    t.partial = false;
    if (step === STEP_NONE) {
      if (t.upIdx >= 0) { removeAt(uploadList, t.upIdx, (x, i) => { x.upIdx = i; }); t.upIdx = -1; }
    } else if (t.upIdx < 0) {
      t.upIdx = uploadList.length;
      uploadList.push(t);
    }
  }

  /** Drop a build that is (half) uploaded but not displayed yet. */
  function dropStaging(t: TileRec): void {
    t.upLm = null;
    if (!t.staging) return;
    if (t.rt && !t.gpu && t.rt.group === t.staging.group) { t.rt.state = 'disposed'; t.rt = null; }
    scheduleDispose(t.staging, null);
    t.staging = null;
  }

  function receiveBuild(t: TileRec, mesh: TileMesh, lm: LightmapData): void {
    dropStaging(t); // a newer build supersedes one that was half uploaded
    t.mesh = mesh;
    t.lm = lm;
    if (t.full && t.full.chartHash !== mesh.atlas.chartHash) t.full = null;
    t.atlasHash = mesh.atlas.chartHash;
    if (!t.gpu) t.state = 'received';
    queueStep(t, STEP_TEX);
    if (!t.bakeJob && !t.full) submitBake(t);
  }

  /** A full bake failed or came back unusable: retry once, then keep the preview (logged; never blocks readiness). */
  function bakeFailedOnce(t: TileRec): void {
    if (t.bakeRetries++ < BUILD_RETRIES) submitBake(t);
    else t.bakeFailed = true;
  }

  function receiveFull(t: TileRec, lm: LightmapData): void {
    if (lm.chartHash !== t.atlasHash) {
      // bakes are only requested for the displayed/pending atlas, so this is a build/bake determinism bug (WP5/WP7)
      logErr(`bake ${t.ks}`, `chartHash ${lm.chartHash} != build atlas ${t.atlasHash}; full bake discarded`);
      if (!t.buildJob && !Number.isNaN(t.atlasHash)) bakeFailedOnce(t);
      return;
    }
    t.full = lm;
    if (t.step === STEP_NONE && t.gpu) queueStep(t, STEP_SWAP);
    // STEP_TEX not started yet: the texture step uploads the full bake directly; a texture step in progress
    // (preview) or STEP_GEO: swap after the geometry step
  }

  // ================================================================ records

  function ensureChunk(s: StoreyId, cx: number, cz: number): ChunkRec {
    const nk = chunkNumKey(cx, cz);
    let c = recs[s].get(nk);
    if (c && c.key.cx === cx && c.key.cz === cz) return c;
    const key: ChunkKey = { s, cx, cz };
    c = {
      key, ks: chunkKeyStr(key), s, nk, layoutJob: null, data: null, tiles: [], desired: false, keepUntil: 0,
      pfx: (cx + 0.5) * CHUNK_SIZE, pfz: (cz + 0.5) * CHUNK_SIZE, prio: 0, evicted: false, listIdx: chunkList.length, retries: 0,
      failed: false,
    };
    recs[s].set(nk, c);
    chunkList.push(c);
    for (let q = 0; q < 4; q++) {
      const tk: TileKey = { s, cx, cz, q: q as 0 | 1 | 2 | 3 };
      const t: TileRec = {
        key: tk, ks: tileKeyStr(tk), chunk: c, state: 'queued', buildJob: null, bakeJob: null, mesh: null, lm: null, full: null,
        atlasHash: NaN, step: STEP_NONE, partial: false, upLm: null, gpu: null, staging: null, stagingBake: 'preview', rt: null, fadeStart: 0, prio: 0, inView: false,
        ox: tileOriginX(tk), oz: tileOriginZ(tk), evicted: false, loaded: false, failed: false, retries: 0, bakeRetries: 0, bakeFailed: false, needBake: false,
        needBuild: false,
        upIdx: -1, fadeIdx: -1, liveIdx: -1,
      };
      c.tiles.push(t);
      tilesByKey.set(t.ks, t);
    }
    return c;
  }

  /** Submit whatever jobs a freshly created (or re-initialised) chunk still needs. */
  function startJobs(c: ChunkRec): void {
    computeChunkPrio(c);
    if (!c.data && !c.layoutJob && !c.failed) submitLayout(c);
    for (const t of c.tiles) {
      if (!t.buildJob && !t.mesh && !t.staging && !t.failed && (!t.gpu || t.needBuild)) submitBuild(t);
    }
  }

  function scheduleDispose(gpu: TileGpu, rt: TileRuntime | null): void {
    gpu.group.removeFromParent();
    disposeQ.push({ gpu, rt, frame: frameNo });
  }

  function addLive(t: TileRec): void {
    if (t.liveIdx >= 0 || !t.rt) return;
    const list = liveList[t.key.s];
    t.liveIdx = list.length;
    list.push(t);
    liveSets[t.key.s].add(t.rt);
  }
  function removeLive(t: TileRec): void {
    if (t.liveIdx < 0) return;
    removeAt(liveList[t.key.s], t.liveIdx, (x, i) => { x.liveIdx = i; });
    t.liveIdx = -1;
    if (t.rt) liveSets[t.key.s].delete(t.rt);
  }
  function removeFade(t: TileRec): void {
    if (t.fadeIdx < 0) return;
    removeAt(fadeList, t.fadeIdx, (x, i) => { x.fadeIdx = i; });
    t.fadeIdx = -1;
  }

  function evictTile(t: TileRec): void {
    t.evicted = true;
    t.buildJob?.cancel(); t.buildJob = null;
    t.bakeJob?.cancel(); t.bakeJob = null;
    t.mesh = null; t.lm = null; t.full = null;
    queueStep(t, STEP_NONE);
    removeFade(t);
    removeLive(t);
    tilesByKey.delete(t.ks);
    if (t.staging) { scheduleDispose(t.staging, null); t.staging = null; }
    t.upLm = null;
    if (t.gpu) {
      if (t.rt) t.rt.state = 'evicting';
      scheduleDispose(t.gpu, t.rt);
      t.gpu = null;
      t.state = 'evicting';
    } else {
      if (t.rt) t.rt.state = 'disposed';
      t.state = 'disposed';
    }
    if (t.loaded) bus.emit('tileUnloaded', { key: t.ks });
  }

  function evictChunk(c: ChunkRec): void {
    c.evicted = true;
    c.layoutJob?.cancel();
    c.layoutJob = null;
    for (const t of c.tiles) evictTile(t);
    recs[c.s].delete(c.nk);
    removeAt(chunkList, c.listIdx, (x, i) => { x.listIdx = i; });
    if (c.data) {
      data[c.s].delete(c.key.cx, c.key.cz);
      c.data = null;
      bus.emit('chunkUnloaded', { key: c.ks });
    }
  }

  // ================================================================ desired set

  function retarget(): void {
    const R = quality.streamRadius;
    for (let i = 0; i < chunkList.length; i++) {
      const c = chunkList[i];
      if (c.s === storey) c.desired = false;
    }
    const n = desiredChunks(lcx, lcz, pcx, pcz, R, desiredScratch);
    for (let i = 0; i < n; i++) {
      const c = ensureChunk(storey, desiredScratch[i * 2], desiredScratch[i * 2 + 1]);
      c.desired = true;
    }
    chunksDesired = n;
    // jobs after every desired flag is final (priorities depend on it), nearest ring first
    for (let i = 0; i < n; i++) startJobs(recs[storey].get(chunkNumKey(desiredScratch[i * 2], desiredScratch[i * 2 + 1])) as ChunkRec);
    tStorey = storey;
    tRadius = R;
  }

  /** Resident GPU bytes over the preset's budget (0 when within it or unknown), net of what is already queued for
   * disposal (an evicted tile frees its memory a frame later). */
  function overBudget(): number {
    const m = uploader.memory?.();
    if (!m) return 0;
    const budget = RESIDENT_BUDGET_BYTES[quality.name] ?? RESIDENT_BUDGET_BYTES.high;
    const used = m.texBytes + m.geoBytes;
    if (used <= budget) return 0;
    let tiles = 0;
    for (let s = 0; s < 3; s++) tiles += liveList[s].length;
    const perTile = tiles > 0 ? used / tiles : 0;
    return Math.max(0, used - budget - disposeQ.length * perTile);
  }

  function sweep(now: number): void {
    const R = quality.streamRadius;
    let n = 0;
    for (let i = 0; i < chunkList.length && n < MAX_EVICT_CHUNKS_PER_FRAME; i++) {
      const c = chunkList[i];
      const alive = c.keepUntil > now;
      const keep = c.s === storey
        ? c.desired || alive || (!Number.isNaN(lcx) && keepResident(c.key.cx, c.key.cz, lcx, lcz, pcx, pcz, R))
        : alive;
      if (!keep) evictScratch[n++] = c;
    }
    if (n === 0 && !Number.isNaN(pcx) && (frameNo & 7) === 0 && overBudget() > 0) {
      // over the GPU budget: the farthest chunk that is resident but not needed (the hysteresis ring) goes early
      let best: ChunkRec | null = null, bd = -1;
      for (let i = 0; i < chunkList.length; i++) {
        const c = chunkList[i];
        if (c.desired || (c.s === storey && c.key.cx === pcx && c.key.cz === pcz)) continue;
        if (c.keepUntil > now) continue; // live prefetch data (a traversal target) is never evicted early
        if (!c.tiles.some((t) => t.gpu !== null)) continue;
        const d = chebyshev(c.key.cx, c.key.cz, pcx, pcz) + (c.s !== storey ? 0.5 : 0);
        if (d > bd) { bd = d; best = c; }
      }
      if (best) evictScratch[n++] = best;
    }
    for (let i = 0; i < n; i++) evictChunk(evictScratch[i]);
    evictScratch.length = 0;
  }

  // ================================================================ residency steps

  /** A started step always goes first in its slot (it holds half-uploaded GPU resources). */
  const PARTIAL_FIRST = 1e7;
  const effPrio = (t: TileRec): number => {
    const c = t.chunk;
    return (t.partial ? -PARTIAL_FIRST : 0) + jobPriority(t.prio, t.step === STEP_SWAP ? 'bake' : 'build', isPrefetchChunk(c), isOwnChunk(c)) - (t.step === STEP_GEO ? 5 : 0);
  };

  function pick(current: boolean, now: number): TileRec | null {
    let best: TileRec | null = null, bp = Infinity;
    for (let i = 0; i < uploadList.length; i++) {
      const t = uploadList[i];
      if ((t.key.s === storey) !== current) continue;
      // other storeys: only live prefetch data (the old storey after a switch is being evicted: no uploads for it)
      if (!current && t.chunk.keepUntil <= now) continue;
      const p = effPrio(t);
      if (p < bp) { bp = p; best = t; }
    }
    return best;
  }

  function doStep(t: TileRec, now: number): void {
    const s0 = perf();
    unitMark = s0;
    const kind = t.step;
    try {
      doStepInner(t, now);
    } catch (e) {
      // never rethrow every frame from the app loop: the tile fails loudly once and leaves the upload queue
      logErr(`${STEP_NAMES[kind]} step of ${t.ks} failed`, e);
      if (e instanceof Error && e.stack) console.error(e.stack);
      stepFailed(t);
    }
    const ms = perf() - s0;
    timing.steps++;
    if (ms > timing.maxStepMs) { timing.maxStepMs = ms; timing.maxStepKind = STEP_NAMES[kind]; timing.maxStepKey = t.ks; }
  }

  function doStepInner(t: TileRec, now: number): void {
    switch (t.step) {
      case STEP_TEX: {
        const mesh = t.mesh as TileMesh;
        if (!t.partial) {
          // step start: fresh materials + group; a full bake that is already here replaces the preview
          const useFull = t.full !== null;
          t.upLm = (useFull ? t.full : t.lm) as LightmapData;
          t.stagingBake = useFull ? 'full' : 'preview';
          t.lm = null;
          if (useFull) t.full = null;
          t.staging = uploader.createTile(t.key, mesh.water !== null);
          t.partial = true;
          const gpu = t.staging;
          if (!t.rt) {
            t.rt = {
              key: t.key, keyStr: t.ks, zone: mesh.zone, group: gpu.group, materials: gpu.materials, dynLights: mesh.dynLights,
              bake: t.stagingBake, state: 'texUpload', visible: false,
            };
          }
          if (!t.gpu) { t.state = 'texUpload'; t.rt.state = 'texUpload'; }
        }
        if (!uploader.uploadTextures(t.staging as TileGpu, t.upLm as LightmapData, more)) return; // resumes next frame
        t.upLm = null;
        queueStep(t, STEP_GEO);
        break;
      }
      case STEP_GEO: {
        const mesh = t.mesh as TileMesh;
        const gpu = t.staging as TileGpu;
        const rt = t.rt as TileRuntime;
        const fresh = t.gpu === null;
        if (fresh) { t.state = 'geoUpload'; rt.state = 'geoUpload'; }
        t.partial = true;
        if (!uploader.uploadGeometry(gpu, mesh, storeyGroups[t.key.s], more)) return; // resumes next frame
        if (!fresh) {
          // rebuild (quality change): replace the displayed build in one step
          const old = t.gpu as TileGpu;
          uploader.moveDynamics(old, gpu);
          scheduleDispose(old, null);
          uploader.setFade(gpu, 1);
        }
        t.gpu = gpu;
        t.staging = null;
        t.mesh = null;
        rt.group = gpu.group;
        rt.materials = gpu.materials;
        rt.zone = mesh.zone;
        rt.dynLights = mesh.dynLights;
        rt.bake = t.stagingBake;
        if (fresh) {
          // a tile that arrives entirely beyond the fog end cannot be seen popping in: it skips the dither fade, so
          // tiles.fadingIn counts only visible arrivals (§7.4 edge: <= 8 while sprinting)
          if (t.key.s === storey && UPLOAD.FADE_IN_S > 0 && !fogHidden(px, pz, t.ox, t.oz, TILE_SIZE, quality.streamRadius)) {
            t.state = 'fadingIn';
            rt.state = 'fadingIn';
            t.fadeStart = now;
            uploader.setFade(gpu, 0);
            t.fadeIdx = fadeList.length;
            fadeList.push(t);
          } else {
            // prefetch groups are invisible (and fog-hidden tiles unseen): no fade, so a switch never shows a dither
            t.state = 'resident';
            rt.state = 'resident';
            uploader.setFade(gpu, 1);
          }
          addLive(t);
          t.loaded = true;
          bus.emit('tileLoaded', { key: t.ks });
        }
        applyVisibility(t);
        queueStep(t, t.full ? STEP_SWAP : STEP_NONE);
        break;
      }
      case STEP_SWAP: {
        const full = t.full as LightmapData;
        t.partial = true;
        if (!uploader.swapLightmap(t.gpu as TileGpu, full, more)) return; // resumes next frame (same lm)
        t.full = null;
        (t.rt as TileRuntime).bake = 'full';
        queueStep(t, STEP_NONE);
        break;
      }
      default:
        queueStep(t, STEP_NONE);
    }
  }

  /** A residency step threw: drop the half-uploaded build; keep a displayed build (if any) as it is. */
  function stepFailed(t: TileRec): void {
    queueStep(t, STEP_NONE);
    t.mesh = null; t.lm = null; t.full = null;
    dropStaging(t);
    if (!t.gpu) { t.state = 'queued'; t.failed = true; }
  }

  // ================================================================ visibility

  function applyVisibility(t: TileRec): void {
    const gpu = t.gpu, rt = t.rt;
    if (!gpu || !rt) return;
    const R = quality.streamRadius;
    const hidden = fogHidden(px, pz, t.ox, t.oz, TILE_SIZE, R);
    gpu.group.visible = !hidden;
    if (gpu.props) {
      const b = gpu.bounds;
      const d = Number.isFinite(b[0]) ? rectDistance(px, pz, t.ox + b[0], t.oz + b[2], t.ox + b[3], t.oz + b[5]) : 0;
      gpu.props.visible = d <= quality.propDistance;
    }
    if (hidden || t.key.s !== storey) rt.visible = false;
    else if (haveFrustum) {
      const b = gpu.bounds;
      if (Number.isFinite(b[0])) {
        box.min.set(t.ox + b[0], b[1], t.oz + b[2]);
        box.max.set(t.ox + b[3], b[4], t.oz + b[5]);
        rt.visible = frustum.intersectsBox(box);
      } else rt.visible = false;
    } else rt.visible = true;
  }

  // ================================================================ misc

  function tileReady(t: TileRec, needFull: boolean): boolean {
    if (t.failed) return true; // logged loudly; never block readiness on a deterministic failure
    const rt = t.rt;
    return rt !== null && t.gpu !== null && rt.state === 'resident' && (!needFull || rt.bake === 'full' || t.bakeFailed);
  }

  let qualityChain: Promise<void> = Promise.resolve();

  function restartAllJobs(tpcChanged: boolean): void {
    for (let i = 0; i < chunkList.length; i++) {
      const c = chunkList[i];
      c.layoutJob = null; // dropped by the pool (never settles)
      c.retries = 0;
      c.failed = false;
      for (const t of c.tiles) {
        t.buildJob = null;
        t.bakeJob = null;
        t.retries = 0;
        t.bakeRetries = 0;
        t.failed = false;
        t.bakeFailed = false;
        t.full = null;
        if (tpcChanged || !t.gpu) {
          // new atlas: rebuild; the displayed build (if any) stays until the new one is uploaded
          t.mesh = null;
          t.lm = null;
          dropStaging(t);
          queueStep(t, STEP_NONE);
          t.needBuild = true;
          if (!t.gpu) { t.state = 'queued'; if (t.rt) t.rt = null; }
        } else {
          // same atlas: only a new full bake is needed (the displayed lightmap is from the old settings)
          if (t.rt) t.rt.bake = 'preview';
          if (t.step === STEP_SWAP) queueStep(t, STEP_NONE);
          t.needBake = true;
        }
      }
    }
    for (let i = 0; i < chunkList.length; i++) {
      const c = chunkList[i];
      startJobs(c);
      for (const t of c.tiles) if (t.needBake && !t.bakeJob) submitBake(t);
    }
  }

  // ================================================================ the streamer

  const streamer: WorldStreamer = {
    get storey() { return storey; },
    query,
    scene: root,

    update(x, z, vx, vz, camera, frame) {
      const u0 = perf();
      frameNo++;
      const now = clock();
      updateMotion(motion, x, z, now);
      lookahead(motion, x, z, la);
      px = x; pz = z;
      const vl = Math.sqrt(vx * vx + vz * vz);
      if (vl > 1e-6) { viewX = vx / vl; viewZ = vz / vl; }
      const cam = camera as THREE.PerspectiveCamera | null;
      if (cam && cam.projectionMatrix && cam.matrixWorldInverse) {
        projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projView);
        haveFrustum = true;
      } else haveFrustum = false;
      const ncx = worldToChunk(x), ncz = worldToChunk(z);
      const nlx = worldToChunk(la.x), nlz = worldToChunk(la.z);
      let retargeted = false;
      if (dirty || ncx !== pcx || ncz !== pcz || nlx !== lcx || nlz !== lcz || tStorey !== storey || tRadius !== quality.streamRadius) {
        pcx = ncx; pcz = ncz; lcx = nlx; lcz = nlz;
        dirty = false;
        retarget();
        retargeted = true;
      }
      if (retargeted || frame - lastPrioFrame >= PRIORITY_REFRESH_FRAMES || frame < lastPrioFrame) {
        lastPrioFrame = frame;
        reprioritize();
      }
      sweep(now);
      const live = liveList[storey];
      for (let i = 0; i < live.length; i++) applyVisibility(live[i]);
      timing.updateMs = perf() - u0;
      if (timing.updateMs > timing.maxUpdateMs) timing.maxUpdateMs = timing.updateMs;
    },

    processUploads(_renderer, budgetMs) {
      const u0 = perf();
      const now = clock();
      // deferred disposal: evicted DISPOSE_DELAY_FRAMES ago or more (bounded, oldest first)
      let disposed = 0;
      while (disposeQ.length > 0 && disposed < MAX_DISPOSE_PER_FRAME && disposeQ[0].frame + UPLOAD.DISPOSE_DELAY_FRAMES <= frameNo) {
        const d = disposeQ.shift() as DisposeRec;
        uploader.dispose(d.gpu);
        if (d.rt && d.rt.group === d.gpu.group) d.rt.state = 'disposed';
        disposed++;
        if (perf() - u0 > budgetMs * 0.5) break;
      }
      // fades
      for (let i = fadeList.length - 1; i >= 0; i--) {
        const t = fadeList[i];
        const f = (now - t.fadeStart) / (UPLOAD.FADE_IN_S * 1000);
        if (f >= 1) {
          uploader.setFade(t.gpu as TileGpu, 1);
          t.state = 'resident';
          (t.rt as TileRuntime).state = 'resident';
          removeFade(t);
        } else uploader.setFade(t.gpu as TileGpu, f < 0 ? 0 : f);
      }
      // residency steps: one slot for the current storey, one for prefetch groups (independent: neither starves the
      // other: each does at least one unit when stepping is possible at all). Steps do units until the deadline and
      // resume next frame. No step work when deferred disposal already used the budget up.
      deadline = u0 + budgetMs;
      const canStep = perf() < deadline;
      for (let k = 0; canStep && k < UPLOAD.MAX_STEPS_PER_FRAME; k++) {
        const t = pick(true, now);
        if (!t) break;
        doStep(t, now);
      }
      for (let k = 0; canStep && k < UPLOAD.PREFETCH_STEPS_PER_FRAME; k++) {
        const t = pick(false, now);
        if (!t) break;
        doStep(t, now);
      }
      timing.disposed += disposed;
      timing.uploadMs = perf() - u0;
      timing.uploadFrames++;
      if (timing.uploadMs > budgetMs) timing.overBudgetFrames++;
      if (timing.uploadMs > timing.maxUploadMs) timing.maxUploadMs = timing.uploadMs;
    },

    tiles: () => liveSets[storey],

    prefetch(s, x, z, radiusChunks) {
      const now = clock();
      const cx = worldToChunk(x), cz = worldToChunk(z);
      const r = Math.max(0, radiusChunks | 0);
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const c = ensureChunk(s, cx + dx, cz + dz);
          c.keepUntil = now + (s === leftStorey ? LEFT_STOREY_KEEPALIVE_MS : PREFETCH_KEEPALIVE_MS);
          c.pfx = x; c.pfz = z;
          startJobs(c); // computes priorities; submits only what is missing (idempotent)
          applyJobPriorities(c);
        }
      }
    },

    isPrefetched(s, x, z) {
      const cx = worldToChunk(x), cz = worldToChunk(z);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const c = recs[s].get(chunkNumKey(cx + dx, cz + dz));
          if (!c || c.key.cx !== cx + dx || c.key.cz !== cz + dz) return false;
          if (!c.data) {
            if (c.failed) continue; // logged; a deterministic failure must not block a traversal forever
            return false;
          }
          const centre = dx === 0 && dz === 0;
          for (const t of c.tiles) {
            if (t.failed) continue;
            if (!t.gpu || !t.rt) return false;
            if (centre && t.rt.bake !== 'full' && !t.bakeFailed) return false;
          }
        }
      }
      return true;
    },

    switchStorey(to) {
      if (to === storey) return;
      const from = storey;
      storey = to;
      leftStorey = from;
      // the storey left behind: short keep-alive (refreshed while the player stays at the tower / elevator)
      const until = clock() + LEFT_STOREY_KEEPALIVE_MS;
      for (let i = 0; i < chunkList.length; i++) {
        const c = chunkList[i];
        if (c.s === from && c.keepUntil > until) c.keepUntil = until;
      }
      for (let s = 0; s < 3; s++) storeyGroups[s].visible = s === to;
      // tiles of the OLD storey that are still fading in finish now (they are hidden from here on; no dither left
      // behind if the player comes back before they are evicted)
      for (let i = fadeList.length - 1; i >= 0; i--) {
        const t = fadeList[i];
        if (t.key.s !== to) {
          uploader.setFade(t.gpu as TileGpu, 1);
          t.state = 'resident';
          (t.rt as TileRuntime).state = 'resident';
          removeFade(t);
        }
      }
      for (let i = 0; i < chunkList.length; i++) chunkList[i].desired = false;
      // re-target the desired set now (same x/z, new storey); the old storey is evicted progressively by sweep()
      if (!Number.isNaN(pcx)) {
        retarget();
        reprioritize();
        dirty = false;
      } else dirty = true;
    },

    attachDynamicMesh(tileKey: string, m: MeshBuffers): DynamicMeshHandle | null {
      const t = tilesByKey.get(tileKey);
      if (!t || !t.gpu || t.evicted) return null;
      return uploader.attachDynamic(t.gpu, m);
    },

    isReady(radiusChunks, needFull) {
      if (Number.isNaN(pcx)) return false;
      const r = Math.max(0, radiusChunks | 0);
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const c = recs[storey].get(chunkNumKey(pcx + dx, pcz + dz));
          if (!c || c.key.cx !== pcx + dx || c.key.cz !== pcz + dz) return false;
          if (!c.data) {
            if (c.failed) continue; // logged loudly; never block readiness on a deterministic failure
            return false;
          }
          for (const t of c.tiles) if (!tileReady(t, needFull)) return false;
        }
      }
      return true;
    },

    isReadyNear(nearM, viewM, needFull) {
      if (Number.isNaN(pcx)) return false;
      const own = recs[storey].get(chunkNumKey(pcx, pcz));
      if (!own || !(own.data || own.failed)) return false;
      const reach = Math.max(nearM, viewM);
      const r = Math.ceil(reach / CHUNK_SIZE);
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const cx = pcx + dx, cz = pcz + dz;
          const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
          const d = rectDistance(px, pz, x0, z0, x0 + CHUNK_SIZE, z0 + CHUNK_SIZE);
          if (d > reach) continue;
          const c = recs[storey].get(chunkNumKey(cx, cz));
          if (!c || c.key.cx !== cx || c.key.cz !== cz) return false;
          if (!c.data) { if (c.failed) continue; return false; }
          for (const t of c.tiles) {
            const td = rectDistance(px, pz, t.ox, t.oz, t.ox + TILE_SIZE, t.oz + TILE_SIZE);
            const needed = td <= nearM || (td <= viewM && inView(t.ox, t.oz, TILE_SIZE));
            if (needed && !tileReady(t, needFull)) return false;
          }
        }
      }
      return true;
    },

    isIdle: () => pool.queued() === 0 && pool.busy() === 0 && uploadList.length === 0,

    setQuality(q) {
      const run = async (): Promise<void> => {
        const old = quality;
        quality = q;
        const bq = bakeQualityOf(q);
        const ob = init.bake;
        const tpcChanged = bq.tpc !== ob.tpc;
        const bakeChanged = tpcChanged || bq.shadowSamples !== ob.shadowSamples || bq.probeRays !== ob.probeRays;
        if (old.streamRadius !== q.streamRadius) dirty = true;
        if (!bakeChanged) return;
        init = { ...init, bake: bq };
        const ready = pool.reinit(init); // synchronously drops every queued job and in-flight result
        restartAllJobs(tpcChanged); // re-queued behind the init broadcast (per-worker FIFO)
        resubmitQueries(); // pending find/spawn/ascii would otherwise never settle
        dirty = true;
        await ready;
      };
      qualityChain = qualityChain.then(run, run);
      return qualityChain;
    },

    reset(nextInit) {
      const run = async (): Promise<void> => {
        while (chunkList.length > 0) evictChunk(chunkList[chunkList.length - 1]);
        // The frame loop is stopped during a seed change. Release old geometry now;
        // the bounded texture pool can reuse matching allocations for the new world.
        for (const d of disposeQ) {
          uploader.dispose(d.gpu);
          if (d.rt) d.rt.state = 'disposed';
        }
        disposeQ.length = 0;
        init = nextInit;
        dirty = true;
        resetMotion(motion);
        bakeLastMs = bakeSumMs = bakeN = buildSumMs = buildN = 0;
        const ready = pool.reinit(init);
        resubmitQueries();
        await ready;
      };
      qualityChain = qualityChain.then(run, run);
      return qualityChain;
    },

    findNearest(q, from, maxChunks) {
      return runQuery<'find'>({ t: 'find', job: 0, query: q, from: { s: from.s, x: from.x, z: from.z }, maxChunks }).then((r) => r.result);
    },
    spawn(s) {
      return runQuery<'spawn'>({ t: 'spawn', job: 0, s }).then((r) => r.result);
    },
    asciiMap(s, cx0, cz0, cx1, cz1) {
      return runQuery<'ascii'>({ t: 'ascii', job: 0, s, cx0, cz0, cx1, cz1 }).then((r) => r.text);
    },

    chunkLoaded(k) {
      const c = recs[k.s].get(chunkNumKey(k.cx, k.cz));
      return c !== undefined && c.key.cx === k.cx && c.key.cz === k.cz && c.data !== null;
    },

    stats(): StreamStats {
      let chunksResident = 0, layoutsPending = 0;
      for (let i = 0; i < chunkList.length; i++) {
        const c = chunkList[i];
        if (c.s !== storey) continue;
        if (c.data) chunksResident++;
        else if (c.layoutJob) layoutsPending++;
      }
      let tilesFull = 0;
      const live = liveList[storey];
      for (let i = 0; i < live.length; i++) if (live[i].rt?.bake === 'full') tilesFull++;
      const busy = pool.busy();
      let tilesOtherStoreys = 0;
      for (let s = 0; s < liveList.length; s++) if (s !== storey) tilesOtherStoreys += liveList[s].length;
      return {
        chunksResident, chunksDesired, layoutsPending, tilesResident: live.length, tilesOtherStoreys,
        tilesPreview: live.length - tilesFull, tilesFull, queued: pool.queued(), inFlight: busy,
        uploadsPending: uploadList.length, fadingIn: fadeList.length, workers: pool.size, workersBusy: busy,
        texturesPooled: uploader.texturesPooled(), bakeLastMs, bakeAvgMs: bakeN > 0 ? bakeSumMs / bakeN : 0,
        buildAvgMs: buildN > 0 ? buildSumMs / buildN : 0,
      };
    },

    dispose() {
      queries.clear(); // like the pool's dropped jobs, pending queries never settle after dispose
      while (chunkList.length > 0) evictChunk(chunkList[chunkList.length - 1]);
      for (const d of disposeQ) {
        uploader.dispose(d.gpu);
        if (d.rt) d.rt.state = 'disposed';
      }
      disposeQ.length = 0;
      uploader.destroy();
      root.removeFromParent();
    },
  };
  timings.set(streamer, timing);
  // debug surface for headless soak probes (the app's __backrooms API does not expose the streamer itself)
  (globalThis as { __streamTiming?: StreamTiming }).__streamTiming = timing;
  return streamer;
}
