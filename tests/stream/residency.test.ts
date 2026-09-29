// tests/stream/residency.test.ts (WP10) — the residency state machine with a fake uploader and a fake worker pool:
// at most 1 step per frame (+1 prefetch step), evict -> dispose next frame, prefetch issues layout jobs,
// isPrefetched false until the 9 layouts are registered, switchStorey swaps `query` in the same frame.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CHUNK_CELL_COUNT, CHUNK_SIZE, TILE_SIZE, UPLOAD } from '../../src/core/constants.ts';
import { EventBus, type GameEvents } from '../../src/core/events.ts';
import { chunkKeyStr, tileKeyStr, type ChunkKey, type TileKey } from '../../src/core/grid.ts';
import type { StoreyId } from '../../src/core/ids.ts';
import { createEmptyLayout, type ChunkLayout } from '../../src/core/layout.ts';
import { emptyMeshBuffers, type ChunkCollision, type LightmapData, type MeshBuffers, type TileMesh } from '../../src/core/mesh.ts';
import { bakeQualityOf, QUALITY, type QualityConfig } from '../../src/core/quality.ts';
import type { DynamicMeshHandle, TileMaterials, WorldStreamer } from '../../src/core/runtime.ts';
import type { WorkerInit, WorkerRequest, WorkerResponse } from '../../src/core/worker.ts';
import {
  createStreamerCore, getCaptureControl, LEFT_STOREY_KEEPALIVE_MS, MAX_DISPOSE_PER_FRAME, PREFETCH_KEEPALIVE_MS, RESIDENT_BUDGET_BYTES,
  type CaptureControl, type StreamerCoreOptions, type StreamScope,
} from '../../src/stream/ChunkStreamer.ts';
import { CAPTURE_NEAR_M, fogEnd, rectChebyshev, rectDistance } from '../../src/stream/priorities.ts';
import type { TileGpu, TileUploader } from '../../src/stream/TileObject.ts';
import type { JobHandle, WorkerPool } from '../../src/stream/WorkerPool.ts';

// ---------------------------------------------------------------- fakes

interface FakeJob { id: number; req: WorkerRequest; priority: number; cancelled: boolean; resolve(r: WorkerResponse): void; reject(e: Error): void; affinity?: string }

class FakePool implements WorkerPool {
  size = 4;
  jobs: FakeJob[] = [];
  reinits = 0;
  private next = 1;
  submit<T extends WorkerRequest['t']>(req: Extract<WorkerRequest, { t: T }>, priority: number, affinity?: string): JobHandle<Extract<WorkerResponse, { t: T }>> {
    const id = this.next++;
    let job!: FakeJob;
    const promise = new Promise<Extract<WorkerResponse, { t: T }>>((resolve, reject) => {
      job = { id, req: { ...req, job: id } as WorkerRequest, priority, cancelled: false, resolve: (r) => resolve(r as Extract<WorkerResponse, { t: T }>), reject, affinity };
    });
    this.jobs.push(job);
    return {
      id, promise,
      get priority() { return job.priority; },
      set priority(p: number) { job.priority = p; },
      cancel() { job.cancelled = true; },
    };
  }
  reinit(): Promise<void> {
    this.reinits++;
    for (const j of this.jobs) j.cancelled = true;
    return Promise.resolve();
  }
  resize(n: number): Promise<void> { this.size = n; return Promise.resolve(); }
  queued(): number { return this.pending().length; }
  busy(): number { return 0; }
  dispose(): void {}
  pending(t?: WorkerRequest['t']): FakeJob[] { return this.jobs.filter((j) => !j.cancelled && (t === undefined || j.req.t === t)); }
  take(t: WorkerRequest['t'], pred: (j: FakeJob) => boolean = () => true): FakeJob[] {
    const out = this.pending(t).filter(pred);
    for (const j of out) j.cancelled = true; // answered: no longer pending
    return out;
  }
}

function fakeLayout(k: ChunkKey, floorCm: number): ChunkLayout {
  const l = createEmptyLayout(k, 0, 1, 0);
  l.floorCm.fill(floorCm);
  l.ceilCm.fill(floorCm + 270);
  return l;
}
const fakeCollision = (k: ChunkKey): ChunkCollision => ({
  chunkKey: chunkKeyStr(k), boxes: new Float32Array(0), boxFlags: new Uint8Array(0),
  cellStart: new Uint32Array(CHUNK_CELL_COUNT + 1), cellBoxes: new Uint32Array(0), ramps: new Float32Array(0),
});
function fakeMesh(k: TileKey, hash: number): TileMesh {
  const shell: MeshBuffers = { ...emptyMeshBuffers(), bounds: [0, 0, 0, TILE_SIZE, 2.7, TILE_SIZE] };
  return {
    tileKey: tileKeyStr(k), zone: 0, shell, props: null, water: null, decals: null,
    atlas: { width: 4, height: 4, tpc: 8, chartHash: hash, chartCount: 0 }, dynLights: new Array(9).fill(null), tris: 0,
  };
}
function fakeLm(k: TileKey, variant: 'preview' | 'full', hash: number): LightmapData {
  return {
    tileKey: tileKeyStr(k), variant, width: 4, height: 4, chartHash: hash, irr: new Uint16Array(64), dir: new Uint8Array(64),
    flick: null, mask: new Uint8Array(64), emission: new Uint16Array(4), volume: { a: new Uint16Array(4), b: new Uint8Array(4), c: null, wallMask: new Uint8Array(4) },
    stats: { ms: 1, texels: 16, rays: 0, lights: 0 },
  };
}

interface Call { op: string; key: string; frame: number; done: boolean }
/** Fake GPU side. Every resumable call is recorded (op tex|geo|swap, done = the step completed in that call). Steps
 * are `texUnits`/`geoUnits`/`swapUnits` units long; each unit advances the streamer's budget clock by `unitMs`. */
class FakeUploader implements TileUploader {
  calls: Call[] = [];
  frame = 0;
  disposed = new Set<string>();
  stagedSwaps = new Set<string>();
  cancelledSwaps: string[] = [];
  fades = new Map<string, number>();
  failTex = new Set<string>();
  work = { t: 0 };
  unitMs = 0;
  texUnits = 1; geoUnits = 1; swapUnits = 1;
  units: { op: string; key: string; frame: number; lm: unknown }[] = [];
  private cur = new Map<string, { of: unknown; n: number }>();
  private run(op: string, key: string, of: unknown, total: number, more: () => boolean): boolean {
    let c = this.cur.get(op + key);
    if (!c || c.of !== of) this.cur.set(op + key, (c = { of, n: 0 }));
    do {
      c.n++;
      this.work.t += this.unitMs;
      this.units.push({ op, key, frame: this.frame, lm: of });
    } while (c.n < total && more());
    const done = c.n >= total;
    if (done) this.cur.delete(op + key);
    this.calls.push({ op, key, frame: this.frame, done });
    return done;
  }
  createTile(key: TileKey): TileGpu {
    const materials = { bindings: { fade: { value: 0 } }, dispose() {} } as unknown as TileMaterials;
    const group = new THREE.Group();
    return { key: tileKeyStr(key), group, materials, props: null, bounds: new Float64Array([0, 0, 0, TILE_SIZE, 2.7, TILE_SIZE]) };
  }
  uploadTextures(gpu: TileGpu, lm: LightmapData, more: () => boolean): boolean {
    if (this.failTex.has(gpu.key)) {
      this.calls.push({ op: 'tex', key: gpu.key, frame: this.frame, done: false });
      throw new Error('texture upload exploded');
    }
    return this.run('tex', gpu.key, lm, this.texUnits, more);
  }
  uploadGeometry(gpu: TileGpu, m: TileMesh, parent: THREE.Group, more: () => boolean): boolean {
    const done = this.run('geo', gpu.key, m, this.geoUnits, more);
    if (done) parent.add(gpu.group);
    return done;
  }
  swapLightmap(gpu: TileGpu, lm: LightmapData, more: () => boolean): boolean {
    const done = this.run('swap', gpu.key, lm, this.swapUnits, more);
    if (done) this.stagedSwaps.delete(gpu.key); else this.stagedSwaps.add(gpu.key);
    return done;
  }
  cancelLightmapSwap(gpu: TileGpu): void {
    this.cancelledSwaps.push(gpu.key);
    this.stagedSwaps.delete(gpu.key);
    this.cur.delete('swap' + gpu.key);
  }
  setFade(gpu: TileGpu, f: number): void { this.fades.set(gpu.key, f); }
  attachDynamic(): DynamicMeshHandle { return { setOffset() {}, dispose() {} }; }
  moveDynamics(): void {}
  dispose(gpu: TileGpu): void {
    this.calls.push({ op: 'dispose', key: gpu.key, frame: this.frame, done: true });
    expect(gpu.group.parent, 'disposed while still in the scene').toBe(null);
    this.disposed.add(gpu.key);
  }
  texturesPooled(): number { return 0; }
  destroy(): void {}
  steps(frame: number): Call[] { return this.calls.filter((c) => c.frame === frame && c.op !== 'dispose'); }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Rig {
  st: WorldStreamer; pool: FakePool; up: FakeUploader; bus: EventBus<GameEvents>; clock: { t: number };
  frame: number;
  tick(x: number, z: number, ms?: number): void;
  answerLayouts(pred?: (k: ChunkKey) => boolean, floor?: (k: ChunkKey) => number): Promise<number>;
  answerBuilds(pred?: (k: TileKey) => boolean): Promise<number>;
  answerBakes(pred?: (k: TileKey) => boolean): Promise<number>;
}

function rig(q: QualityConfig = { ...QUALITY.low, streamRadius: 1 }, start: StoreyId = 0, extra: Partial<StreamerCoreOptions> = {}): Rig {
  const pool = new FakePool();
  const up = new FakeUploader();
  const bus = new EventBus<GameEvents>();
  const clock = { t: 0 };
  const init: WorkerInit = {
    opts: { seed: 1, seedText: '1', forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' },
    bake: bakeQualityOf(q), bakeTerm: 'all', validate: false,
  };
  const st = createStreamerCore({
    quality: q, init, bus, pool, startStorey: start, uploader: up, clock: () => clock.t, budgetClock: () => up.work.t, ...extra,
  });
  const r: Rig = {
    st, pool, up, bus, clock, frame: 0,
    tick(x, z, ms = 16) {
      r.frame++;
      up.frame = r.frame;
      clock.t += ms;
      st.update(x, z, 0, -1, null as unknown as THREE.Camera, r.frame);
      st.processUploads(null as unknown as THREE.WebGLRenderer, 3);
    },
    async answerLayouts(pred = () => true, floor = () => 0) {
      const js = pool.take('layout', (j) => pred((j.req as Extract<WorkerRequest, { t: 'layout' }>).key));
      for (const j of js) {
        const k = (j.req as Extract<WorkerRequest, { t: 'layout' }>).key;
        j.resolve({ t: 'layout', job: j.id, layout: fakeLayout(k, floor(k)), collision: fakeCollision(k), ms: 1 });
      }
      await flush();
      return js.length;
    },
    async answerBuilds(pred = () => true) {
      const js = pool.take('build', (j) => pred((j.req as Extract<WorkerRequest, { t: 'build' }>).key));
      for (const j of js) {
        const req = j.req as Extract<WorkerRequest, { t: 'build' }>;
        const k = req.key;
        j.resolve({ t: 'build', job: j.id, mesh: fakeMesh(k, 7), lightmap: fakeLm(k, req.lighting ?? 'preview', 7), ms: { gen: 1, mesh: 1, bake: 1 } });
      }
      await flush();
      return js.length;
    },
    async answerBakes(pred = () => true) {
      const js = pool.take('bake', (j) => pred((j.req as Extract<WorkerRequest, { t: 'bake' }>).key));
      for (const j of js) {
        const k = (j.req as Extract<WorkerRequest, { t: 'bake' }>).key;
        j.resolve({ t: 'bake', job: j.id, lightmap: fakeLm(k, 'full', 7), ms: 5 });
      }
      await flush();
      return js.length;
    },
  };
  return r;
}

const C = CHUNK_SIZE;

describe('residency state machine', () => {
  it('requests layouts + builds for the desired set, own chunk first', () => {
    const r = rig();
    r.tick(C / 2, C / 2);
    expect(r.pool.pending('layout').length).toBe(9);
    expect(r.pool.pending('build').length).toBe(36);
    const builds = r.pool.pending('build');
    const best = builds.reduce((a, b) => (b.priority < a.priority ? b : a));
    const k = (best.req as Extract<WorkerRequest, { t: 'build' }>).key;
    expect([k.cx, k.cz]).toEqual([0, 0]);
    // every layout/build/bake job carries the chunk key as affinity
    for (const j of r.pool.pending()) expect(j.affinity).toMatch(/^0:-?\d+:-?\d+$/);
  });

  it('does at most 1 residency step per frame (+1 prefetch step), texture then geometry', async () => {
    const r = rig();
    r.tick(C / 2, C / 2);
    r.st.prefetch(1, C / 2, C / 2, 1);
    await r.answerLayouts();
    await r.answerBuilds();
    let frames = 0;
    while (!r.st.isIdle() && frames < 400) {
      r.tick(C / 2, C / 2);
      const steps = r.up.steps(r.frame);
      const main = steps.filter((c) => c.key.startsWith('0:'));
      const pf = steps.filter((c) => c.key.startsWith('1:'));
      expect(main.length).toBeLessThanOrEqual(UPLOAD.MAX_STEPS_PER_FRAME);
      expect(pf.length).toBeLessThanOrEqual(UPLOAD.PREFETCH_STEPS_PER_FRAME);
      if (frames < 60) expect(pf.length).toBe(1); // the prefetch slot is never starved by current-storey uploads
      frames++;
      if (frames % 20 === 0) { await r.answerBakes(); }
    }
    // 72 tiles x (tex + geo) steps, each tile's texture step strictly before its geometry step
    const tex = r.up.calls.filter((c) => c.op === 'tex');
    const geo = r.up.calls.filter((c) => c.op === 'geo');
    expect(tex.length).toBe(72);
    expect(geo.length).toBe(72);
    for (const g of geo) {
      const t = tex.find((c) => c.key === g.key) as Call;
      expect(t.frame).toBeLessThan(g.frame);
    }
  });

  it('a step longer than the budget resumes on later frames: one tile per slot, budget + 1 unit, started step first', async () => {
    const r = rig({ ...QUALITY.low, streamRadius: 0 });
    r.up.texUnits = 9; r.up.geoUnits = 4; r.up.swapUnits = 9; r.up.unitMs = 1.2; // budget 3 ms => 3 units per frame
    r.tick(C / 2, C / 2);
    r.st.prefetch(1, C / 2, C / 2, 0);
    await r.answerLayouts();
    await r.answerBuilds();
    let frames = 0;
    while (!r.st.isIdle() && frames < 200) {
      const w0 = r.up.work.t;
      r.tick(C / 2, C / 2);
      const us = r.up.units.filter((u) => u.frame === r.frame);
      const main = us.filter((u) => u.key.startsWith('0:'));
      const pf = us.filter((u) => u.key.startsWith('1:'));
      expect(new Set(main.map((u) => u.key)).size).toBeLessThanOrEqual(UPLOAD.MAX_STEPS_PER_FRAME);
      expect(new Set(pf.map((u) => u.key)).size).toBeLessThanOrEqual(UPLOAD.PREFETCH_STEPS_PER_FRAME);
      // the current slot starts a unit only when it still fits in the budget (3 ms); the prefetch slot still does one
      expect(main.length * r.up.unitMs).toBeLessThanOrEqual(3 + 1e-9);
      expect(r.up.work.t - w0).toBeLessThanOrEqual(3 + r.up.unitMs + 1e-9);
      if (frames < 10) expect(pf.length).toBeGreaterThanOrEqual(1);
      frames++;
      if (frames === 5) await r.answerBakes();
    }
    expect(r.st.isIdle()).toBe(true);
    // a started step is finished before its slot starts another one: every tile's units of one step are contiguous
    for (const pre of ['0:', '1:']) {
      const seq = r.up.units.filter((u) => u.key.startsWith(pre)).map((u) => `${u.op}|${u.key}`);
      const seen = new Set<string>();
      for (let i = 0; i < seq.length; i++) {
        if (i > 0 && seq[i] !== seq[i - 1]) {
          expect(seen.has(seq[i]), `${seq[i]} resumed after another step ran`).toBe(false);
          seen.add(seq[i - 1]);
        }
      }
    }
    expect(r.up.calls.filter((c) => c.op === 'tex' && c.done).length).toBe(8);
    expect(r.up.calls.filter((c) => c.op === 'geo' && c.done).length).toBe(8);
    // steps really spanned several frames
    expect(r.up.calls.filter((c) => c.op === 'tex' && !c.done).length).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) r.tick(C / 2, C / 2, 20); // finish the fades
    expect(r.st.isReady(0, true)).toBe(true);
    expect(r.st.isPrefetched(1, C / 2, C / 2)).toBe(false); // radius-0 prefetch: neighbours never requested
    expect(r.st.scene.children[1].children.length).toBe(4);
  });

  it('a full bake that arrives during a started texture step is swapped in after the geometry step', async () => {
    const r = rig({ ...QUALITY.low, streamRadius: 0 });
    r.up.texUnits = 9; r.up.unitMs = 1.2;
    r.tick(C / 2, C / 2);
    await r.answerLayouts();
    await r.answerBuilds();
    r.tick(C / 2, C / 2); // first tile: texture step started with the preview (3 of 9 units)
    const first = r.up.units[0];
    expect((first.lm as LightmapData).variant).toBe('preview');
    await r.answerBakes();
    for (let i = 0; i < 80; i++) r.tick(C / 2, C / 2, 20);
    // the started step finished with the preview (never mixes two lightmaps), then the full bake was swapped in
    const texOfFirst = r.up.units.filter((u) => u.op === 'tex' && u.key === first.key);
    expect(texOfFirst.every((u) => u.lm === first.lm)).toBe(true);
    const swaps = r.up.calls.filter((c) => c.op === 'swap' && c.done);
    expect(swaps.map((c) => c.key)).toEqual([first.key]);
    // the other tiles uploaded the full bake directly
    for (const u of r.up.units.filter((x) => x.op === 'tex' && x.key !== first.key)) expect((u.lm as LightmapData).variant).toBe('full');
    expect(r.st.isReady(0, true)).toBe(true);
  });

  it('a tile evicted in the middle of a step disposes its half-uploaded build', async () => {
    const r = rig({ ...QUALITY.low, streamRadius: 0 });
    r.up.texUnits = 9; r.up.unitMs = 1.2;
    r.tick(C / 2, C / 2);
    await r.answerLayouts();
    await r.answerBuilds();
    r.tick(C / 2, C / 2);
    const k = r.up.units[0].key;
    for (let i = 0; i < 10; i++) r.tick(10 * C, 10 * C);
    expect(r.up.disposed.has(k)).toBe(true);
    expect(r.up.calls.some((c) => c.key === k && c.op === 'geo')).toBe(false);
    expect(r.st.chunkLoaded({ s: 0, cx: 0, cz: 0 })).toBe(false);
  });

  it('fades in over UPLOAD.FADE_IN_S; isReady needs resident tiles (and full bakes when asked)', async () => {
    const r = rig();
    r.tick(C / 2, C / 2);
    await r.answerLayouts();
    await r.answerBuilds();
    for (let i = 0; i < 80; i++) r.tick(C / 2, C / 2, 1); // 1 ms frames: uploads done, fades not
    expect(r.st.stats().fadingIn).toBeGreaterThan(0);
    expect(r.st.isReady(1, false)).toBe(false);
    for (let i = 0; i < 40; i++) r.tick(C / 2, C / 2, 20);
    expect(r.st.stats().fadingIn).toBe(0);
    expect([...r.up.fades.values()].every((f) => f === 1)).toBe(true);
    expect(r.st.isReady(1, false)).toBe(true);
    expect(r.st.isReady(1, true)).toBe(false);
    expect(await r.answerBakes()).toBe(36);
    for (let i = 0; i < 40; i++) r.tick(C / 2, C / 2);
    expect(r.up.calls.filter((c) => c.op === 'swap').length).toBe(36); // texture step only, no new geometry
    expect(r.up.calls.filter((c) => c.op === 'geo').length).toBe(36);
    expect(r.st.isReady(1, true)).toBe(true);
    const s = r.st.stats();
    expect(s.tilesResident).toBe(36);
    expect(s.tilesFull).toBe(36);
    expect([...r.st.tiles()].length).toBe(36);
  });

  it('a full bake that arrives before the texture step is uploaded directly (no swap)', async () => {
    const r = rig({ ...QUALITY.low, streamRadius: 0 });
    r.tick(C / 2, C / 2);
    await r.answerLayouts();
    await r.answerBuilds();
    await r.answerBakes();
    for (let i = 0; i < 60; i++) r.tick(C / 2, C / 2, 20);
    expect(r.up.calls.filter((c) => c.op === 'tex').length).toBe(4);
    expect(r.up.calls.filter((c) => c.op === 'swap').length).toBe(0);
    expect(r.st.isReady(0, true)).toBe(true);
  });

  it('evict -> removed from the scene at once, disposed on a later frame', async () => {
    const r = rig();
    r.tick(C / 2, C / 2);
    await r.answerLayouts();
    await r.answerBuilds();
    for (let i = 0; i < 120; i++) r.tick(C / 2, C / 2, 20);
    expect(r.st.isReady(1, false)).toBe(true);
    const unloaded: string[] = [];
    r.bus.on('tileUnloaded', (e) => unloaded.push(e.key));
    // teleport far away: every old chunk leaves the hysteresis band
    const far = 20 * C;
    let evictFrame = -1;
    for (let i = 0; i < 80; i++) {
      r.tick(far, far);
      if (unloaded.length > 0 && evictFrame < 0) {
        evictFrame = r.frame;
        // the evicted tiles' disposal did not happen in the eviction frame
        const disposedNow = r.up.calls.filter((c) => c.op === 'dispose' && c.frame === r.frame);
        expect(disposedNow.length).toBe(0);
      }
      const d = r.up.calls.filter((c) => c.op === 'dispose' && c.frame === r.frame);
      expect(d.length).toBeLessThanOrEqual(MAX_DISPOSE_PER_FRAME);
    }
    expect(unloaded.length).toBe(36);
    expect(r.up.disposed.size).toBe(36);
    const firstDispose = r.up.calls.find((c) => c.op === 'dispose') as Call;
    expect(firstDispose.frame).toBeGreaterThan(evictFrame);
    expect(r.st.query.isLoaded(C / 2, C / 2)).toBe(false);
    expect(r.st.chunkLoaded({ s: 0, cx: 0, cz: 0 })).toBe(false);
  });

  it('prefetch issues layout jobs; isPrefetched is false until the 9 layouts are registered and tiles are uploaded', async () => {
    const r = rig();
    const x = 5 * C + 3, z = -2 * C + 7;
    r.tick(C / 2, C / 2);
    await r.answerLayouts();
    await r.answerBuilds();
    r.st.prefetch(2, x, z, 1);
    const pl = r.pool.pending('layout').filter((j) => (j.req as Extract<WorkerRequest, { t: 'layout' }>).key.s === 2);
    expect(pl.length).toBe(9);
    // prefetch jobs queue behind current-storey work
    const mainBakes = r.pool.pending('bake').filter((j) => (j.req as Extract<WorkerRequest, { t: 'bake' }>).key.s === 0);
    expect(mainBakes.length).toBe(36);
    const mainBake = Math.max(...mainBakes.map((j) => j.priority));
    const pfBuild = Math.min(...r.pool.pending('build').filter((j) => (j.req as Extract<WorkerRequest, { t: 'build' }>).key.s === 2).map((j) => j.priority));
    expect(pfBuild).toBeGreaterThan(mainBake);
    // idempotent: a repeated call (keep-alive) submits nothing new
    const before = r.pool.jobs.length;
    r.st.prefetch(2, x, z, 1);
    expect(r.pool.jobs.length).toBe(before);
    // 8 of 9 layouts
    let n = 0;
    await r.answerLayouts((k) => k.s === 2 && !(k.cx === 6 && k.cz === -1) && ++n <= 8);
    expect(r.st.isPrefetched(2, x, z)).toBe(false);
    await r.answerLayouts((k) => k.s === 2);
    expect(r.st.chunkLoaded({ s: 2, cx: 6, cz: -1 })).toBe(true);
    expect(r.st.isPrefetched(2, x, z)).toBe(false); // tiles not uploaded yet
    await r.answerBuilds((k) => k.s === 2);
    for (let i = 0; i < 100; i++) r.tick(C / 2, C / 2);
    expect(r.st.isPrefetched(2, x, z)).toBe(false); // centre chunk not full-baked yet
    await r.answerBakes((k) => k.s === 2 && k.cx === 5 && k.cz === -2);
    for (let i = 0; i < 10; i++) r.tick(C / 2, C / 2);
    expect(r.st.isPrefetched(2, x, z)).toBe(true);
    // prefetched groups are hidden (their storey group is invisible) and never fade
    const g = r.st.scene.children[2];
    expect(g.visible).toBe(false);
    expect(g.children.length).toBe(36);
  });

  it('switchStorey swaps `query` so floorAt in the new storey is finite in the same frame', async () => {
    const r = rig();
    const x = C / 2, z = C / 2;
    r.tick(x, z);
    await r.answerLayouts((k) => k.s === 0, () => 0);
    r.st.prefetch(1, x, z, 1);
    await r.answerLayouts((k) => k.s === 1, () => -300);
    expect(r.st.query.floorAt(x, z, 0)).toBe(0);
    expect(r.st.query.storey).toBe(0);
    r.st.switchStorey(1);
    // same frame, no update() in between
    expect(r.st.query.storey).toBe(1);
    expect(r.st.storey).toBe(1);
    expect(r.st.query.floorAt(x, z, -3)).toBe(-3);
    expect(Number.isFinite(r.st.query.floorAt(x, z, -3))).toBe(true);
    expect(r.st.scene.children[0].visible).toBe(false);
    expect(r.st.scene.children[1].visible).toBe(true);
    // the desired set is re-targeted in the same call: storey 1's ring (radius 1) is desired, no longer "prefetch"
    expect(r.st.stats().chunksDesired).toBe(9);
    expect(r.st.stats().chunksResident).toBe(9);
    const builds1 = r.pool.pending('build').filter((j) => (j.req as Extract<WorkerRequest, { t: 'build' }>).key.s === 1);
    expect(builds1.length).toBe(36);
    expect(Math.max(...builds1.map((j) => j.priority))).toBeLessThan(400); // PREFETCH_OFFSET no longer applies
  });

  it('the old storey is evicted progressively after a switch; prefetched data expires after 10 s', async () => {
    const r = rig();
    const x = C / 2, z = C / 2;
    r.tick(x, z);
    await r.answerLayouts();
    r.st.prefetch(1, x, z, 1);
    await r.answerLayouts();
    r.st.switchStorey(1);
    let unloadedPerFrame = 0;
    const counts: number[] = [];
    r.bus.on('chunkUnloaded', () => unloadedPerFrame++);
    for (let i = 0; i < 10; i++) { unloadedPerFrame = 0; r.tick(x, z); counts.push(unloadedPerFrame); }
    expect(Math.max(...counts)).toBeLessThanOrEqual(2);
    expect(r.st.chunkLoaded({ s: 0, cx: 0, cz: 0 })).toBe(false);
    // storey 1 is now the current storey: its chunks are desired (no expiry)
    r.clock.t += 20_000;
    r.tick(x, z);
    expect(r.st.chunkLoaded({ s: 1, cx: 0, cz: 0 })).toBe(true);
    // a prefetch of another storey without keep-alive expires
    r.st.prefetch(2, x, z, 0);
    await r.answerLayouts((k) => k.s === 2);
    r.tick(x, z);
    expect(r.st.chunkLoaded({ s: 2, cx: 0, cz: 0 })).toBe(true);
    r.tick(x, z, 11_000);
    expect(r.st.chunkLoaded({ s: 2, cx: 0, cz: 0 })).toBe(false);
  });

  it('the storey just left keeps ~2 s of prefetch keep-alive (refreshed at the tower), others 10 s (R2 B9)', async () => {
    const r = rig();
    const x = C / 2, z = C / 2;
    r.tick(x, z);
    await r.answerLayouts();
    r.st.prefetch(1, x, z, 0);
    r.st.prefetch(0, x, z, 0); // (the current storey's own chunk: desired anyway)
    await r.answerLayouts();
    r.st.switchStorey(1);
    // the traversal's proximity tick prefetches the storey below (storey 0: the one just left) while at the tower
    for (let i = 0; i < 40; i++) {
      if (i % 15 === 0) r.st.prefetch(0, x, z, 0);
      r.tick(x, z, 100);
    }
    expect(r.st.chunkLoaded({ s: 0, cx: 0, cz: 0 })).toBe(true); // still at the tower: alive
    // walked away: no more prefetch calls -> gone ~2 s later (not 10 s)
    for (let i = 0; i < Math.ceil(LEFT_STOREY_KEEPALIVE_MS / 100) + 5; i++) r.tick(x, z, 100);
    expect(r.st.chunkLoaded({ s: 0, cx: 0, cz: 0 })).toBe(false);
    // a storey that was not just left keeps the full keep-alive
    r.st.prefetch(2, x, z, 0);
    await r.answerLayouts((k) => k.s === 2);
    for (let i = 0; i < Math.ceil(LEFT_STOREY_KEEPALIVE_MS / 100) + 5; i++) r.tick(x, z, 100);
    expect(r.st.chunkLoaded({ s: 2, cx: 0, cz: 0 })).toBe(true);
    r.tick(x, z, PREFETCH_KEEPALIVE_MS);
    expect(r.st.chunkLoaded({ s: 2, cx: 0, cz: 0 })).toBe(false);
  });

  it('over the GPU budget, the farthest non-desired (hysteresis) chunks go early; the desired set never (R2 B9)', async () => {
    const q = { ...QUALITY.low, streamRadius: 1 };
    const r = rig(q);
    let bytes = 0;
    (r.up as unknown as { memory(): unknown }).memory = () => ({ texLive: 0, texBytes: bytes, texPooled: 0, texPooledBytes: 0, geoBytes: 0, meshes: 0 });
    const x = C / 2, z = C / 2;
    r.tick(x, z);
    await r.answerLayouts();
    await r.answerBuilds();
    for (let i = 0; i < 200 && !r.st.isIdle(); i++) r.tick(x, z);
    // one chunk east: the west column (cx = -1) is outside the desired set but inside the hysteresis ring
    const x2 = x + C;
    for (let i = 0; i < 40; i++) r.tick(x2, z);
    await r.answerLayouts();
    await r.answerBuilds();
    for (let i = 0; i < 300 && !r.st.isIdle(); i++) r.tick(x2, z);
    expect(r.st.chunkLoaded({ s: 0, cx: -1, cz: 0 })).toBe(true); // within budget: kept by hysteresis
    bytes = RESIDENT_BUDGET_BYTES.low * 2;
    for (let i = 0; i < 200; i++) r.tick(x2, z);
    for (const cz of [-1, 0, 1]) expect(r.st.chunkLoaded({ s: 0, cx: -1, cz })).toBe(false);
    for (let cx = 0; cx <= 2; cx++) for (let cz = -1; cz <= 1; cz++) expect(r.st.chunkLoaded({ s: 0, cx, cz })).toBe(true);
  });

  it('after a switch, the old storey (no prefetch keep-alive) gets no more upload steps while it is evicted', async () => {
    const r = rig();
    const x = C / 2, z = C / 2;
    r.tick(x, z);
    await r.answerLayouts();
    await r.answerBuilds(); // 36 storey-0 tiles waiting for their texture step
    r.st.switchStorey(1);
    for (let i = 0; i < 30; i++) r.tick(x, z);
    expect(r.up.calls.filter((c) => (c.op === 'tex' || c.op === 'geo') && c.key.startsWith('0:')).length).toBe(0);
    // coming back (e.g. the player walks back up the tower) resumes them as current-storey uploads
    r.st.switchStorey(0);
    await r.answerLayouts();
    await r.answerBuilds();
    for (let i = 0; i < 10; i++) r.tick(x, z);
    expect(r.up.calls.filter((c) => c.op === 'tex' && c.key.startsWith('0:')).length).toBeGreaterThan(0);
  });

  it('attachDynamicMesh: null unless the tile is uploaded; stale jobs of evicted tiles are cancelled', async () => {
    const r = rig({ ...QUALITY.low, streamRadius: 0 });
    r.tick(C / 2, C / 2);
    expect(r.st.attachDynamicMesh('0:0:0:0', emptyMeshBuffers())).toBe(null);
    await r.answerLayouts();
    await r.answerBuilds();
    for (let i = 0; i < 10; i++) r.tick(C / 2, C / 2);
    expect(r.st.attachDynamicMesh('0:0:0:0', emptyMeshBuffers())).not.toBe(null);
    r.tick(10 * C, 10 * C);
    for (let i = 0; i < 5; i++) r.tick(10 * C, 10 * C);
    expect(r.st.attachDynamicMesh('0:0:0:0', emptyMeshBuffers())).toBe(null);
    // bake jobs of the evicted chunk were cancelled
    expect(r.pool.pending('bake').some((j) => (j.req as Extract<WorkerRequest, { t: 'bake' }>).key.cx === 0)).toBe(false);
  });

  it('setQuality: radius change re-targets; BakeQuality change reinits the pool and rebuilds', async () => {
    const q = { ...QUALITY.low, streamRadius: 1 };
    const r = rig(q);
    r.tick(C / 2, C / 2);
    await r.answerLayouts();
    await r.answerBuilds();
    for (let i = 0; i < 100; i++) r.tick(C / 2, C / 2, 20);
    expect(r.st.isReady(1, false)).toBe(true);
    await r.st.setQuality({ ...q, streamRadius: 2 });
    r.tick(C / 2, C / 2);
    expect(r.st.stats().chunksDesired).toBe(25);
    expect(r.pool.reinits).toBe(0);
    await r.st.setQuality({ ...QUALITY.high, streamRadius: 2 }); // tpc 8 -> 12
    expect(r.pool.reinits).toBe(1);
    const builds = r.pool.pending('build');
    expect(builds.length).toBe(100); // everything is rebuilt (new atlas)
    // the displayed tiles stay until their replacement is uploaded
    expect(r.st.isReady(1, false)).toBe(true);
  });

  it('retains a distant portal door pose when a quality change replaces its geometry', async () => {
    const r = rig({ ...QUALITY.low, streamRadius: 0 });
    const upload = r.up.uploadGeometry.bind(r.up);
    r.up.uploadGeometry = (gpu, mesh, parent, more) => {
      const done = upload(gpu, mesh, parent, more);
      if (done && gpu.key === '0:0:0:0') {
        const leaf = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 2.1));
        leaf.name = 'door:123';
        leaf.userData.door = { x: 0, y: 0, z: 0, yaw: 0,
          position: (leaf.geometry.getAttribute('position').array as Float32Array).slice(),
          normal: (leaf.geometry.getAttribute('normal').array as Float32Array).slice() };
        gpu.group.add(leaf);
      }
      return done;
    };
    r.tick(C / 2, C / 2);
    await r.answerLayouts(); await r.answerBuilds();
    for (let i = 0; i < 20; i++) r.tick(C / 2, C / 2);
    r.st.setDoorYaw!(0, 0, 0, 123, Math.PI / 2);
    const old = r.st.scene.getObjectByName('door:123') as THREE.Mesh;
    expect(old.geometry.getAttribute('normal').getX(0)).toBeCloseTo(1, 6);
    // The player is now in the remote room, outside the active 3x3 door scan.
    r.st.prefetch(0, C / 2, C / 2, 1);
    r.tick(3.5 * C, 3.5 * C);
    await r.answerLayouts(); await r.answerBuilds();
    await r.st.setQuality({ ...QUALITY.high, streamRadius: 0 });
    await r.answerBuilds();
    for (let i = 0; i < 120; i++) r.tick(3.5 * C, 3.5 * C);
    const fresh = r.st.scene.getObjectByName('door:123') as THREE.Mesh;
    expect(fresh).not.toBe(old);
    expect(fresh.geometry.getAttribute('normal').getX(0)).toBeCloseTo(1, 6);
    r.st.dispose();
  });

  it.each(['same atlas quality', 'new atlas quality', 'eviction', 'reset'] as const)(
    '%s cancels unfinished live-tile lightmap uploads immediately', async (action) => {
      const r = rig({ ...QUALITY.low, streamRadius: 0 });
      r.tick(C / 2, C / 2);
      await r.answerLayouts();
      await r.answerBuilds();
      for (let i = 0; i < 60; i++) r.tick(C / 2, C / 2, 20);
      const displayed = [...r.st.tiles()].find((t) => t.key.q === 0)!;
      const materials = displayed.materials;
      r.up.swapUnits = 9;
      r.up.unitMs = 1.2;
      expect(await r.answerBakes((k) => k.q === 0)).toBe(1);
      r.tick(C / 2, C / 2);
      expect(r.up.stagedSwaps.has(displayed.keyStr)).toBe(true);
      if (action === 'same atlas quality' || action === 'new atlas quality') {
        await r.st.setQuality({ ...(action === 'same atlas quality' ? QUALITY.medium : QUALITY.high), streamRadius: 0 });
        expect(displayed.materials).toBe(materials);
        expect(r.st.stats().tilesResident).toBe(4);
      } else if (action === 'eviction') {
        r.tick(10 * C, 10 * C);
      } else {
        await r.st.reset({
          opts: { seed: 2, seedText: '2', forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' },
          bake: bakeQualityOf({ ...QUALITY.low, streamRadius: 0 }), bakeTerm: 'all', validate: false,
        });
      }
      expect(r.up.stagedSwaps.size).toBe(0);
      expect(r.up.cancelledSwaps).toContain(displayed.keyStr);
    },
  );
  it('a residency step that throws fails that tile once (logged) instead of throwing every frame', async () => {
    const r = rig({ ...QUALITY.low, streamRadius: 0 });
    r.up.failTex.add('0:0:0:1');
    const errs: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errs.push(a); };
    try {
      r.tick(C / 2, C / 2);
      await r.answerLayouts();
      await r.answerBuilds();
      for (let i = 0; i < 60; i++) expect(() => r.tick(C / 2, C / 2, 20)).not.toThrow();
    } finally { console.error = orig; }
    expect(errs.length).toBeGreaterThan(0);
    expect(r.up.calls.filter((c) => c.op === 'tex' && c.key === '0:0:0:1').length).toBe(1);
    expect(r.st.stats().tilesResident).toBe(3);
    expect(r.st.stats().uploadsPending).toBe(0);
  });

  it('pending find / spawn queries survive a BakeQuality reinit (re-submitted, never stranded)', async () => {
    const q = { ...QUALITY.low, streamRadius: 0 };
    const r = rig(q);
    r.tick(C / 2, C / 2);
    let spawned: unknown = null;
    const sp = r.st.spawn(0).then((v) => { spawned = v; });
    let found: unknown = 'pending';
    const fd = r.st.findNearest('safe', { s: 0, x: 1, z: 2 }, 4).then((v) => { found = v; });
    expect(r.pool.pending('spawn').length).toBe(1);
    await r.st.setQuality({ ...QUALITY.high, streamRadius: 0 }); // tpc change: pool.reinit drops every job
    expect(r.pool.reinits).toBe(1);
    const spJobs = r.pool.take('spawn');
    const fdJobs = r.pool.take('find');
    expect(spJobs.length).toBe(1); // re-submitted after the reinit
    expect(fdJobs.length).toBe(1);
    const point = { s: 0, x: 3, y: 0, z: 4, yaw: 0 };
    spJobs[0].resolve({ t: 'spawn', job: spJobs[0].id, result: point } as unknown as WorkerResponse);
    fdJobs[0].resolve({ t: 'find', job: fdJobs[0].id, result: null });
    await sp;
    await fd;
    expect(spawned).toEqual(point);
    expect(found).toBe(null);
  });

  it('a full bake that keeps failing leaves the preview and does not block isReady(needFull)', async () => {
    const r = rig({ ...QUALITY.low, streamRadius: 0 });
    const orig = console.error;
    const errs: unknown[] = [];
    console.error = (...a: unknown[]) => { errs.push(a); };
    try {
      r.tick(C / 2, C / 2);
      await r.answerLayouts();
      await r.answerBuilds();
      for (let i = 0; i < 80; i++) r.tick(C / 2, C / 2, 20);
      expect(r.st.isReady(0, false)).toBe(true);
      expect(r.st.isReady(0, true)).toBe(false);
      // three tiles bake fine; one tile's bake fails twice (retry once, then give up)
      await r.answerBakes((k) => k.q !== 2);
      for (let attempt = 0; attempt < 2; attempt++) {
        const js = r.pool.take('bake');
        expect(js.length).toBe(1);
        js[0].reject(new Error('bake exploded'));
        await flush();
      }
      expect(r.pool.pending('bake').length).toBe(0);
      for (let i = 0; i < 20; i++) r.tick(C / 2, C / 2, 20);
    } finally { console.error = orig; }
    expect(errs.length).toBeGreaterThan(0);
    expect(r.st.stats().tilesFull).toBe(3);
    expect(r.st.isReady(0, true)).toBe(true);
  });

  it('a layout that keeps failing is not resubmitted forever and does not block isReady', async () => {
    const r = rig({ ...QUALITY.low, streamRadius: 0 });
    const orig = console.error;
    console.error = () => {};
    try {
      r.tick(C / 2, C / 2);
      for (let attempt = 0; attempt < 2; attempt++) {
        const js = r.pool.take('layout');
        expect(js.length).toBe(1);
        js[0].reject(new Error('layout exploded'));
        await flush();
      }
      expect(r.pool.pending('layout').length).toBe(0);
      await r.answerBuilds();
      for (let i = 0; i < 80; i++) r.tick(C / 2, C / 2, 20);
      r.tick(C / 2 + C, C / 2); // re-target: the failed chunk is not resubmitted
      r.tick(C / 2, C / 2);
      expect(r.pool.pending('layout').filter((j) => chunkKeyStr((j.req as Extract<WorkerRequest, { t: 'layout' }>).key) === '0:0:0').length).toBe(0);
    } finally { console.error = orig; }
    expect(r.st.chunkLoaded({ s: 0, cx: 0, cz: 0 })).toBe(false);
    expect(r.st.isReady(0, false)).toBe(true);
  });
});

describe('seed reset', () => {
  it('releases the previous world and ignores late replies even when new tiles reuse its keys', async () => {
    const r = rig();
    r.tick(C / 2, C / 2);
    await r.answerLayouts();
    await r.answerBuilds();
    for (let i = 0; i < 80; i++) r.tick(C / 2, C / 2);
    expect(r.st.stats().tilesResident).toBe(36);
    const oldBake = r.pool.pending('bake')[0];
    const key = (oldBake.req as Extract<WorkerRequest, { t: 'bake' }>).key;
    await r.st.reset({
      opts: { seed: 2, seedText: '2', forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' },
      bake: bakeQualityOf(QUALITY.low), bakeTerm: 'all', validate: false,
    });
    expect(r.st.stats().tilesResident).toBe(0);
    expect(r.st.query.isLoaded(C / 2, C / 2)).toBe(false);
    expect(r.up.disposed.size).toBe(36);
    r.tick(C / 2, C / 2);
    await r.answerLayouts(() => true, () => 100);
    await r.answerBuilds();
    oldBake.resolve({ t: 'bake', job: oldBake.id, lightmap: fakeLm(key, 'full', 7), ms: 5 });
    await flush();
    for (let i = 0; i < 80; i++) r.tick(C / 2, C / 2);
    expect(r.st.query.floorAt(C / 2, C / 2, 1)).toBe(1);
    expect(r.st.stats().tilesFull).toBe(0);
    expect(r.st.stats().tilesResident).toBe(36);
    r.st.dispose();
  });
});

describe('automation gate ring (fullBakeRing) and burst uploads', () => {
  const ringOf = (k: TileKey): number => Math.max(Math.abs(k.cx), Math.abs(k.cz));
  const buildKey = (j: FakeJob): TileKey => (j.req as Extract<WorkerRequest, { t: 'build' }>).key;

  it('builds the gate ring with full lighting ahead of every farther build, and never bakes it again', async () => {
    const r = rig({ ...QUALITY.low, streamRadius: 2 }, 0, { fullBakeRing: 1 });
    r.tick(C / 2, C / 2);
    await r.answerLayouts();
    r.tick(C / 2, C / 2);
    const builds = r.pool.pending('build');
    const inner = builds.filter((j) => ringOf(buildKey(j)) <= 1), outer = builds.filter((j) => ringOf(buildKey(j)) === 2);
    expect(inner.length).toBe(36);
    expect(outer.length).toBeGreaterThan(0);
    for (const j of inner) expect((j.req as Extract<WorkerRequest, { t: 'build' }>).lighting).toBe('full');
    for (const j of outer) expect((j.req as Extract<WorkerRequest, { t: 'build' }>).lighting).toBeUndefined();
    expect(Math.max(...inner.map((j) => j.priority))).toBeLessThan(Math.min(...outer.map((j) => j.priority)));
    await r.answerBuilds((k) => ringOf(k) <= 1);
    for (let i = 0; i < 200 && !r.st.isReady(1, true); i++) r.tick(C / 2, C / 2);
    expect(r.st.isReady(1, true)).toBe(true);
    expect(r.pool.pending('bake').filter((j) => ringOf((j.req as Extract<WorkerRequest, { t: 'bake' }>).key) <= 1)).toHaveLength(0);
  });

  it('keeps the default order without a gate ring (full bakes queue behind nearby builds)', async () => {
    const r = rig({ ...QUALITY.low, streamRadius: 2 });
    r.tick(C / 2, C / 2);
    await r.answerLayouts();
    r.tick(C / 2, C / 2);
    for (const j of r.pool.pending('build')) expect((j.req as Extract<WorkerRequest, { t: 'build' }>).lighting).toBeUndefined();
  });

  it('burst uploads take any number of steps within the budget and skip the fade', async () => {
    const r = rig();
    r.tick(C / 2, C / 2);
    await r.answerLayouts();
    await r.answerBuilds();
    r.frame++;
    r.up.frame = r.frame;
    r.st.update(C / 2, C / 2, 0, -1, null as unknown as THREE.Camera, r.frame);
    r.st.processUploads(null as unknown as THREE.WebGLRenderer, 1e6, true);
    expect(r.up.steps(r.frame).length).toBeGreaterThan(UPLOAD.MAX_STEPS_PER_FRAME);
    const s = r.st.stats();
    expect(s.tilesResident).toBe(36);
    expect(s.fadingIn).toBe(0);
  });
});

describe('automation capture gate v2 (StreamerOptions.capture)', () => {
  const Q: QualityConfig = { ...QUALITY.low, streamRadius: 2 };
  const P = C / 2; // the player at the centre of chunk (0, 0)
  const FE = fogEnd(Q.streamRadius);
  const ringOf = (k: TileKey): number => Math.max(Math.abs(k.cx), Math.abs(k.cz));
  const rect = (k: TileKey): [number, number, number, number] => {
    const x0 = k.cx * C + (k.q & 1) * TILE_SIZE, z0 = k.cz * C + (k.q >> 1) * TILE_SIZE;
    return [x0, z0, x0 + TILE_SIZE, z0 + TILE_SIZE];
  };
  const dist = (k: TileKey): number => rectDistance(P, P, ...rect(k));
  const cheb = (k: TileKey): number => rectChebyshev(P, P, ...rect(k));
  const buildKey = (j: FakeJob): TileKey => (j.req as Extract<WorkerRequest, { t: 'build' }>).key;
  const allTiles = (): TileKey[] => {
    const out: TileKey[] = [];
    for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) for (let q = 0; q < 4; q++) out.push({ s: 0, cx, cz, q: q as TileKey['q'] });
    return out;
  };
  const ks = (k: TileKey): string => tileKeyStr(k);

  function gated(scope: StreamScope = 'full', q: QualityConfig = Q): { r: Rig; cc: CaptureControl; closed: { v: boolean } } {
    const closed = { v: true };
    const r = rig(q, 0, { capture: { gateClosed: () => closed.v, scope } });
    const cc = getCaptureControl(r.st);
    if (!cc) throw new Error('no capture control');
    return { r, cc, closed };
  }
  async function settleAll(r: Rig, cc: CaptureControl): Promise<void> {
    await r.answerLayouts();
    await r.answerBuilds();
    for (let i = 0; i < 600 && !cc.isCaptureReady(); i++) r.tick(P, P);
  }

  it('while the gate is closed: only the capture set, built with full lighting; the rest follows when it opens', async () => {
    const { r, cc, closed } = gated();
    r.tick(P, P);
    const builds = r.pool.pending('build');
    const built = new Set(builds.map((j) => ks(buildKey(j))));
    for (const j of builds) {
      const k = buildKey(j);
      expect((j.req as Extract<WorkerRequest, { t: 'build' }>).lighting, ks(k)).toBe('full');
      expect(ringOf(k) <= 1 || dist(k) <= FE, `${ks(k)} beyond the fog end`).toBe(true);
    }
    // every tile the probe cube / light atlas reaches, and ring 1, is in; tiles outside the set wait
    for (const k of allTiles()) {
      if (ringOf(k) <= 1 || (dist(k) <= FE && cheb(k) <= CAPTURE_NEAR_M + 1)) expect(built.has(ks(k)), ks(k)).toBe(true);
    }
    const gateTiles = cc.stats().gateTiles;
    expect(gateTiles).toBe(builds.length);
    expect(gateTiles).toBeGreaterThan(36);
    expect(gateTiles).toBeLessThan(100);
    // layouts only for chunks that hold a gate tile
    const withGate = new Set(builds.map((j) => chunkKeyStr({ s: 0, cx: buildKey(j).cx, cz: buildKey(j).cz })));
    for (const j of r.pool.pending('layout')) expect(withGate.has(chunkKeyStr((j.req as Extract<WorkerRequest, { t: 'layout' }>).key))).toBe(true);
    expect(r.pool.pending('layout').length).toBe(withGate.size);
    // gate work goes first: every gate build ahead of any layout of a chunk without one (there are none yet)
    expect(cc.isCaptureReady()).toBe(false);
    await settleAll(r, cc);
    expect(cc.isCaptureReady()).toBe(true);
    expect(cc.stats()).toMatchObject({ gateTiles, gateReady: gateTiles, scope: 'full' });
    expect(r.pool.pending()).toHaveLength(0); // nothing else was submitted while closed
    // the gate opens: the rest of the radius streams (previews, then bakes)
    closed.v = false;
    r.tick(P, P);
    const rest = r.pool.pending('build');
    expect(rest.length).toBe(100 - gateTiles);
    for (const j of rest) expect((j.req as Extract<WorkerRequest, { t: 'build' }>).lighting).toBeUndefined();
    expect(r.pool.pending('layout').length).toBe(25 - withGate.size);
    r.st.dispose();
  });

  it('isCaptureReady waits for the layouts of every chunk holding a gate tile', async () => {
    const { r, cc } = gated();
    r.tick(P, P);
    await r.answerBuilds();
    for (let i = 0; i < 600; i++) r.tick(P, P);
    expect(r.st.stats().tilesFull).toBe(cc.stats().gateTiles);
    expect(cc.isCaptureReady()).toBe(false);
    await r.answerLayouts();
    r.tick(P, P);
    expect(cc.isCaptureReady()).toBe(true);
    r.st.dispose();
  });

  it('a closing gate drops the queued work outside its capture set (a new shot does not wait behind the last)', async () => {
    const { r, cc, closed } = gated();
    closed.v = false;
    r.tick(P, P);
    expect(r.pool.pending('build').length).toBe(100);
    closed.v = true;
    r.tick(P, P);
    const left = r.pool.pending('build');
    expect(left.length).toBe(cc.stats().gateTiles);
    for (const j of left) expect(ringOf(buildKey(j)) <= 1 || dist(buildKey(j)) <= FE).toBe(true);
    // and they come back once it opens again
    closed.v = false;
    r.tick(P, P);
    expect(r.pool.pending('build').length).toBe(100);
    r.st.dispose();
  });

  it('while closed, the capture set follows the view: tiles that come into view get full-lit builds at once', async () => {
    // radius 3 (ultra): the in-view band runs from the probe reach (60 m) to the fog end (92 m)
    const { r, cc } = gated('full', { ...QUALITY.low, streamRadius: 3 });
    r.tick(P, P); // looking toward -z
    const before = new Set(r.pool.pending('build').map((j) => ks(buildKey(j))));
    // turn around (+z): the in-view band between the probe reach and the fog end moves to the other side
    r.frame++;
    r.st.update(P, P, 0, 1, null as unknown as THREE.Camera, r.frame);
    const after = r.pool.pending('build');
    const added = after.filter((j) => !before.has(ks(buildKey(j))));
    expect(added.length).toBeGreaterThan(0);
    for (const j of added) {
      expect((j.req as Extract<WorkerRequest, { t: 'build' }>).lighting).toBe('full');
      expect(buildKey(j).cz).toBeGreaterThan(0); // behind the old view, in front of the new one
    }
    // tiles that left the set keep their jobs while the gate stays closed (only a closing gate drops work)
    expect(after.length).toBe(before.size + added.length);
    expect(cc.stats().gateTiles).toBeLessThanOrEqual(after.length);
    r.st.dispose();
  });

  it('scope capture: only capture chunks are desired, nothing else streams after ready, the rest is evicted', async () => {
    const { r, cc, closed } = gated('capture');
    closed.v = false; // even with the gate open
    r.tick(P, P);
    const gateTiles = cc.stats().gateTiles;
    expect(r.pool.pending('build').length).toBe(gateTiles);
    await settleAll(r, cc);
    for (let i = 0; i < 20; i++) r.tick(P, P);
    expect(r.pool.pending()).toHaveLength(0);
    expect(r.st.stats().tilesResident).toBeLessThanOrEqual(r.st.stats().chunksResident * 4);
    // the whole radius once the scope widens
    cc.setScope('full');
    r.tick(P, P);
    expect(r.pool.pending('build').length).toBe(100 - gateTiles);
    await r.answerLayouts();
    await r.answerBuilds();
    await r.answerBakes();
    for (let i = 0; i < 800 && !r.st.isIdle(); i++) { r.tick(P, P); if (i % 50 === 0) await r.answerBakes(); }
    expect(r.st.stats().tilesResident).toBe(100);
    // back to the capture scope: no hysteresis ring, chunks without capture tiles go
    cc.setScope('capture');
    for (let i = 0; i < 60; i++) r.tick(P, P);
    const s = r.st.stats();
    expect(s.tilesResident).toBeLessThan(100);
    expect(s.tilesResident).toBeGreaterThanOrEqual(gateTiles);
    expect(cc.isCaptureReady()).toBe(true);
    r.st.dispose();
  });

  it('scope capture follows the view: a chunk that gains capture tiles becomes desired and streams', async () => {
    const { r, cc, closed } = gated('capture', { ...QUALITY.low, streamRadius: 3 });
    closed.v = false;
    // near the +z edge of chunk (0, 0): chunks at cz = 3 (78 m away) hold view-band tiles only
    const Z = 37;
    const look = (vz: number): void => { r.frame++; r.st.update(P, Z, 0, vz, null as unknown as THREE.Camera, r.frame); };
    look(-1);
    const layouts = (): Set<string> => new Set(r.pool.pending('layout').map((j) => chunkKeyStr((j.req as Extract<WorkerRequest, { t: 'layout' }>).key)));
    const before = new Set(r.pool.pending('build').map((j) => ks(buildKey(j))));
    expect([...layouts()].some((k) => k.endsWith(':3'))).toBe(false);
    for (let i = 0; i < 10; i++) look(1); // turn around: +z
    const added = r.pool.pending('build').filter((j) => !before.has(ks(buildKey(j))));
    expect(added.length).toBeGreaterThan(0);
    for (const j of added) expect(buildKey(j).cz).toBeGreaterThan(0);
    expect([...layouts()].some((k) => k.endsWith(':3'))).toBe(true);
    expect(cc.scope).toBe('capture');
    r.st.dispose();
  });

  it('a quality change then its gate: resident tiles outside the capture set are still rebuilt once it opens', async () => {
    // app/boot.ts applyQuality: streamer.setQuality (rebuilds submitted), THEN gate.open('quality') closes the gate,
    // which drops the rebuilds outside the capture set. They must come back: the tiles hold the old preset's atlas.
    const { r, cc, closed } = gated();
    closed.v = false;
    r.tick(P, P);
    await r.answerLayouts();
    await r.answerBuilds();
    await r.answerBakes();
    for (let i = 0; i < 800 && !r.st.isIdle(); i++) { r.tick(P, P); if (i % 50 === 0) await r.answerBakes(); }
    expect(r.st.stats().tilesResident).toBe(100);
    await r.st.setQuality({ ...QUALITY.high, streamRadius: 2 }); // tpc change: every tile is rebuilt
    expect(r.pool.pending('build').length).toBe(100);
    closed.v = true;
    r.tick(P, P);
    const gateTiles = cc.stats().gateTiles;
    expect(r.pool.pending('build').length).toBe(gateTiles);
    await r.answerBuilds();
    for (let i = 0; i < 600 && !cc.isCaptureReady(); i++) r.tick(P, P);
    expect(cc.isCaptureReady()).toBe(true);
    closed.v = false;
    r.tick(P, P);
    expect(r.pool.pending('build').length).toBe(100 - gateTiles);
    r.st.dispose();
  });

  it('forgetPosition (load() in place): a storey switch re-targets at the next position, not at the old x/z', () => {
    const keysOf = (js: FakeJob[]): string[] => js.map((j) => {
      const k = (j.req as { key?: ChunkKey | TileKey }).key;
      return k ? `${j.req.t}:${'q' in k ? tileKeyStr(k) : chunkKeyStr(k)}` : j.req.t;
    });
    for (const forget of [false, true]) {
      const { r, cc, closed } = gated('capture');
      closed.v = false;
      r.tick(P, P); // storey 0, chunk (0, 0)
      const n0 = r.pool.jobs.length;
      if (forget) cc.forgetPosition();
      r.st.switchStorey(1);
      const atOld = keysOf(r.pool.jobs.slice(n0));
      // stairs / lifts (no forget): the new storey streams at once around the same x/z
      if (!forget) expect(atOld.some((k) => k.endsWith(':1:0:0') || k.includes(':1:0:0:'))).toBe(true);
      else expect(atOld).toEqual([]);
      if (!forget) { r.st.dispose(); continue; }
      const X = 10 * C + C / 2;
      closed.v = true; // the load's gate
      r.tick(X, P);
      const next = r.pool.pending();
      expect(next.length).toBeGreaterThan(0);
      for (const j of next) {
        const k = (j.req as { key?: ChunkKey }).key;
        if (!k) continue;
        expect(k.s).toBe(1);
        expect(Math.abs(k.cx - 10)).toBeLessThanOrEqual(2);
      }
      r.st.dispose();
    }
  });

  it('players are untouched: no capture options, no gate flags, no holding', async () => {
    const r = rig(Q);
    r.tick(P, P);
    expect(r.pool.pending('build').length).toBe(100);
    for (const j of r.pool.pending('build')) expect((j.req as Extract<WorkerRequest, { t: 'build' }>).lighting).toBeUndefined();
    const cc = getCaptureControl(r.st);
    expect(cc?.stats().gateTiles).toBe(0);
    r.st.dispose();
  });
});
