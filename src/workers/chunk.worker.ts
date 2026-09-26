// src/workers/chunk.worker.ts — worker entry (WP10): a thin shell around the pure handleRequest.
// Loaded with new Worker(new URL('../workers/chunk.worker.ts', import.meta.url), { type: 'module' }).
// Responses always carry the request's job id (errors included), so the pool can settle the job.

import type { WorkerRequest, WorkerResponse } from '../core/worker.ts';
import { createHandlerState, handleRequest } from './handler.ts';

const st = createHandlerState();

self.onmessage = (e: MessageEvent<WorkerRequest>): void => {
  const { res, transfer } = handleRequest(e.data, st); // `init` also clears st.layouts and st.bakeCache
  try {
    self.postMessage(res, { transfer });
  } catch (err) {
    // A payload that cannot be cloned/transferred must still settle the job on the main thread.
    const m = err instanceof Error ? err : new Error(String(err));
    const fail: WorkerResponse = { t: 'error', job: e.data.job, message: `postMessage(${res.t}) failed: ${m.message}`, stack: m.stack ?? '' };
    self.postMessage(fail);
  }
};
