// tests/integration/pipeline-a.test.ts (WP10) — the first-try integration gate, shard a: zones 0, 3, 6, 9 of the
// 50-tile full-bake gate and of the low-quality smoke, the tower and leak test scenes, and the find / spawn / ascii
// round trip (see pipelineHarness.ts; shards b and c hold the other zones).
import { describe, expect, it } from 'vitest';
import type { TestSceneId } from '../../src/core/world.ts';
import { createHandlerState, handleRequest } from '../../src/workers/handler.ts';
import {
  collect, createStats, layoutStep, logBench, makeInit, newRun, nextJob, PIPELINE_SHARD_TILES, runGateShard, runSmokeShard, send, tileStep,
} from './pipelineHarness.ts';

const SHARD = 0;
const stats = createStats();

// in order even under --sequence.shuffle: 'logs bench numbers' reads what the gate and the scenes collected
describe('worker pipeline (Node, handleRequest)', { shuffle: false }, () => {
  it('rejects work before init and reports errors as responses', () => {
    const st = createHandlerState();
    const r = handleRequest({ t: 'layout', job: 5, key: { s: 0, cx: 0, cz: 0 } }, st);
    expect(r.res.t).toBe('error');
    expect(r.res.job).toBe(5);
    expect(r.transfer).toEqual([]);
  });

  it('smoke, shard a (zones 0, 3, 6, 9): one tile each at low bake quality through structuredClone(res, { transfer })', () => {
    runSmokeShard(SHARD);
  });

  it('50-tile gate, shard a (zones 0, 3, 6, 9): layout, build, bake through structuredClone(res, { transfer })', { tags: ['sweep'] }, () => {
    runGateShard(SHARD, stats);
  });

  it('test scenes: tower and leak', { tags: ['sweep'] }, () => {
    for (const scene of ['tower', 'leak'] as TestSceneId[]) {
      const init = makeInit({ testScene: scene, quality: 'high' });
      const run = newRun(init);
      layoutStep(run, init, 0, 0, 0);
      for (let q = 0; q < 4; q++) tileStep(run, { s: 0, cx: 0, cz: 0, q: q as 0 | 1 | 2 | 3 });
      if (scene === 'tower') {
        // the storey below sees the same periodic tower
        layoutStep(run, init, 1, 0, 0);
        tileStep(run, { s: 1, cx: 0, cz: 0, q: 0 });
      }
      collect(stats, run);
    }
  });

  it('find / spawn / ascii round-trip the boundary', () => {
    const run = newRun(makeInit({ quality: 'medium' }));
    const sp = send(run, { t: 'spawn', job: nextJob(), s: 0 });
    expect(sp.t).toBe('spawn');
    if (sp.t === 'spawn') expect(Number.isFinite(sp.result.x) && Number.isFinite(sp.result.z)).toBe(true);
    const f = send(run, { t: 'find', job: nextJob(), query: 'spawn', from: { s: 0, x: 0, z: 0 }, maxChunks: 4 });
    expect(f.t).toBe('find');
    const a = send(run, { t: 'ascii', job: nextJob(), s: 0, cx0: -1, cz0: -1, cx1: 0, cz1: 0 });
    expect(a.t).toBe('ascii');
    if (a.t === 'ascii') expect(typeof a.text).toBe('string');
  });

  it('logs bench numbers', { tags: ['sweep'] }, () => {
    logBench('a', stats);
    expect(stats.tiles).toBeGreaterThanOrEqual(PIPELINE_SHARD_TILES[SHARD]);
  });
});
