// tests/stream/pool.test.ts (WP10) — WorkerPool: init before jobs, heap ordering, cancel, reinit, soft affinity.

import { describe, expect, it } from 'vitest';
import { bakeQualityOf, QUALITY } from '../../src/core/quality.ts';
import type { WorkerInit, WorkerRequest, WorkerResponse } from '../../src/core/worker.ts';
import { affinityWorker, bootPoolSizeFor, createWorkerPool, poolSizeFor, type WorkerPool } from '../../src/stream/WorkerPool.ts';

class FakeWorker {
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  inbox: WorkerRequest[] = [];
  terminated = false;
  postMessage(req: WorkerRequest): void { this.inbox.push(req); }
  terminate(): void { this.terminated = true; }
  /** reply to the oldest unanswered request */
  answer(make?: (req: WorkerRequest) => WorkerResponse): WorkerRequest {
    const req = this.inbox.shift();
    if (!req) throw new Error('nothing to answer');
    const res: WorkerResponse = make ? make(req) : req.t === 'init' ? { t: 'ready', job: req.job } : { t: 'ascii', job: req.job, text: `done ${req.job}` };
    this.onmessage?.({ data: res } as MessageEvent<WorkerResponse>);
    return req;
  }
}

const init = (tag = 1): WorkerInit => ({
  opts: { seed: tag, seedText: String(tag), forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' },
  bake: bakeQualityOf(QUALITY.medium), bakeTerm: 'all', validate: false,
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function makePool(n: number): Promise<{ pool: WorkerPool; ws: FakeWorker[] }> {
  const ws: FakeWorker[] = [];
  const p = createWorkerPool(n, init(), () => {
    const w = new FakeWorker();
    ws.push(w);
    return w as unknown as Worker;
  });
  expect(ws.length).toBe(n);
  for (const w of ws) expect(w.inbox[0].t).toBe('init'); // init is broadcast before any job
  for (const w of ws) w.answer();
  return { pool: await p, ws };
}

const ascii = (tag: number): Extract<WorkerRequest, { t: 'ascii' }> => ({ t: 'ascii', job: 0, s: 0, cx0: tag, cz0: 0, cx1: 0, cz1: 0 });

describe('WorkerPool', () => {
  it('sizes the pool as clamp(hardwareConcurrency - 4, 2, bakeWorkers)', () => {
    expect(poolSizeFor(QUALITY.high, 32)).toBe(4);
    expect(poolSizeFor(QUALITY.ultra, 32)).toBe(6);
    expect(poolSizeFor(QUALITY.ultra, 32, 4)).toBe(4); // 4 GB device: one ~155 MB worker per GB at most
    expect(poolSizeFor(QUALITY.ultra, 32, 0.5)).toBe(2);
    expect(poolSizeFor(QUALITY.ultra, 6, 8)).toBe(2);
    expect(poolSizeFor(QUALITY.high, 7)).toBe(3);
    expect(poolSizeFor(QUALITY.low, 4)).toBe(2);
    expect(poolSizeFor(QUALITY.medium, 64)).toBe(4);
  });

  it('boot pool: the steady-state size (extra boot workers were slower: memory-bandwidth-bound bake)', () => {
    expect(bootPoolSizeFor(QUALITY.high, 32, 8)).toBe(poolSizeFor(QUALITY.high, 32, 8));
    expect(bootPoolSizeFor(QUALITY.ultra, 14)).toBe(6);
    expect(bootPoolSizeFor(QUALITY.low, 4)).toBe(2);
  });

  it('resize grows with initialised workers and shrinks idle ones now, busy ones after their job', async () => {
    const { pool, ws } = await makePool(2);
    const grown = pool.resize(4);
    expect(ws.length).toBe(4);
    expect(ws[2].inbox[0].t).toBe('init');
    let ready = false;
    void grown.then(() => { ready = true; });
    const a = pool.submit(ascii(1), 0);
    const b = pool.submit(ascii(2), 0);
    const c = pool.submit(ascii(3), 0); // the new workers are not ready yet: queued
    expect(pool.queued()).toBe(1);
    ws[2].answer();
    ws[3].answer();
    await flush();
    expect(ready).toBe(true);
    expect(pool.size).toBe(4);
    expect(pool.queued()).toBe(0); // c went to a new worker
    const busyIdx = ws.findIndex((w) => w.inbox.length > 0 && w.inbox[0].t === 'ascii' && (w.inbox[0] as { cx0: number }).cx0 === 3);
    expect(busyIdx).toBeGreaterThanOrEqual(2);
    // shrink to 1: the idle new worker stops now, the busy ones after their job
    await pool.resize(1);
    expect(pool.size).toBe(1);
    const idleNew = busyIdx === 2 ? 3 : 2;
    expect(ws[idleNew].terminated).toBe(true);
    expect(ws[busyIdx].terminated).toBe(false);
    ws[busyIdx].answer();
    ws[1].answer();
    ws[0].answer();
    await Promise.all([a.promise, b.promise, c.promise]);
    expect(ws[busyIdx].terminated).toBe(true);
    expect(ws[1].terminated).toBe(true);
    expect(ws[0].terminated).toBe(false);
    // later jobs run on the remaining worker
    const d = pool.submit(ascii(4), 0, 'some-chunk');
    expect(ws[0].inbox[0].t).toBe('ascii');
    ws[0].answer();
    await d.promise;
    pool.dispose();
  });

  it('does not resolve creation before every worker is ready, and dispatches no job before init', async () => {
    const ws: FakeWorker[] = [];
    let created = false;
    const p = createWorkerPool(2, init(), () => { const w = new FakeWorker(); ws.push(w); return w as unknown as Worker; });
    void p.then(() => { created = true; });
    ws[0].answer();
    await flush();
    expect(created).toBe(false);
    ws[1].answer();
    const pool = await p;
    expect(created).toBe(true);
    expect(pool.size).toBe(2);
    pool.dispose();
  });

  it('runs one job per worker in priority order (min-heap), with priority updates', async () => {
    const { pool, ws } = await makePool(1);
    const done: number[] = [];
    const a = pool.submit(ascii(1), 50);
    a.promise.then(() => done.push(1));
    expect(ws[0].inbox.length).toBe(1); // dispatched immediately (worker idle)
    const b = pool.submit(ascii(2), 30);
    const c = pool.submit(ascii(3), 10);
    const d = pool.submit(ascii(4), 20);
    b.promise.then(() => done.push(2));
    c.promise.then(() => done.push(3));
    d.promise.then(() => done.push(4));
    expect(pool.queued()).toBe(3);
    expect(pool.busy()).toBe(1);
    expect(ws[0].inbox.length).toBe(1); // one job at a time
    b.priority = 0; // now the most urgent
    const order: number[] = [];
    while (ws[0].inbox.length > 0) {
      const req = ws[0].answer() as Extract<WorkerRequest, { t: 'ascii' }>;
      order.push(req.cx0);
      await flush();
    }
    expect(order).toEqual([1, 2, 3, 4]);
    expect(done).toEqual([1, 2, 3, 4]);
    expect(pool.queued()).toBe(0);
    expect(pool.busy()).toBe(0);
    pool.dispose();
  });

  it('cancel() removes a queued job; a cancelled running job is dropped', async () => {
    const { pool, ws } = await makePool(1);
    let settled = 0;
    const running = pool.submit(ascii(1), 0);
    const queued = pool.submit(ascii(2), 1);
    running.promise.then(() => settled++, () => settled++);
    queued.promise.then(() => settled++, () => settled++);
    queued.cancel();
    expect(pool.queued()).toBe(0);
    running.cancel();
    ws[0].answer(); // result of the running job is dropped
    await flush();
    expect(settled).toBe(0);
    expect(ws[0].inbox.length).toBe(0); // the cancelled queued job never reached the worker
    expect(pool.busy()).toBe(0);
    pool.dispose();
  });

  it('rejects the job when the worker answers with an error', async () => {
    const { pool, ws } = await makePool(1);
    const h = pool.submit(ascii(1), 0);
    ws[0].answer((req) => ({ t: 'error', job: req.job, message: 'boom', stack: '' }));
    await expect(h.promise).rejects.toThrow(/boom/);
    pool.dispose();
  });

  it('reinit cancels queued jobs, drops in-flight results and resolves after all workers reply', async () => {
    const { pool, ws } = await makePool(2);
    let settled = 0;
    const inflight = [pool.submit(ascii(1), 0), pool.submit(ascii(2), 0)];
    const queued = [pool.submit(ascii(3), 5), pool.submit(ascii(4), 6)];
    for (const h of [...inflight, ...queued]) h.promise.then(() => settled++, () => settled++);
    expect(pool.queued()).toBe(2);
    let reinited = false;
    const r = pool.reinit(init(2)).then(() => { reinited = true; });
    expect(pool.queued()).toBe(0); // queued jobs cancelled synchronously
    // a job submitted during reinit waits for the new init
    const after = pool.submit(ascii(9), 0);
    let afterDone = false;
    after.promise.then(() => { afterDone = true; });
    // each worker: [in-flight job, new init]
    for (const w of ws) {
      expect(w.inbox.map((q) => q.t)).toEqual(['ascii', 'init']);
      expect((w.inbox[1] as Extract<WorkerRequest, { t: 'init' }>).init.opts.seed).toBe(2);
    }
    ws[0].answer(); // in-flight result: dropped
    ws[0].answer(); // ready
    await flush();
    expect(reinited).toBe(false); // worker 1 has not replied yet
    // the post-reinit job may already run on worker 0 (ready), never before its init
    ws[1].answer();
    ws[1].answer();
    await r;
    expect(reinited).toBe(true);
    const w = ws.find((x) => x.inbox.length > 0) as FakeWorker;
    expect(w.inbox[0].t).toBe('ascii');
    w.answer();
    await flush();
    expect(afterDone).toBe(true);
    expect(settled).toBe(0); // no dropped or cancelled job ever settles
    pool.dispose();
  });

  it('affinity routing prefers the hashed worker, falling back to any idle worker', async () => {
    const { pool, ws } = await makePool(4);
    const key = '0:3:-2';
    const home = affinityWorker(key, 4);
    pool.submit({ t: 'layout', job: 0, key: { s: 0, cx: 3, cz: -2 } }, 0, key).promise.catch(() => undefined);
    expect(ws[home].inbox.length).toBe(1);
    expect(ws.filter((w) => w.inbox.length > 0).length).toBe(1);
    // home busy, others idle: the next job of the same chunk goes elsewhere
    pool.submit({ t: 'build', job: 0, key: { s: 0, cx: 3, cz: -2, q: 0 } }, 0, key).promise.catch(() => undefined);
    expect(ws[home].inbox.length).toBe(1);
    expect(ws.filter((w) => w.inbox.length > 0).length).toBe(2);
    // many keys: each lands on its hashed worker when all are idle
    for (const w of ws) while (w.inbox.length) w.answer((req) => ({ t: 'error', job: req.job, message: 'x', stack: '' }));
    await flush();
    for (let i = 0; i < 20; i++) {
      const k = `0:${i}:${i * 3}`;
      const h = affinityWorker(k, 4);
      const job = pool.submit(ascii(i), 0, k);
      job.promise.catch(() => undefined);
      expect(ws[h].inbox.length).toBe(1);
      ws[h].answer();
      await flush();
    }
    pool.dispose();
  });

  it('dispose terminates workers and drops everything', async () => {
    const { pool, ws } = await makePool(2);
    pool.submit(ascii(1), 0);
    pool.submit(ascii(2), 0);
    pool.submit(ascii(3), 0);
    pool.dispose();
    expect(ws.every((w) => w.terminated)).toBe(true);
    expect(pool.queued()).toBe(0);
    expect(pool.busy()).toBe(0);
  });
  it('a worker that fails to start is taken out of rotation; creation rejects when none starts', async () => {
    const crash = (w: FakeWorker): void => w.onerror?.({ message: 'Failed to fetch module', preventDefault() {} } as unknown as ErrorEvent);
    // one of two workers fails before acknowledging init: the pool still comes up with the other one
    const ws: FakeWorker[] = [];
    const p = createWorkerPool(2, init(), () => { const w = new FakeWorker(); ws.push(w); return w as unknown as Worker; });
    crash(ws[0]);
    ws[1].answer();
    const pool = await p;
    expect(ws[0].terminated).toBe(true);
    const h = pool.submit(ascii(1), 0);
    expect(ws[1].inbox[0].t).toBe('ascii');
    ws[1].answer();
    await expect(h.promise).resolves.toMatchObject({ t: 'ascii' });
    expect(pool.busy()).toBe(0);
    pool.dispose();
    // every worker fails: creation rejects instead of hanging the boot
    const ws2: FakeWorker[] = [];
    const p2 = createWorkerPool(2, init(), () => { const w = new FakeWorker(); ws2.push(w); return w as unknown as Worker; });
    crash(ws2[0]);
    crash(ws2[1]);
    await expect(p2).rejects.toThrow(/failed to start/);
  });
});
