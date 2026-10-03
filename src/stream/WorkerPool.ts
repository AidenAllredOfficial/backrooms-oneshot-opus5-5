// src/stream/WorkerPool.ts — main-thread worker pool (WP10). One job per worker; min-heap priority queue (lower
// priority value = sooner); soft chunk affinity; cancel / reinit semantics per DESIGN §5 WP10.
//
// Settlement rules:
//  - a job resolves with the worker's response, or rejects with an Error when the worker answers `error`
//    (or crashes while running it);
//  - a job that is cancelled (handle.cancel(), reinit(), dispose()) NEVER settles: callers attach handlers
//    freely without seeing spurious rejections, and dropped results never reach them.

import { hashString } from '../core/rng.ts';
import type { QualityConfig } from '../core/quality.ts';
import type { WorkerInit, WorkerRequest, WorkerResponse } from '../core/worker.ts';

export interface JobHandle<R> { readonly id: number; readonly promise: Promise<R>; priority: number; cancel(): void }
export interface WorkerPool {
  /** live workers (retiring ones excluded) */
  readonly size: number;
  /** affinity (chunk key string): soft routing — the job goes to worker hash(affinity) % size when that worker is
   * idle or becomes idle before any other idle worker would take it; otherwise to any idle worker. */
  submit<T extends WorkerRequest['t']>(req: Extract<WorkerRequest, { t: T }>, priority: number, affinity?: string): JobHandle<Extract<WorkerResponse, { t: T }>>;
  /** cancel all queued jobs, drop results of in-flight ones, broadcast `init` to every worker, resolve when all reply 'ready' */
  reinit(init: WorkerInit): Promise<void>;
  /** grow (new workers get the current init; resolves when they are ready) or shrink (idle workers stop now, busy
   * ones after their running job; queued jobs stay queued for the rest) to `n` >= 1 live workers (R2 B9: a larger
   * pool during the boot, the steady-state size after ready). */
  resize(n: number): Promise<void>;
  queued(): number; busy(): number; dispose(): void;
}

/** Pool size = max(2, min(quality.bakeWorkers, hardwareConcurrency - 4, max(2, floor(deviceMemory GB)))) (R2 B9):
 * each bake worker holds ~155 MB (world generator, layout LRU, bake scratch), so a 16-thread machine with 8 GB must
 * not start 12 of them. `deviceMemory` is navigator.deviceMemory (Chromium: rounded down to a power of 2, max 8;
 * undefined elsewhere -> 8). */
export function poolSizeFor(q: Pick<QualityConfig, 'bakeWorkers'>, hardwareConcurrency: number, deviceMemory?: number): number {
  const hc = Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0 ? hardwareConcurrency : 4;
  const mem = deviceMemory !== undefined && Number.isFinite(deviceMemory) && deviceMemory > 0 ? deviceMemory : 8;
  return Math.max(2, Math.min(q.bakeWorkers, hc - 4, Math.max(2, Math.floor(mem))));
}

/** Boot-time pool size. R2 B9 added 2 workers during the boot; measured, they made the boot slower (the bake is
 * memory-bandwidth bound: 10 workers 4.3 s to ready vs 4 workers 3.4 s), so the boot uses the steady-state size.
 * Kept as a function so the boot / steady split (resize at the gate) stays in one place. */
export function bootPoolSizeFor(q: Pick<QualityConfig, 'bakeWorkers'>, hardwareConcurrency: number, deviceMemory?: number): number {
  return poolSizeFor(q, hardwareConcurrency, deviceMemory);
}

/** Home worker of an affinity key. */
export const affinityWorker = (affinity: string, size: number): number => (hashString(affinity) >>> 0) % size;

interface Job {
  id: number;
  req: WorkerRequest;
  priority: number;
  seq: number; // FIFO tie-break among equal priorities
  aff: number; // affinity hash (>>> 0), -1 = none; the home worker is resolved at dispatch among the live workers
  heapIndex: number; // -1 when not queued
  dropped: boolean;
  resolve(r: WorkerResponse): void;
  reject(e: Error): void;
}
interface Slot {
  index: number;
  w: Worker;
  job: Job | null; // the running job (dropped jobs stay here until the worker answers)
  initJob: number; // job id of the init this worker must still acknowledge; 0 = ready
  dead: boolean;
  retiring: boolean; // resize(): stops as soon as it has neither a job nor a pending init
}

// ---------------------------------------------------------------- indexed binary min-heap

const before = (a: Job, b: Job): boolean => a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq);

class JobHeap {
  readonly a: Job[] = [];
  get size(): number { return this.a.length; }
  peek(): Job | undefined { return this.a[0]; }
  push(j: Job): void {
    j.heapIndex = this.a.length;
    this.a.push(j);
    this.up(j.heapIndex);
  }
  remove(j: Job): void {
    const i = j.heapIndex;
    if (i < 0) return;
    const last = this.a.pop() as Job;
    j.heapIndex = -1;
    if (i < this.a.length) {
      this.a[i] = last;
      last.heapIndex = i;
      this.update(last);
    }
  }
  pop(): Job | undefined {
    const top = this.a[0];
    if (top) this.remove(top);
    return top;
  }
  update(j: Job): void {
    if (j.heapIndex < 0) return;
    this.up(j.heapIndex);
    this.down(j.heapIndex);
  }
  clear(): Job[] {
    const all = this.a.splice(0);
    for (const j of all) j.heapIndex = -1;
    return all;
  }
  private up(i: number): void {
    const a = this.a;
    const j = a[i];
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(j, a[p])) break;
      a[i] = a[p];
      a[i].heapIndex = i;
      i = p;
    }
    a[i] = j;
    j.heapIndex = i;
  }
  private down(i: number): void {
    const a = this.a, n = a.length;
    const j = a[i];
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const c = r < n && before(a[r], a[l]) ? r : l;
      if (!before(a[c], j)) break;
      a[i] = a[c];
      a[i].heapIndex = i;
      i = c;
    }
    a[i] = j;
    j.heapIndex = i;
  }
}

const defaultFactory = (): Worker => new Worker(new URL('../workers/chunk.worker.ts', import.meta.url), { type: 'module' });

export function createWorkerPool(size: number, init: WorkerInit, factory?: () => Worker): Promise<WorkerPool> {
  const make = factory ?? defaultFactory;
  const n = Math.max(1, size | 0);
  const slots: Slot[] = [];
  const heap = new JobHeap();
  let nextId = 1;
  let seq = 0;
  let currentInit = init;
  let disposed = false;
  let initWaiters: (() => void)[] = [];
  let initFailers: ((e: Error) => void)[] = [];
  let rr = 0; // round-robin start for non-affinity dispatch

  const idle = (s: Slot): boolean => !s.dead && !s.retiring && s.job === null && s.initJob === 0;
  const live: Slot[] = [];
  const liveSlots = (): Slot[] => {
    live.length = 0;
    for (const x of slots) if (!x.dead && !x.retiring) live.push(x);
    return live;
  };

  const dispatch = (s: Slot, j: Job): void => {
    s.job = j;
    try { s.w.postMessage(j.req); }
    catch (e) { onCrash(s, `postMessage failed: ${e instanceof Error ? e.message : String(e)}`); }
  };

  /** Assign queued jobs to idle workers: repeatedly take the best job; it goes to its home worker if that one is
   * idle, else to any idle worker (soft affinity). */
  const pump = (): void => {
    if (disposed) return;
    for (;;) {
      if (heap.size === 0) return;
      let anyIdle = -1;
      for (let k = 0; k < slots.length; k++) {
        const i = (rr + k) % slots.length;
        if (idle(slots[i])) { anyIdle = i; break; }
      }
      if (anyIdle < 0) return;
      const j = heap.pop() as Job;
      let target = anyIdle;
      if (j.aff >= 0) {
        const L = liveSlots();
        const home = L.length > 0 ? L[j.aff % L.length] : null;
        if (home && idle(home)) target = home.index;
      }
      if (target === anyIdle) rr = (anyIdle + 1) % slots.length;
      dispatch(slots[target], j);
    }
  };

  const checkInitDone = (): void => {
    for (const s of slots) if (!s.dead && s.initJob !== 0) return;
    if (slots.length > 0 && slots.every((x) => x.dead) && !disposed) return; // failAll() rejects the waiters
    const ws = initWaiters;
    initWaiters = [];
    initFailers = [];
    for (const f of ws) f();
  };

  /** Take a worker out of the pool for good (crashed at start, or retired by resize). */
  const stop = (s: Slot): void => {
    s.dead = true;
    s.retiring = false;
    s.initJob = 0;
    s.job = null;
    s.w.onmessage = null;
    s.w.onerror = null;
    s.w.onmessageerror = null;
    s.w.terminate();
  };
  const retireIfDone = (s: Slot): void => {
    if (s.retiring && !s.dead && s.job === null && s.initJob === 0) stop(s);
  };

  const onMessage = (s: Slot, res: WorkerResponse): void => {
    if (s.initJob !== 0 && res.job === s.initJob) {
      // the init we are waiting for (an older init's reply is ignored: a newer one is still queued behind it)
      if (res.t !== 'ready') {
        onCrash(s, res.t === 'error' ? `init failed: ${res.message}` : `init answered with '${res.t}' instead of 'ready'`);
        return;
      }
      s.initJob = 0;
      retireIfDone(s);
      checkInitDone();
      pump();
      return;
    }
    const j = s.job;
    if (j === null || j.id !== res.job) {
      // reply to a superseded init or to an unknown job: ignore
      if (res.t === 'error' && j === null) console.error(`[WorkerPool] worker ${s.index}: ${res.message}`);
      return;
    }
    if (res.t !== 'error' && res.t !== (j.req.t === 'init' ? 'ready' : j.req.t)) {
      onCrash(s, `${j.req.t} answered with '${res.t}'`);
      return;
    }
    s.job = null;
    if (!j.dropped) {
      if (res.t === 'error') j.reject(new Error(`worker ${j.req.t} job failed: ${res.message}\n${res.stack}`));
      else j.resolve(res);
    }
    retireIfDone(s);
    pump();
  };

  const onCrash = (s: Slot, message: string): void => {
    console.error(`[WorkerPool] worker ${s.index} error: ${message}`);
    if (s.dead) return;
    const j = s.job;
    const starting = s.initJob !== 0;
    if (j && !j.dropped) j.reject(new Error(`worker ${s.index} crashed while running ${j.req.t}: ${message}`));
    // An error does not prove that the worker can accept another job. In particular a crash while a cancelled
    // job is running can prevent its queued init from ever replying. Retire it and release all init waiters.
    stop(s);
    if (liveSlots().length === 0) {
      failAll(new Error(`[WorkerPool] every worker failed${starting ? ' to start' : ''} (last error: ${message})`));
      return;
    }
    checkInitDone();
    pump();
  };

  /** No live worker is left: reject every queued job and every pending init waiter. */
  const failAll = (err: Error): void => {
    for (const q of heap.clear()) if (!q.dropped) { q.dropped = true; q.reject(err); }
    const ws = initFailers;
    initWaiters = [];
    initFailers = [];
    for (const f of ws) f(err);
  };

  const sendInit = (s: Slot, it: WorkerInit): void => {
    const id = nextId++;
    s.initJob = id;
    try { s.w.postMessage({ t: 'init', job: id, init: it } satisfies WorkerRequest); }
    catch (e) { onCrash(s, `init postMessage failed: ${e instanceof Error ? e.message : String(e)}`); }
  };

  const waitInit = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (!disposed && slots.length > 0 && slots.every((x) => x.dead)) {
        reject(new Error('[WorkerPool] no live worker'));
        return;
      }
      initWaiters.push(resolve);
      initFailers.push(reject);
      checkInitDone();
    });

  const addSlot = (): void => {
    const s: Slot = { index: slots.length, w: make(), job: null, initJob: 0, dead: false, retiring: false };
    s.w.onmessage = (e: MessageEvent<WorkerResponse>): void => onMessage(s, e.data);
    s.w.onerror = (e: ErrorEvent): void => { e.preventDefault?.(); onCrash(s, e.message || 'uncaught error'); };
    s.w.onmessageerror = (): void => onCrash(s, 'messageerror (response could not be deserialised)');
    slots.push(s);
    sendInit(s, currentInit);
  };
  try { for (let i = 0; i < n; i++) addSlot(); }
  catch (e) {
    for (const s of slots) if (!s.dead) stop(s);
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }

  const pool: WorkerPool = {
    get size() { return liveSlots().length; },
    submit<T extends WorkerRequest['t']>(req: Extract<WorkerRequest, { t: T }>, priority: number, affinity?: string): JobHandle<Extract<WorkerResponse, { t: T }>> {
      const id = nextId++;
      let job!: Job;
      const promise = new Promise<Extract<WorkerResponse, { t: T }>>((resolve, reject) => {
        job = {
          id, req: { ...req, job: id } as WorkerRequest, priority, seq: seq++,
          aff: affinity === undefined ? -1 : hashString(affinity) >>> 0, heapIndex: -1, dropped: false,
          resolve: (r) => resolve(r as Extract<WorkerResponse, { t: T }>), reject,
        };
      });
      if (disposed) job.dropped = true;
      else if (slots.every((x) => x.dead)) {
        job.dropped = true;
        job.reject(new Error('[WorkerPool] no live worker'));
      } else {
        heap.push(job);
        pump();
      }
      return {
        id, promise,
        get priority() { return job.priority; },
        set priority(p: number) {
          if (p === job.priority) return;
          job.priority = p;
          heap.update(job);
        },
        cancel() {
          job.dropped = true;
          heap.remove(job);
        },
      };
    },
    reinit(it: WorkerInit): Promise<void> {
      currentInit = it;
      for (const j of heap.clear()) j.dropped = true;
      for (const s of slots) {
        if (s.job) s.job.dropped = true; // its reply arrives before the init's 'ready' (FIFO per worker)
        if (!s.dead && !s.retiring) sendInit(s, currentInit);
      }
      return waitInit();
    },
    resize(target: number): Promise<void> {
      if (disposed) return Promise.resolve();
      const want = Math.max(1, target | 0);
      const L = liveSlots().slice();
      if (want > L.length) {
        try { for (let i = L.length; i < want; i++) addSlot(); }
        catch (e) { return Promise.reject(e instanceof Error ? e : new Error(String(e))); }
        return waitInit();
      }
      // retire the newest workers (the oldest keep their warm layout caches)
      for (let i = L.length - 1; i >= want; i--) {
        const s = L[i];
        s.retiring = true;
        retireIfDone(s);
      }
      pump();
      return Promise.resolve();
    },
    queued: () => heap.size,
    busy: () => {
      let c = 0;
      for (const s of slots) if (!s.dead && (s.job !== null || s.initJob !== 0)) c++;
      return c;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const j of heap.clear()) j.dropped = true;
      for (const s of slots) {
        if (s.job) s.job.dropped = true;
        s.job = null;
        s.initJob = 0;
        s.dead = true;
        s.w.onmessage = null;
        s.w.onerror = null;
        s.w.onmessageerror = null;
        s.w.terminate();
      }
      checkInitDone();
    },
  };
  return waitInit().then(() => pool);
}
