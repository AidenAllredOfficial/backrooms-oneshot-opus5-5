// src/workers/chunk.worker.ts — worker entry (WP10): a thin shell around the pure handleRequest.
// Loaded with new Worker(new URL('../workers/chunk.worker.ts', import.meta.url), { type: 'module' }).
// Responses always carry the request's job id (errors included), so the pool can settle the job.
// Tool runs (CACHE_CODE non-empty) serve layouts / builds / bakes / spawn / find from the persistent result cache
// (tileCache.ts). Messages are handled strictly in arrival order either way: the pool relies on FIFO replies (a
// cancelled job's reply arrives before the next 'init' answers 'ready'). A computed result is posted first; its
// encoded entry then goes to this worker's cache writer (cacheWriter.worker.ts, transferred), so the bake thread
// never spends time on gzip or uploads.

import type { WorkerInit, WorkerRequest, WorkerResponse } from '../core/worker.ts';
import { createHandlerState, handleRequest } from './handler.ts';
import { CACHE_CODE, buffersOf, cacheAddr, cacheLookup, createCacheWriter, encodeEntry, isCacheable } from './tileCache.ts';

const st = createHandlerState();
let init: WorkerInit | null = null;
const writer = createCacheWriter(() =>
  typeof Worker === 'function' ? new Worker(new URL('./cacheWriter.worker.ts', import.meta.url), { type: 'module' }) : null);

function post(res: WorkerResponse, transfer: Transferable[], job: number): void {
  try {
    self.postMessage(res, { transfer });
  } catch (err) {
    // A payload that cannot be cloned/transferred must still settle the job on the main thread.
    const m = err instanceof Error ? err : new Error(String(err));
    const fail: WorkerResponse = { t: 'error', job, message: `postMessage(${res.t}) failed: ${m.message}`, stack: m.stack ?? '' };
    self.postMessage(fail);
  }
}

async function handle(req: WorkerRequest): Promise<void> {
  if (req.t === 'init') init = req.init;
  const cached = CACHE_CODE !== '' && init !== null && isCacheable(req);
  const addr = cached && isCacheable(req) ? await cacheAddr(init as WorkerInit, req) : null;
  if (addr && isCacheable(req)) {
    const hit = await cacheLookup(init as WorkerInit, req, addr);
    if (hit) { post(hit, buffersOf(hit), req.job); return; }
  }
  const { res, transfer } = handleRequest(req, st); // `init` also clears st.layouts and st.bakeCache
  // encode before the transfer detaches the payload's buffers
  const entry = addr && res.t === req.t ? encodeEntry(res) : null;
  post(res, transfer, req.job);
  if (addr && entry) writer.store(addr, entry);
}

let queue: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<WorkerRequest>): void => {
  const req = e.data;
  if (CACHE_CODE === '') {
    const { res, transfer } = handleRequest(req, st);
    post(res, transfer, req.job);
    return;
  }
  queue = queue.then(() => handle(req)).catch((err: unknown) => {
    const m = err instanceof Error ? err : new Error(String(err));
    self.postMessage({ t: 'error', job: req.job, message: m.message, stack: m.stack ?? '' } satisfies WorkerResponse);
  });
};
