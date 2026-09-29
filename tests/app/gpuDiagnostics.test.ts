import { describe, expect, it } from 'vitest';
import type { AppCore } from '../../src/app/appState.ts';
import { createDebugApi, type DebugHost } from '../../src/app/debugApi.ts';
import { createGpuProfiler } from '../../src/app/gpuProfile.ts';

interface Query { ready: boolean; ms: number; deleted: boolean; resultReads: number }

function timerContext() {
  const queries: Query[] = [];
  let active: Query | null = null, disjoint = false;
  const gl = {
    QUERY_RESULT_AVAILABLE: 1, QUERY_RESULT: 2,
    getExtension: () => ({ TIME_ELAPSED_EXT: 3, GPU_DISJOINT_EXT: 4 }),
    getParameter: () => disjoint,
    createQuery() { const q = { ready: false, ms: 4, deleted: false, resultReads: 0 }; queries.push(q); return q; },
    beginQuery(_target: number, q: Query) {
      expect(active).toBeNull();
      active = q;
      q.ready = false;
    },
    endQuery() { expect(active).not.toBeNull(); active = null; },
    getQueryParameter(q: Query, p: number) {
      expect(q.deleted).toBe(false);
      if (p === 1) return q.ready;
      q.resultReads++;
      return q.ms * 1e6;
    },
    deleteQuery(q: Query) { expect(q.deleted).toBe(false); q.deleted = true; },
  };
  return {
    gl: gl as unknown as WebGL2RenderingContext, queries,
    get active() { return active; },
    setDisjoint(v: boolean) { disjoint = v; },
  };
}

describe('GPU profiler', () => {
  it('accumulates resolved segments and divides by measured frames', () => {
    const t = timerContext(), prof = createGpuProfiler(t.gl)!;
    for (const frame of [[2, 3], [4, 1]]) {
      prof.mark('scene'); t.active!.ms = frame[0]; prof.stop();
      prof.mark('post'); t.active!.ms = frame[1]; prof.stop();
      prof.endFrame();
      for (const q of t.queries) q.ready = true;
      prof.poll();
    }
    expect(prof.report()).toEqual({ frames: 2, passes: { scene: 3, post: 2 }, totalMs: 5 });
    prof.dispose();
    expect(t.queries.every((q) => q.deleted)).toBe(true);
  });

  it('drops unavailable and active queries on disjoint and restarts the measured-frame window', () => {
    const t = timerContext(), prof = createGpuProfiler(t.gl)!;
    prof.mark('scene'); t.active!.ms = 1; prof.stop(); prof.endFrame();
    t.queries[0].ready = true;
    prof.poll();
    expect(prof.report().totalMs).toBe(1);
    prof.mark('scene'); const invalidPending = t.active!; prof.stop();
    prof.mark('post'); const invalidActive = t.active!;
    t.setDisjoint(true);
    prof.poll();
    expect(t.active).toBeNull();
    expect(prof.current).toBeNull();
    prof.mark('scene'); prof.endFrame(); // no GPU work is measured while the timer is invalid
    expect(t.active).toBeNull();
    expect(prof.report()).toEqual({ frames: 0, passes: { scene: 0, post: 0 }, totalMs: 0 });
    invalidPending.ready = invalidActive.ready = true;
    invalidPending.ms = invalidActive.ms = 999;
    t.setDisjoint(false);
    prof.poll();
    expect(prof.report().totalMs).toBe(0);
    prof.mark('scene'); t.active!.ms = 2; prof.stop(); prof.endFrame();
    for (const q of t.queries) q.ready = true;
    prof.poll();
    expect(prof.report()).toEqual({ frames: 1, passes: { scene: 2, post: 0 }, totalMs: 2 });
    expect(invalidPending.resultReads).toBe(1); // its only read was the valid first-frame sample
    prof.dispose();
    expect(t.queries.every((q) => q.deleted)).toBe(true);
  });
});

function benchmark(t: ReturnType<typeof timerContext>) {
  const hooks: ((frameMs: number) => boolean)[] = [];
  const core = {
    bus: { on: () => () => {} }, hooks, clock: { t: 0 },
    renderer: { getContext: () => t.gl, domElement: { width: 1280, height: 720 } },
    sys: {
      probe: { update() {} }, streamer: { query: {} }, player: { state: {} }, features: { probe: true },
      post: { render() {} }, materials: { globals: { reflOn: { value: 0 } } },
    },
  } as unknown as AppCore;
  const api = createDebugApi(core, {} as DebugHost).api;
  const report = api.gpuBench!(2);
  return { report, frame: () => hooks[0](16) };
}

describe('GPU benchmark', () => {
  it('restarts the sample set and never consumes late invalid queries', async () => {
    const t = timerContext(), b = benchmark(t);
    expect(b.frame()).toBe(false); // first round
    t.queries[0].ready = true;
    expect(b.frame()).toBe(false); // accepts first sample and submits an unavailable second round
    const invalid = t.queries[1];
    t.setDisjoint(true);
    expect(b.frame()).toBe(false);
    expect(invalid.deleted).toBe(true);
    invalid.ms = 999; invalid.ready = true;
    t.setDisjoint(false);
    let finished = false;
    for (let i = 0; i < 20 && !finished; i++) {
      for (const q of t.queries) if (!q.deleted) q.ready = true;
      finished = b.frame();
    }
    expect(finished).toBe(true);
    expect(await b.report).toMatchObject({ ms: 2, rounds: 7, repeats: 2 });
    expect(invalid.resultReads).toBe(0);
    expect(t.queries.every((q) => q.deleted)).toBe(true);
  });

  it('finishes without a fabricated timing after a sustained disjoint epoch', async () => {
    const t = timerContext();
    t.setDisjoint(true);
    const b = benchmark(t);
    for (let i = 0; i < 119; i++) expect(b.frame()).toBe(false);
    expect(b.frame()).toBe(true);
    expect(await b.report).toMatchObject({ ms: null, rounds: 0 });
    expect(t.queries).toHaveLength(0);
  });
});
