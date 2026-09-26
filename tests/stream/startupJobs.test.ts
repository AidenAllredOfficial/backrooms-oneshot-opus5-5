import { describe, expect, it } from 'vitest';
import { createStartupJobs } from '../../src/stream/StartupJobs.ts';
import type { WorkerPool, JobHandle } from '../../src/stream/WorkerPool.ts';
import type { WorkerRequest, WorkerResponse, WorkerInit } from '../../src/core/worker.ts';

function rig() {
  const jobs: { request: WorkerRequest; handle: JobHandle<WorkerResponse>; cancelled: boolean; resolve(r: WorkerResponse): void; reject(e: Error): void }[] = [];
  const source = {
    size: 2,
    submit(request: WorkerRequest, priority: number) {
      let resolve!: (r: WorkerResponse) => void, reject!: (e: Error) => void;
      const promise = new Promise<WorkerResponse>((a, b) => { resolve = a; reject = b; });
      const job = { request, resolve, reject, cancelled: false, handle: { id: jobs.length, promise, priority, cancel: () => { job.cancelled = true; } } };
      jobs.push(job);
      return job.handle;
    },
    reinit: async () => { for (const j of jobs) j.cancelled = true; },
    resize: async () => {}, queued: () => jobs.length, busy: () => 0, dispose() {},
  } as WorkerPool;
  return { ...createStartupJobs(source), jobs };
}
const request = { t: 'build', job: 0, key: { s: 0, cx: 1, cz: -1, q: 0 } } as const;

describe('startup jobs', () => {
  it('hands a completed build to the streamer once without cloning or repeating it', async () => {
    const r = rig();
    r.preload(request, 20);
    const response = { t: 'build', job: 0 } as WorkerResponse;
    r.jobs[0].resolve(response);
    await Promise.resolve();
    const h = r.pool.submit(request, -10);
    expect(await h.promise).toBe(response);
    expect(h.priority).toBe(-10);
    r.clear();
    expect(r.jobs[0].cancelled).toBe(false);
    r.pool.submit(request, 0);
    expect(r.jobs).toHaveLength(2);
  });

  it('cancels only unclaimed work and distinguishes tiles and storeys', () => {
    const r = rig();
    r.preload(request, 0);
    r.preload(request, 0);
    r.preload({ ...request, key: { ...request.key, q: 1 } }, 0);
    r.preload({ ...request, key: { ...request.key, s: 1 } }, 0);
    expect(r.jobs).toHaveLength(3);
    r.pool.submit(request, 0);
    r.clear();
    expect(r.jobs.map(j => j.cancelled)).toEqual([false, true, true]);
  });

  it('invalidates seed-specific results on reinit and preserves errors for the consumer', async () => {
    const r = rig();
    r.preload(request, 0);
    r.jobs[0].reject(new Error('failed build'));
    await expect(r.pool.submit(request, 0).promise).rejects.toThrow('failed build');
    r.preload(request, 0);
    await r.pool.reinit({} as WorkerInit);
    r.pool.submit(request, 0);
    expect(r.jobs).toHaveLength(3);
    expect(r.jobs[1].cancelled).toBe(true);
  });
});
