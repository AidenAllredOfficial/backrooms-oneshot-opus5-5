// tests/bake/bench.test.ts — WP7 bench gate (runs only with BENCH=1: `npm run bench`). Uses tools/bakebench.ts:
// the six bench zones at quality high, per-tile preview/full timings (cold / warm cache), the radius-1
// time-to-ready on worker_threads with chunk affinity, and the K_MAX tail statistics.

import { describe, expect, it } from 'vitest';
import { BENCH_ZONES, GATE, runBench, type ZoneResult } from '../../tools/bakebench.ts';

const BENCH = process.env.BENCH === '1';

describe.skipIf(!BENCH)('bake bench gate (BENCH=1)', () => {
  let results: ZoneResult[] = [];
  it('runs all bench zones', async () => {
    results = await runBench({ zones: BENCH_ZONES, seed: 1, quality: 'high', workers: 12, ttr: true, quiet: false });
    expect(results.length).toBe(BENCH_ZONES.length);
  }, 1_800_000);
  it('full p95 <= 600 ms warm, <= 900 ms cold; preview p95 <= 60 ms', () => {
    for (const r of results) {
      expect(r.fullWarmP95, `${r.zone} full warm p95`).toBeLessThanOrEqual(GATE.fullWarmP95);
      expect(r.fullColdMax, `${r.zone} full cold`).toBeLessThanOrEqual(GATE.fullColdMax);
      expect(r.previewP95, `${r.zone} preview p95`).toBeLessThanOrEqual(GATE.previewP95);
    }
  });
  it('time-to-ready of the radius-1 neighbourhood <= 2.5 s', () => {
    for (const r of results) expect(r.ttrMs ?? 0, `${r.zone} time-to-ready`).toBeLessThanOrEqual(GATE.ttrMs);
  });
  it('no static FLICKER/ANOMALY lights; K_MAX tail small outside the tall-lattice landmark', () => {
    for (const r of results) {
      expect(r.nonDynFlicker, r.zone).toBe(0);
      // the tail beyond the K_MAX strongest lights is approximated (not dropped); the ATRIUM's 12 m lattice is the
      // designed exception where it is large (covered by the tall-light acceptance test)
      if (!r.zone.startsWith('ATRIUM')) expect(r.tailMean, `${r.zone} mean K_MAX tail`).toBeLessThan(0.2);
    }
  });
});
