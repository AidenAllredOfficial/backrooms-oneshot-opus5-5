// tests/integration/pipeline-b.test.ts (WP10) — the first-try integration gate, shard b: zones 1, 4, 7, 10 of the
// 50-tile full-bake gate and of the low-quality smoke (see pipelineHarness.ts).
import { describe, expect, it } from 'vitest';
import { createStats, logBench, PIPELINE_SHARD_TILES, runGateShard, runSmokeShard } from './pipelineHarness.ts';

const SHARD = 1;
const stats = createStats();

describe('worker pipeline (Node, handleRequest)', () => {
  it('smoke, shard b (zones 1, 4, 7, 10): one tile each at low bake quality through structuredClone(res, { transfer })', () => {
    runSmokeShard(SHARD);
  });

  it('50-tile gate, shard b (zones 1, 4, 7, 10): layout, build, bake through structuredClone(res, { transfer })', { tags: ['sweep'] }, () => {
    runGateShard(SHARD, stats);
  });

  it('logs bench numbers', { tags: ['sweep'] }, () => {
    logBench('b', stats);
    expect(stats.tiles).toBeGreaterThanOrEqual(PIPELINE_SHARD_TILES[SHARD]);
  });
});
