import { describe, expect, it } from 'vitest';
import { createGpuTimer } from '../../src/app/perf.ts';

function setup() {
  const queries: { ready: boolean; ms: number }[] = [];
  let active: typeof queries[number] | null = null;
  let disjoint = false;
  const gl = {
    QUERY_RESULT_AVAILABLE: 1, QUERY_RESULT: 2,
    getExtension: () => ({ TIME_ELAPSED_EXT: 3, GPU_DISJOINT_EXT: 4 }),
    createQuery() { const q = { ready: false, ms: 0 }; queries.push(q); return q; },
    getParameter: () => disjoint,
    getQueryParameter: (q: typeof queries[number], p: number) => p === 1 ? q.ready : q.ms * 1e6,
    beginQuery(_target: number, q: typeof queries[number]) { active = q; q.ready = false; },
    endQuery() { active = null; },
  };
  const timer = createGpuTimer(gl as unknown as WebGL2RenderingContext);
  return { timer, queries, get active() { return active; }, setDisjoint(v: boolean) { disjoint = v; } };
}

describe('GPU frame timer', () => {
  it('returns the newest completed frame after the query ring wraps', () => {
    const t = setup();
    for (let i = 0; i < 4; i++) { t.timer.begin(); t.timer.end(); t.queries[i].ms = i + 1; }
    t.queries[0].ready = true;
    t.timer.begin(); // reuse slot 0 for a newer frame while slots 1-3 remain pending
    t.timer.end();
    t.queries[0].ms = 5;
    for (const q of t.queries) q.ready = true;
    t.timer.begin();
    expect(t.timer.lastMs).toBe(5);
    expect(t.timer.consume()).toBe(5);
    expect(t.timer.consume()).toBeNull();
    t.timer.end();
  });

  it('drops pending results from a disjoint timer epoch and waits before starting another query', () => {
    const t = setup();
    t.timer.begin(); t.timer.end();
    t.setDisjoint(true);
    t.timer.begin();
    expect(t.active).toBeNull();
    expect(t.timer.ms).toBeNull();
    t.queries[0].ready = true;
    t.queries[0].ms = 999; // became available after the invalidation
    t.setDisjoint(false);
    t.timer.begin();
    expect(t.timer.consume()).toBeNull();
    expect(t.timer.lastMs).toBeNull();
    t.timer.end();
    t.queries[1].ready = true;
    t.queries[1].ms = 2;
    t.timer.begin();
    expect(t.timer.consume()).toBe(2);
    t.timer.end();
  });
});
