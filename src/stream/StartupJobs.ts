import { chunkKeyStr, tileKeyStr } from '../core/grid.ts';
import type { WorkerRequest, WorkerResponse } from '../core/worker.ts';
import type { JobHandle, WorkerPool } from './WorkerPool.ts';

type StartupRequest = Extract<WorkerRequest, { t: 'layout' | 'build' }>;
const keyOf = (r: StartupRequest): string => r.t === 'layout' ? `layout:${chunkKeyStr(r.key)}` : `build:${tileKeyStr(r.key)}:${r.lighting === 'full' ? 'full' : 'preview'}`;

/** Start nearby jobs before GPU initialization finishes. The streamer claims each handle
 * exactly once, including completed results, so no geometry or lighting is built twice. */
export function createStartupJobs(source: WorkerPool): { pool: WorkerPool; preload(r: StartupRequest, priority: number): void; clear(): void } {
  const pending = new Map<string, JobHandle<WorkerResponse>>();
  const clear = (): void => {
    for (const h of pending.values()) h.cancel();
    pending.clear();
  };
  const pool: WorkerPool = {
    get size() { return source.size; },
    submit<T extends WorkerRequest['t']>(r: Extract<WorkerRequest, { t: T }>, priority: number, affinity?: string): JobHandle<Extract<WorkerResponse, { t: T }>> {
      if (r.t === 'layout' || r.t === 'build') {
        const startupReq = r as StartupRequest;
        let key = keyOf(startupReq);
        let h = pending.get(key);
        // A full result can satisfy a preview request. A preview must never stand in for a requested full bake.
        if (!h && startupReq.t === 'build' && startupReq.lighting !== 'full') {
          key = keyOf({ ...startupReq, lighting: 'full' });
          h = pending.get(key);
        }
        if (h) {
          pending.delete(key);
          h.priority = priority;
          return h as JobHandle<Extract<WorkerResponse, { t: T }>>;
        }
      }
      return source.submit(r, priority, affinity);
    },
    reinit(init) { clear(); return source.reinit(init); },
    resize: (n) => source.resize(n),
    queued: () => source.queued(),
    busy: () => source.busy(),
    dispose() { clear(); source.dispose(); },
  };
  return {
    pool, clear,
    preload(r, priority) {
      const key = keyOf(r);
      if (pending.has(key)) return;
      const h = source.submit(r, priority, chunkKeyStr(r.key));
      pending.set(key, h);
      // Rejections remain on the original promise for the streamer to report/retry.
      void h.promise.catch(() => undefined);
    },
  };
}
